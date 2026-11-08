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
	"time"
)

// Restore of a PostgreSQL dump (pg-<base>, pg_dump -Fd) into a NEW database of the local server (#210), the
// same flow as MongoDB (dbrestore.go): nothing is overwritten (createdb itself refuses an existing name), the
// objects belong to the postgres user of the target (--no-owner --no-privileges: the roles of the dump are not
// needed), and a database this agent created and could not fill is dropped again.
//
// The mount of the PBS is readable by root only, so the dump is first copied next to the data of the server,
// where the postgres user can read it: the free space of that volume is checked (a copy of the dump).

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
		FreeTmp:   freeSpace(home), // where the dump is copied
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

// pgJobs: parallel jobs of pg_restore, as many as the host has processors, four at most.
func pgJobs() int {
	n := runtime.NumCPU()
	if n > 4 {
		n = 4
	}
	if n < 1 {
		n = 1
	}
	return n
}

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
	uid, gid, home, err := lookupPostgres()
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

	// the dump goes where the postgres user can read it, removed at the end whatever happens
	work := filepath.Join(home, "hlm-restore-"+s.Target)
	size := dirSize(dir)
	if free := freeSpace(home); free >= 0 && size > 0 && free < size {
		return fmt.Errorf("place insuffisante pour copier le dump dans %s (%d octets libres, %d necessaires)", home, free, size)
	}
	if err := resetDir(work, uid, gid); err != nil {
		return err
	}
	defer func() {
		if err := os.RemoveAll(work); err != nil {
			emit(fmt.Sprintf("nettoyage de %s : %v\n", work, err))
		}
	}()
	emit("copie du dump pour l'utilisateur postgres…\n")
	if err := runDumpStep(ctx, env, emit, "cp", "-r", dir+"/.", work); err != nil {
		return err
	}
	if err := runDumpStep(ctx, env, emit, "chown", "-R", fmt.Sprintf("%d:%d", uid, gid), work); err != nil {
		return err
	}

	// refused before anything is created: version and extensions of the dump
	toc, err := dumpOutput(ctx, env, "runuser", as("pg_restore", "-l", work)...)
	if err != nil {
		return fmt.Errorf("lecture du dump : %w", err)
	}
	dumpMajor, exts := pgDumpInfo(string(toc))
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

	// createdb refuses an existing name: nothing can be overwritten, even if the name appeared meanwhile
	if err := runDumpStep(ctx, env, emit, "runuser", as("createdb", "--no-password", s.Target)...); err != nil {
		return err
	}
	emit(fmt.Sprintf("restauration %s -> %s (%d jobs)…\n", s.Source, s.Target, pgJobs()))
	if err := runDumpStep(ctx, env, emit, "runuser", as("pg_restore", "-Fd", "-j", strconv.Itoa(pgJobs()), "--no-owner", "--no-privileges", "--exit-on-error", "--no-password", "-d", s.Target, work)...); err != nil {
		// this agent created the database a moment ago: dropping it leaves nothing behind
		cctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if derr := runDumpStep(cctx, env, emit, "runuser", as("dropdb", "--if-exists", "--no-password", s.Target)...); derr != nil {
			emit(fmt.Sprintf("echec : la base %q n'a pas pu etre supprimee, a supprimer a la main avant de recommencer\n", s.Target))
		} else {
			emit(fmt.Sprintf("echec : la base %q creee pour la restauration a ete supprimee\n", s.Target))
		}
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
