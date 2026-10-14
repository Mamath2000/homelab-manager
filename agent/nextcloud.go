package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"
)

// Backups of a Nextcloud All-in-One instance (homelab#148): the hub generates its jobs (plugin), each of
// kind "nextcloud" with a mode:
//   - database: pg_dump -Fd -Z0 of its database and pg_dumpall --globals-only, run in the database
//     container (its tools, same major version) then copied out of it (pg-globals, pg-nextcloud);
//   - config: config/ of the Nextcloud volume, the compose files of the mastercontainer, the files at the
//     root of the data directory and appdata_<instanceid> without its caches (nc-config);
//
// the data of each user is a plain directories job. Nothing is fixed in the definition but the mode: the
// containers are found by their image and the paths asked to Nextcloud (occ) and Docker at each run.

// AIO containers, by the repository of their image (registry and tag left out)
const (
	aioMaster    = "master"
	aioNextcloud = "nextcloud"
	aioDatabase  = "database"
)

// aioRole: the part of Nextcloud AIO a container image is, "" when none. The reference of the container
// (.Config.Image) is kept by Docker even when the tag has moved to a newer image since.
func aioRole(ref string) string {
	repo := strings.ToLower(ref)
	if i := strings.Index(repo, "@"); i >= 0 {
		repo = repo[:i]
	}
	if i := strings.LastIndex(repo, ":"); i > strings.LastIndex(repo, "/") {
		repo = repo[:i]
	}
	switch {
	case repo == "nextcloud/all-in-one" || strings.HasSuffix(repo, "/nextcloud/all-in-one"):
		return aioMaster
	case !strings.Contains(path.Dir(repo), "nextcloud"):
		return ""
	case path.Base(repo) == "aio-nextcloud":
		return aioNextcloud
	case path.Base(repo) == "aio-postgresql":
		return aioDatabase
	}
	return ""
}

// aioContainers: the running containers of Nextcloud AIO, by role.
func aioContainers(ctx context.Context) (map[string]string, error) {
	env := append(os.Environ(), "LC_ALL=C")
	ids, err := dumpOutput(ctx, env, "docker", "ps", "-q")
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	if len(strings.Fields(string(ids))) == 0 {
		return out, nil
	}
	list, err := dumpOutput(ctx, env, "docker", append([]string{"inspect", "-f", "{{.Name}}\t{{.Config.Image}}"}, strings.Fields(string(ids))...)...)
	if err != nil {
		return nil, err
	}
	for _, l := range strings.Split(strings.TrimSpace(string(list)), "\n") {
		name, image, ok := strings.Cut(l, "\t")
		name = strings.TrimPrefix(strings.TrimSpace(name), "/")
		if r := aioRole(strings.TrimSpace(image)); ok && r != "" && containerRe.MatchString(name) {
			if _, seen := out[r]; !seen {
				out[r] = name
			}
		}
	}
	return out, nil
}

// nextcloudRunning: Nextcloud and its database run here (the capability of the plugin).
func nextcloudRunning(ctx context.Context) bool {
	if !dockerUsable(ctx) {
		return false
	}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	c, err := aioContainers(cctx)
	return err == nil && c[aioNextcloud] != "" && c[aioDatabase] != ""
}

type NextcloudUser struct {
	ID     string `json:"id"`
	Name   string `json:"name"`            // display name
	Path   string `json:"path,omitempty"`  // its directory on the host (data directory/<id>)
	Exists bool   `json:"exists"`          // the directory is there (a user who never logged in has none)
	Error  string `json:"error,omitempty"` // id unusable as a directory name
}

// NextcloudAIO: what the agent found of the instance (form of the plugin, discovery.json of nc-config).
type NextcloudAIO struct {
	Containers   map[string]string `json:"containers"` // role → name
	Version      string            `json:"version"`
	Database     string            `json:"database"`
	DBSize       int64             `json:"dbSize"` // -1: unknown
	DBTools      string            `json:"dbTools,omitempty"`
	DataDir      string            `json:"dataDir"`      // on the host
	ConfigDir    string            `json:"configDir"`    // on the host
	InstanceID   string            `json:"instanceId"`   // appdata_<instanceId>
	ComposeFiles []string          `json:"composeFiles"` // of the mastercontainer (none when not run by compose)
	Users        []NextcloudUser   `json:"users,omitempty"`
	Free         int64             `json:"free"` // free space for the work directory (-1: unknown)
	dbSuper      string            // superuser of the database container (POSTGRES_USER)
}

var (
	nextcloudUserRe = regexp.MustCompile(`^[A-Za-z0-9_.@-]{1,64}$`)
	instanceIDRe    = regexp.MustCompile(`^[a-z0-9]{1,32}$`)
	roleRe          = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]{0,62}$`)
)

// caches of appdata_<instanceid>, rebuilt by Nextcloud (preview: tens of GB)
var nextcloudAppdataExcludes = map[string]bool{"preview": true, "appstore": true, "js": true}

func cleanAbs(p string) bool {
	return filepath.IsAbs(p) && filepath.Clean(p) == p && !strings.ContainsAny(p, ":\n")
}

// discoverNextcloud: containers, versions and paths of the instance; users when asked (form).
func discoverNextcloud(ctx context.Context, users bool) (*NextcloudAIO, error) {
	c, err := aioContainers(ctx)
	if err != nil {
		return nil, err
	}
	nc, db := c[aioNextcloud], c[aioDatabase]
	if nc == "" || db == "" {
		return nil, errors.New("Nextcloud AIO introuvable : conteneurs aio-nextcloud et aio-postgresql non démarrés")
	}
	env := append(os.Environ(), "LC_ALL=C")
	occ := func(args ...string) (string, error) {
		out, err := dumpOutput(ctx, env, "docker", append([]string{"exec", "-u", "www-data", nc, "php", "occ"}, args...)...)
		if err != nil {
			return "", fmt.Errorf("occ %s : %w", args[0], err)
		}
		return strings.TrimSpace(string(out)), nil
	}
	a := &NextcloudAIO{Containers: c, DBSize: -1, ComposeFiles: []string{}, Free: -1}
	if st, err := occ("status", "--output=json"); err == nil {
		var s struct {
			Version string `json:"versionstring"`
		}
		if json.Unmarshal([]byte(lastLine(st)), &s) == nil {
			a.Version = s.Version
		}
	}
	if a.Database, err = occ("config:system:get", "dbname"); err != nil {
		return nil, err
	}
	if !dbNameRe.MatchString(a.Database) {
		return nil, fmt.Errorf("nom de base inattendu : %q", a.Database)
	}
	dataIn, err := occ("config:system:get", "datadirectory")
	if err != nil {
		return nil, err
	}
	if a.InstanceID, err = occ("config:system:get", "instanceid"); err != nil {
		return nil, err
	}
	if !instanceIDRe.MatchString(a.InstanceID) {
		return nil, fmt.Errorf("instanceid inattendu : %q", a.InstanceID)
	}

	// paths on the host: the mounts of the Nextcloud container
	raw, err := dumpOutput(ctx, env, "docker", "inspect", "-f", "{{json .Mounts}}", nc)
	if err != nil {
		return nil, err
	}
	var mounts []struct{ Source, Destination string }
	if err := json.Unmarshal([]byte(lastLine(string(raw))), &mounts); err != nil {
		return nil, fmt.Errorf("montages de %s illisibles : %w", nc, err)
	}
	onHost := func(in string) string {
		best, out := "", ""
		for _, m := range mounts {
			if (in == m.Destination || strings.HasPrefix(in, strings.TrimSuffix(m.Destination, "/")+"/")) && len(m.Destination) > len(best) {
				best, out = m.Destination, filepath.Join(m.Source, strings.TrimPrefix(in, m.Destination))
			}
		}
		return out
	}
	if a.DataDir = onHost(dataIn); !cleanAbs(a.DataDir) {
		return nil, fmt.Errorf("répertoire de données %s : aucun montage de l'hôte", dataIn)
	}
	if a.ConfigDir = onHost("/var/www/html/config"); !cleanAbs(a.ConfigDir) {
		return nil, errors.New("config de Nextcloud : aucun montage de l'hôte pour /var/www/html")
	}

	// superuser of the database container: POSTGRES_USER of its image (local socket in trust)
	a.dbSuper = "postgres"
	if raw, err := dumpOutput(ctx, env, "docker", "inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", db); err == nil {
		for _, l := range strings.Split(string(raw), "\n") {
			if v, ok := strings.CutPrefix(strings.TrimSpace(l), "POSTGRES_USER="); ok && roleRe.MatchString(v) {
				a.dbSuper = v
			}
		}
	}
	if v, err := dumpOutput(ctx, env, "docker", "exec", db, "pg_dump", "--version"); err == nil {
		a.DBTools = strings.TrimSpace(string(v))
	}
	if out, err := dumpOutput(ctx, env, "docker", "exec", db, "psql", "-U", a.dbSuper, "-AtX", "--no-password", "-d", a.Database, "-c", "select pg_database_size(current_database())"); err == nil {
		fmt.Sscan(strings.TrimSpace(string(out)), &a.DBSize)
	}

	// compose files of the mastercontainer, when it runs with compose
	if m := c[aioMaster]; m != "" {
		if raw, err := dumpOutput(ctx, env, "docker", "inspect", "-f", `{{index .Config.Labels "com.docker.compose.project.config_files"}}`, m); err == nil {
			for _, f := range strings.Split(strings.TrimSpace(string(raw)), ",") {
				if f = strings.TrimSpace(f); cleanAbs(f) {
					a.ComposeFiles = append(a.ComposeFiles, f)
				}
			}
		}
	}

	if users {
		list, err := occ("user:list", "--output=json", "--limit=10000")
		if err != nil {
			return nil, err
		}
		var names map[string]string
		if err := json.Unmarshal([]byte(lastLine(list)), &names); err != nil {
			return nil, fmt.Errorf("liste des utilisateurs illisible : %w", err)
		}
		for id, name := range names {
			u := NextcloudUser{ID: id, Name: name}
			if !nextcloudUserRe.MatchString(id) || id == "." || id == ".." || strings.HasPrefix(id, "appdata_") {
				u.Error = "identifiant inutilisable comme répertoire"
			} else {
				u.Path = filepath.Join(a.DataDir, id)
				fi, err := os.Stat(u.Path)
				u.Exists = err == nil && fi.IsDir()
			}
			a.Users = append(a.Users, u)
		}
		sort.Slice(a.Users, func(i, j int) bool { return strings.ToLower(a.Users[i].ID) < strings.ToLower(a.Users[j].ID) })
	}
	return a, nil
}

// checkNextcloudOnHost: the discovery for the form of the plugin, with the free space of its work directory.
func checkNextcloudOnHost(ctx context.Context, workDir string) (*NextcloudAIO, error) {
	a, err := discoverNextcloud(ctx, true)
	if err != nil {
		return nil, err
	}
	if workDir != "" {
		if !cleanAbs(workDir) {
			return nil, fmt.Errorf("répertoire de travail invalide %q", workDir)
		}
		a.Free = freeSpace(workDir)
	}
	return a, nil
}

// pg_dump runs in the database container; the dumps are then copied out of it.
const nextcloudTmp = "/tmp/homelab-agent-dump"

func dumpNextcloud(ctx context.Context, p *DatabaseDump, emit func(string)) (err error) {
	a, err := discoverNextcloud(ctx, false)
	if err != nil {
		return err
	}
	env := append(os.Environ(), "LC_ALL=C")
	emit(fmt.Sprintf("Nextcloud %s : conteneurs %s, %s ; données %s\n", a.Version, a.Containers[aioNextcloud], a.Containers[aioDatabase], a.DataDir))
	if p.Mode == "config" {
		return stageNextcloudConfig(ctx, a, filepath.Join(p.WorkDir, "nc-config"), emit)
	}
	db := a.Containers[aioDatabase]
	if err := runDumpStep(ctx, env, emit, "docker", "exec", db, "rm", "-rf", nextcloudTmp); err != nil {
		return err
	}
	defer func() {
		if cerr := runDumpStep(context.WithoutCancel(ctx), env, emit, "docker", "exec", db, "rm", "-rf", nextcloudTmp); cerr != nil && err == nil {
			emit("nettoyage du conteneur : " + cerr.Error() + "\n")
		}
	}()
	steps := [][]string{
		{"exec", db, "mkdir", "-p", nextcloudTmp},
		// roles: the owner of the database and its rights
		{"exec", db, "pg_dumpall", "-U", a.dbSuper, "--globals-only", "--no-password", "-f", nextcloudTmp + "/globals.sql"},
		{"exec", db, "pg_dump", "-U", a.dbSuper, "-Fd", "-Z0", "--no-password", "-f", nextcloudTmp + "/db", a.Database},
	}
	for _, s := range steps {
		if err := runDumpStep(ctx, env, emit, "docker", s...); err != nil {
			return err
		}
	}
	for _, a := range dumpArchives("nextcloud", p) {
		if err := resetDir(a.Path, os.Getuid(), os.Getgid()); err != nil {
			return err
		}
	}
	if err := runDumpStep(ctx, env, emit, "docker", "cp", db+":"+nextcloudTmp+"/globals.sql", filepath.Join(p.WorkDir, "pg-globals", "globals.sql")); err != nil {
		return err
	}
	return runDumpStep(ctx, env, emit, "docker", "cp", db+":"+nextcloudTmp+"/db/.", filepath.Join(p.WorkDir, "pg-nextcloud"))
}

// stageNextcloudConfig copies what restores the instance besides its database and the data of its users
// (cp -a: owners and modes kept, www-data in the container):
//
//	config/                     config/ of the Nextcloud volume (config.php…)
//	compose/                    compose files of the mastercontainer
//	data/<files>                files at the root of the data directory (.ncdata, .htaccess…)
//	data/appdata_<instanceid>/  without its caches (preview, appstore, js)
//	discovery.json              what the agent found (containers, paths, versions)
func stageNextcloudConfig(ctx context.Context, a *NextcloudAIO, dir string, emit func(string)) error {
	env := append(os.Environ(), "LC_ALL=C")
	if err := resetDir(dir, os.Getuid(), os.Getgid()); err != nil {
		return err
	}
	cp := func(src, dst string) error { return runDumpStep(ctx, env, emit, "cp", "-a", src, dst) }
	if err := cp(a.ConfigDir, filepath.Join(dir, "config")); err != nil {
		return err
	}
	if len(a.ComposeFiles) > 0 {
		if err := os.Mkdir(filepath.Join(dir, "compose"), 0o700); err != nil {
			return err
		}
		for _, f := range a.ComposeFiles {
			if err := cp(f, filepath.Join(dir, "compose")+"/"); err != nil {
				return err
			}
		}
	}
	data := filepath.Join(dir, "data")
	if err := os.Mkdir(data, 0o700); err != nil {
		return err
	}
	entries, err := os.ReadDir(a.DataDir)
	if err != nil {
		return err
	}
	appdata := "appdata_" + a.InstanceID
	for _, e := range entries {
		src := filepath.Join(a.DataDir, e.Name())
		switch {
		case e.Type().IsRegular():
			if err := cp(src, data+"/"); err != nil {
				return err
			}
		case e.IsDir() && e.Name() == appdata:
			if err := copyDirExcept(ctx, env, emit, src, filepath.Join(data, appdata), nextcloudAppdataExcludes); err != nil {
				return err
			}
		}
	}
	raw, _ := json.MarshalIndent(a, "", "  ")
	return os.WriteFile(filepath.Join(dir, "discovery.json"), raw, 0o600)
}

// copyDirExcept copies a directory without some of its entries, keeping its owner and mode.
func copyDirExcept(ctx context.Context, env []string, emit func(string), src, dst string, except map[string]bool) error {
	fi, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if err := os.Mkdir(dst, fi.Mode().Perm()); err != nil {
		return err
	}
	if err := chownLike(dst, fi); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	var skipped []string
	for _, e := range entries {
		if except[e.Name()] {
			skipped = append(skipped, e.Name())
			continue
		}
		if err := runDumpStep(ctx, env, emit, "cp", "-a", filepath.Join(src, e.Name()), dst+"/"); err != nil {
			return err
		}
	}
	if len(skipped) > 0 {
		emit(fmt.Sprintf("%s : %s non copiés (caches)\n", src, strings.Join(skipped, ", ")))
	}
	return nil
}

// chownLike gives dst the owner of fi (root only: as another user, it stays the agent's).
func chownLike(dst string, fi os.FileInfo) error {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || os.Geteuid() != 0 {
		return nil
	}
	return os.Chown(dst, int(st.Uid), int(st.Gid))
}

// dumpSizesNextcloud: the database dump against the size of the database; the config has no source size.
func dumpSizesNextcloud(ctx context.Context, p *DatabaseDump) []DumpInfo {
	var a *NextcloudAIO
	if p.Mode != "config" {
		a, _ = discoverNextcloud(ctx, false)
	}
	var out []DumpInfo
	for _, ar := range dumpArchives("nextcloud", p) {
		d := DumpInfo{Archive: ar.Name, DBSize: -1, DumpSize: dirSize(ar.Path)}
		switch ar.Name {
		case "pg-globals":
			d.DBSize = 0
		case "pg-nextcloud":
			if a != nil {
				d.Database, d.DBSize = a.Database, a.DBSize
			}
		}
		out = append(out, d)
	}
	return out
}
