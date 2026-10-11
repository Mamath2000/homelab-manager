package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// Backups of directories to the Proxmox Backup Server, defined by the hub and run by the agent
// with proxmox-backup-client: natively when the client is installed, otherwise in a container
// (Unraid). The hub sends the whole definition (backup_sync); the agent keeps it on disk and runs
// the jobs on their schedule by itself, so backups go on while the hub is down. A run missed while
// the agent was stopped is caught up at start. Results are kept until the hub acknowledges them.

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
	TZ       string          `json:"tz"`
	Enabled  bool            `json:"enabled"`
}

type BackupSpec struct {
	Hash        string      `json:"hash"`
	Server      string      `json:"server"` // host:port of the PBS
	Fingerprint string      `json:"fingerprint"`
	TokenID     string      `json:"tokenId"`
	TokenSecret string      `json:"tokenSecret"`
	Image       string      `json:"image"` // client image, when the client is not installed
	Jobs        []BackupJob `json:"jobs"`
}

type BackupResult struct {
	ID      string `json:"id"`
	JobID   string `json:"jobId"`           // backup job
	RunID   string `json:"runId,omitempty"` // hub job of a run on demand
	Trigger string `json:"trigger"`         // schedule | catchup | manual
	Start   int64  `json:"start"`           // unix ms
	End     int64  `json:"end"`
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
	Log     string `json:"log"` // end of the output
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
		if _, err := parseCalendar(j.Schedule); err != nil {
			return fmt.Errorf("job %s: schedule %q: %w", j.ID, j.Schedule, err)
		}
		if _, err := time.LoadLocation(j.TZ); err != nil || j.TZ == "" {
			return fmt.Errorf("job %s: time zone %q", j.ID, j.TZ)
		}
		if len(j.Archives) == 0 {
			return fmt.Errorf("job %s: no directory", j.ID)
		}
		for _, a := range j.Archives {
			// ':' separates the archive spec and the docker volume: refused in paths
			if !archiveNameRe.MatchString(a.Name) || !filepath.IsAbs(a.Path) || filepath.Clean(a.Path) != a.Path || strings.ContainsAny(a.Path, ":\n") {
				return fmt.Errorf("job %s: invalid directory %q", j.ID, a.Path)
			}
		}
		for _, e := range j.Excludes {
			if e == "" || len(e) > 256 || strings.ContainsAny(e, "\n\x00") {
				return fmt.Errorf("job %s: invalid exclusion", j.ID)
			}
		}
	}
	return nil
}

// --- module ------------------------------------------------------------------------------------

type backupState struct {
	Spec      *BackupSpec      `json:"spec"`
	FirstSeen map[string]int64 `json:"firstSeen"` // when a job appeared: earlier runs are not caught up
	LastRun   map[string]int64 `json:"lastRun"`   // start of the last run of each job
}

type backupModule struct {
	mu    sync.Mutex
	dir   string
	state backupState
	runMu sync.Mutex // one backup at a time

	sendMu sync.Mutex
	send   func(Outbound) error
	kick   chan struct{}
}

var backups = newBackupModule(stateDir())

func newBackupModule(dir string) *backupModule {
	b := &backupModule{dir: dir, kick: make(chan struct{}, 1), state: backupState{FirstSeen: map[string]int64{}, LastRun: map[string]int64{}}}
	if raw, err := os.ReadFile(b.statePath()); err == nil {
		var st backupState
		if json.Unmarshal(raw, &st) == nil {
			if st.FirstSeen == nil {
				st.FirstSeen = map[string]int64{}
			}
			if st.LastRun == nil {
				st.LastRun = map[string]int64{}
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

// Client image when the definition does not name one (the hub sends its setting with every definition).
const defaultClientImage = "mathmath350/pbs-client:latest"

func (b *backupModule) image() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.state.Spec != nil && b.state.Spec.Image != "" {
		return b.state.Spec.Image
	}
	return defaultClientImage
}

// The client image is published for amd64 only.
func dockerBackupPossible(ctx context.Context) bool {
	if onWSL || runtime.GOARCH != "amd64" || !dock.available(ctx) {
		return false
	}
	_, err := exec.LookPath("docker")
	return err == nil
}

func imagePresent(ctx context.Context, image string) bool {
	return exec.CommandContext(ctx, "docker", "image", "inspect", image).Run() == nil
}

// Debian release the client repository of Proxmox serves (amd64 only); "" when not available here.
func aptBackupCodename() string {
	if runtime.GOARCH != "amd64" || !hasApt() {
		return ""
	}
	rel := osRelease()
	if rel["ID"] != "debian" {
		return ""
	}
	switch c := rel["VERSION_CODENAME"]; c {
	case "bookworm", "trixie":
		return c
	}
	return ""
}

func osRelease() map[string]string {
	out := map[string]string{}
	raw, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return out
	}
	for _, l := range strings.Split(string(raw), "\n") {
		if k, v, ok := strings.Cut(l, "="); ok {
			out[k] = strings.Trim(v, `"`)
		}
	}
	return out
}

// backupMode: how this host runs proxmox-backup-client: "native" (installed), "docker" (client
// image present), "" (neither: to install).
func backupMode(ctx context.Context) string {
	if _, err := exec.LookPath("proxmox-backup-client"); err == nil {
		return "native"
	}
	if dockerBackupPossible(ctx) && imagePresent(ctx, backups.image()) {
		return "docker"
	}
	return ""
}

// backupInstallOptions: how the client can be installed here, given the current mode.
func backupInstallOptions(ctx context.Context, mode string) []string {
	var out []string
	if mode != "native" && aptBackupCodename() != "" {
		out = append(out, "apt")
	}
	if mode == "" && dockerBackupPossible(ctx) {
		out = append(out, "docker")
	}
	return out
}

// installBackupClient installs the client: the client-only repository of Proxmox and its package,
// or the client image.
func installBackupClient(ctx context.Context, method string, emit func(string)) (int, error) {
	switch method {
	case "apt":
		codename := aptBackupCodename()
		if codename == "" {
			return -1, errors.New("APT install: Debian bookworm or trixie on amd64 only")
		}
		keyring := "/usr/share/keyrings/proxmox-release-" + codename + ".gpg"
		keyURL := "https://enterprise.proxmox.com/debian/proxmox-release-" + codename + ".gpg"
		emit("downloading the Proxmox release key " + keyURL + "\n")
		key, err := httpGetBytes(ctx, keyURL, 64*1024)
		if err != nil {
			return -1, fmt.Errorf("release key: %w", err)
		}
		if err := os.WriteFile(keyring, key, 0o644); err != nil {
			return -1, err
		}
		list := "deb [signed-by=" + keyring + "] http://download.proxmox.com/debian/pbs-client " + codename + " main\n"
		if err := os.WriteFile("/etc/apt/sources.list.d/pbs-client.list", []byte(list), 0o644); err != nil {
			return -1, err
		}
		emit("/etc/apt/sources.list.d/pbs-client.list: " + list)
		if code, err := runStreaming(ctx, aptEnv(), emit, "apt-get", "update"); err != nil || code != 0 {
			return code, err
		}
		return runStreaming(ctx, aptEnv(), emit, "apt-get", "install", "-y", "proxmox-backup-client")
	case "docker":
		if !dockerBackupPossible(ctx) {
			return -1, errors.New("Docker install: Docker on amd64 only (the client image is published for amd64)")
		}
		return runStreaming(ctx, os.Environ(), emit, "docker", "pull", backups.image())
	default:
		return -1, fmt.Errorf("unknown install method %q", method)
	}
}

func httpGetBytes(ctx context.Context, url string, max int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := (&http.Client{Timeout: time.Minute}).Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return io.ReadAll(io.LimitReader(res.Body, max))
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

// due returns the jobs whose last scheduled time is after their last run (and after they appeared).
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
			if first {
				trigger = "catchup"
			}
			b.runJob(ctx, j.ID, trigger, "", func(string) {})
		}
		first = false
		select {
		case <-ctx.Done():
			return
		case <-t.C:
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
	code, err := runBackup(rctx, spec, j, out)
	res := BackupResult{ID: randomID(), JobID: j.ID, RunID: runID, Trigger: trigger, Start: start.UnixMilli(), End: time.Now().UnixMilli(), OK: err == nil && code == 0, Log: tail.String()}
	if err != nil {
		res.Error = err.Error()
	} else if code != 0 {
		res.Error = fmt.Sprintf("proxmox-backup-client a échoué (code %d)", code)
	}
	b.keep(res)
	b.flush()
	if err == nil && code != 0 {
		err = errors.New(res.Error)
	}
	return code, err
}

func backupArgs(j BackupJob) []string {
	args := []string{"backup"}
	for _, a := range j.Archives {
		args = append(args, a.Name+".pxar:"+a.Path)
	}
	args = append(args, "--backup-type", "host", "--backup-id", j.BackupID)
	if j.NS != "" {
		args = append(args, "--ns", j.NS)
	}
	for _, e := range j.Excludes {
		args = append(args, "--exclude", e)
	}
	return args
}

// The secret goes through the environment only, never the command line (visible in ps).
func backupEnv(spec *BackupSpec, j BackupJob) []string {
	return append(os.Environ(),
		"LC_ALL=C",
		"PBS_REPOSITORY="+spec.TokenID+"@"+spec.Server+":"+j.Store,
		"PBS_PASSWORD="+spec.TokenSecret,
		"PBS_FINGERPRINT="+spec.Fingerprint,
	)
}

func runBackup(ctx context.Context, spec *BackupSpec, j BackupJob, emit func(string)) (int, error) {
	env := backupEnv(spec, j)
	switch backupMode(ctx) {
	case "native":
		emit(fmt.Sprintf("proxmox-backup-client %s\n", strings.Join(backupArgs(j), " ")))
		return runStreaming(ctx, env, emit, "proxmox-backup-client", backupArgs(j)...)
	case "docker":
		if spec.Image == "" {
			return -1, errors.New("no proxmox-backup-client and no client image")
		}
		if err := exec.CommandContext(ctx, "docker", "image", "inspect", spec.Image).Run(); err != nil {
			emit("pulling " + spec.Image + "\n")
			if code, err := runStreaming(ctx, os.Environ(), emit, "docker", "pull", spec.Image); err != nil || code != 0 {
				return code, fmt.Errorf("docker pull %s failed", spec.Image)
			}
		}
		args := []string{"run", "--rm", "--network", "host", "-e", "PBS_REPOSITORY", "-e", "PBS_PASSWORD", "-e", "PBS_FINGERPRINT", "-e", "LC_ALL"}
		for _, a := range j.Archives {
			args = append(args, "-v", a.Path+":"+a.Path+":ro")
		}
		args = append(args, spec.Image)
		args = append(args, backupArgs(j)...)
		emit(fmt.Sprintf("docker run … %s %s\n", spec.Image, strings.Join(backupArgs(j), " ")))
		return runStreaming(ctx, env, emit, "docker", args...)
	default:
		return -1, errors.New("proxmox-backup-client unavailable (neither installed nor Docker)")
	}
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
	go b.flush()
}

func (b *backupModule) detach() {
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
