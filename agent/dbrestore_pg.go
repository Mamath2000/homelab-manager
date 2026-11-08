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
	"strconv"
	"strings"
	"sync"
	"time"
)

// Restore of a PostgreSQL dump (pg-<base>, pg_dump -Fd) into a NEW database of the local server (#210), the
// same flow as MongoDB (dbrestore.go): nothing is overwritten (createdb itself refuses an existing name), the
// objects belong to the postgres user of the target (--no-owner --no-privileges: the roles of the dump are not
// needed), and a database this agent created and could not fill is dropped again.
//
// The mount of the PBS is readable by root only and the postgres user cannot read it: root reads the dump
// (pg_restore -f -, no connection) and pipes the SQL to psql run as postgres. Nothing is copied nor written to
// disk, no right is given to postgres on the dump; parallel restore (-j) is given up for that.

// pgDataDir: where the server keeps its data, to know the free space of the restore (-1: unknown).
func pgDataFree(ctx context.Context, env []string) int64 {
	out, err := dumpOutput(ctx, env, "runuser", "-u", "postgres", "--", "psql", "-AtX", "--no-password", "-d", "postgres", "-c", "show data_directory")
	if err != nil {
		return -1
	}
	dir := strings.TrimSpace(string(out))
	if !filepath.IsAbs(dir) {
		return -1
	}
	return freeSpace(dir)
}

// pgTools: the tools the restore runs, as the dump does.
func pgTools() error {
	for _, t := range []string{"pg_restore", "createdb", "dropdb", "psql", "runuser"} {
		if _, err := lookPath(t); err != nil {
			return fmt.Errorf("%s introuvable sur cet hôte", t)
		}
	}
	return nil
}

// seam for the tests
var lookPath = exec.LookPath

// pgServerMajor: major version of the local server.
func pgServerMajor(ctx context.Context, env []string) (int, error) {
	out, err := dumpOutput(ctx, env, "runuser", "-u", "postgres", "--", "psql", "-AtX", "--no-password", "-d", "postgres", "-c", "show server_version_num")
	if err != nil {
		return 0, err
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || n < 100000 {
		return 0, fmt.Errorf("version du serveur illisible : %q", strings.TrimSpace(string(out)))
	}
	return n / 10000, nil
}

// pgDatabases: databases of the local server with their size (the query of the dump listing, without its tools).
func pgDatabases(ctx context.Context, env []string) ([]DatabaseInfo, error) {
	out, err := dumpOutput(ctx, env, "runuser", "-u", "postgres", "--", "psql", "-AtX", "--no-password", "-d", "postgres", "-c",
		"select datname, pg_database_size(datname) from pg_database where datallowconn and not datistemplate order by 1")
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

// seam for the tests
var pgRunning = postgresRunning

// hasExactDatabase: PostgreSQL names are case sensitive.
func hasExactDatabase(dbs []DatabaseInfo, name string) bool {
	for _, d := range dbs {
		if d.Name == name {
			return true
		}
	}
	return false
}

func checkPostgresRestore(ctx context.Context, p *DatabaseDump, target string) (*DbRestoreCheck, error) {
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
	env := append(os.Environ(), "LC_ALL=C", "HOME="+home, "PGAPPNAME=homelab-agent")
	major, err := pgServerMajor(ctx, env)
	if err != nil {
		return nil, err
	}
	tools := fmt.Sprintf("PostgreSQL %d", major)
	if target == "" {
		// listing of the targets: the local server is the only one
		return &DbRestoreCheck{Tools: tools, Databases: []DatabaseInfo{}, Free: -1, FreeTmp: -1, Candidates: []DbRestoreCandidate{{Container: "postgresql", Image: tools + " (serveur local)"}}}, nil
	}
	dbs, err := pgDatabases(ctx, env)
	if err != nil {
		return nil, err
	}
	return &DbRestoreCheck{
		Tools:     tools,
		Databases: dbs,
		Exists:    hasExactDatabase(dbs, target),
		Free:      pgDataFree(ctx, env),
		FreeTmp:   -1, // nothing is copied
	}, nil
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
	if err := pgTools(); err != nil {
		return err
	}
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
	_, _, home, err := lookupPostgres()
	if err != nil {
		return err
	}
	env := append(os.Environ(), "LC_ALL=C", "HOME="+home, "PGAPPNAME=homelab-agent")
	as := func(args ...string) []string { return append([]string{"-u", "postgres", "--"}, args...) }

	major, err := pgServerMajor(ctx, env)
	if err != nil {
		return err
	}
	emit(fmt.Sprintf("serveur PostgreSQL %d, cible %s\n", major, s.Target))
	dbs, err := pgDatabases(ctx, env)
	if err != nil {
		return err
	}
	if hasExactDatabase(dbs, s.Target) {
		return fmt.Errorf("la base %q existe deja : rien n'est ecrase", s.Target)
	}

	// refused before anything is created: version and extensions of the dump (read by root, no connection)
	toc, err := dumpOutput(ctx, env, "pg_restore", "-l", dir)
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
		out, err := dumpOutput(ctx, env, "runuser", as("psql", "-AtX", "--no-password", "-d", "postgres", "-c", "select name from pg_available_extensions")...)
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
	if err := runDumpStep(ctx, env, emit, "runuser", as("createdb", "--no-password", "-T", "template0", s.Target)...); err != nil {
		return err
	}
	// from here the database is this agent's: dropped again on failure
	drop := func() {
		cctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if derr := runDumpStep(cctx, env, emit, "runuser", as("dropdb", "--if-exists", "--no-password", s.Target)...); derr != nil {
			emit(fmt.Sprintf("echec : la base %q n'a pas pu etre supprimee, a supprimer a la main avant de recommencer\n", s.Target))
		} else {
			emit(fmt.Sprintf("echec : la base %q creee pour la restauration a ete supprimee\n", s.Target))
		}
	}
	// the objects belong to postgres here: nobody else may connect while they are restored (the name is validated)
	if err := runDumpStep(ctx, env, emit, "runuser", as("psql", "-X", "--no-password", "-d", "postgres", "-c", `REVOKE CONNECT, TEMPORARY ON DATABASE "`+s.Target+`" FROM PUBLIC`)...); err != nil {
		drop()
		return err
	}
	emit(fmt.Sprintf("restauration %s -> %s…\n", s.Source, s.Target))
	first := []string{"pg_restore", "-f", "-", "--no-owner", "--no-privileges", "--no-tablespaces", "--no-subscriptions", dir}
	second := append([]string{"runuser"}, as("psql", "-X", "-q", "--no-password", "-v", "ON_ERROR_STOP=1", "-d", s.Target)...)
	emit(strings.Join(first, " ") + " | " + strings.Join(second, " ") + "\n")
	if err := pipeRun(ctx, env, emit, first, second); err != nil {
		drop()
		return err
	}
	dbs, err = pgDatabases(ctx, env)
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
