package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func TestAioRole(t *testing.T) {
	cases := map[string]string{
		"nextcloud/all-in-one:latest":                       aioMaster,
		"nextcloud/all-in-one":                              aioMaster,
		"docker.io/nextcloud/all-in-one:beta":               aioMaster,
		"ghcr.io/nextcloud-releases/all-in-one:latest":      "",
		"ghcr.io/nextcloud-releases/aio-nextcloud:latest":   aioNextcloud,
		"ghcr.io/nextcloud-releases/aio-postgresql:latest":  aioDatabase,
		"mirror.lan:5000/nextcloud-releases/aio-postgresql": aioDatabase,
		"ghcr.io/nextcloud-releases/aio-postgresql@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef": aioDatabase,
		"nextcloud:29":             "",
		"postgres:16":              "",
		"someone/aio-postgresql:1": "", // not of Nextcloud
		"ghcr.io/nextcloud-releases/aio-redis:latest": "",
	}
	for ref, want := range cases {
		if got := aioRole(ref); got != want {
			t.Errorf("aioRole(%q) = %q, want %q", ref, got, want)
		}
	}
}

func TestNextcloudJobInSpec(t *testing.T) {
	for mode, want := range map[string]string{
		"database": "backup pg-globals.pxar:/mnt/user/hlm/database/pg-globals pg-nextcloud.pxar:/mnt/user/hlm/database/pg-nextcloud --backup-type host --backup-id x4 --ns Hosts",
		"config":   "backup nc-config.pxar:/mnt/user/hlm/config/nc-config --backup-type host --backup-id x4 --ns Hosts",
	} {
		s := testSpec()
		j := &s.Jobs[0]
		j.Kind, j.Archives, j.Excludes = "nextcloud", nil, nil
		j.Database = &DatabaseDump{Mode: mode, WorkDir: "/mnt/user/hlm/" + mode, Keep: 2}
		if err := validateBackupSpec(s); err != nil {
			t.Fatalf("%s: %v", mode, err)
		}
		if got := strings.Join(backupArgs(*j), " "); got != want {
			t.Errorf("%s: args = %q", mode, got)
		}
	}
	for i, d := range []DatabaseDump{
		{Mode: "users", WorkDir: "/mnt/user/hlm"},
		{Mode: "database", Databases: []string{"nextcloud_database"}, WorkDir: "/mnt/user/hlm"},
		{Mode: "database", Container: "nextcloud-aio-database", WorkDir: "/mnt/user/hlm"},
		{Mode: "config", WorkDir: "/etc/hlm"},
	} {
		if validateDatabase("nextcloud", &d) == nil {
			t.Errorf("bad case %d accepted", i)
		}
	}
}

// answers of docker and occ on an Unraid host like the one of vouille
func fakeAIO(t *testing.T, dataDir, configRoot string) {
	t.Helper()
	mounts, _ := json.Marshal([]map[string]string{
		{"Source": dataDir, "Destination": "/mnt/ncdata"},
		{"Source": configRoot, "Destination": "/var/www/html"},
		{"Source": "/var/lib/docker/volumes/nextcloud_aio_apache/_data", "Destination": "/mnt/apache"},
	})
	fakeOutput(t, map[string]string{
		"docker ps -q":          "a1\nb2\nc3\nd4\n",
		"{{.Name}}":             "/nextcloud-aio-mastercontainer\tnextcloud/all-in-one:latest\n/nextcloud-aio-nextcloud\tghcr.io/nextcloud-releases/aio-nextcloud:latest\n/nextcloud-aio-database\tghcr.io/nextcloud-releases/aio-postgresql:latest\n/nextcloud-aio-redis\tghcr.io/nextcloud-releases/aio-redis:latest\n",
		"occ status":            `{"installed":true,"version":"31.0.9.1","versionstring":"31.0.9","edition":""}`,
		"get dbname":            "nextcloud_database\n",
		"get datadirectory":     "/mnt/ncdata\n",
		"get instanceid":        "ochz3p5m7m1t\n",
		"user:list":             `{"admin":"admin","David":"David","mamath":"Mamath","../x":"bad"}`,
		"{{json .Mounts}}":      string(mounts) + "\n",
		"{{range .Config.Env}}": "PATH=/usr/bin\nPOSTGRES_DB=nextcloud_database\nPOSTGRES_USER=nextcloud\n",
		"pg_dump --version":     "pg_dump (PostgreSQL) 18.6\n",
		"pg_database_size":      "1095761920\n",
		"config_files":          "/mnt/user/docker/nextcloud-aio/docker-compose.yml\n",
	})
}

func TestDiscoverNextcloud(t *testing.T) {
	data := t.TempDir()
	for _, d := range []string{"admin", "mamath", "appdata_ochz3p5m7m1t"} {
		if err := os.Mkdir(filepath.Join(data, d), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	fakeAIO(t, data, "/var/lib/docker/volumes/nextcloud_aio_nextcloud/_data")
	a, err := checkNextcloudOnHost(context.Background(), "/mnt/user/hlm")
	if err != nil {
		t.Fatal(err)
	}
	if a.Version != "31.0.9" || a.Database != "nextcloud_database" || a.DBSize != 1095761920 || a.dbSuper != "nextcloud" || a.DBTools != "pg_dump (PostgreSQL) 18.6" {
		t.Errorf("database = %+v", a)
	}
	if a.DataDir != data || a.ConfigDir != "/var/lib/docker/volumes/nextcloud_aio_nextcloud/_data/config" || a.InstanceID != "ochz3p5m7m1t" {
		t.Errorf("paths = %q %q %q", a.DataDir, a.ConfigDir, a.InstanceID)
	}
	if !reflect.DeepEqual(a.ComposeFiles, []string{"/mnt/user/docker/nextcloud-aio/docker-compose.yml"}) {
		t.Errorf("compose = %v", a.ComposeFiles)
	}
	if a.Containers[aioDatabase] != "nextcloud-aio-database" || a.Containers[aioNextcloud] != "nextcloud-aio-nextcloud" {
		t.Errorf("containers = %v", a.Containers)
	}
	var got []string
	for _, u := range a.Users {
		got = append(got, u.ID+"|"+u.Path+"|"+map[bool]string{true: "ok", false: "-"}[u.Exists]+"|"+u.Error)
	}
	want := []string{
		"../x||-|identifiant inutilisable comme répertoire",
		"admin|" + data + "/admin|ok|",
		"David|" + data + "/David|-|", // never logged in: no directory
		"mamath|" + data + "/mamath|ok|",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("users =\n%s", strings.Join(got, "\n"))
	}
	if a.Free <= 0 {
		t.Error("free space unknown")
	}

	// AIO not running
	fakeOutput(t, map[string]string{"docker ps -q": "a1\n", "{{.Name}}": "/nginx\tnginx:1\n"})
	if _, err := discoverNextcloud(context.Background(), false); err == nil || !strings.Contains(err.Error(), "introuvable") {
		t.Fatalf("no AIO: %v", err)
	}
}

func TestDumpNextcloudDatabase(t *testing.T) {
	fakeAIO(t, t.TempDir(), "/var/lib/docker/volumes/nextcloud_aio_nextcloud/_data")
	calls := fakeDump(t, "")
	work := filepath.Join(t.TempDir(), "database")
	p := &DatabaseDump{Mode: "database", WorkDir: work}
	if err := dumpDatabases(context.Background(), "nextcloud", p, func(string) {}); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"exec nextcloud-aio-database rm -rf /tmp/homelab-agent-dump",
		"exec nextcloud-aio-database mkdir -p /tmp/homelab-agent-dump",
		"exec nextcloud-aio-database pg_dumpall -U nextcloud --globals-only --no-password -f /tmp/homelab-agent-dump/globals.sql",
		"exec nextcloud-aio-database pg_dump -U nextcloud -Fd -Z0 --no-password -f /tmp/homelab-agent-dump/db nextcloud_database",
		"cp nextcloud-aio-database:/tmp/homelab-agent-dump/globals.sql " + work + "/pg-globals/globals.sql",
		"cp nextcloud-aio-database:/tmp/homelab-agent-dump/db/. " + work + "/pg-nextcloud",
		"exec nextcloud-aio-database rm -rf /tmp/homelab-agent-dump",
	}
	var got []string
	for _, c := range *calls {
		got = append(got, c.args)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("calls =\n%s", strings.Join(got, "\n"))
	}
	// a failed dump still cleans the container
	calls = fakeDump(t, "pg_dump -U")
	if err := dumpDatabases(context.Background(), "nextcloud", p, func(string) {}); err == nil {
		t.Fatal("failure not reported")
	}
	if last := (*calls)[len(*calls)-1]; last.args != "exec nextcloud-aio-database rm -rf /tmp/homelab-agent-dump" {
		t.Fatalf("last call = %s", last.args)
	}
}

func TestStageNextcloudConfig(t *testing.T) {
	if _, err := exec.LookPath("cp"); err != nil {
		t.Skip("no cp")
	}
	root := t.TempDir()
	data := filepath.Join(root, "ncdata")
	vol := filepath.Join(root, "volume")
	compose := filepath.Join(root, "aio", "docker-compose.yml")
	files := map[string]string{
		"volume/config/config.php":                        "<?php $CONFIG = [];",
		"aio/docker-compose.yml":                          "services: {}",
		"ncdata/.ocdata":                                  "",
		"ncdata/nextcloud.log":                            "log",
		"ncdata/mamath/files/a.txt":                       "user data",
		"ncdata/appdata_ochz3p5m7m1t/identityproof/k.key": "key",
		"ncdata/appdata_ochz3p5m7m1t/preview/1/p.jpg":     "cache",
		"ncdata/appdata_ochz3p5m7m1t/appstore/apps.json":  "cache",
		"ncdata/appdata_ochz3p5m7m1t/js/core/merged.js":   "cache",
		"ncdata/appdata_oldinstance1/identityproof/k.key": "old",
	}
	for f, c := range files {
		p := filepath.Join(root, f)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(c), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	a := &NextcloudAIO{Version: "31.0.9", Database: "nextcloud_database", DataDir: data, ConfigDir: filepath.Join(vol, "config"), InstanceID: "ochz3p5m7m1t", ComposeFiles: []string{compose}}
	dir := filepath.Join(root, "work", "nc-config")
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := stageNextcloudConfig(context.Background(), a, dir, func(string) {}); err != nil {
		t.Fatal(err)
	}
	var got []string
	_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			rel, _ := filepath.Rel(dir, p)
			got = append(got, rel)
		}
		return nil
	})
	sort.Strings(got)
	want := []string{
		"compose/docker-compose.yml",
		"config/config.php",
		"data/.ocdata",
		"data/appdata_ochz3p5m7m1t/identityproof/k.key",
		"data/nextcloud.log",
		"discovery.json",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("staged =\n%s", strings.Join(got, "\n"))
	}
	if fi, _ := os.Stat(filepath.Join(dir, "config", "config.php")); fi.Mode().Perm() != 0o640 {
		t.Error("mode of config.php not kept")
	}
	// the dump directory of a previous run is replaced
	if err := stageNextcloudConfig(context.Background(), a, dir, func(string) {}); err != nil {
		t.Fatal(err)
	}
}

func TestRunningNextcloud(t *testing.T) {
	oldDocker := dockerUsable
	t.Cleanup(func() { dockerUsable = oldDocker })
	dockerUsable = func(context.Context) bool { return true }
	fakeAIO(t, t.TempDir(), "/v")
	if !nextcloudRunning(context.Background()) {
		t.Fatal("AIO not detected")
	}
	// the database stopped: nothing to back up
	fakeOutput(t, map[string]string{"docker ps -q": "a1\n", "{{.Name}}": "/nextcloud-aio-nextcloud\tghcr.io/nextcloud-releases/aio-nextcloud:latest\n"})
	if nextcloudRunning(context.Background()) {
		t.Fatal("detected without its database")
	}
}

// HLM_LIVE_NEXTCLOUD=1 on a host running Nextcloud AIO: the discovery for real (reads only).
func TestNextcloudLive(t *testing.T) {
	if os.Getenv("HLM_LIVE_NEXTCLOUD") == "" {
		t.Skip("HLM_LIVE_NEXTCLOUD not set")
	}
	a, err := checkNextcloudOnHost(context.Background(), os.Getenv("HLM_LIVE_WORKDIR"))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.MarshalIndent(a, "", "  ")
	t.Logf("super=%s running=%v\n%s", a.dbSuper, nextcloudRunning(context.Background()), raw)
}
