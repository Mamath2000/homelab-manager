package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestValidateDatabase(t *testing.T) {
	type c struct {
		kind string
		d    DatabaseDump
	}
	ok := []c{
		{"postgres", DatabaseDump{Mode: "databases", Databases: []string{"hass", "hass-jarsay"}, WorkDir: "/mnt/backup"}},
		{"postgres", DatabaseDump{Mode: "cluster", WorkDir: "/mnt/backup", Keep: 3}},
		{"mongodb", DatabaseDump{Container: "homelab-manager-mongo", Databases: []string{"homelab"}, WorkDir: "/home/mamath/dumps", Keep: 0}},
	}
	for i, x := range ok {
		if err := validateDatabase(x.kind, &x.d); err != nil {
			t.Errorf("case %d: %v", i, err)
		}
	}
	bad := []c{
		{"mysql", DatabaseDump{WorkDir: "/mnt/backup"}},
		{"postgres", DatabaseDump{Mode: "databases", WorkDir: "/mnt/backup"}},                            // no database
		{"postgres", DatabaseDump{Mode: "cluster", Databases: []string{"ltss"}, WorkDir: "/mnt/backup"}}, // cluster: no list
		{"postgres", DatabaseDump{Mode: "all", Databases: []string{"x"}, WorkDir: "/mnt/backup"}},        // unknown mode
		{"postgres", DatabaseDump{Mode: "databases", Databases: []string{"x"}, Container: "pg", WorkDir: "/mnt/backup"}},
		{"postgres", DatabaseDump{Mode: "databases", Databases: []string{"a;rm"}, WorkDir: "/mnt/backup"}},   // name
		{"postgres", DatabaseDump{Mode: "databases", Databases: []string{"-x"}, WorkDir: "/mnt/backup"}},     // option
		{"postgres", DatabaseDump{Mode: "databases", Databases: []string{"a", "a"}, WorkDir: "/mnt/backup"}}, // twice
		{"postgres", DatabaseDump{Mode: "cluster", WorkDir: "/mnt"}},                                         // one level
		{"postgres", DatabaseDump{Mode: "cluster", WorkDir: "/"}},
		{"postgres", DatabaseDump{Mode: "cluster", WorkDir: "mnt/backup"}},
		{"postgres", DatabaseDump{Mode: "cluster", WorkDir: "/mnt/../etc"}},
		{"postgres", DatabaseDump{Mode: "cluster", WorkDir: "/etc/backup"}},
		{"postgres", DatabaseDump{Mode: "cluster", WorkDir: "/mnt/a:b"}},
		{"mongodb", DatabaseDump{Databases: []string{"x"}, WorkDir: "/mnt/backup"}},                   // no container
		{"mongodb", DatabaseDump{Container: "-it", Databases: []string{"x"}, WorkDir: "/mnt/backup"}}, // option as container
		{"mongodb", DatabaseDump{Container: "mongo", WorkDir: "/mnt/backup"}},                         // no database
		{"mongodb", DatabaseDump{Container: "mongo", Mode: "cluster", Databases: []string{"x"}, WorkDir: "/mnt/backup"}},
		{"postgres", DatabaseDump{Mode: "cluster", WorkDir: "/mnt/backup", Keep: -1}},
		{"postgres", DatabaseDump{Mode: "cluster", WorkDir: "/mnt/backup", Keep: 31}},
	}
	for i, x := range bad {
		if validateDatabase(x.kind, &x.d) == nil {
			t.Errorf("bad case %d accepted", i)
		}
	}
}

func TestDatabaseJobInSpec(t *testing.T) {
	s := testSpec()
	j := &s.Jobs[0]
	j.Kind, j.Archives, j.Excludes = "postgres", nil, nil
	j.Database = &DatabaseDump{Mode: "databases", Databases: []string{"hass"}, WorkDir: "/mnt/backup"}
	if err := validateBackupSpec(s); err != nil {
		t.Fatal(err)
	}
	got := strings.Join(backupArgs(*j), " ")
	if got != "backup pg-globals.pxar:/mnt/backup/pg-globals pg-hass.pxar:/mnt/backup/pg-hass --backup-type host --backup-id x4 --ns Hosts" {
		t.Fatalf("args = %q", got)
	}
	bad := []func(j *BackupJob){
		// a database job holds its dumps only
		func(j *BackupJob) { j.Archives = []BackupArchive{{Name: "home", Path: "/home"}} },
		func(j *BackupJob) { j.Excludes = []string{"x"} },
		func(j *BackupJob) { j.Database = nil },
		func(j *BackupJob) { j.Database.WorkDir = "/etc/x" },
		func(j *BackupJob) { j.Kind = "mysql" },
		// a directories job: no database settings
		func(j *BackupJob) {
			j.Kind = "directories"
			j.Archives = []BackupArchive{{Name: "home", Path: "/home"}}
		},
	}
	for i, f := range bad {
		s := testSpec()
		j := &s.Jobs[0]
		j.Kind, j.Archives, j.Excludes = "postgres", nil, nil
		j.Database = &DatabaseDump{Mode: "databases", Databases: []string{"hass"}, WorkDir: "/mnt/backup"}
		f(j)
		if validateBackupSpec(s) == nil {
			t.Errorf("case %d accepted", i)
		}
	}
}

type dumpCall struct {
	name string
	args string
	env  []string
}

func fakeDump(t *testing.T, fail string) *[]dumpCall {
	t.Helper()
	calls := &[]dumpCall{}
	oldRun, oldLookup := dumpRun, lookupPostgres
	dumpRun = func(_ context.Context, env []string, _ func(string), name string, args ...string) (int, error) {
		*calls = append(*calls, dumpCall{name, strings.Join(args, " "), env})
		if fail != "" && strings.Contains(name+" "+strings.Join(args, " "), fail) {
			return 1, nil
		}
		return 0, nil
	}
	lookupPostgres = func() (int, int, string, error) { return os.Getuid(), os.Getgid(), "/var/lib/postgresql", nil }
	t.Cleanup(func() { dumpRun, lookupPostgres = oldRun, oldLookup })
	return calls
}

func TestDumpPostgresDatabases(t *testing.T) {
	calls := fakeDump(t, "")
	// a parent closed to others, like /mnt/backup on ct-1007
	parent := filepath.Join(t.TempDir(), "mnt")
	work := filepath.Join(parent, "backup")
	// a dump of yesterday is replaced, not mixed with the new one
	if err := os.MkdirAll(filepath.Join(work, "pg-hass"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(work, "pg-hass", "old.dat"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{work, parent} {
		if err := os.Chmod(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	kind, p := "postgres", &DatabaseDump{Mode: "databases", Databases: []string{"hass", "hass-jarsay"}, WorkDir: work}
	if err := dumpDatabases(context.Background(), kind, p, func(string) {}); err != nil {
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
	for _, d := range []string{work, parent} {
		if fi, _ := os.Stat(d); fi.Mode().Perm() != 0o701 {
			t.Errorf("%s: mode %o, postgres cannot traverse it (or more than x was opened)", d, fi.Mode().Perm())
		}
	}
	finishDumps(kind, p, true, time.Now(), func(string) {})
	for _, d := range []string{"pg-globals", "pg-hass", "pg-hass-jarsay"} {
		if _, err := os.Stat(filepath.Join(work, d)); !os.IsNotExist(err) {
			t.Errorf("%s not cleaned", d)
		}
	}
	if _, err := os.Stat(work); err != nil {
		t.Error("work directory removed")
	}
}

func TestFinishDumpsKeepsTheLastRuns(t *testing.T) {
	work := filepath.Join(t.TempDir(), "w")
	kind, p := "mongodb", &DatabaseDump{Container: "mongo", Databases: []string{"db"}, WorkDir: work, Keep: 2}
	dump := filepath.Join(work, "mongo-db")
	at := time.Date(2026, 10, 13, 3, 0, 0, 0, time.Local)
	for day := 0; day < 3; day++ {
		if err := os.MkdirAll(dump, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dump, "x.bson"), []byte{byte(day)}, 0o600); err != nil {
			t.Fatal(err)
		}
		finishDumps(kind, p, true, at.AddDate(0, 0, day), func(string) {})
	}
	entries, _ := os.ReadDir(filepath.Join(work, "history"))
	var got []string
	for _, e := range entries {
		got = append(got, e.Name())
	}
	if strings.Join(got, " ") != "20261014-030000 20261015-030000" {
		t.Fatalf("history = %v", got)
	}
	if raw, _ := os.ReadFile(filepath.Join(work, "history", "20261015-030000", "mongo-db", "x.bson")); len(raw) != 1 || raw[0] != 2 {
		t.Fatal("last dump not kept")
	}
	if _, err := os.Stat(dump); !os.IsNotExist(err) {
		t.Fatal("dump left in place: the next run would mix with it")
	}
	// a failed dump: incomplete dump removed, history untouched
	if err := os.MkdirAll(dump, 0o700); err != nil {
		t.Fatal(err)
	}
	finishDumps(kind, p, false, at.AddDate(0, 0, 5), func(string) {})
	if _, err := os.Stat(dump); !os.IsNotExist(err) {
		t.Fatal("incomplete dump kept")
	}
	if entries, _ := os.ReadDir(filepath.Join(work, "history")); len(entries) != 2 {
		t.Fatal("history changed by a failed run")
	}
	// Keep 0: removed once sent, and the history goes
	p.Keep = 0
	if err := os.MkdirAll(dump, 0o700); err != nil {
		t.Fatal(err)
	}
	finishDumps(kind, p, true, at.AddDate(0, 0, 6), func(string) {})
	if entries, _ := os.ReadDir(filepath.Join(work, "history")); len(entries) != 0 {
		t.Fatalf("history kept with Keep 0: %d", len(entries))
	}
}

func fakeOutput(t *testing.T, answers map[string]string) {
	t.Helper()
	old := dumpOutput
	dumpOutput = func(_ context.Context, _ []string, name string, args ...string) ([]byte, error) {
		cmd := name + " " + strings.Join(args, " ")
		for k, v := range answers {
			if strings.Contains(cmd, k) {
				if v == "ERR" {
					return nil, errors.New(k + " failed")
				}
				return []byte(v), nil
			}
		}
		return nil, errors.New("unexpected " + cmd)
	}
	t.Cleanup(func() { dumpOutput = old })
}

func TestCheckMongo(t *testing.T) {
	fakeOutput(t, map[string]string{
		"inspect":             "true\n",
		"mongodump --version": "mongodump version: 100.10.0\ngit version: x\n",
		"mongosh":             `[{"name":"admin","size":40960},{"name":"canicoif","size":1.25e8}]` + "\n",
	})
	kind, p := "mongodb", &DatabaseDump{Container: "mongo", Databases: []string{"canicoif", "absent"}, WorkDir: t.TempDir() + "/w"}
	r, err := checkDatabaseOnHost(context.Background(), kind, p)
	if err != nil {
		t.Fatal(err)
	}
	if r.Tools != "mongodump version: 100.10.0" {
		t.Errorf("tools = %q", r.Tools)
	}
	if len(r.Databases) != 2 || r.Databases[1].Size != 125000000 || strings.Join(r.Missing, ",") != "absent" || r.Free <= 0 {
		t.Fatalf("check = %+v", r)
	}
	// listing before any database is chosen
	if r, err := checkDatabaseOnHost(context.Background(), kind, &DatabaseDump{Container: "mongo", WorkDir: p.WorkDir}); err != nil || len(r.Databases) != 2 || len(r.Missing) != 0 {
		t.Fatalf("listing: %v %+v", err, r)
	}
	if _, err := checkDatabaseOnHost(context.Background(), kind, &DatabaseDump{WorkDir: p.WorkDir}); err == nil {
		t.Fatal("listing without a container accepted")
	}
	// mongo before 6: no mongosh
	fakeOutput(t, map[string]string{"inspect": "true", "mongodump": "v", "mongosh": "ERR", "mongo --quiet": `[{"name":"x","size":1}]`})
	if r, err := checkDatabaseOnHost(context.Background(), kind, p); err != nil || r.Databases[0].Name != "x" {
		t.Fatalf("fallback: %v %+v", err, r)
	}
	fakeOutput(t, map[string]string{"inspect": "false"})
	if _, err := checkDatabaseOnHost(context.Background(), kind, p); err == nil || !strings.Contains(err.Error(), "arrêté") {
		t.Fatalf("stopped container: %v", err)
	}
}

func TestDumpSizes(t *testing.T) {
	fakeOutput(t, map[string]string{"inspect": "true", "mongodump": "v", "mongosh": `[{"name":"db","size":1000}]`})
	work := t.TempDir()
	kind, p := "mongodb", &DatabaseDump{Container: "mongo", Databases: []string{"db"}, WorkDir: work}
	if err := os.MkdirAll(filepath.Join(work, "mongo-db", "db"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(work, "mongo-db", "db", "c.bson"), make([]byte, 300), 0o600); err != nil {
		t.Fatal(err)
	}
	got := dumpSizes(context.Background(), kind, p)
	if len(got) != 1 || got[0].Database != "db" || got[0].DBSize != 1000 || got[0].DumpSize != 300 {
		t.Fatalf("sizes = %+v", got)
	}
}

func TestDumpPostgresStopsAtFirstFailure(t *testing.T) {
	calls := fakeDump(t, "pg_dump -Fd -Z0 --no-password -f")
	kind, p := "postgres", &DatabaseDump{Mode: "databases", Databases: []string{"a", "b"}, WorkDir: filepath.Join(t.TempDir(), "w")}
	err := dumpDatabases(context.Background(), kind, p, func(string) {})
	if err == nil || !strings.Contains(err.Error(), "code 1") {
		t.Fatalf("err = %v", err)
	}
	if len(*calls) != 2 {
		t.Fatalf("%d calls: the dump of b ran after the failure of a", len(*calls))
	}
}

func TestDumpPostgresCluster(t *testing.T) {
	calls := fakeDump(t, "")
	work := filepath.Join(t.TempDir(), "w")
	kind, p := "postgres", &DatabaseDump{Mode: "cluster", WorkDir: work}
	if err := dumpDatabases(context.Background(), kind, p, func(string) {}); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || (*calls)[0].args != "-u postgres -- pg_basebackup -D "+work+"/pg-cluster -Fp -Xstream -c fast --no-password" {
		t.Fatalf("calls = %+v", *calls)
	}
}

func TestDumpMongo(t *testing.T) {
	calls := fakeDump(t, "")
	work := filepath.Join(t.TempDir(), "w")
	kind, p := "mongodb", &DatabaseDump{Container: "mongo", Databases: []string{"canicoif"}, WorkDir: work}
	if err := dumpDatabases(context.Background(), kind, p, func(string) {}); err != nil {
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
	calls = fakeDump(t, "mongodump")
	if err := dumpDatabases(context.Background(), kind, p, func(string) {}); err == nil {
		t.Fatal("failure not reported")
	}
	if last := (*calls)[len(*calls)-1]; last.args != "exec mongo rm -rf /tmp/homelab-agent-dump" {
		t.Fatalf("last call = %s", last.args)
	}
}

func TestRunningDatabaseKinds(t *testing.T) {
	oldSock, oldImages, oldDocker := postgresSockets, runningImages, dockerUsable
	t.Cleanup(func() { postgresSockets, runningImages, dockerUsable = oldSock, oldImages, oldDocker })
	dir := t.TempDir()
	postgresSockets = []string{filepath.Join(dir, ".s.PGSQL.*")}
	dockerUsable = func(context.Context) bool { return true }
	images := []string{"nginx:1", "bitnami/mongodb:7"}
	runningImages = func(context.Context) ([]string, error) { return images, nil }

	// pg_dump may be absent on the test machine: only assert the socket-less case then
	if got := runningDatabaseKinds(context.Background()); !reflect.DeepEqual(got, []string{"mongodb"}) {
		t.Fatalf("no postgres socket, mongo container: %v", got)
	}
	images = []string{"nginx:1"}
	if got := runningDatabaseKinds(context.Background()); len(got) != 0 {
		t.Fatalf("nothing running: %v", got)
	}
	images = []string{"mongo:6"}
	dockerUsable = func(context.Context) bool { return false }
	if got := runningDatabaseKinds(context.Background()); len(got) != 0 {
		t.Fatalf("docker unusable: %v", got)
	}
}
