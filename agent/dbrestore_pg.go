//go:build !windows

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Restore of a PostgreSQL dump (pg-<base>, pg_dump -Fd) into a NEW database (#210), the same flow as MongoDB
// (dbrestore.go): nothing is overwritten (createdb itself refuses an existing name), the objects belong to the
// superuser of the target (--no-owner --no-privileges: the roles of the dump are not needed), the new database
// is closed to PUBLIC, and a database this agent created and could not fill is dropped again.
//
// Two kinds of target server, each with its own pg_restore:
//   - the local server of the host: root reads the dump (pg_restore -f -, no connection) and pipes the SQL to
//     psql run as postgres (the mount is readable by root only). Nothing is copied; no parallel restore.
//   - a PostgreSQL container: a throwaway container of the SAME image (its pg_restore, the version of the server,
//     nothing to install) gets the mounted dump read-only and the network of the target container, and restores
//     with -j over 127.0.0.1 (trust in the official images; a password otherwise). Nothing is copied, and a forged
//     dump stays confined in that container.

// pgTarget: the server a restore talks to, and how its tools are run.
type pgTarget struct {
	container string   // empty: the local server
	user      string   // container: superuser of the server
	image     string   // container: image id of the target container (sha256:...)
	password  bool     // container: PGPASSWORD is in env, passed by name only (-e PGPASSWORD)
	env       []string // of the commands
}

var (
	pgUserRe    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]{0,62}$`)
	imageIDRe   = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	pgImageRe   = regexp.MustCompile(`(^|/)(postgres|postgis|timescaledb)(:|@|$)`)
	pgImageSkip = regexp.MustCompile(`(timescaledb-ha|bitnami)`)
)

// cmd: a PostgreSQL client tool run against the target (createdb, dropdb, psql).
func (t *pgTarget) cmd(tool string, args ...string) (string, []string) {
	if t.container == "" {
		return "runuser", append([]string{"-u", "postgres", "--", tool}, args...)
	}
	a := []string{"exec"}
	if t.password {
		a = append(a, "-e", "PGPASSWORD")
	}
	a = append(a, t.container, tool, "-h", "127.0.0.1", "-U", t.user)
	return "docker", append(a, args...)
}

func (t *pgTarget) query(ctx context.Context, sql string) ([]byte, error) {
	name, args := t.cmd("psql", "-AtX", "--no-password", "-d", "postgres", "-c", sql)
	return dumpOutput(ctx, t.env, name, args...)
}

func (t *pgTarget) step(ctx context.Context, emit func(string), tool string, args ...string) error {
	name, a := t.cmd(tool, args...)
	return runDumpStep(ctx, t.env, emit, name, a...)
}

func (t *pgTarget) label() string {
	if t.container == "" {
		return "serveur local"
	}
	return "conteneur " + t.container
}

// pgTools: the tools the restore runs on the host for the local server, as the dump does.
func pgTools() error {
	for _, tool := range []string{"pg_restore", "createdb", "dropdb", "psql", "runuser"} {
		if _, err := lookPath(tool); err != nil {
			return fmt.Errorf("%s introuvable sur cet hôte", tool)
		}
	}
	return nil
}

// seams for the tests
var (
	lookPath  = exec.LookPath
	pgRunning = postgresRunning
)

// newPgTarget: the local server (no container) or a running PostgreSQL container, checked.
func newPgTarget(ctx context.Context, p *DatabaseDump) (*pgTarget, error) {
	env := append(os.Environ(), "LC_ALL=C", "PGAPPNAME=homelab-agent")
	if p.Container == "" {
		if !pgRunning() {
			return nil, errors.New("aucun serveur PostgreSQL local")
		}
		if err := pgTools(); err != nil {
			return nil, err
		}
		_, _, home, err := lookupPostgres()
		if err != nil {
			return nil, err
		}
		return &pgTarget{env: append(env, "HOME="+home)}, nil
	}
	if !dockerUsable(ctx) {
		return nil, errors.New("Docker indisponible sur cet hôte")
	}
	state, err := dumpOutput(ctx, env, "docker", "inspect", "-f", "{{.State.Running}} {{.Image}}", p.Container)
	if err != nil {
		return nil, fmt.Errorf("conteneur %s introuvable", p.Container)
	}
	f := strings.Fields(string(state))
	if len(f) != 2 || f[0] != "true" {
		return nil, fmt.Errorf("conteneur %s arrêté", p.Container)
	}
	if !imageIDRe.MatchString(f[1]) {
		return nil, fmt.Errorf("image du conteneur %s illisible", p.Container)
	}
	user := p.Username
	if user == "" {
		user = "postgres"
		vars, err := dumpOutput(ctx, env, "docker", "inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", p.Container)
		if err == nil {
			for _, l := range strings.Split(string(vars), "\n") {
				if v, ok := strings.CutPrefix(strings.TrimSpace(l), "POSTGRES_USER="); ok && v != "" {
					user = v
				}
			}
		}
	}
	if !pgUserRe.MatchString(user) {
		return nil, fmt.Errorf("utilisateur PostgreSQL du conteneur invalide : %q", user)
	}
	t := &pgTarget{container: p.Container, user: user, image: f[1], env: env}
	if p.Password != "" {
		t.password = true
		t.env = append(t.env, "PGPASSWORD="+p.Password)
	}
	return t, nil
}

// pgServerMajor: major version of the target server.
func pgServerMajor(ctx context.Context, t *pgTarget) (int, error) {
	out, err := t.query(ctx, "show server_version_num")
	if err != nil {
		return 0, err
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || n < 100000 {
		return 0, fmt.Errorf("version du serveur illisible : %q", strings.TrimSpace(string(out)))
	}
	return n / 10000, nil
}

// pgDatabases: databases of the target server with their size (the query of the dump listing).
func pgDatabases(ctx context.Context, t *pgTarget) ([]DatabaseInfo, error) {
	out, err := t.query(ctx, "select datname, pg_database_size(datname) from pg_database where datallowconn and not datistemplate order by 1")
	if err != nil {
		return nil, err
	}
	dbs := []DatabaseInfo{}
	for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		name, size, ok := strings.Cut(l, "|")
		if !ok {
			continue
		}
		n, _ := strconv.ParseInt(size, 10, 64)
		dbs = append(dbs, DatabaseInfo{Name: name, Size: n})
	}
	return dbs, nil
}

// pgDataFree: free space where the server keeps its data (-1: unknown).
func pgDataFree(ctx context.Context, t *pgTarget) int64 {
	out, err := t.query(ctx, "show data_directory")
	if err != nil {
		return -1
	}
	dir := strings.TrimSpace(string(out))
	if !filepath.IsAbs(dir) {
		return -1
	}
	if t.container == "" {
		return freeSpace(dir)
	}
	return containerFree(ctx, t.container, dir)
}

// hasExactDatabase: PostgreSQL names are case sensitive.
func hasExactDatabase(dbs []DatabaseInfo, name string) bool {
	for _, d := range dbs {
		if d.Name == name {
			return true
		}
	}
	return false
}

// pgCandidates: the servers a dump can go into: the local one, and the running PostgreSQL containers of an image
// whose tools and access are known (official postgres, postgis, timescale/timescaledb).
// localReason: why the local server is not offered ("" when it is, or when there is no local server at all).
func pgCandidates(ctx context.Context) (out []DbRestoreCandidate, localReason string) {
	out = []DbRestoreCandidate{}
	if t, err := newPgTarget(ctx, &DatabaseDump{}); err == nil {
		if major, err := pgServerMajor(ctx, t); err == nil {
			out = append(out, DbRestoreCandidate{Image: fmt.Sprintf("PostgreSQL %d (serveur local)", major)})
		} else {
			localReason = "serveur PostgreSQL local injoignable : " + err.Error()
		}
	} else if pgRunning() || pgInstalled() {
		// a server is there but cannot be used: say why rather than leave it out
		localReason = "serveur PostgreSQL local : " + err.Error()
	}
	if !dockerUsable(ctx) {
		return out, localReason
	}
	b, err := dumpOutput(ctx, nil, "docker", "ps", "--format", "{{.Names}}\t{{.Image}}")
	if err != nil {
		return out, localReason
	}
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		name, image, ok := strings.Cut(l, "\t")
		if !ok || !containerRe.MatchString(name) || !pgImageRe.MatchString(strings.ToLower(image)) || pgImageSkip.MatchString(strings.ToLower(image)) {
			continue
		}
		t, err := newPgTarget(ctx, &DatabaseDump{Container: name})
		if err != nil {
			continue
		}
		// without a password: trust over 127.0.0.1, as in the official images; else credentials to give
		if major, err := pgServerMajor(ctx, t); err == nil {
			out = append(out, DbRestoreCandidate{Container: name, Image: fmt.Sprintf("PostgreSQL %d · %s", major, image)})
		} else {
			out = append(out, DbRestoreCandidate{Container: name, Image: image, NeedsAuth: true})
		}
	}
	return out, localReason
}

// pgInstalled: a PostgreSQL server package is on the host, whether its socket was found or not.
var pgInstalled = func() bool {
	m, _ := filepath.Glob("/usr/lib/postgresql/*/bin/postgres")
	return len(m) > 0
}

func checkPostgresRestore(ctx context.Context, p *DatabaseDump, target string) (*DbRestoreCheck, error) {
	if target == "" && p.Container == "" {
		// listing of the targets
		cands, reason := pgCandidates(ctx)
		return &DbRestoreCheck{Databases: []DatabaseInfo{}, Free: -1, FreeTmp: -1, Candidates: cands, LocalReason: reason}, nil
	}
	t, err := newPgTarget(ctx, p)
	if err != nil {
		return nil, err
	}
	major, err := pgServerMajor(ctx, t)
	if err != nil {
		return nil, mongoCommandError(err, "", p.Password)
	}
	dbs, err := pgDatabases(ctx, t)
	if err != nil {
		return nil, mongoCommandError(err, "", p.Password)
	}
	return &DbRestoreCheck{
		Tools:     fmt.Sprintf("PostgreSQL %d (%s)", major, t.label()),
		Databases: dbs,
		Exists:    target != "" && hasExactDatabase(dbs, target),
		Free:      pgDataFree(ctx, t),
		FreeTmp:   -1, // nothing is copied
	}, nil
}

// pgJobs: parallel jobs of pg_restore in a container, as many as the host has processors, four at most.
func pgJobs() int {
	return max(1, min(runtime.NumCPU(), 4))
}

var (
	pgDumpVersionRe = regexp.MustCompile(`(?m)^;\s*Dumped from database version:\s*(\d+)`)
	pgExtensionRe   = regexp.MustCompile(`(?m)\sEXTENSION - (\S+)`)
)

// pgDumpInfo: server major version the dump comes from and its extensions, read from its table of contents.
func pgDumpInfo(toc string) (major int, extensions []string) {
	if m := pgDumpVersionRe.FindStringSubmatch(toc); m != nil {
		major, _ = strconv.Atoi(m[1])
	}
	for _, m := range pgExtensionRe.FindAllStringSubmatch(toc, -1) {
		extensions = append(extensions, m[1])
	}
	return major, extensions
}

// pipeRun runs two commands, the output of the first being the input of the second; their messages go to emit.
// Seam for the tests.
var pipeRun = runPipe

func runPipe(ctx context.Context, env []string, emit func(string), first, second []string) error {
	src := exec.CommandContext(ctx, first[0], first[1:]...)
	dst := exec.CommandContext(ctx, second[0], second[1:]...)
	src.Env, dst.Env = env, env
	w := &lineWriter{emit: emit}
	src.Stderr, dst.Stderr, dst.Stdout = w, w, w
	// our own pipe: this process closes both ends once the children have them, so that the writer gets SIGPIPE
	// when the reader stops (an exec StdoutPipe keeps the read end open here until the writer is waited for)
	r, pw, err := os.Pipe()
	if err != nil {
		return err
	}
	src.Stdout, dst.Stdin = pw, r
	if err := dst.Start(); err != nil {
		_ = r.Close()
		_ = pw.Close()
		return fmt.Errorf("%s: %w", second[0], err)
	}
	_ = r.Close()
	if err := src.Start(); err != nil {
		_ = pw.Close()
		_ = dst.Wait()
		return fmt.Errorf("%s: %w", first[0], err)
	}
	_ = pw.Close()
	// both are waited for: the first one ending early closes the pipe of the second
	srcErr := src.Wait()
	dstErr := dst.Wait()
	w.flush()
	// the reader first: when it stops, the writer only dies of the broken pipe
	if dstErr != nil {
		return fmt.Errorf("%s a échoué : %w", second[0], dstErr)
	}
	if srcErr != nil {
		return fmt.Errorf("%s a échoué : %w", first[0], srcErr)
	}
	return nil
}

// lineWriter gives the lines written to it to emit.
type lineWriter struct {
	emit func(string)
	mu   sync.Mutex
	buf  strings.Builder
}

func (w *lineWriter) Write(b []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.buf.Write(b)
	for {
		s := w.buf.String()
		i := strings.IndexByte(s, '\n')
		if i < 0 {
			break
		}
		w.emit(s[:i+1])
		w.buf.Reset()
		w.buf.WriteString(s[i+1:])
	}
	return len(b), nil
}

func (w *lineWriter) flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.buf.Len() > 0 {
		w.emit(w.buf.String() + "\n")
		w.buf.Reset()
	}
}

// runPostgresRestore: the new database is created by this agent (createdb refuses an existing name), closed to
// PUBLIC while it is filled, and dropped again if the restore fails.
func runPostgresRestore(ctx context.Context, s *DbRestoreSpec, emit func(string)) error {
	emit = mongoSafeEmit(emit, s.Database.Password)
	mounts := restoreMountsOf(pbsMountRootFor(&PbsMountSpec{MountRoot: s.MountRoot}))
	if len(mounts) != 1 {
		return fmt.Errorf("expected exactly one mounted backup on this host, found %d", len(mounts))
	}
	dir := mounts[0]
	// the mount is the one of this dump: <type>-<id>_<date>_pg-<source> (pbsMountPath)
	if !strings.HasSuffix(filepath.Base(dir), "_pg-"+s.Source) {
		return fmt.Errorf("the backup mounted on this host (%s) is not the dump pg-%s", dir, s.Source)
	}
	if _, err := os.Stat(filepath.Join(dir, "toc.dat")); err != nil {
		return fmt.Errorf("%s does not look like a pg_dump directory (no toc.dat)", dir)
	}
	t, err := newPgTarget(ctx, s.Database)
	if err != nil {
		return err
	}
	// container: the dump is given read-only to a throwaway container (--mount: no separator in the path)
	bind := "type=bind,source=" + dir + ",target=/dump,readonly"
	if t.container != "" && strings.ContainsAny(dir, ",=\"") {
		return fmt.Errorf("chemin du montage inutilisable par Docker : %s", dir)
	}

	major, err := pgServerMajor(ctx, t)
	if err != nil {
		return err
	}
	emit(fmt.Sprintf("serveur PostgreSQL %d (%s), cible %s\n", major, t.label(), s.Target))
	dbs, err := pgDatabases(ctx, t)
	if err != nil {
		return err
	}
	if hasExactDatabase(dbs, s.Target) {
		return fmt.Errorf("la base %q existe deja : rien n'est ecrase", s.Target)
	}

	// refused before anything is created: version and extensions of the dump, read without any connection
	var toc []byte
	if t.container == "" {
		toc, err = dumpOutput(ctx, t.env, "pg_restore", "-l", dir)
	} else {
		toc, err = dumpOutput(ctx, t.env, "docker", "run", "--rm", "--network", "none", "--mount", bind, "--entrypoint", "pg_restore", t.image, "-l", "/dump")
	}
	if err != nil {
		return fmt.Errorf("lecture du dump : %w", err)
	}
	dumpMajor, exts := pgDumpInfo(string(toc))
	if dumpMajor == 0 {
		return errors.New("version du serveur d'origine illisible dans le dump : restauration refusee")
	}
	if dumpMajor > major {
		return fmt.Errorf("le dump vient d'un serveur PostgreSQL %d, plus recent que la cible (%d)", dumpMajor, major)
	}
	for _, e := range exts {
		if e == "timescaledb" {
			return errors.New("le dump utilise TimescaleDB : sa restauration demande une procedure dediee, non prise en charge")
		}
	}
	if len(exts) > 0 {
		out, err := t.query(ctx, "select name from pg_available_extensions")
		if err != nil {
			return err
		}
		have := map[string]bool{}
		for _, l := range strings.Fields(string(out)) {
			have[l] = true
		}
		var missing []string
		for _, e := range exts {
			if !have[e] {
				missing = append(missing, e)
			}
		}
		if len(missing) > 0 {
			return fmt.Errorf("extensions du dump absentes de la cible : %s", strings.Join(missing, ", "))
		}
	}

	// createdb refuses an existing name: nothing can be overwritten, even if the name appeared meanwhile.
	// template0: a clean base, whatever was added to template1.
	if err := t.step(ctx, emit, "createdb", "--no-password", "-T", "template0", s.Target); err != nil {
		return err
	}
	// from here the database is this agent's: dropped again on failure
	drop := func() {
		cctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if derr := t.step(cctx, emit, "dropdb", "--if-exists", "--no-password", s.Target); derr != nil {
			emit(fmt.Sprintf("echec : la base %q n'a pas pu etre supprimee, a supprimer a la main avant de recommencer\n", s.Target))
		} else {
			emit(fmt.Sprintf("echec : la base %q creee pour la restauration a ete supprimee\n", s.Target))
		}
	}
	// the objects belong to the superuser here: nobody else may connect while they are restored (the name is validated)
	if err := t.step(ctx, emit, "psql", "-X", "--no-password", "-d", "postgres", "-c", `REVOKE CONNECT, TEMPORARY ON DATABASE "`+s.Target+`" FROM PUBLIC`); err != nil {
		drop()
		return err
	}
	emit(fmt.Sprintf("restauration %s -> %s…\n", s.Source, s.Target))
	flags := []string{"--no-owner", "--no-privileges", "--no-tablespaces", "--no-subscriptions"}
	if t.container == "" {
		first := append(append([]string{"pg_restore", "-f", "-"}, flags...), dir)
		second := append([]string{"runuser"}, "-u", "postgres", "--", "psql", "-X", "-q", "--no-password", "-v", "ON_ERROR_STOP=1", "-d", s.Target)
		emit(strings.Join(first, " ") + " | " + strings.Join(second, " ") + "\n")
		err = pipeRun(ctx, t.env, emit, first, second)
	} else {
		// named: one left behind by an agent stopped mid-restore is removed first
		name := "hlm-restore-" + s.Target
		_, _ = dumpOutput(ctx, t.env, "docker", "rm", "-f", name)
		args := []string{"run", "--rm", "--name", name, "--network", "container:" + t.container, "--mount", bind}
		if t.password {
			args = append(args, "-e", "PGPASSWORD")
		}
		args = append(args, "--entrypoint", "pg_restore", t.image, "-h", "127.0.0.1", "-U", t.user, "-j", strconv.Itoa(pgJobs()))
		args = append(append(args, flags...), "--exit-on-error", "--no-password", "-d", s.Target, "/dump")
		err = runDumpStep(ctx, t.env, emit, "docker", args...)
	}
	if err != nil {
		drop()
		return err
	}
	dbs, err = pgDatabases(ctx, t)
	if err != nil {
		return fmt.Errorf("verification apres restauration : %w", err)
	}
	for _, d := range dbs {
		if d.Name == s.Target {
			emit(fmt.Sprintf("base %s restauree (%d octets sur disque)\n", s.Target, d.Size))
			return nil
		}
	}
	return fmt.Errorf("la base %q est absente apres la restauration", s.Target)
}
