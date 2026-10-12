package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidatePrepare(t *testing.T) {
	ok := []BackupPrepare{
		{Type: "postgres", Mode: "databases", Databases: []string{"hass", "hass-jarsay"}, WorkDir: "/mnt/backup"},
		{Type: "postgres", Mode: "cluster", WorkDir: "/mnt/backup", Cleanup: true},
		{Type: "mongodb", Container: "homelab-manager-mongo", Databases: []string{"homelab"}, WorkDir: "/home/mamath/dumps"},
	}
	for i, p := range ok {
		if err := validatePrepare(&p); err != nil {
			t.Errorf("case %d: %v", i, err)
		}
	}
	bad := []BackupPrepare{
		{Type: "mysql", WorkDir: "/mnt/backup"},
		{Type: "postgres", Mode: "databases", WorkDir: "/mnt/backup"},                            // no database
		{Type: "postgres", Mode: "cluster", Databases: []string{"ltss"}, WorkDir: "/mnt/backup"}, // cluster: no list
		{Type: "postgres", Mode: "all", Databases: []string{"x"}, WorkDir: "/mnt/backup"},        // unknown mode
		{Type: "postgres", Mode: "databases", Databases: []string{"x"}, Container: "pg", WorkDir: "/mnt/backup"},
		{Type: "postgres", Mode: "databases", Databases: []string{"a;rm"}, WorkDir: "/mnt/backup"},   // name
		{Type: "postgres", Mode: "databases", Databases: []string{"-x"}, WorkDir: "/mnt/backup"},     // option
		{Type: "postgres", Mode: "databases", Databases: []string{"a", "a"}, WorkDir: "/mnt/backup"}, // twice
		{Type: "postgres", Mode: "cluster", WorkDir: "/mnt"},                                         // one level
		{Type: "postgres", Mode: "cluster", WorkDir: "/"},
		{Type: "postgres", Mode: "cluster", WorkDir: "mnt/backup"},
		{Type: "postgres", Mode: "cluster", WorkDir: "/mnt/../etc"},
		{Type: "postgres", Mode: "cluster", WorkDir: "/etc/backup"},
		{Type: "postgres", Mode: "cluster", WorkDir: "/mnt/a:b"},
		{Type: "mongodb", Databases: []string{"x"}, WorkDir: "/mnt/backup"},                   // no container
		{Type: "mongodb", Container: "-it", Databases: []string{"x"}, WorkDir: "/mnt/backup"}, // option as container
		{Type: "mongodb", Container: "mongo", WorkDir: "/mnt/backup"},                         // no database
		{Type: "mongodb", Container: "mongo", Mode: "cluster", Databases: []string{"x"}, WorkDir: "/mnt/backup"},
	}
	for i, p := range bad {
		if validatePrepare(&p) == nil {
			t.Errorf("bad case %d accepted", i)
		}
	}
}

func TestPreparedArchivesInSpec(t *testing.T) {
	s := testSpec()
	s.Jobs[0].Prepare = &BackupPrepare{Type: "postgres", Mode: "databases", Databases: []string{"hass"}, WorkDir: "/mnt/backup"}
	if err := validateBackupSpec(s); err != nil {
		t.Fatal(err)
	}
	got := strings.Join(backupArgs(s.Jobs[0]), " ")
	if !strings.Contains(got, "home.pxar:/home etc.pxar:/etc pg-globals.pxar:/mnt/backup/pg-globals pg-hass.pxar:/mnt/backup/pg-hass ") {
		t.Fatalf("args = %q", got)
	}
	// a job may hold only its dumps
	s.Jobs[0].Archives = nil
	if err := validateBackupSpec(s); err != nil {
		t.Fatal(err)
	}
	// an archive of the job may not take the name of a dump
	s.Jobs[0].Archives = []BackupArchive{{Name: "pg-hass", Path: "/srv"}}
	if validateBackupSpec(s) == nil {
		t.Fatal("archive name of a dump accepted")
	}
	s.Jobs[0].Archives = nil
	s.Jobs[0].Prepare.WorkDir = "/etc/x"
	if validateBackupSpec(s) == nil {
		t.Fatal("invalid preparation accepted")
	}
}

type prepCall struct {
	name string
	args string
	env  []string
}

func fakePrep(t *testing.T, fail string) *[]prepCall {
	t.Helper()
	calls := &[]prepCall{}
	oldRun, oldLookup := prepRun, lookupPostgres
	prepRun = func(_ context.Context, env []string, _ func(string), name string, args ...string) (int, error) {
		*calls = append(*calls, prepCall{name, strings.Join(args, " "), env})
		if fail != "" && strings.Contains(name+" "+strings.Join(args, " "), fail) {
			return 1, nil
		}
		return 0, nil
	}
	lookupPostgres = func() (int, int, string, error) { return os.Getuid(), os.Getgid(), "/var/lib/postgresql", nil }
	t.Cleanup(func() { prepRun, lookupPostgres = oldRun, oldLookup })
	return calls
}

func TestPreparePostgresDatabases(t *testing.T) {
	calls := fakePrep(t, "")
	work := filepath.Join(t.TempDir(), "backup")
	// a dump of yesterday is replaced, not mixed with the new one
	if err := os.MkdirAll(filepath.Join(work, "pg-hass"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(work, "pg-hass", "old.dat"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(work, 0o700); err != nil {
		t.Fatal(err)
	}
	p := &BackupPrepare{Type: "postgres", Mode: "databases", Databases: []string{"hass", "hass-jarsay"}, WorkDir: work}
	if err := prepareBackup(context.Background(), p, func(string) {}); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"-u postgres -- pg_dumpall --globals-only --no-password -f " + work + "/pg-globals/globals.sql",
		"-u postgres -- pg_dump -Fd -Z0 --no-password -f " + work + "/pg-hass hass",
		"-u postgres -- pg_dump -Fd -Z0 --no-password -f " + work + "/pg-hass-jarsay hass-jarsay",
	}
	if len(*calls) != len(want) {
		t.Fatalf("calls = %+v", *calls)
	}
	for i, c := range *calls {
		if c.name != "runuser" || c.args != want[i] {
			t.Errorf("call %d = %s %s", i, c.name, c.args)
		}
	}
	if !strings.Contains(strings.Join((*calls)[0].env, "\n"), "HOME=/var/lib/postgresql") {
		t.Error("HOME of postgres not set")
	}
	if _, err := os.Stat(filepath.Join(work, "pg-hass", "old.dat")); !os.IsNotExist(err) {
		t.Error("previous dump kept")
	}
	if fi, _ := os.Stat(work); fi.Mode().Perm()&0o001 == 0 {
		t.Error("postgres cannot traverse the work directory")
	}
	cleanupPrepared(p, func(string) {})
	for _, d := range []string{"pg-globals", "pg-hass", "pg-hass-jarsay"} {
		if _, err := os.Stat(filepath.Join(work, d)); !os.IsNotExist(err) {
			t.Errorf("%s not cleaned", d)
		}
	}
	if _, err := os.Stat(work); err != nil {
		t.Error("work directory removed")
	}
}

func TestPreparePostgresStopsAtFirstFailure(t *testing.T) {
	calls := fakePrep(t, "pg_dump -Fd -Z0 --no-password -f")
	p := &BackupPrepare{Type: "postgres", Mode: "databases", Databases: []string{"a", "b"}, WorkDir: filepath.Join(t.TempDir(), "w")}
	err := prepareBackup(context.Background(), p, func(string) {})
	if err == nil || !strings.Contains(err.Error(), "code 1") {
		t.Fatalf("err = %v", err)
	}
	if len(*calls) != 2 {
		t.Fatalf("%d calls: the dump of b ran after the failure of a", len(*calls))
	}
}

func TestPreparePostgresCluster(t *testing.T) {
	calls := fakePrep(t, "")
	work := filepath.Join(t.TempDir(), "w")
	p := &BackupPrepare{Type: "postgres", Mode: "cluster", WorkDir: work}
	if err := prepareBackup(context.Background(), p, func(string) {}); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || (*calls)[0].args != "-u postgres -- pg_basebackup -D "+work+"/pg-cluster -Fp -Xstream -c fast --no-password" {
		t.Fatalf("calls = %+v", *calls)
	}
}

func TestPrepareMongo(t *testing.T) {
	calls := fakePrep(t, "")
	work := filepath.Join(t.TempDir(), "w")
	p := &BackupPrepare{Type: "mongodb", Container: "mongo", Databases: []string{"canicoif"}, WorkDir: work}
	if err := prepareBackup(context.Background(), p, func(string) {}); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"exec mongo rm -rf /tmp/homelab-agent-dump",
		"exec mongo mongodump --db canicoif --out /tmp/homelab-agent-dump",
		"cp mongo:/tmp/homelab-agent-dump/canicoif/. " + work + "/mongo-canicoif",
		"exec mongo rm -rf /tmp/homelab-agent-dump",
	}
	if len(*calls) != len(want) {
		t.Fatalf("calls = %+v", *calls)
	}
	for i, c := range *calls {
		if c.name != "docker" || c.args != want[i] {
			t.Errorf("call %d = %s %s", i, c.name, c.args)
		}
	}
	// a failed dump still cleans the container
	calls = fakePrep(t, "mongodump")
	if err := prepareBackup(context.Background(), p, func(string) {}); err == nil {
		t.Fatal("failure not reported")
	}
	if last := (*calls)[len(*calls)-1]; last.args != "exec mongo rm -rf /tmp/homelab-agent-dump" {
		t.Fatalf("last call = %s", last.args)
	}
}
