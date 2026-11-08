//go:build !windows

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const tocPlain = "; Archive created at 2026-11-08\n; Dumped from database version: 16.4 (Debian)\n; Dumped by pg_dump version: 16.4\n4; 3079 16385 EXTENSION - pgcrypto\n"

// home of the postgres user of the fake server (fakeDump sets its own, afterwards)
var pgTestHome string

func fakePgUser() {
	lookupPostgres = func() (int, int, string, error) { return os.Getuid(), os.Getgid(), pgTestHome, nil }
}

// fakePg: the local server answers the queries of the restore; tables and calls are recorded by fakeDump.
func fakePg(t *testing.T, serverNum string, databases string, toc string, available string) {
	t.Helper()
	oldOut, oldLook, oldRun, oldLookup := dumpOutput, lookPath, pgRunning, lookupPostgres
	home := t.TempDir()
	pgTestHome = home
	fakePgUser()
	lookPath = func(string) (string, error) { return "/usr/bin/x", nil }
	pgRunning = func() bool { return true }
	dumpOutput = func(_ context.Context, _ []string, name string, args ...string) ([]byte, error) {
		cmd := name + " " + strings.Join(args, " ")
		switch {
		case strings.Contains(cmd, "server_version_num"):
			return []byte(serverNum + "\n"), nil
		case strings.Contains(cmd, "pg_database_size"):
			return []byte(databases), nil
		case strings.Contains(cmd, "data_directory"):
			return []byte(home + "\n"), nil
		case strings.Contains(cmd, "pg_restore -l"):
			return []byte(toc), nil
		case strings.Contains(cmd, "pg_available_extensions"):
			return []byte(available), nil
		}
		return nil, errors.New("unexpected " + cmd)
	}
	t.Cleanup(func() { dumpOutput, lookPath, pgRunning, lookupPostgres = oldOut, oldLook, oldRun, oldLookup })
}

func pgSpec() *DbRestoreSpec {
	return &DbRestoreSpec{Kind: "postgres", Database: &DatabaseDump{}, Source: "nextcloud", Target: "nextcloud_copy"}
}

func pgMount(t *testing.T) string {
	t.Helper()
	dump := filepath.Join(t.TempDir(), "host-vm_2026-10-19_02-30-00_pg-nextcloud")
	if err := os.MkdirAll(dump, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dump, "toc.dat"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	fakeRestoreMounts(t, dump)
	return dump
}

func TestCheckPostgresRestore(t *testing.T) {
	fakePg(t, "160004", "postgres|8000000\nnextcloud|120000000\n", "", "")
	ctx := context.Background()
	// listing of the targets: the local server
	r, err := checkDbRestore(ctx, "postgres", &DatabaseDump{}, "")
	if err != nil || len(r.Candidates) != 1 || r.Candidates[0].Container != "postgresql" || !strings.Contains(r.Candidates[0].Image, "PostgreSQL 16") {
		t.Fatalf("listing: %v %+v", err, r)
	}
	r, err = checkDbRestore(ctx, "postgres", &DatabaseDump{}, "nextcloud_copy")
	if err != nil || r.Exists || len(r.Databases) != 2 || r.Free <= 0 || r.FreeTmp <= 0 {
		t.Fatalf("check: %v %+v", err, r)
	}
	// names are case sensitive in PostgreSQL
	if r, _ = checkDbRestore(ctx, "postgres", &DatabaseDump{}, "nextcloud"); !r.Exists {
		t.Error("existing name not seen")
	}
	if r, _ = checkDbRestore(ctx, "postgres", &DatabaseDump{}, "NEXTCLOUD"); r.Exists {
		t.Error("PostgreSQL names are case sensitive")
	}
	for _, bad := range []string{"postgres", "template0", "template1", "a b", "x;y"} {
		if _, err := checkDbRestore(ctx, "postgres", &DatabaseDump{}, bad); err == nil {
			t.Errorf("name %q accepted", bad)
		}
	}
	if _, err := checkDbRestore(ctx, "postgres", &DatabaseDump{Container: "x"}, "ok"); err == nil {
		t.Error("a container for the local server accepted")
	}
}

func TestRunPostgresRestore(t *testing.T) {
	dump := pgMount(t)
	fakePg(t, "160004", "postgres|8000000\nnextcloud|120000000\n", tocPlain, "pgcrypto\nplpgsql\n")
	calls := fakeDump(t, "")
	fakePgUser()
	if err := runDbRestore(context.Background(), pgSpec(), func(string) {}); err != nil {
		// the new database is listed after the restore: not in this fake, so only that last step may fail
		if !strings.Contains(err.Error(), "absente apres") {
			t.Fatal(err)
		}
	}
	var seq []string
	for _, c := range *calls {
		seq = append(seq, c.name+" "+c.args)
	}
	joined := strings.Join(seq, "\n")
	for _, want := range []string{
		"cp -r " + dump + "/.",
		"chown -R",
		"runuser -u postgres -- createdb --no-password nextcloud_copy",
		"-Fd -j",
		"--no-owner --no-privileges --exit-on-error --no-password -d nextcloud_copy",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in:\n%s", want, joined)
		}
	}
	if strings.Contains(joined, "dropdb") {
		t.Error("dropped after a restore that went through")
	}
	// createdb comes before pg_restore, and the data is never restored with the owners nor with the roles
	if strings.Index(joined, "createdb") > strings.Index(joined, "pg_restore") {
		t.Error("restore before the creation")
	}
}

func TestRunPostgresRestoreRefusals(t *testing.T) {
	ctx := context.Background()
	run := func(s *DbRestoreSpec) (error, string) {
		calls := fakeDump(t, "")
		fakePgUser()
		err := runDbRestore(ctx, s, func(string) {})
		var seq []string
		for _, c := range *calls {
			seq = append(seq, c.name+" "+c.args)
		}
		return err, strings.Join(seq, "\n")
	}
	// the name is taken: nothing is copied nor created
	pgMount(t)
	fakePg(t, "160004", "nextcloud|1\nnextcloud_copy|1\n", tocPlain, "pgcrypto\n")
	if err, calls := run(pgSpec()); err == nil || !strings.Contains(err.Error(), "existe deja") || strings.Contains(calls, "createdb") || strings.Contains(calls, "cp -r") {
		t.Fatalf("name taken: %v\n%s", err, calls)
	}
	// dump from a newer server
	pgMount(t)
	fakePg(t, "140010", "nextcloud|1\n", tocPlain, "pgcrypto\n")
	if err, calls := run(pgSpec()); err == nil || !strings.Contains(err.Error(), "plus recent") || strings.Contains(calls, "createdb") {
		t.Fatalf("newer dump: %v\n%s", err, calls)
	}
	// extension missing on the target
	pgMount(t)
	fakePg(t, "160004", "nextcloud|1\n", tocPlain, "plpgsql\n")
	if err, calls := run(pgSpec()); err == nil || !strings.Contains(err.Error(), "pgcrypto") || strings.Contains(calls, "createdb") {
		t.Fatalf("missing extension: %v\n%s", err, calls)
	}
	// TimescaleDB is refused
	pgMount(t)
	fakePg(t, "160004", "nextcloud|1\n", tocPlain+"5; 3079 16390 EXTENSION - timescaledb\n", "pgcrypto\ntimescaledb\n")
	if err, calls := run(pgSpec()); err == nil || !strings.Contains(err.Error(), "TimescaleDB") || strings.Contains(calls, "createdb") {
		t.Fatalf("timescaledb: %v\n%s", err, calls)
	}
	// another dump is mounted / not a pg_dump directory
	fakeRestoreMounts(t, filepath.Join(t.TempDir(), "host-vm_2026-10-19_02-30-00_pg-autre"))
	fakePg(t, "160004", "nextcloud|1\n", tocPlain, "pgcrypto\n")
	if err, _ := run(pgSpec()); err == nil || !strings.Contains(err.Error(), "not the dump") {
		t.Fatalf("wrong mount: %v", err)
	}
	empty := filepath.Join(t.TempDir(), "host-vm_2026-10-19_02-30-00_pg-nextcloud")
	if err := os.MkdirAll(empty, 0o700); err != nil {
		t.Fatal(err)
	}
	fakeRestoreMounts(t, empty)
	if err, _ := run(pgSpec()); err == nil || !strings.Contains(err.Error(), "toc.dat") {
		t.Fatalf("not a dump: %v", err)
	}
	// the target may not be a system database; the source may be called postgres
	pgMount(t)
	bad := pgSpec()
	bad.Target = "template1"
	if err, _ := run(bad); err == nil {
		t.Error("system database as a target")
	}
}

func TestRunPostgresRestoreFailureDropsWhatItCreated(t *testing.T) {
	pgMount(t)
	fakePg(t, "160004", "nextcloud|1\n", tocPlain, "pgcrypto\n")
	calls := fakeDump(t, "pg_restore -Fd")
	fakePgUser()
	var log strings.Builder
	err := runDbRestore(context.Background(), pgSpec(), func(s string) { log.WriteString(s) })
	if err == nil {
		t.Fatal("failure not reported")
	}
	var seq []string
	for _, c := range *calls {
		seq = append(seq, c.name+" "+c.args)
	}
	joined := strings.Join(seq, "\n")
	if !strings.Contains(joined, "dropdb --if-exists --no-password nextcloud_copy") {
		t.Fatalf("created database left behind:\n%s", joined)
	}
	if !strings.Contains(log.String(), "supprimee") {
		t.Errorf("log = %q", log.String())
	}
}

func TestPgDumpInfo(t *testing.T) {
	major, exts := pgDumpInfo(tocPlain + "9; 3079 1 EXTENSION - postgis\n")
	if major != 16 || strings.Join(exts, ",") != "pgcrypto,postgis" {
		t.Fatalf("info = %d %v", major, exts)
	}
}
