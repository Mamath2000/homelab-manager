//go:build !windows

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Restore of a database dump into a NEW database (#210). The dump is read from the read-only mount of a
// PBS snapshot (pbsmount.go); nothing existing is ever overwritten: a target database that already
// exists is refused. Like the dumps, the commands are fixed and the hub only chooses their parameters.
//
// db_restore_check: what the hub needs before it offers a host as a target: tools present, access to the
// server, databases already there (name clash), free space. Read-only.

// mongoDataDir is where the official image keeps its data (free space of the restore).
const mongoDataDir = "/data/db"

// DbRestoreCandidate: a running MongoDB container whose tools can restore (answer without a container).
type DbRestoreCandidate struct {
	Container string `json:"container"`
	Image     string `json:"image"`
}

// DbRestoreCheck: answer of db_restore_check.
type DbRestoreCheck struct {
	Tools      string               `json:"tools"`                // version of the restore tool
	Databases  []DatabaseInfo       `json:"databases"`            // already on the server
	Exists     bool                 `json:"exists"`               // the new database name is already taken
	Free       int64                `json:"free"`                 // free bytes where the server stores its data (-1: unknown)
	Candidates []DbRestoreCandidate `json:"candidates,omitempty"` // no container given: the containers that could restore
}

// validateDbRestoreTarget: the name of the new database and, for MongoDB, the connection settings.
func validateDbRestoreTarget(kind string, p *DatabaseDump, target string) error {
	if kind != "mongodb" {
		return fmt.Errorf("restore of %q: not supported yet", kind)
	}
	if target != "" && !dbNameRe.MatchString(target) {
		return fmt.Errorf("invalid database name %q", target)
	}
	// same rules as the dump for the connection settings; no work directory nor database list here
	q := *p
	q.WorkDir, q.Keep, q.Databases = "/var/lib/homelab-restore", 0, nil
	if q.Container == "" {
		return nil // candidates only
	}
	return validateDatabaseSettings(kind, &q, false)
}

// mongoCandidates: running containers whose image looks like MongoDB and that have mongorestore.
func mongoCandidates(ctx context.Context) []DbRestoreCandidate {
	out := []DbRestoreCandidate{}
	if !dockerUsable(ctx) {
		return out
	}
	b, err := dumpOutput(ctx, nil, "docker", "ps", "--format", "{{.Names}}\t{{.Image}}")
	if err != nil {
		return out
	}
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		name, image, ok := strings.Cut(l, "\t")
		if !ok || !containerRe.MatchString(name) || !strings.Contains(strings.ToLower(image), "mongo") {
			continue
		}
		if _, err := dumpOutput(ctx, nil, "docker", "exec", name, "mongorestore", "--version"); err != nil {
			continue
		}
		out = append(out, DbRestoreCandidate{Container: name, Image: image})
	}
	return out
}

// containerFree: free bytes of the data directory of the container (-1: unknown).
func containerFree(ctx context.Context, container string) int64 {
	b, err := dumpOutput(ctx, nil, "docker", "exec", container, "df", "-Pk", mongoDataDir)
	if err != nil {
		return -1
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	f := strings.Fields(lines[len(lines)-1])
	if len(f) < 4 {
		return -1
	}
	kb, err := strconv.ParseInt(f[3], 10, 64)
	if err != nil {
		return -1
	}
	return kb * 1024
}

func checkDbRestore(ctx context.Context, kind string, p *DatabaseDump, target string) (*DbRestoreCheck, error) {
	if p == nil {
		return nil, errors.New("missing database settings")
	}
	if err := validateDbRestoreTarget(kind, p, target); err != nil {
		return nil, err
	}
	if p.Container == "" {
		return &DbRestoreCheck{Databases: []DatabaseInfo{}, Free: -1, Candidates: mongoCandidates(ctx)}, nil
	}
	// the access is tested by listing the databases (authenticated when asked)
	_, dbs, err := listDatabases(ctx, kind, p)
	if err != nil {
		return nil, err
	}
	v, err := dumpOutput(ctx, nil, "docker", "exec", p.Container, "mongorestore", "--version")
	if err != nil {
		return nil, fmt.Errorf("mongorestore absent du conteneur %s", p.Container)
	}
	r := &DbRestoreCheck{
		Tools:     strings.SplitN(strings.TrimSpace(string(v)), "\n", 2)[0],
		Databases: dbs,
		Free:      containerFree(ctx, p.Container),
	}
	for _, d := range dbs {
		if d.Name == target {
			r.Exists = true
		}
	}
	return r, nil
}

// --- db_restore --------------------------------------------------------------------------------

// mongoRestoreTmp: where the dump is copied in the container; removed at the end, whatever happens.
const mongoRestoreTmp = "/tmp/homelab-agent-restore"

var dbRestoreMu sync.Mutex

// restoreMountsOf: seam for the tests (the mounts of the host).
var restoreMountsOf = restoreMounts

// hasBson: the mounted archive looks like the dump of a MongoDB database (mongodump layout: <collection>.bson).
func hasBson(dir string) bool {
	m, _ := filepath.Glob(filepath.Join(dir, "*.bson"))
	return len(m) > 0
}

func validateDbRestore(s *DbRestoreSpec) error {
	if s == nil || s.Database == nil {
		return errors.New("missing restore settings")
	}
	if err := validateDbRestoreTarget(s.Kind, s.Database, s.Target); err != nil {
		return err
	}
	if s.Database.Container == "" {
		return errors.New("mongodb: container required")
	}
	if !dbNameRe.MatchString(s.Source) || !dbNameRe.MatchString(s.Target) {
		return errors.New("invalid database name")
	}
	if s.MountRoot != "" && !validPbsMountRoot(s.MountRoot) {
		return errors.New("invalid mount root")
	}
	return nil
}

// runDbRestore: restores the mounted dump into the new database. Never overwrites: refused when the
// target database exists (checked just before, mongorestore then only creates). On a failure the partial
// new database is left in place (the log says so): dropping is left to the admin.
func runDbRestore(ctx context.Context, s *DbRestoreSpec, emit func(string)) (err error) {
	if err := validateDbRestore(s); err != nil {
		return err
	}
	if !dbRestoreMu.TryLock() {
		return errors.New("a restore is already running on this host")
	}
	defer dbRestoreMu.Unlock()
	p := s.Database
	emit = mongoSafeEmit(emit, p.Password)

	mounts := restoreMountsOf(pbsMountRootFor(&PbsMountSpec{MountRoot: s.MountRoot}))
	if len(mounts) != 1 {
		return fmt.Errorf("expected exactly one mounted backup on this host, found %d", len(mounts))
	}
	dir := mounts[0]
	if !hasBson(dir) {
		return fmt.Errorf("%s does not look like a MongoDB dump (no .bson file)", dir)
	}

	env := append(os.Environ(), "LC_ALL=C")

	emit(fmt.Sprintf("verification de la cible %s dans %s…\n", s.Target, p.Container))
	_, dbs, lerr := listDatabases(ctx, s.Kind, p)
	if lerr != nil {
		return lerr
	}
	for _, d := range dbs {
		if d.Name == s.Target {
			return fmt.Errorf("la base %q existe deja sur %s : rien n'est ecrase", s.Target, p.Container)
		}
	}

	// the config file of the container is shared with the dumps (database.go): one at a time
	if err := func() error {
		mongoConfigMu.Lock()
		defer mongoConfigMu.Unlock()
		cleanup := func() {
			cctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			_ = runMongoDumpStep(cctx, env, func(string) {}, p, "docker", "exec", p.Container, "rm", "-rf", mongoRestoreTmp, mongoConfigPath)
		}
		cleanup()
		defer cleanup()

		if p.Username != "" {
			config, cerr := mongoConfig(p)
			if cerr != nil {
				return cerr
			}
			if err := runMongoDumpStepInput(ctx, env, emit, p, config, "docker", "exec", "-i", p.Container, "sh", "-c", "umask 077; cat > "+mongoConfigPath+" && chmod 600 "+mongoConfigPath); err != nil {
				return err
			}
		}
		dest := mongoRestoreTmp + "/" + s.Source
		if err := runMongoDumpStep(ctx, env, emit, p, "docker", "exec", p.Container, "mkdir", "-p", dest); err != nil {
			return err
		}
		emit("copie du dump dans le conteneur…\n")
		if err := runMongoDumpStep(ctx, env, emit, p, "docker", "cp", dir+"/.", p.Container+":"+dest); err != nil {
			return err
		}
		emit(fmt.Sprintf("restauration %s -> %s…\n", s.Source, s.Target))
		args := append([]string{"exec", p.Container, "mongorestore"}, mongoConfigArgs(p)...)
		args = append(args, "--nsInclude", s.Source+".*", "--nsFrom", s.Source+".$coll$", "--nsTo", s.Target+".$coll$", mongoRestoreTmp)
		if err := runMongoDumpStep(ctx, env, emit, p, "docker", args...); err != nil {
			emit(fmt.Sprintf("echec : la base %q peut etre partiellement creee, a supprimer a la main avant de recommencer\n", s.Target))
			return err
		}
		return nil
	}(); err != nil {
		return err
	}
	// the new database exists now
	_, dbs, lerr = listDatabases(ctx, s.Kind, p)
	if lerr != nil {
		return fmt.Errorf("verification apres restauration : %w", lerr)
	}
	for _, d := range dbs {
		if d.Name == s.Target {
			emit(fmt.Sprintf("base %s restauree (%d octets sur disque)\n", s.Target, d.Size))
			return nil
		}
	}
	return fmt.Errorf("la base %q est absente apres la restauration", s.Target)
}
