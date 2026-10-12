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

// Preparation of a backup: a dump of a database made by the agent just before proxmox-backup-client,
// into a work directory whose sub-directories become archives of the snapshot. The commands are
// fixed (no shell, no command sent by the hub): the hub only chooses the type and its parameters.
// The dumps are not compressed so that the PBS deduplicates them from one day to the next (it
// compresses the chunks itself). A failed preparation fails the job: nothing is sent. Once sent, the
// dumps are kept on the host (Keep last runs, in <workDir>/history/<time>/) or removed (Keep 0).

type BackupPrepare struct {
	Type      string   `json:"type"`                // postgres | mongodb
	Mode      string   `json:"mode,omitempty"`      // postgres: databases (pg_dump of each) | cluster (pg_basebackup)
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

func validatePrepare(p *BackupPrepare) error {
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
	switch p.Type {
	case "postgres":
		if p.Container != "" {
			return errors.New("postgres: local server only")
		}
		switch p.Mode {
		case "databases":
			if len(p.Databases) == 0 {
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
		if p.Mode != "" || !containerRe.MatchString(p.Container) || len(p.Databases) == 0 {
			return errors.New("mongodb: container and at least one database")
		}
	default:
		return fmt.Errorf("unknown preparation %q", p.Type)
	}
	return nil
}

// preparedArchives: the archives the preparation writes, one per dump.
func preparedArchives(p *BackupPrepare) []BackupArchive {
	var out []BackupArchive
	add := func(name string) { out = append(out, BackupArchive{Name: name, Path: filepath.Join(p.WorkDir, name)}) }
	switch p.Type {
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
	}
	return out
}

// jobArchives: the directories of the job, then the dumps of its preparation.
func jobArchives(j BackupJob) []BackupArchive {
	if j.Prepare == nil {
		return j.Archives
	}
	return append(append([]BackupArchive{}, j.Archives...), preparedArchives(j.Prepare)...)
}

// seams for the tests
var (
	prepRun    = runStreaming
	prepOutput = func(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
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

func runPrepStep(ctx context.Context, env []string, emit func(string), name string, args ...string) error {
	emit(fmt.Sprintf("%s %s\n", name, strings.Join(args, " ")))
	code, err := prepRun(ctx, env, emit, name, args...)
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

// prepareBackup makes the dumps of the job.
func prepareBackup(ctx context.Context, p *BackupPrepare, emit func(string)) error {
	if err := os.MkdirAll(p.WorkDir, 0o711); err != nil {
		return err
	}
	switch p.Type {
	case "postgres":
		return preparePostgres(ctx, p, emit)
	case "mongodb":
		return prepareMongo(ctx, p, emit)
	}
	return fmt.Errorf("unknown preparation %q", p.Type)
}

// Run as the postgres user (peer authentication on the local socket), like the PostgreSQL tools expect.
func preparePostgres(ctx context.Context, p *BackupPrepare, emit func(string)) error {
	uid, gid, home, err := lookupPostgres()
	if err != nil {
		return err
	}
	// postgres must reach its dump directories: traversal of the work directory (not its listing)
	if fi, err := os.Stat(p.WorkDir); err == nil && fi.Mode().Perm()&0o001 == 0 {
		if err := os.Chmod(p.WorkDir, fi.Mode().Perm()|0o001); err != nil {
			return err
		}
		emit(fmt.Sprintf("%s : droit de traversée ajouté pour l'utilisateur postgres\n", p.WorkDir))
	}
	env := append(os.Environ(), "LC_ALL=C", "HOME="+home, "PGAPPNAME=homelab-agent")
	as := func(args ...string) []string { return append([]string{"-u", "postgres", "--"}, args...) }
	for _, a := range preparedArchives(p) {
		if err := resetDir(a.Path, uid, gid); err != nil {
			return err
		}
	}
	if p.Mode == "cluster" {
		// physical copy of the whole cluster, plain format with its WAL: restored as is (extensions included)
		return runPrepStep(ctx, env, emit, "runuser", as("pg_basebackup", "-D", filepath.Join(p.WorkDir, "pg-cluster"), "-Fp", "-Xstream", "-c", "fast", "--no-password")...)
	}
	if err := runPrepStep(ctx, env, emit, "runuser", as("pg_dumpall", "--globals-only", "--no-password", "-f", filepath.Join(p.WorkDir, "pg-globals", "globals.sql"))...); err != nil {
		return err
	}
	for _, d := range p.Databases {
		// directory format, one file per table, without compression
		if err := runPrepStep(ctx, env, emit, "runuser", as("pg_dump", "-Fd", "-Z0", "--no-password", "-f", filepath.Join(p.WorkDir, "pg-"+d), d)...); err != nil {
			return err
		}
	}
	return nil
}

// mongodump runs in the container (its tools, its socket); the dump is then copied out of it.
const mongoTmp = "/tmp/homelab-agent-dump"

func prepareMongo(ctx context.Context, p *BackupPrepare, emit func(string)) (err error) {
	env := append(os.Environ(), "LC_ALL=C")
	if err := runPrepStep(ctx, env, emit, "docker", "exec", p.Container, "rm", "-rf", mongoTmp); err != nil {
		return err
	}
	defer func() {
		if cerr := runPrepStep(context.WithoutCancel(ctx), env, emit, "docker", "exec", p.Container, "rm", "-rf", mongoTmp); cerr != nil && err == nil {
			emit("nettoyage du conteneur : " + cerr.Error() + "\n")
		}
	}()
	for _, d := range p.Databases {
		dir := filepath.Join(p.WorkDir, "mongo-"+d)
		if err := resetDir(dir, os.Getuid(), os.Getgid()); err != nil {
			return err
		}
		if err := runPrepStep(ctx, env, emit, "docker", "exec", p.Container, "mongodump", "--db", d, "--out", mongoTmp); err != nil {
			return err
		}
		// "/." copies the content of the dump of the database into its archive directory
		if err := runPrepStep(ctx, env, emit, "docker", "cp", p.Container+":"+mongoTmp+"/"+d+"/.", dir); err != nil {
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

func historyDir(p *BackupPrepare) string { return filepath.Join(p.WorkDir, "history") }

// finishPrepared moves the dumps of a successful preparation into the history (or removes them, Keep 0)
// and keeps the last Keep runs; the dumps of a failed preparation are incomplete: removed.
func finishPrepared(p *BackupPrepare, prepared bool, at time.Time, emit func(string)) {
	remove := func(path string) {
		if err := os.RemoveAll(path); err != nil {
			emit(fmt.Sprintf("suppression de %s : %v\n", path, err))
		}
	}
	if !prepared || p.Keep == 0 {
		for _, a := range preparedArchives(p) {
			remove(a.Path)
		}
		if prepared {
			emit("dumps supprimés après l'envoi\n")
		}
	} else {
		dest := filepath.Join(historyDir(p), at.Format("20060102-150405"))
		if err := os.MkdirAll(dest, 0o711); err != nil {
			emit(fmt.Sprintf("historique des dumps : %v\n", err))
			return
		}
		for _, a := range preparedArchives(p) {
			if err := os.Rename(a.Path, filepath.Join(dest, a.Name)); err != nil {
				emit(fmt.Sprintf("historique de %s : %v\n", a.Name, err))
			}
		}
		emit(fmt.Sprintf("dumps gardés dans %s\n", dest))
	}
	if !prepared {
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

// PrepareCheck: what the check of a preparation found on the host (button of the form).
type PrepareCheck struct {
	Tools     string         `json:"tools"`     // version of the dump tool
	Databases []DatabaseInfo `json:"databases"` // on the server
	Missing   []string       `json:"missing"`   // chosen but not on the server
	Free      int64          `json:"free"`      // free space for the work directory (-1: unknown)
}

// PreparedDump: size of a dump of a run, reported with its result.
type PreparedDump struct {
	Archive  string `json:"archive"`
	Database string `json:"database,omitempty"` // empty: globals, or the whole cluster
	DBSize   int64  `json:"dbSize"`             // -1: unknown
	DumpSize int64  `json:"dumpSize"`
}

// listDatabases: the databases of the server, with their size.
func listDatabases(ctx context.Context, p *BackupPrepare) (tools string, dbs []DatabaseInfo, err error) {
	switch p.Type {
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
		v, err := prepOutput(ctx, env, "runuser", "-u", "postgres", "--", "pg_dump", "--version")
		if err != nil {
			return "", nil, err
		}
		out, err := prepOutput(ctx, env, "runuser", "-u", "postgres", "--", "psql", "-AtX", "--no-password", "-d", "postgres", "-c",
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
		state, err := prepOutput(ctx, env, "docker", "inspect", "-f", "{{.State.Running}}", p.Container)
		if err != nil {
			return "", nil, fmt.Errorf("conteneur %s introuvable", p.Container)
		}
		if strings.TrimSpace(string(state)) != "true" {
			return "", nil, fmt.Errorf("conteneur %s arrêté", p.Container)
		}
		v, err := prepOutput(ctx, env, "docker", "exec", p.Container, "mongodump", "--version")
		if err != nil {
			return "", nil, fmt.Errorf("mongodump absent du conteneur %s", p.Container)
		}
		const js = `JSON.stringify(db.adminCommand({listDatabases: 1}).databases.map((d) => ({name: d.name, size: Number(d.sizeOnDisk)})))`
		// mongosh since MongoDB 6, mongo before
		out, err := prepOutput(ctx, env, "docker", "exec", p.Container, "mongosh", "--quiet", "--norc", "--eval", js)
		if err != nil {
			if out, err = prepOutput(ctx, env, "docker", "exec", p.Container, "mongo", "--quiet", "--norc", "--eval", js); err != nil {
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
	}
	return "", nil, fmt.Errorf("unknown preparation %q", p.Type)
}

func checkPrepareOnHost(ctx context.Context, p *BackupPrepare) (*PrepareCheck, error) {
	if err := validatePrepare(p); err != nil {
		return nil, err
	}
	tools, dbs, err := listDatabases(ctx, p)
	if err != nil {
		return nil, err
	}
	r := &PrepareCheck{Tools: tools, Databases: dbs, Missing: []string{}, Free: freeSpace(p.WorkDir)}
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

// preparedSizes: size of each dump and of its database (best effort: unknown when unreadable).
func preparedSizes(ctx context.Context, p *BackupPrepare) []PreparedDump {
	sizes := map[string]int64{}
	var total int64
	if _, dbs, err := listDatabases(ctx, p); err == nil {
		for _, d := range dbs {
			sizes[d.Name] = d.Size
			total += d.Size
		}
	}
	var out []PreparedDump
	for _, a := range preparedArchives(p) {
		d := PreparedDump{Archive: a.Name, DBSize: -1, DumpSize: dirSize(a.Path)}
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
