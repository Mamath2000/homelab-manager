package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Backups of directories to the Proxmox Backup Server, defined by the hub and run by the agent: with
// proxmox-backup-client on Linux (backup_unix.go), with the directory CLI of proxmoxbackupclient_go on
// Windows (backup_windows.go). The hub sends the whole definition (backup_sync); the agent keeps it on
// disk and runs the jobs on their schedule by itself, so backups go on while the hub is down. A run
// missed while the agent was stopped is caught up at start. Results are kept until the hub
// acknowledges them.
//
// Each side provides runBackup, validDirectory, checkPlatformJob and the database jobs (isDatabaseKind,
// jobArchives, validateDatabase, dumpDatabases, dumpSizes, finishDumps).

type BackupArchive struct {
	Name string `json:"name"` // <name>.pxar
	Path string `json:"path"`
}

type BackupJob struct {
	ID       string          `json:"id"`
	Name     string          `json:"name"`
	Archives []BackupArchive `json:"archives"`
	Excludes []string        `json:"excludes"`
	Store    string          `json:"store"`
	NS       string          `json:"ns"`
	BackupID string          `json:"backupId"`
	Schedule string          `json:"schedule"`
	// roaming hosts: instead of a schedule, run when the agent connects to the hub, at most once
	// every ConnectEveryDays days (since the last successful run)
	ConnectEveryDays int           `json:"connectEveryDays,omitempty"`
	TZ               string        `json:"tz"`
	Enabled          bool          `json:"enabled"`
	Kind             string        `json:"kind,omitempty"`     // directories (default) | postgres | mongodb (database.go)
	Database         *DatabaseDump `json:"database,omitempty"` // postgres, mongodb: what to dump
}

type DatabaseDump struct {
	Mode      string   `json:"mode,omitempty"`      // postgres: databases (pg_dump of each) | cluster (pg_basebackup); nextcloud: database | config
	Databases []string `json:"databases,omitempty"` // postgres databases mode, mongodb
	Container string   `json:"container,omitempty"` // mongodb: container running mongod
	WorkDir   string   `json:"workDir"`
	Keep      int      `json:"keep"` // dumps kept on the host after the backup (0: removed once sent)
}

// DumpInfo: size of a dump of a run and of its database, reported with its result.
type DumpInfo struct {
	Archive  string `json:"archive"`
	Database string `json:"database,omitempty"` // empty: globals, or the whole cluster
	DBSize   int64  `json:"dbSize"`             // -1: unknown
	DumpSize int64  `json:"dumpSize"`
}

type BackupSpec struct {
	Hash        string `json:"hash"`
	Server      string `json:"server"` // host:port of the PBS
	Fingerprint string `json:"fingerprint"`
	TokenID     string `json:"tokenId"`
	TokenSecret string `json:"tokenSecret"`
	Image       string `json:"image"` // client image, when the client is not installed
	// Windows: path of the directory CLI (proxmoxbackup-directory.exe), installed by hand
	ClientPath string      `json:"clientPath,omitempty"`
	Jobs       []BackupJob `json:"jobs"`
}

type BackupResult struct {
	ID      string `json:"id"`
	JobID   string `json:"jobId"`           // backup job
	RunID   string `json:"runId,omitempty"` // hub job of a run on demand
	Trigger string `json:"trigger"`         // schedule | catchup | connect | manual
	Start   int64  `json:"start"`           // unix ms
	End     int64  `json:"end"`
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
	Log     string `json:"log"` // end of the output
	// dumps of the preparation: size of each and of its database
	Dumps []DumpInfo `json:"dumps,omitempty"`
}

var (
	archiveNameRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	backupIDRe    = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$`)
	storeRe       = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$`)
	nsRe          = regexp.MustCompile(`^([A-Za-z0-9_][A-Za-z0-9._-]{0,31})(/[A-Za-z0-9_][A-Za-z0-9._-]{0,31}){0,7}$`)
	tokenIDRe     = regexp.MustCompile(`^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z0-9._-]+$`)
	serverRe      = regexp.MustCompile(`^[A-Za-z0-9.\-\[\]:]+:\d{1,5}$`)
	imageRe       = regexp.MustCompile(`^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[0-9a-f]{64})?$`)
	jobIDRe       = regexp.MustCompile(`^[0-9a-f]{24}$`)
)

func validateBackupSpec(s *BackupSpec) error {
	if s.Image != "" && !imageRe.MatchString(s.Image) {
		return fmt.Errorf("invalid client image %q", s.Image)
	}
	if s.ClientPath != "" && (!filepath.IsAbs(s.ClientPath) || len(s.ClientPath) > 260 || strings.ContainsAny(s.ClientPath, "\n\x00")) {
		return fmt.Errorf("invalid client path %q", s.ClientPath)
	}
	if len(s.Jobs) == 0 {
		return nil // nothing to run: credentials may be absent
	}
	if !serverRe.MatchString(s.Server) || !tokenIDRe.MatchString(s.TokenID) || s.TokenSecret == "" {
		return errors.New("invalid PBS server or token")
	}
	for _, j := range s.Jobs {
		if !jobIDRe.MatchString(j.ID) || !backupIDRe.MatchString(j.BackupID) || !storeRe.MatchString(j.Store) || (j.NS != "" && !nsRe.MatchString(j.NS)) {
			return fmt.Errorf("invalid job %q", j.ID)
		}
		if j.ConnectEveryDays < 0 || j.ConnectEveryDays > 365 {
			return fmt.Errorf("job %s: connectEveryDays %d", j.ID, j.ConnectEveryDays)
		}
		if j.ConnectEveryDays == 0 {
			if _, err := parseCalendar(j.Schedule); err != nil {
				return fmt.Errorf("job %s: schedule %q: %w", j.ID, j.Schedule, err)
			}
		}
		if _, err := time.LoadLocation(j.TZ); err != nil || j.TZ == "" {
			return fmt.Errorf("job %s: time zone %q", j.ID, j.TZ)
		}
		switch {
		case j.Kind == "" || j.Kind == "directories":
			if j.Database != nil {
				return fmt.Errorf("job %s: database settings on a directories job", j.ID)
			}
		case isDatabaseKind(j.Kind):
			// only its dumps: no directory, no exclusion
			if j.Database == nil || len(j.Archives) != 0 || len(j.Excludes) != 0 {
				return fmt.Errorf("job %s: a database job holds its dumps only", j.ID)
			}
			if err := validateDatabase(j.Kind, j.Database); err != nil {
				return fmt.Errorf("job %s: %w", j.ID, err)
			}
		default:
			return fmt.Errorf("job %s: unknown kind %q", j.ID, j.Kind)
		}
		if err := checkPlatformJob(j); err != nil {
			return fmt.Errorf("job %s: %w", j.ID, err)
		}
		if len(jobArchives(j)) == 0 {
			return fmt.Errorf("job %s: no directory", j.ID)
		}
		if err := validateDirectories(jobArchives(j), j.Excludes); err != nil {
			return fmt.Errorf("job %s: %w", j.ID, err)
		}
	}
	return nil
}

// validateDirectories: the archives (name, absolute clean path) and exclusions of a job.
func validateDirectories(archives []BackupArchive, excludes []string) error {
	names := map[string]bool{}
	for _, a := range archives {
		if names[a.Name] {
			return fmt.Errorf("archive %q twice", a.Name)
		}
		names[a.Name] = true
		if !archiveNameRe.MatchString(a.Name) || !validDirectory(a.Path) {
			return fmt.Errorf("invalid directory %q", a.Path)
		}
	}
	for _, e := range excludes {
		if e == "" || len(e) > 256 || strings.ContainsAny(e, "\n\x00") {
			return errors.New("invalid exclusion")
		}
	}
	return nil
}

// --- module ------------------------------------------------------------------------------------

type backupState struct {
	Spec      *BackupSpec      `json:"spec"`
	FirstSeen map[string]int64 `json:"firstSeen"` // when a job appeared: earlier runs are not caught up
	LastRun   map[string]int64 `json:"lastRun"`   // start of the last run of each job
	LastOK    map[string]int64 `json:"lastOk"`    // start of the last successful run of each job
}

type backupModule struct {
	mu    sync.Mutex
	dir   string
	state backupState
	// when the agent connected to the hub (unix ms), 0 while disconnected: jobs set to run on
	// connection are due only then
	connectedAt int64
	runMu       sync.Mutex // one backup at a time

	sendMu sync.Mutex
	send   func(Outbound) error
	kick   chan struct{}
}

func newBackupModule(dir string) *backupModule {
	b := &backupModule{dir: dir, kick: make(chan struct{}, 1), state: backupState{FirstSeen: map[string]int64{}, LastRun: map[string]int64{}, LastOK: map[string]int64{}}}
	if raw, err := os.ReadFile(b.statePath()); err == nil {
		var st backupState
		if json.Unmarshal(raw, &st) == nil {
			if st.FirstSeen == nil {
				st.FirstSeen = map[string]int64{}
			}
			if st.LastRun == nil {
				st.LastRun = map[string]int64{}
			}
			if st.LastOK == nil {
				st.LastOK = map[string]int64{}
			}
			b.state = st
		}
	}
	return b
}

func (b *backupModule) statePath() string  { return filepath.Join(b.dir, "backup.json") }
func (b *backupModule) resultsDir() string { return filepath.Join(b.dir, "backup-results") }

// holds the token secret: 0600 (the agent directory is root only)
func (b *backupModule) saveLocked() {
	raw, _ := json.Marshal(b.state)
	if err := os.MkdirAll(b.dir, 0o700); err != nil {
		log.Printf("backup state: %v", err)
		return
	}
	if err := writeFileAtomic(b.statePath(), raw, 0o600); err != nil {
		log.Printf("backup state: %v", err)
	}
}

// apply stores a new definition sent by the hub.
func (b *backupModule) apply(s *BackupSpec) error {
	if err := validateBackupSpec(s); err != nil {
		return err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now().UnixMilli()
	keep := map[string]bool{}
	for _, j := range s.Jobs {
		keep[j.ID] = true
		if _, ok := b.state.FirstSeen[j.ID]; !ok {
			b.state.FirstSeen[j.ID] = now
		}
	}
	for id := range b.state.FirstSeen {
		if !keep[id] {
			delete(b.state.FirstSeen, id)
			delete(b.state.LastRun, id)
			delete(b.state.LastOK, id)
		}
	}
	b.state.Spec = s
	b.saveLocked()
	return nil
}

func (b *backupModule) hash() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.state.Spec == nil {
		return ""
	}
	return b.state.Spec.Hash
}

// due returns the jobs whose last scheduled time is after their last run (and after they appeared),
// and, while connected to the hub, those set to run on connection whose last success is old enough.
func (b *backupModule) due(now time.Time) []BackupJob {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.state.Spec == nil {
		return nil
	}
	var out []BackupJob
	for _, j := range b.state.Spec.Jobs {
		if !j.Enabled {
			continue
		}
		if j.ConnectEveryDays > 0 {
			// once per connection (a failed run is retried at the next one), when the last success is old enough
			age := time.Duration(j.ConnectEveryDays) * 24 * time.Hour
			if b.connectedAt > 0 && b.state.LastRun[j.ID] < b.connectedAt && now.UnixMilli()-b.state.LastOK[j.ID] >= age.Milliseconds() {
				out = append(out, j)
			}
			continue
		}
		spec, err := parseCalendar(j.Schedule)
		if err != nil {
			continue
		}
		loc, err := time.LoadLocation(j.TZ)
		if err != nil {
			continue
		}
		prev := spec.previous(now, loc)
		since := max(b.state.FirstSeen[j.ID], b.state.LastRun[j.ID])
		if !prev.IsZero() && prev.UnixMilli() > since {
			out = append(out, j)
		}
	}
	return out
}

func (b *backupModule) job(id string) (BackupJob, *BackupSpec, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.state.Spec == nil {
		return BackupJob{}, nil, false
	}
	for _, j := range b.state.Spec.Jobs {
		if j.ID == id {
			spec := *b.state.Spec
			return j, &spec, true
		}
	}
	return BackupJob{}, nil, false
}

// loop runs the scheduled jobs, one at a time; started once for the whole process.
func (b *backupModule) loop(ctx context.Context) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	first := true
	for {
		for _, j := range b.due(time.Now()) {
			trigger := "schedule"
			if j.ConnectEveryDays > 0 {
				trigger = "connect"
			} else if first {
				trigger = "catchup"
			}
			b.runJob(ctx, j.ID, trigger, "", func(string) {})
		}
		first = false
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-b.kick:
		}
	}
}

// runJob runs one backup and keeps its result for the hub; the exit code and error are the job's.
func (b *backupModule) runJob(ctx context.Context, jobID, trigger, runID string, emit func(string)) (int, error) {
	b.runMu.Lock()
	defer b.runMu.Unlock()
	j, spec, ok := b.job(jobID)
	if !ok {
		return -1, fmt.Errorf("unknown backup job %s", jobID)
	}
	start := time.Now()
	b.mu.Lock()
	b.state.LastRun[j.ID] = start.UnixMilli()
	b.saveLocked()
	b.mu.Unlock()

	tail := newTail(16 * 1024)
	out := func(s string) {
		tail.write(s)
		emit(s)
	}
	// a backup must never be cut by the hub connection: own context, long limit
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 12*time.Hour)
	defer cancel()
	var code int
	var err error
	var dumps []DumpInfo
	db := isDatabaseKind(j.Kind)
	if db {
		out(fmt.Sprintf("dump %s dans %s\n", j.Kind, j.Database.WorkDir))
		if derr := dumpDatabases(rctx, j.Kind, j.Database, out); derr != nil {
			code, err = -1, fmt.Errorf("dump %s : %w", j.Kind, derr)
		} else {
			dumps = dumpSizes(rctx, j.Kind, j.Database)
		}
	}
	if err == nil {
		code, err = runBackup(rctx, spec, j, out)
	}
	if db {
		finishDumps(j.Kind, j.Database, dumps != nil, start, out)
	}
	res := BackupResult{ID: randomID(), JobID: j.ID, RunID: runID, Trigger: trigger, Start: start.UnixMilli(), End: time.Now().UnixMilli(), OK: err == nil && code == 0, Log: tail.String(), Dumps: dumps}
	if err != nil {
		res.Error = err.Error()
	} else if code != 0 {
		res.Error = fmt.Sprintf("proxmox-backup-client a échoué (code %d)", code)
	}
	if res.OK {
		b.mu.Lock()
		b.state.LastOK[j.ID] = start.UnixMilli()
		b.saveLocked()
		b.mu.Unlock()
	}
	b.keep(res)
	b.flush()
	if err == nil && code != 0 {
		err = errors.New(res.Error)
	}
	return code, err
}

// --- results -------------------------------------------------------------------------------

func (b *backupModule) keep(r BackupResult) {
	if err := os.MkdirAll(b.resultsDir(), 0o700); err != nil {
		log.Printf("backup result: %v", err)
		return
	}
	raw, _ := json.Marshal(r)
	if err := writeFileAtomic(filepath.Join(b.resultsDir(), r.ID+".json"), raw, 0o600); err != nil {
		log.Printf("backup result: %v", err)
	}
}

// flush sends the results not acknowledged yet, oldest first.
func (b *backupModule) flush() {
	b.sendMu.Lock()
	send := b.send
	b.sendMu.Unlock()
	if send == nil {
		return
	}
	entries, err := os.ReadDir(b.resultsDir())
	if err != nil {
		return
	}
	names := []string{}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".json") && !strings.HasPrefix(e.Name(), ".") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, n := range names {
		raw, err := os.ReadFile(filepath.Join(b.resultsDir(), n))
		if err != nil {
			continue
		}
		var r BackupResult
		if json.Unmarshal(raw, &r) != nil {
			_ = os.Remove(filepath.Join(b.resultsDir(), n))
			continue
		}
		if send(Outbound{Type: "backup_result", Result: r}) != nil {
			return
		}
	}
}

var resultIDRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

func (b *backupModule) ack(id string) {
	if !resultIDRe.MatchString(id) {
		return
	}
	_ = os.Remove(filepath.Join(b.resultsDir(), id+".json"))
}

func (b *backupModule) attach(send func(Outbound) error) {
	b.sendMu.Lock()
	b.send = send
	b.sendMu.Unlock()
	b.mu.Lock()
	b.connectedAt = time.Now().UnixMilli()
	b.mu.Unlock()
	go b.flush()
	select { // the loop need not wait for its tick
	case b.kick <- struct{}{}:
	default:
	}
}

func (b *backupModule) detach() {
	b.mu.Lock()
	b.connectedAt = 0
	b.mu.Unlock()
	b.sendMu.Lock()
	b.send = nil
	b.sendMu.Unlock()
}

// result ids sort by time: the hub gets them in order
func randomID() string {
	var r [10]byte
	_, _ = rand.Read(r[:])
	return fmt.Sprintf("%012x", time.Now().UnixMilli())[:12] + hex.EncodeToString(r[:])
}

// tail keeps the last bytes written.
type tailBuffer struct {
	max int
	buf []byte
}

func newTail(max int) *tailBuffer { return &tailBuffer{max: max} }

func (t *tailBuffer) write(s string) {
	t.buf = append(t.buf, s...)
	if len(t.buf) > t.max {
		t.buf = t.buf[len(t.buf)-t.max:]
	}
}

func (t *tailBuffer) String() string { return string(t.buf) }
