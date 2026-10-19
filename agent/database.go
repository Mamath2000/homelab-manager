//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Backups of databases: a job of kind postgres or mongodb dumps its databases into a work directory,
// then sends the dumps (one sub-directory each) as the archives of its snapshot. The commands are
// fixed (no shell, no command sent by the hub): the hub only chooses the kind and its parameters.
// The dumps are not compressed so that the PBS deduplicates them from one day to the next (it
// compresses the chunks itself). A failed dump fails the job: nothing is sent. Once sent, the dumps
// are kept on the host (Keep last runs, in <workDir>/history/<time>/) or removed (Keep 0).

// kinds of backup job: directories (the default) or the dump of databases, Nextcloud AIO included
// (nextcloud.go)
func isDatabaseKind(kind string) bool {
	return kind == "postgres" || kind == "mongodb" || kind == "nextcloud"
}

type DatabaseDump struct {
	Mode      string   `json:"mode,omitempty"`      // postgres: databases (pg_dump of each) | cluster (pg_basebackup); nextcloud: database | config
	Databases []string `json:"databases,omitempty"` // postgres databases mode, mongodb
	Container string   `json:"container,omitempty"` // mongodb: container running mongod
	WorkDir   string   `json:"workDir"`
	Keep      int      `json:"keep"` // dumps kept on the host after the backup (0: removed once sent)
}

// most dumps kept on the host
const maxKeep = 30

var (
	dbNameRe    = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_-]{0,47}$`)
	containerRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
)

// directories a work directory may not be in: the agent empties its sub-directories
var forbiddenWorkRoots = []string{"/proc", "/sys", "/dev", "/run", "/boot", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64"}

func validateDatabase(kind string, p *DatabaseDump) error {
	return validateDatabaseSettings(kind, p, true)
}

// validateDatabaseSettings: chosen false for the listing of the databases of the server (form of a job,
// before any is chosen).
func validateDatabaseSettings(kind string, p *DatabaseDump, chosen bool) error {
	w := p.WorkDir
	if !filepath.IsAbs(w) || filepath.Clean(w) != w || strings.ContainsAny(w, ":\n") || strings.Count(w, "/") < 2 {
		return fmt.Errorf("invalid work directory %q (absolute, at least two levels)", w)
	}
	for _, r := range forbiddenWorkRoots {
		if w == r || strings.HasPrefix(w, r+"/") {
			return fmt.Errorf("work directory %q: not under %s", w, r)
		}
	}
	if p.Keep < 0 || p.Keep > maxKeep {
		return fmt.Errorf("dumps kept: 0 to %d", maxKeep)
	}
	seen := map[string]bool{}
	for _, d := range p.Databases {
		if !dbNameRe.MatchString(d) || seen[d] {
			return fmt.Errorf("invalid database %q", d)
		}
		seen[d] = true
	}
	switch kind {
	case "postgres":
		if p.Container != "" {
			return errors.New("postgres: local server only")
		}
		switch p.Mode {
		case "databases":
			if chosen && len(p.Databases) == 0 {
				return errors.New("postgres: no database")
			}
		case "cluster":
			if len(p.Databases) != 0 {
				return errors.New("postgres cluster: the whole cluster, no database list")
			}
		default:
			return fmt.Errorf("postgres: unknown mode %q", p.Mode)
		}
	case "mongodb":
		if p.Mode != "" || !containerRe.MatchString(p.Container) || (chosen && len(p.Databases) == 0) {
			return errors.New("mongodb: container and at least one database")
		}
	case "nextcloud":
		// the containers and the database are found on the host at each run
		if (p.Mode != "database" && p.Mode != "config") || p.Container != "" || len(p.Databases) != 0 {
			return errors.New("nextcloud: mode database or config, nothing else")
		}
	default:
		return fmt.Errorf("unknown database kind %q", kind)
	}
	return nil
}

// dumpArchives: the archives of a database job, one per dump.
func dumpArchives(kind string, p *DatabaseDump) []BackupArchive {
	var out []BackupArchive
	add := func(name string) { out = append(out, BackupArchive{Name: name, Path: filepath.Join(p.WorkDir, name)}) }
	switch kind {
	case "postgres":
		if p.Mode == "cluster" {
			add("pg-cluster")
			break
		}
		add("pg-globals") // roles and tablespaces: needed to restore the rights of the databases
		for _, d := range p.Databases {
			add("pg-" + d)
		}
	case "mongodb":
		for _, d := range p.Databases {
			add("mongo-" + d)
		}
	case "nextcloud":
		if p.Mode == "config" {
			add("nc-config")
			break
		}
		add("pg-globals")
		add("pg-nextcloud")
	}
	return out
}

// jobArchives: the directories of a directories job, the dumps of a database job.
func jobArchives(j BackupJob) []BackupArchive {
	if isDatabaseKind(j.Kind) && j.Database != nil {
		return dumpArchives(j.Kind, j.Database)
	}
	return j.Archives
}

// seams for the tests
var (
	dumpRun    = runStreaming
	dumpOutput = func(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
		cmd := exec.CommandContext(ctx, name, args...)
		cmd.Env = env
		out, err := cmd.Output()
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			return out, fmt.Errorf("%s: %s", name, strings.TrimSpace(lastLine(string(ee.Stderr))))
		}
		return out, err
	}
	lookupPostgres = func() (uid, gid int, home string, err error) {
		u, err := user.Lookup("postgres")
		if err != nil {
			return 0, 0, "", errors.New("no postgres user on this host (PostgreSQL server not installed?)")
		}
		uid, _ = strconv.Atoi(u.Uid)
		gid, _ = strconv.Atoi(u.Gid)
		return uid, gid, u.HomeDir, nil
	}
)

func runDumpStep(ctx context.Context, env []string, emit func(string), name string, args ...string) error {
	emit(fmt.Sprintf("%s %s\n", name, strings.Join(args, " ")))
	code, err := dumpRun(ctx, env, emit, name, args...)
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	if code != 0 {
		return fmt.Errorf("%s a échoué (code %d)", name, code)
	}
	return nil
}

// resetDir empties a dump directory (created by the agent: its name is fixed) and gives it to uid.
func resetDir(dir string, uid, gid int) error {
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	if err := os.Mkdir(dir, 0o700); err != nil {
		return err
	}
	return os.Chown(dir, uid, gid)
}

// dumpDatabases makes the dumps of a database job.
func dumpDatabases(ctx context.Context, kind string, p *DatabaseDump, emit func(string)) error {
	if err := os.MkdirAll(p.WorkDir, 0o711); err != nil {
		return err
	}
	switch kind {
	case "postgres":
		return dumpPostgres(ctx, p, emit)
	case "mongodb":
		return dumpMongo(ctx, p, emit)
	case "nextcloud":
		return dumpNextcloud(ctx, p, emit)
	}
	return fmt.Errorf("unknown database kind %q", kind)
}

// openTraversal: postgres must reach its dump directories, so the work directory and each of its parents
// get the traversal right for others where it is missing (x only: their content cannot be listed).
func openTraversal(dir string, emit func(string)) error {
	for d := dir; d != "/" && d != "."; d = filepath.Dir(d) {
		fi, err := os.Stat(d)
		if err != nil {
			return err
		}
		if fi.Mode().Perm()&0o001 != 0 {
			continue
		}
		if err := os.Chmod(d, fi.Mode().Perm()|0o001); err != nil {
			return err
		}
		emit(fmt.Sprintf("%s : droit de traversée ajouté pour l'utilisateur postgres (%o → %o)\n", d, fi.Mode().Perm(), fi.Mode().Perm()|0o001))
	}
	return nil
}

// Run as the postgres user (peer authentication on the local socket), like the PostgreSQL tools expect.
func dumpPostgres(ctx context.Context, p *DatabaseDump, emit func(string)) error {
	uid, gid, home, err := lookupPostgres()
	if err != nil {
		return err
	}
	if err := openTraversal(p.WorkDir, emit); err != nil {
		return err
	}
	env := append(os.Environ(), "LC_ALL=C", "HOME="+home, "PGAPPNAME=homelab-agent")
	as := func(args ...string) []string { return append([]string{"-u", "postgres", "--"}, args...) }
	for _, a := range dumpArchives("postgres", p) {
		if err := resetDir(a.Path, uid, gid); err != nil {
			return err
		}
	}
	if p.Mode == "cluster" {
		// physical copy of the whole cluster, plain format with its WAL: restored as is (extensions included)
		return runDumpStep(ctx, env, emit, "runuser", as("pg_basebackup", "-D", filepath.Join(p.WorkDir, "pg-cluster"), "-Fp", "-Xstream", "-c", "fast", "--no-password")...)
	}
	if err := runDumpStep(ctx, env, emit, "runuser", as("pg_dumpall", "--globals-only", "--no-password", "-f", filepath.Join(p.WorkDir, "pg-globals", "globals.sql"))...); err != nil {
		return err
	}
	for _, d := range p.Databases {
		// directory format, one file per table, without compression
		if err := runDumpStep(ctx, env, emit, "runuser", as("pg_dump", "-Fd", "-Z0", "--no-password", "-f", filepath.Join(p.WorkDir, "pg-"+d), d)...); err != nil {
			return err
		}
	}
	return nil
}

// mongodump runs in the container (its tools, its socket); the dump is then copied out of it.
const mongoTmp = "/tmp/homelab-agent-dump"

func dumpMongo(ctx context.Context, p *DatabaseDump, emit func(string)) (err error) {
	env := append(os.Environ(), "LC_ALL=C")
	if err := runDumpStep(ctx, env, emit, "docker", "exec", p.Container, "rm", "-rf", mongoTmp); err != nil {
		return err
	}
	defer func() {
		if cerr := runDumpStep(context.WithoutCancel(ctx), env, emit, "docker", "exec", p.Container, "rm", "-rf", mongoTmp); cerr != nil && err == nil {
			emit("nettoyage du conteneur : " + cerr.Error() + "\n")
		}
	}()
	for _, d := range p.Databases {
		dir := filepath.Join(p.WorkDir, "mongo-"+d)
		if err := resetDir(dir, os.Getuid(), os.Getgid()); err != nil {
			return err
		}
		if err := runDumpStep(ctx, env, emit, "docker", "exec", p.Container, "mongodump", "--db", d, "--out", mongoTmp); err != nil {
			return err
		}
		// "/." copies the content of the dump of the database into its archive directory
		if err := runDumpStep(ctx, env, emit, "docker", "cp", p.Container+":"+mongoTmp+"/"+d+"/.", dir); err != nil {
			return err
		}
	}
	return nil
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return lines[len(lines)-1]
}

// --- after the backup ---------------------------------------------------------------------------

var stampRe = regexp.MustCompile(`^\d{8}-\d{6}$`)

func historyDir(p *DatabaseDump) string { return filepath.Join(p.WorkDir, "history") }

// finishDumps moves the dumps of a successful run into the history (or removes them, Keep 0) and keeps
// the last Keep runs; the dumps of a failed dump are incomplete: removed.
func finishDumps(kind string, p *DatabaseDump, dumped bool, at time.Time, emit func(string)) {
	remove := func(path string) {
		if err := os.RemoveAll(path); err != nil {
			emit(fmt.Sprintf("suppression de %s : %v\n", path, err))
		}
	}
	if !dumped || p.Keep == 0 {
		for _, a := range dumpArchives(kind, p) {
			remove(a.Path)
		}
		if dumped {
			emit("dumps supprimés après l'envoi\n")
		}
	} else {
		dest := filepath.Join(historyDir(p), at.Format("20060102-150405"))
		if err := os.MkdirAll(dest, 0o711); err != nil {
			emit(fmt.Sprintf("historique des dumps : %v\n", err))
			return
		}
		for _, a := range dumpArchives(kind, p) {
			if err := os.Rename(a.Path, filepath.Join(dest, a.Name)); err != nil {
				emit(fmt.Sprintf("historique de %s : %v\n", a.Name, err))
			}
		}
		emit(fmt.Sprintf("dumps gardés dans %s\n", dest))
	}
	if !dumped {
		return
	}
	// the last Keep runs (all of them with Keep 0: the history goes)
	entries, _ := os.ReadDir(historyDir(p))
	var runs []string
	for _, e := range entries {
		if e.IsDir() && stampRe.MatchString(e.Name()) {
			runs = append(runs, e.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(runs)))
	for i, r := range runs {
		if i >= p.Keep {
			remove(filepath.Join(historyDir(p), r))
			emit(fmt.Sprintf("ancien dump supprimé : %s\n", r))
		}
	}
}

// --- sizes and check ------------------------------------------------------------------------------

type DatabaseInfo struct {
	Name string `json:"name"`
	Size int64  `json:"size"` // bytes on the server (PostgreSQL: pg_database_size, MongoDB: sizeOnDisk)
}

// DatabaseCheck: what the check of a database job found on the host (button of the form).
type DatabaseCheck struct {
	Tools     string         `json:"tools"`     // version of the dump tool
	Databases []DatabaseInfo `json:"databases"` // on the server
	Missing   []string       `json:"missing"`   // chosen but not on the server
	Free      int64          `json:"free"`      // free space for the work directory (-1: unknown)
}

// DumpInfo: size of a dump of a run and of its database, reported with its result.
type DumpInfo struct {
	Archive  string `json:"archive"`
	Database string `json:"database,omitempty"` // empty: globals, or the whole cluster
	DBSize   int64  `json:"dbSize"`             // -1: unknown
	DumpSize int64  `json:"dumpSize"`
}

// listDatabases: the databases of the server, with their size.
func listDatabases(ctx context.Context, kind string, p *DatabaseDump) (tools string, dbs []DatabaseInfo, err error) {
	switch kind {
	case "postgres":
		_, _, home, err := lookupPostgres()
		if err != nil {
			return "", nil, err
		}
		env := append(os.Environ(), "LC_ALL=C", "HOME="+home, "PGAPPNAME=homelab-agent")
		for _, t := range []string{"pg_dump", "pg_dumpall", "pg_basebackup", "psql", "runuser"} {
			if _, err := exec.LookPath(t); err != nil {
				return "", nil, fmt.Errorf("%s introuvable sur cet hôte", t)
			}
		}
		v, err := dumpOutput(ctx, env, "runuser", "-u", "postgres", "--", "pg_dump", "--version")
		if err != nil {
			return "", nil, err
		}
		out, err := dumpOutput(ctx, env, "runuser", "-u", "postgres", "--", "psql", "-AtX", "--no-password", "-d", "postgres", "-c",
			"select datname, pg_database_size(datname) from pg_database where datallowconn and not datistemplate order by 1")
		if err != nil {
			return "", nil, err
		}
		for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			name, size, ok := strings.Cut(l, "|")
			if !ok {
				continue
			}
			n, _ := strconv.ParseInt(size, 10, 64)
			dbs = append(dbs, DatabaseInfo{Name: name, Size: n})
		}
		return strings.TrimSpace(string(v)), dbs, nil
	case "mongodb":
		env := append(os.Environ(), "LC_ALL=C")
		state, err := dumpOutput(ctx, env, "docker", "inspect", "-f", "{{.State.Running}}", p.Container)
		if err != nil {
			return "", nil, fmt.Errorf("conteneur %s introuvable", p.Container)
		}
		if strings.TrimSpace(string(state)) != "true" {
			return "", nil, fmt.Errorf("conteneur %s arrêté", p.Container)
		}
		v, err := dumpOutput(ctx, env, "docker", "exec", p.Container, "mongodump", "--version")
		if err != nil {
			return "", nil, fmt.Errorf("mongodump absent du conteneur %s", p.Container)
		}
		const js = `JSON.stringify(db.adminCommand({listDatabases: 1}).databases.map((d) => ({name: d.name, size: Number(d.sizeOnDisk)})))`
		// mongosh since MongoDB 6, mongo before
		out, err := dumpOutput(ctx, env, "docker", "exec", p.Container, "mongosh", "--quiet", "--norc", "--eval", js)
		if err != nil {
			if out, err = dumpOutput(ctx, env, "docker", "exec", p.Container, "mongo", "--quiet", "--norc", "--eval", js); err != nil {
				return "", nil, fmt.Errorf("liste des bases : %w", err)
			}
		}
		var list []struct {
			Name string  `json:"name"`
			Size float64 `json:"size"`
		}
		if err := json.Unmarshal([]byte(lastLine(string(out))), &list); err != nil {
			return "", nil, fmt.Errorf("liste des bases illisible : %w", err)
		}
		for _, d := range list {
			dbs = append(dbs, DatabaseInfo{Name: d.Name, Size: int64(d.Size)})
		}
		return strings.SplitN(strings.TrimSpace(string(v)), "\n", 2)[0], dbs, nil
	case "nextcloud":
		a, err := discoverNextcloud(ctx, false)
		if err != nil {
			return "", nil, err
		}
		return strings.TrimSpace("Nextcloud " + a.Version + " · " + a.DBTools), []DatabaseInfo{{Name: a.Database, Size: a.DBSize}}, nil
	}
	return "", nil, fmt.Errorf("unknown database kind %q", kind)
}

func checkDatabaseOnHost(ctx context.Context, kind string, p *DatabaseDump) (*DatabaseCheck, error) {
	if err := validateDatabaseSettings(kind, p, false); err != nil {
		return nil, err
	}
	tools, dbs, err := listDatabases(ctx, kind, p)
	if err != nil {
		return nil, err
	}
	r := &DatabaseCheck{Tools: tools, Databases: dbs, Missing: []string{}, Free: freeSpace(p.WorkDir)}
	have := map[string]bool{}
	for _, d := range dbs {
		have[d.Name] = true
	}
	for _, d := range p.Databases {
		if !have[d] {
			r.Missing = append(r.Missing, d)
		}
	}
	return r, nil
}

// freeSpace of the file system of a directory, or of its closest existing parent.
func freeSpace(dir string) int64 {
	for d := dir; ; d = filepath.Dir(d) {
		var st syscall.Statfs_t
		if err := syscall.Statfs(d, &st); err == nil {
			return int64(st.Bavail) * st.Bsize
		}
		if d == "/" {
			return -1
		}
	}
}

func dirSize(dir string) int64 {
	var n int64
	_ = filepath.WalkDir(dir, func(_ string, e os.DirEntry, err error) error {
		if err == nil && !e.IsDir() {
			if fi, err := e.Info(); err == nil {
				n += fi.Size()
			}
		}
		return nil
	})
	return n
}

// dumpSizes: size of each dump and of its database (best effort: unknown when unreadable).
func dumpSizes(ctx context.Context, kind string, p *DatabaseDump) []DumpInfo {
	if kind == "nextcloud" {
		return dumpSizesNextcloud(ctx, p)
	}
	sizes := map[string]int64{}
	var total int64
	if _, dbs, err := listDatabases(ctx, kind, p); err == nil {
		for _, d := range dbs {
			sizes[d.Name] = d.Size
			total += d.Size
		}
	}
	var out []DumpInfo
	for _, a := range dumpArchives(kind, p) {
		d := DumpInfo{Archive: a.Name, DBSize: -1, DumpSize: dirSize(a.Path)}
		switch {
		case a.Name == "pg-cluster":
			if len(sizes) > 0 {
				d.DBSize = total
			}
		case a.Name == "pg-globals":
			d.DBSize = 0
		default:
			d.Database = strings.TrimPrefix(strings.TrimPrefix(a.Name, "pg-"), "mongo-")
			if n, ok := sizes[d.Database]; ok {
				d.DBSize = n
			}
		}
		out = append(out, d)
	}
	return out
}

// Engines that can be backed up here are those running now (not merely tools present): the capability is
// re-evaluated at each hello, so an engine started later shows up with the next one.
var (
	// socket of a local PostgreSQL server (the dump runs natively as the postgres user)
	postgresSockets = []string{"/var/run/postgresql/.s.PGSQL.*", "/run/postgresql/.s.PGSQL.*", "/tmp/.s.PGSQL.*"}
	// images of the running containers, one per line
	runningImages = func(ctx context.Context) ([]string, error) {
		out, err := exec.CommandContext(ctx, "docker", "ps", "--format", "{{.Image}}").Output()
		return strings.Fields(string(out)), err
	}
	// docker present and not on WSL
	dockerUsable = func(ctx context.Context) bool { return !onWSL && dock.available(ctx) }
)

func postgresRunning() bool {
	if _, err := exec.LookPath("pg_dump"); err != nil {
		return false
	}
	for _, g := range postgresSockets {
		if m, _ := filepath.Glob(g); len(m) > 0 {
			return true
		}
	}
	return false
}

func mongoRunning(ctx context.Context) bool {
	if !dockerUsable(ctx) {
		return false
	}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	images, err := runningImages(cctx)
	if err != nil {
		return false
	}
	for _, img := range images {
		if strings.Contains(strings.ToLower(img), "mongo") {
			return true
		}
	}
	return false
}

// runningDatabaseKinds: the kinds of database jobs usable on this host.
func runningDatabaseKinds(ctx context.Context) (kinds []string) {
	if postgresRunning() {
		kinds = append(kinds, "postgres")
	}
	if mongoRunning(ctx) {
		kinds = append(kinds, "mongodb")
	}
	if nextcloudRunning(ctx) {
		kinds = append(kinds, "nextcloud")
	}
	return kinds
}
