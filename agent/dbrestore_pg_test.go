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

// fakePg: the local server answers the queries of the restore. databases is read at each listing.
func fakePg(t *testing.T, serverNum string, databases func() string, toc string, available string) {
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
			return []byte(databases()), nil
		case strings.Contains(cmd, "data_directory"):
			return []byte(home + "\n"), nil
		case strings.HasPrefix(cmd, "pg_restore -l"):
			return []byte(toc), nil
		case strings.Contains(cmd, "pg_available_extensions"):
			return []byte(available), nil
		}
		return nil, errors.New("unexpected " + cmd)
	}
	t.Cleanup(func() { dumpOutput, lookPath, pgRunning, lookupPostgres = oldOut, oldLook, oldRun, oldLookup })
}

func static(s string) func() string { return func() string { return s } }

// fakePipe records the pipeline of the restore; fail makes it fail.
func fakePipe(t *testing.T, fail bool) *[]string {
	t.Helper()
	var got []string
	old := pipeRun
	pipeRun = func(_ context.Context, _ []string, _ func(string), first, second []string) error {
		got = append(got, strings.Join(first, " ")+" | "+strings.Join(second, " "))
		if fail {
			return errors.New("psql a échoué")
		}
		return nil
	}
	t.Cleanup(func() { pipeRun = old })
	return &got
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

func calls2s(calls *[]dumpCall) string {
	var seq []string
	for _, c := range *calls {
		seq = append(seq, c.name+" "+c.args)
	}
	return strings.Join(seq, "\n")
}

func TestCheckPostgresRestore(t *testing.T) {
	fakePg(t, "160004", static("postgres|8000000\nnextcloud|120000000\n"), "", "")
	ctx := context.Background()
	// listing of the targets: the local server
	r, err := checkDbRestore(ctx, "postgres", &DatabaseDump{}, "")
	if err != nil || len(r.Candidates) != 1 || r.Candidates[0].Container != "postgresql" || !strings.Contains(r.Candidates[0].Image, "PostgreSQL 16") {
		t.Fatalf("listing: %v %+v", err, r)
	}
	r, err = checkDbRestore(ctx, "postgres", &DatabaseDump{}, "nextcloud_copy")
	if err != nil || r.Exists || len(r.Databases) != 2 || r.Free <= 0 || r.FreeTmp != -1 {
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
	var calls *[]dumpCall
	created := func() bool { return calls != nil && strings.Contains(calls2s(calls), "createdb") }
	fakePg(t, "160004", func() string {
		if created() {
			return "postgres|1\nnextcloud|1\nnextcloud_copy|5000\n"
		}
		return "postgres|1\nnextcloud|1\n"
	}, tocPlain, "pgcrypto\nplpgsql\n")
	calls = fakeDump(t, "")
	fakePgUser()
	pipe := fakePipe(t, false)
	var log strings.Builder
	if err := runDbRestore(context.Background(), pgSpec(), func(s string) { log.WriteString(s) }); err != nil {
		t.Fatal(err)
	}
	joined := calls2s(calls)
	for _, want := range []string{
		"runuser -u postgres -- createdb --no-password -T template0 nextcloud_copy",
		`REVOKE CONNECT, TEMPORARY ON DATABASE "nextcloud_copy" FROM PUBLIC`,
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in:\n%s", want, joined)
		}
	}
	// nothing is copied nor given to postgres; nothing is dropped after a restore that went through
	for _, never := range []string{"cp ", "chown", "dropdb"} {
		if strings.Contains(joined, never) {
			t.Errorf("%q run:\n%s", never, joined)
		}
	}
	// the dump is read by root and piped, without owners, privileges, tablespaces nor subscriptions
	if len(*pipe) != 1 {
		t.Fatalf("pipeline = %v", *pipe)
	}
	for _, want := range []string{
		"pg_restore -f - --no-owner --no-privileges --no-tablespaces --no-subscriptions " + dump,
		"runuser -u postgres -- psql -X -q --no-password -v ON_ERROR_STOP=1 -d nextcloud_copy",
	} {
		if !strings.Contains((*pipe)[0], want) {
			t.Errorf("pipeline lacks %q: %s", want, (*pipe)[0])
		}
	}
	// the database is closed to the others before it is filled
	if strings.Index(joined, "REVOKE") < strings.Index(joined, "createdb") {
		t.Error("closed before created")
	}
	if !strings.Contains(log.String(), "restauree") {
		t.Errorf("log = %q", log.String())
	}
}

func TestRunPostgresRestoreRefusals(t *testing.T) {
	ctx := context.Background()
	run := func(s *DbRestoreSpec) (error, string, *[]string) {
		calls := fakeDump(t, "")
		fakePgUser()
		pipe := fakePipe(t, false)
		err := runDbRestore(ctx, s, func(string) {})
		return err, calls2s(calls), pipe
	}
	refused := func(err error, calls string, pipe *[]string, msg string) {
		t.Helper()
		if err == nil || !strings.Contains(err.Error(), msg) || strings.Contains(calls, "createdb") || len(*pipe) != 0 {
			t.Fatalf("want a refusal %q before anything is created: %v\n%s", msg, err, calls)
		}
	}
	// the name is taken
	pgMount(t)
	fakePg(t, "160004", static("nextcloud|1\nnextcloud_copy|1\n"), tocPlain, "pgcrypto\n")
	err, calls, pipe := run(pgSpec())
	refused(err, calls, pipe, "existe deja")
	// dump from a newer server
	pgMount(t)
	fakePg(t, "140010", static("nextcloud|1\n"), tocPlain, "pgcrypto\n")
	err, calls, pipe = run(pgSpec())
	refused(err, calls, pipe, "plus recent")
	// version of the dump unreadable: refused, not skipped
	pgMount(t)
	fakePg(t, "160004", static("nextcloud|1\n"), "; no header here\n", "pgcrypto\n")
	err, calls, pipe = run(pgSpec())
	refused(err, calls, pipe, "illisible")
	// extension missing on the target
	pgMount(t)
	fakePg(t, "160004", static("nextcloud|1\n"), tocPlain, "plpgsql\n")
	err, calls, pipe = run(pgSpec())
	refused(err, calls, pipe, "pgcrypto")
	// TimescaleDB is refused
	pgMount(t)
	fakePg(t, "160004", static("nextcloud|1\n"), tocPlain+"5; 3079 16390 EXTENSION - timescaledb\n", "pgcrypto\ntimescaledb\n")
	err, calls, pipe = run(pgSpec())
	refused(err, calls, pipe, "TimescaleDB")
	// another dump is mounted / not a pg_dump directory
	fakeRestoreMounts(t, filepath.Join(t.TempDir(), "host-vm_2026-10-19_02-30-00_pg-autre"))
	fakePg(t, "160004", static("nextcloud|1\n"), tocPlain, "pgcrypto\n")
	err, calls, pipe = run(pgSpec())
	refused(err, calls, pipe, "not the dump")
	empty := filepath.Join(t.TempDir(), "host-vm_2026-10-19_02-30-00_pg-nextcloud")
	if err := os.MkdirAll(empty, 0o700); err != nil {
		t.Fatal(err)
	}
	fakeRestoreMounts(t, empty)
	err, calls, pipe = run(pgSpec())
	refused(err, calls, pipe, "toc.dat")
	// the target may not be a system database
	pgMount(t)
	bad := pgSpec()
	bad.Target = "template1"
	err, calls, pipe = run(bad)
	refused(err, calls, pipe, "invalid database name")
}

func TestRunPostgresRestoreDropsOnlyWhatItCreated(t *testing.T) {
	// createdb fails (the name exists): nothing to drop, nothing restored
	pgMount(t)
	fakePg(t, "160004", static("nextcloud|1\n"), tocPlain, "pgcrypto\n")
	calls := fakeDump(t, "createdb")
	fakePgUser()
	pipe := fakePipe(t, false)
	if err := runDbRestore(context.Background(), pgSpec(), func(string) {}); err == nil {
		t.Fatal("createdb failure not reported")
	}
	if strings.Contains(calls2s(calls), "dropdb") || len(*pipe) != 0 {
		t.Fatalf("a database that this agent did not create was touched:\n%s", calls2s(calls))
	}

	// the restore fails after the creation: dropped
	for name, failing := range map[string]string{"restore": "", "close": "REVOKE"} {
		pgMount(t)
		fakePg(t, "160004", static("nextcloud|1\n"), tocPlain, "pgcrypto\n")
		calls = fakeDump(t, failing)
		fakePgUser()
		pipe = fakePipe(t, failing == "")
		var log strings.Builder
		if err := runDbRestore(context.Background(), pgSpec(), func(s string) { log.WriteString(s) }); err == nil {
			t.Fatalf("%s: failure not reported", name)
		}
		if !strings.Contains(calls2s(calls), "dropdb --if-exists --no-password nextcloud_copy") {
			t.Fatalf("%s: created database left behind:\n%s", name, calls2s(calls))
		}
		if !strings.Contains(log.String(), "supprimee") {
			t.Errorf("%s: log = %q", name, log.String())
		}
	}
}

func TestPgDumpInfo(t *testing.T) {
	major, exts := pgDumpInfo(tocPlain + "9; 3079 1 EXTENSION - postgis\n")
	if major != 16 || strings.Join(exts, ",") != "pgcrypto,postgis" {
		t.Fatalf("info = %d %v", major, exts)
	}
	if major, _ := pgDumpInfo("; nothing\n"); major != 0 {
		t.Fatalf("no header gives %d", major)
	}
}

func TestRunPipe(t *testing.T) {
	var got []string
	emit := func(s string) { got = append(got, s) }
	if err := runPipe(context.Background(), os.Environ(), emit, []string{"printf", "one\ntwo"}, []string{"cat"}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, "|") != "one\n|two\n" {
		t.Fatalf("lines = %q", got)
	}
	// the reader failing is the error reported, not the broken pipe of the writer
	err := runPipe(context.Background(), os.Environ(), func(string) {}, []string{"yes"}, []string{"sh", "-c", "head -c 10 >/dev/null; exit 3"})
	if err == nil || !strings.Contains(err.Error(), "sh a échoué") {
		t.Fatalf("reader failure: %v", err)
	}
	if err := runPipe(context.Background(), os.Environ(), func(string) {}, []string{"false"}, []string{"cat"}); err == nil || !strings.Contains(err.Error(), "false a échoué") {
		t.Fatalf("writer failure: %v", err)
	}
}
