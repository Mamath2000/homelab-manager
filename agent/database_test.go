//go:build !windows

package main

import (
	"context"
	"errors"
	"io"
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
		{"mongodb", DatabaseDump{Container: "mongo", Username: "bad user", Password: "pw", Databases: []string{"x"}, WorkDir: "/mnt/backup"}},
		{"mongodb", DatabaseDump{Container: "mongo", Username: "user", Databases: []string{"x"}, WorkDir: "/mnt/backup"}},
		{"mongodb", DatabaseDump{Container: "mongo", Password: "pw", Databases: []string{"x"}, WorkDir: "/mnt/backup"}},
		{"mongodb", DatabaseDump{Container: "mongo", Username: "user", Password: "pw", AuthSource: "bad/source", Databases: []string{"x"}, WorkDir: "/mnt/backup"}},
		{"mongodb", DatabaseDump{Container: "mongo", Username: "user", Password: "line\nbreak", Databases: []string{"x"}, WorkDir: "/mnt/backup"}},
		{"postgres", DatabaseDump{Mode: "cluster", Username: "user", Password: "pw", WorkDir: "/mnt/backup"}},
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
	name  string
	args  string
	env   []string
	stdin string
}

func fakeDump(t *testing.T, fail string) *[]dumpCall {
	t.Helper()
	calls := &[]dumpCall{}
	oldRun, oldRunInput, oldLookup := dumpRun, dumpRunInput, lookupPostgres
	dumpRun = func(_ context.Context, env []string, _ func(string), name string, args ...string) (int, error) {
		*calls = append(*calls, dumpCall{name: name, args: strings.Join(args, " "), env: env})
		if fail != "" && strings.Contains(name+" "+strings.Join(args, " "), fail) {
			return 1, nil
		}
		return 0, nil
	}
	dumpRunInput = func(_ context.Context, env []string, stdin io.Reader, _ func(string), name string, args ...string) (int, error) {
		data, err := io.ReadAll(stdin)
		if err != nil {
			return -1, err
		}
		*calls = append(*calls, dumpCall{name, strings.Join(args, " "), env, string(data)})
		if fail != "" && strings.Contains(name+" "+strings.Join(args, " "), fail) {
			return 1, nil
		}
		return 0, nil
	}
	lookupPostgres = func() (int, int, string, error) { return os.Getuid(), os.Getgid(), "/var/lib/postgresql", nil }
	t.Cleanup(func() { dumpRun, dumpRunInput, lookupPostgres = oldRun, oldRunInput, oldLookup })
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
		"mongosh":             `{"version":"7.0.2","databases":[{"name":"admin","size":40960},{"name":"canicoif","size":1.25e8}]}` + "\n",
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
	// MongoDB versions before 7 are unsupported and never fall back to the legacy mongo shell.
	fakeOutput(t, map[string]string{"inspect": "true", "mongodump": "v", "mongosh": `{"version":"6.0.9","databases":[]}`})
	if _, err := checkDatabaseOnHost(context.Background(), kind, p); err == nil || !strings.Contains(err.Error(), "MongoDB 7") {
		t.Fatalf("old MongoDB accepted: %v", err)
	}
	fakeOutput(t, map[string]string{"inspect": "false"})
	if _, err := checkDatabaseOnHost(context.Background(), kind, p); err == nil || !strings.Contains(err.Error(), "arrêté") {
		t.Fatalf("stopped container: %v", err)
	}
}

func TestCheckMongoAuthenticated(t *testing.T) {
	oldOutput, oldOutputInput := dumpOutput, dumpOutputInput
	var shellArgs, shellInput string
	dumpOutput = func(_ context.Context, _ []string, name string, args ...string) ([]byte, error) {
		cmd := name + " " + strings.Join(args, " ")
		switch {
		case strings.Contains(cmd, "inspect"):
			return []byte("true\n"), nil
		case strings.Contains(cmd, "mongodump --version"):
			return []byte("mongodump version: 100.10.0\n"), nil
		default:
			return nil, errors.New("unexpected " + cmd)
		}
	}
	dumpOutputInput = func(_ context.Context, _ []string, stdin io.Reader, name string, args ...string) ([]byte, error) {
		shellArgs = name + " " + strings.Join(args, " ")
		input, err := io.ReadAll(stdin)
		shellInput = string(input)
		return []byte(`{"version":"7.0.2","databases":[{"name":"app","size":1000}]}` + "\n"), err
	}
	t.Cleanup(func() { dumpOutput, dumpOutputInput = oldOutput, oldOutputInput })
	p := &DatabaseDump{
		Container:  "mongo",
		Databases:  []string{"app"},
		Username:   "backup",
		Password:   "private@secret",
		AuthSource: "admin",
		WorkDir:    filepath.Join(t.TempDir(), "backup"),
	}
	r, err := checkDatabaseOnHost(context.Background(), "mongodb", p)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Databases) != 1 || r.Databases[0].Name != "app" {
		t.Fatalf("database list = %+v", r.Databases)
	}
	if !strings.Contains(shellArgs, "exec -i mongo mongosh") ||
		!strings.Contains(shellArgs, "--username backup --authenticationDatabase admin --password") ||
		strings.Contains(shellArgs, p.Password) || shellInput != p.Password+"\n" {
		t.Fatalf("mongosh auth was not passed securely: args=%q stdin=%q", shellArgs, shellInput)
	}
}

func TestDumpSizes(t *testing.T) {
	fakeOutput(t, map[string]string{"inspect": "true", "mongodump": "v", "mongosh": `{"version":"7.0.0","databases":[{"name":"db","size":1000}]}`})
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
		"exec mongo rm -rf /tmp/homelab-agent-dump /tmp/homelab-agent-mongo.yaml",
		"exec mongo mongodump --db canicoif --out /tmp/homelab-agent-dump",
		"cp mongo:/tmp/homelab-agent-dump/canicoif/. " + work + "/mongo-canicoif",
		"exec mongo rm -rf /tmp/homelab-agent-dump /tmp/homelab-agent-mongo.yaml",
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
	if last := (*calls)[len(*calls)-1]; last.args != "exec mongo rm -rf /tmp/homelab-agent-dump /tmp/homelab-agent-mongo.yaml" {
		t.Fatalf("last call = %s", last.args)
	}
}

func TestDumpMongoAuthenticated(t *testing.T) {
	calls := fakeDump(t, "")
	work := filepath.Join(t.TempDir(), "w")
	if err := os.MkdirAll(work, 0o700); err != nil {
		t.Fatal(err)
	}
	p := &DatabaseDump{
		Container:  "mongo",
		Databases:  []string{"db"},
		Username:   "backup-user",
		Password:   "p@ss word",
		AuthSource: "admin",
		WorkDir:    work,
	}
	var log strings.Builder
	if err := dumpMongo(context.Background(), p, func(s string) { log.WriteString(s) }); err != nil {
		t.Fatal(err)
	}
	var config *dumpCall
	for i := range *calls {
		c := &(*calls)[i]
		if c.stdin != "" {
			config = c
		}
	}
	if config == nil || !strings.Contains(config.args, "exec -i mongo sh -c umask 077; cat > "+mongoConfigPath+" && chmod 600 "+mongoConfigPath) {
		t.Fatalf("config was not delivered on stdin: %+v", *calls)
	}
	if strings.Contains(config.stdin, p.Password) || !strings.Contains(config.stdin, "p%40ss%20word") || !strings.Contains(config.stdin, "authSource=admin") {
		t.Fatalf("unsafe or malformed config: %q", config.stdin)
	}
	var dump *dumpCall
	for i := range *calls {
		if strings.Contains((*calls)[i].args, "mongodump") {
			dump = &(*calls)[i]
		}
	}
	if dump == nil || !strings.Contains(dump.args, "--config "+mongoConfigPath) {
		t.Fatalf("mongodump did not use config file: %+v", *calls)
	}
	if strings.Contains(log.String(), p.Password) || strings.Contains(log.String(), "p%40ss%20word") {
		t.Fatalf("password leaked to log: %s", log.String())
	}
	if last := (*calls)[len(*calls)-1]; !strings.Contains(last.args, "rm -rf "+mongoTmp+" "+mongoConfigPath) {
		t.Fatalf("config cleanup missing: %s", last.args)
	}

	calls = fakeDump(t, "mongodump")
	if err := dumpMongo(context.Background(), p, func(string) {}); err == nil {
		t.Fatal("failed authenticated dump reported success")
	}
	if last := (*calls)[len(*calls)-1]; !strings.Contains(last.args, "rm -rf "+mongoTmp+" "+mongoConfigPath) {
		t.Fatalf("config not cleaned after failure: %s", last.args)
	}
}

func TestMongoLogRedactsPasswordAndExplainsAuthenticationFailure(t *testing.T) {
	oldRun := dumpRun
	dumpRun = func(_ context.Context, _ []string, emit func(string), name string, args ...string) (int, error) {
		emit("Authentication failed for password-secret\n")
		return 1, nil
	}
	defer func() { dumpRun = oldRun }()
	var log strings.Builder
	p := &DatabaseDump{Password: "password-secret"}
	err := runMongoDumpStep(context.Background(), nil, func(s string) { log.WriteString(s) }, p, "docker", "exec", "mongo", "mongodump")
	if err == nil || !strings.Contains(err.Error(), "authentification MongoDB échouée") || strings.Contains(err.Error(), p.Password) {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(log.String(), p.Password) || !strings.Contains(log.String(), "[REDACTED]") {
		t.Fatalf("password leaked to log: %s", log.String())
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

func TestCheckDbRestoreMongo(t *testing.T) {
	fakeOutput(t, map[string]string{
		"inspect":                "true\n",
		"mongodump --version":    "mongodump version: 100.10.0\n",
		"mongorestore --version": "mongorestore version: 100.10.0\ngit version: x\n",
		"mongosh":                `{"version":"7.0.2","databases":[{"name":"admin","size":40960},{"name":"canicoif","size":1.25e8}]}` + "\n",
		"df -Pk":                 "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 400 600 40% /data/db\n",
	})
	ctx := context.Background()
	p := &DatabaseDump{Container: "mongo"}
	r, err := checkDbRestore(ctx, "mongodb", p, "canicoif_copy")
	if err != nil {
		t.Fatal(err)
	}
	if r.Exists || r.Tools != "mongorestore version: 100.10.0" || len(r.Databases) != 2 || r.Free != 600*1024 {
		t.Fatalf("check = %+v", r)
	}
	if r.FreeTmp != 600*1024 {
		t.Fatalf("tmp free = %d", r.FreeTmp)
	}
	if r, err = checkDbRestore(ctx, "mongodb", p, "CANICOIF"); err != nil || !r.Exists {
		t.Fatalf("case clash: %v %+v", err, r)
	}
	if _, err = checkDbRestore(ctx, "mongodb", p, "admin"); err == nil {
		t.Fatal("reserved name accepted")
	}
	// name clash: never offered
	if r, err = checkDbRestore(ctx, "mongodb", p, "canicoif"); err != nil || !r.Exists {
		t.Fatalf("clash: %v %+v", err, r)
	}
	// validated inputs
	for _, bad := range []string{"a b", "../x", "$x", strings.Repeat("a", 60)} {
		if _, err := checkDbRestore(ctx, "mongodb", p, bad); err == nil {
			t.Errorf("name %q accepted", bad)
		}
	}
	if _, err := checkDbRestore(ctx, "mongodb", &DatabaseDump{Container: "m;rm"}, "x"); err == nil {
		t.Error("bad container accepted")
	}
	if _, err := checkDbRestore(ctx, "mongodb", &DatabaseDump{Container: "mongo", Username: "u"}, "x"); err == nil {
		t.Error("user without password accepted")
	}
	if _, err := checkDbRestore(ctx, "postgres", p, "x"); err == nil {
		t.Error("postgres not supported yet")
	}
	// mongorestore missing from the container
	fakeOutput(t, map[string]string{"inspect": "true", "mongodump --version": "v", "mongosh": `{"version":"7.0.2","databases":[]}`, "mongorestore --version": "ERR"})
	if _, err := checkDbRestore(ctx, "mongodb", p, "x"); err == nil || !strings.Contains(err.Error(), "mongorestore") {
		t.Fatalf("missing mongorestore: %v", err)
	}
}

func fakeRestoreMounts(t *testing.T, paths ...string) {
	t.Helper()
	old := restoreMountsOf
	restoreMountsOf = func(string) []string { return paths }
	t.Cleanup(func() { restoreMountsOf = old })
}

func TestRunDbRestoreMongo(t *testing.T) {
	dump := filepath.Join(t.TempDir(), "host-vm_2026-10-19_02-30-00_mongo-canicoif")
	if err := os.MkdirAll(dump, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dump, "c1.bson"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	fakeRestoreMounts(t, dump)
	spec := func() *DbRestoreSpec {
		return &DbRestoreSpec{Kind: "mongodb", Database: &DatabaseDump{Container: "mongo"}, Source: "canicoif", Target: "canicoif_copy"}
	}
	// success: the new database appears after the restore
	listed := 0
	oldOut := dumpOutput
	t.Cleanup(func() { dumpOutput = oldOut })
	dumpOutput = func(_ context.Context, _ []string, name string, args ...string) ([]byte, error) {
		cmd := name + " " + strings.Join(args, " ")
		switch {
		case strings.Contains(cmd, "inspect"):
			return []byte("true"), nil
		case strings.Contains(cmd, "mongodump --version"):
			return []byte("v"), nil
		case strings.Contains(cmd, "mongosh"):
			listed++
			// the name is looked at before the copy, again before the restore, then once restored
			if listed <= 2 {
				return []byte(`{"version":"7.0.2","databases":[{"name":"canicoif","size":10}]}`), nil
			}
			return []byte(`{"version":"7.0.2","databases":[{"name":"canicoif","size":10},{"name":"canicoif_copy","size":5}]}`), nil
		}
		return nil, errors.New("unexpected " + cmd)
	}
	calls := fakeDump(t, "")
	var log strings.Builder
	if err := runDbRestore(context.Background(), spec(), func(s string) { log.WriteString(s) }); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"exec mongo rm -rf /tmp/homelab-agent-restore /tmp/homelab-agent-restore.yaml",
		"exec mongo mkdir -p /tmp/homelab-agent-restore/canicoif",
		"cp " + dump + "/. mongo:/tmp/homelab-agent-restore/canicoif",
		"exec mongo mongorestore --nsInclude canicoif.* --nsFrom canicoif.$coll$ --nsTo canicoif_copy.$coll$ /tmp/homelab-agent-restore",
		"exec mongo rm -rf /tmp/homelab-agent-restore /tmp/homelab-agent-restore.yaml",
	}
	if len(*calls) != len(want) {
		t.Fatalf("calls = %+v", *calls)
	}
	for i, c := range *calls {
		if c.name != "docker" || c.args != want[i] {
			t.Errorf("call %d = %s %s", i, c.name, c.args)
		}
	}
	// never overwrites: the name is taken, nothing is copied nor restored
	calls = fakeDump(t, "")
	listed = 1
	taken := spec()
	taken.Target = "canicoif"
	if err := runDbRestore(context.Background(), taken, func(string) {}); err == nil || !strings.Contains(err.Error(), "existe deja") {
		t.Fatalf("existing database accepted: %v", err)
	}
	for _, c := range *calls {
		if strings.Contains(c.args, "mongorestore") || strings.Contains(c.args, " cp ") || c.name == "docker" && strings.HasPrefix(c.args, "cp ") {
			t.Fatalf("something was run: %+v", *calls)
		}
	}
	// the name differs by case only: MongoDB would refuse it, so it is taken
	listed = 1
	calls = fakeDump(t, "")
	upper := spec()
	upper.Target = "CANICOIF"
	if err := runDbRestore(context.Background(), upper, func(string) {}); err == nil || !strings.Contains(err.Error(), "existe deja") {
		t.Fatalf("name differing by case accepted: %v", err)
	}
	// the name appears while the dump is copied: nothing is restored
	listed = 0
	appears := spec()
	dumpOutput = func(_ context.Context, _ []string, name string, args ...string) ([]byte, error) {
		cmd := name + " " + strings.Join(args, " ")
		switch {
		case strings.Contains(cmd, "inspect"):
			return []byte("true"), nil
		case strings.Contains(cmd, "mongodump --version"):
			return []byte("v"), nil
		case strings.Contains(cmd, "mongosh"):
			listed++
			if listed <= 1 {
				return []byte(`{"version":"7.0.2","databases":[]}`), nil
			}
			return []byte(`{"version":"7.0.2","databases":[{"name":"canicoif_copy","size":5}]}`), nil
		}
		return nil, errors.New("unexpected " + cmd)
	}
	calls = fakeDump(t, "")
	if err := runDbRestore(context.Background(), appears, func(string) {}); err == nil || !strings.Contains(err.Error(), "apparue") {
		t.Fatalf("race not caught: %v", err)
	}
	for _, c := range *calls {
		if strings.Contains(c.args, "mongorestore") {
			t.Fatalf("restored over a database that appeared: %+v", *calls)
		}
	}
	// system databases are never a source nor a target
	for _, n := range []string{"admin", "Local", "CONFIG"} {
		bad := spec()
		bad.Target = n
		if err := runDbRestore(context.Background(), bad, func(string) {}); err == nil {
			t.Errorf("target %q accepted", n)
		}
		bad = spec()
		bad.Source = n
		if err := runDbRestore(context.Background(), bad, func(string) {}); err == nil {
			t.Errorf("source %q accepted", n)
		}
	}
	// another dump is mounted
	other := spec()
	other.Source = "autre"
	if err := runDbRestore(context.Background(), other, func(string) {}); err == nil || !strings.Contains(err.Error(), "not the dump") {
		t.Errorf("wrong mount accepted: %v", err)
	}
	// failed restore: cleaned, partial database announced, password not logged
	dumpOutput = oldOut
	listed = 0
	dumpOutput = func(_ context.Context, _ []string, name string, args ...string) ([]byte, error) {
		cmd := name + " " + strings.Join(args, " ")
		switch {
		case strings.Contains(cmd, "inspect"):
			return []byte("true"), nil
		case strings.Contains(cmd, "mongodump --version"):
			return []byte("v"), nil
		case strings.Contains(cmd, "mongosh"):
			return []byte(`{"version":"7.0.2","databases":[{"name":"canicoif","size":10}]}`), nil
		}
		return nil, errors.New("unexpected " + cmd)
	}
	calls = fakeDump(t, "mongorestore")
	log.Reset()
	if err := runDbRestore(context.Background(), spec(), func(s string) { log.WriteString(s) }); err == nil {
		t.Fatal("failure not reported")
	}
	if !strings.Contains(log.String(), "partiellement") {
		t.Errorf("log = %q", log.String())
	}
	if last := (*calls)[len(*calls)-1]; last.args != "exec mongo rm -rf /tmp/homelab-agent-restore /tmp/homelab-agent-restore.yaml" {
		t.Fatalf("last call = %s", last.args)
	}
	// mounts and inputs
	fakeRestoreMounts(t)
	if err := runDbRestore(context.Background(), spec(), func(string) {}); err == nil {
		t.Error("restore without a mounted backup")
	}
	empty := filepath.Join(t.TempDir(), "host-vm_2026-10-19_02-30-00_mongo-canicoif")
	if err := os.MkdirAll(empty, 0o700); err != nil {
		t.Fatal(err)
	}
	fakeRestoreMounts(t, empty)
	if err := runDbRestore(context.Background(), spec(), func(string) {}); err == nil || !strings.Contains(err.Error(), "bson") {
		t.Errorf("non-dump mount accepted: %v", err)
	}
	bad := spec()
	bad.Target = "x;y"
	if err := runDbRestore(context.Background(), bad, func(string) {}); err == nil {
		t.Error("bad target accepted")
	}
	bad = spec()
	bad.Source = "../x"
	if err := runDbRestore(context.Background(), bad, func(string) {}); err == nil {
		t.Error("bad source accepted")
	}
}

func TestMongoCandidatesTellsWhichNeedCredentials(t *testing.T) {
	oldUsable := dockerUsable
	dockerUsable = func(context.Context) bool { return true }
	t.Cleanup(func() { dockerUsable = oldUsable })
	oldOut := dumpOutput
	t.Cleanup(func() { dumpOutput = oldOut })
	dumpOutput = func(_ context.Context, _ []string, name string, args ...string) ([]byte, error) {
		cmd := name + " " + strings.Join(args, " ")
		switch {
		case strings.HasPrefix(cmd, "docker ps"):
			return []byte("mongo-auth\tmongo:8\nmongo-noauth\tmongo:8\nweb\tnginx\nmongo-old\tmongo:4\n"), nil
		case strings.Contains(cmd, "mongo-old mongorestore"):
			return nil, errors.New("no mongorestore")
		case strings.Contains(cmd, "mongorestore --version"):
			return []byte("mongorestore version: 100.10.0"), nil
		case strings.Contains(cmd, "mongo-auth mongosh"):
			return nil, errors.New("MongoServerError: Command listDatabases requires authentication")
		case strings.Contains(cmd, "mongo-noauth mongosh"):
			return []byte("1\n"), nil
		}
		return nil, errors.New("unexpected " + cmd)
	}
	got := mongoCandidates(context.Background())
	if len(got) != 2 || got[0].Container != "mongo-auth" || !got[0].NeedsAuth || got[1].Container != "mongo-noauth" || got[1].NeedsAuth {
		t.Fatalf("candidates = %+v", got)
	}
}
