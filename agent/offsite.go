package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Copy to a secondary PBS ("copie déportée") run by the agent of that PBS: the hub sends the groups to
// copy (offsite_sync) with the rules of a queue; the agent keeps them on disk, finds the groups whose
// main PBS has a newer snapshot (scan of the remote), queues them (FIFO, once each) and starts their sync
// job (hlm-*, no schedule of the PBS) within the time window, never more than N heavy tasks at a time.
// The PBS is reached through proxmox-backup-debug (local API as root, no token), natively or in its
// container. The copies go on while the hub is down; the hub follows the tasks as before (offsite.ts).

type OffsiteJob struct {
	ID          string `json:"id"`          // hlm-<hash>: the sync job on the PBS
	RemoteStore string `json:"remoteStore"` // datastore of the main PBS
	NS          string `json:"ns"`          // namespace, the same on both PBS
	Type        string `json:"type"`        // vm | ct | host
	BackupID    string `json:"backupId"`
}

type OffsiteSpec struct {
	Hash      string       `json:"hash"`
	Container string       `json:"container"` // PBS in this container; empty: installed on the host
	Store     string       `json:"store"`     // target datastore
	Remote    string       `json:"remote"`    // remote entry of the main PBS
	Jobs      []OffsiteJob `json:"jobs"`
	// queue: launches only from WindowStart to WindowEnd (HH:MM, may cross midnight; equal: all day),
	// at most Concurrency heavy tasks, a group at most once per MinDelayH hours
	WindowStart string `json:"windowStart"`
	WindowEnd   string `json:"windowEnd"`
	TZ          string `json:"tz"`
	Concurrency int    `json:"concurrency"`
	MinDelayH   int    `json:"minDelayH"`
	// verifications and garbage collections count as heavy tasks
	CountMaintenance bool `json:"countMaintenance"`
}

type OffsiteQueued struct {
	JobID string `json:"jobId"`
	Since int64  `json:"since"` // queued at (unix ms)
}

type OffsiteRunning struct {
	JobID string `json:"jobId,omitempty"` // empty: another heavy task of the PBS
	UPID  string `json:"upid"`
	Type  string `json:"type"`
	Start int64  `json:"start"` // unix ms
}

// OffsiteReport: state of the queue, sent to the hub when it changes and after each scan.
type OffsiteReport struct {
	Hash      string           `json:"hash"`
	ScannedAt int64            `json:"scannedAt"` // unix ms, 0: never
	Queue     []OffsiteQueued  `json:"queue"`
	Running   []OffsiteRunning `json:"running"`
	InWindow  bool             `json:"inWindow"`
	Error     string           `json:"error,omitempty"` // last scan or launch failed
}

var (
	offsiteJobIDRe  = regexp.MustCompile(`^hlm-[0-9a-f]{12}$`)
	offsiteRemoteRe = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,31}$`)
	hhmmRe          = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
	upidRe          = regexp.MustCompile(`UPID:[^\s"]+`)
)

func validateOffsiteSpec(s *OffsiteSpec) error {
	if s.Container != "" && !pbsContainerRe.MatchString(s.Container) {
		return fmt.Errorf("invalid container %q", s.Container)
	}
	if len(s.Jobs) == 0 {
		return nil // nothing to copy: the queue is emptied
	}
	if !storeRe.MatchString(s.Store) || !offsiteRemoteRe.MatchString(s.Remote) {
		return errors.New("invalid target datastore or remote")
	}
	if !hhmmRe.MatchString(s.WindowStart) || !hhmmRe.MatchString(s.WindowEnd) {
		return fmt.Errorf("invalid window %q-%q", s.WindowStart, s.WindowEnd)
	}
	if _, err := time.LoadLocation(s.TZ); err != nil || s.TZ == "" {
		return fmt.Errorf("time zone %q", s.TZ)
	}
	if s.Concurrency < 1 || s.Concurrency > 8 || s.MinDelayH < 0 || s.MinDelayH > 720 {
		return errors.New("invalid concurrency or minimum delay")
	}
	for _, j := range s.Jobs {
		if !offsiteJobIDRe.MatchString(j.ID) || !storeRe.MatchString(j.RemoteStore) || (j.NS != "" && !nsRe.MatchString(j.NS)) ||
			(j.Type != "vm" && j.Type != "ct" && j.Type != "host") || !backupIDRe.MatchString(j.BackupID) {
			return fmt.Errorf("invalid job %q", j.ID)
		}
	}
	return nil
}

// --- rules of the queue (pure) -------------------------------------------------------------

func minutesOf(hhmm string) int {
	h, _ := strconv.Atoi(hhmm[:2])
	m, _ := strconv.Atoi(hhmm[3:])
	return h*60 + m
}

// inWindow: the wall-clock time of now in loc is in [start, end), the window may cross midnight.
func inWindow(now time.Time, loc *time.Location, start, end string) bool {
	s, e := minutesOf(start), minutesOf(end)
	if s == e {
		return true
	}
	t := now.In(loc)
	m := t.Hour()*60 + t.Minute()
	if s < e {
		return m >= s && m < e
	}
	return m >= s || m < e
}

// The daily copies would drift by the time they wait in the queue: the delay is counted with this slack.
const offsiteDelaySlack = time.Hour

// groupState: what the scan tells of one group.
type groupState struct {
	remoteLast int64 // last snapshot on the main PBS (unix s), 0: none
	localLast  int64 // last snapshot on the secondary (unix s), 0: none
	lastRun    int64 // start of the last run of its sync job (unix ms), 0: never
}

// wanted: the main PBS has a newer snapshot and the last run is old enough.
func (g groupState) wanted(now time.Time, minDelay time.Duration) bool {
	if g.remoteLast == 0 || g.remoteLast <= g.localLast {
		return false
	}
	return g.lastRun == 0 || now.Sub(time.UnixMilli(g.lastRun)) >= minDelay-offsiteDelaySlack
}

// requeue: the queue after a scan. Groups still wanted keep their place, new ones go at the end (in the
// order of the jobs), the others (copied meanwhile, no longer copied) leave; running ones are not queued.
func requeue(queue []OffsiteQueued, jobs []OffsiteJob, states map[string]groupState, running map[string]bool, now time.Time, minDelay time.Duration) []OffsiteQueued {
	known := map[string]bool{}
	for _, j := range jobs {
		known[j.ID] = true
	}
	out := []OffsiteQueued{}
	in := map[string]bool{}
	for _, q := range queue {
		st, ok := states[q.JobID]
		// kept while its state is unknown (scan of its namespace failed)
		if known[q.JobID] && !running[q.JobID] && !in[q.JobID] && (!ok || st.remoteLast > st.localLast) {
			out = append(out, q)
			in[q.JobID] = true
		}
	}
	for _, j := range jobs {
		if st, ok := states[j.ID]; ok && !in[j.ID] && !running[j.ID] && st.wanted(now, minDelay) {
			out = append(out, OffsiteQueued{JobID: j.ID, Since: now.UnixMilli()})
			in[j.ID] = true
		}
	}
	return out
}

// heavy: the tasks of the PBS that count in the concurrency.
func heavy(workerType string, maintenance bool) bool {
	if workerType == "syncjob" {
		return true
	}
	return maintenance && (workerType == "garbage_collection" || strings.HasPrefix(workerType, "verif"))
}

// jobOfTask: the sync job of a task, from its worker id (remote:store:target:ns:hlm-<hash>).
func jobOfTask(workerID string) string {
	i := strings.LastIndex(workerID, ":")
	id := workerID[i+1:]
	if offsiteJobIDRe.MatchString(id) {
		return id
	}
	return ""
}

// --- module --------------------------------------------------------------------------------

type offsiteState struct {
	Spec  *OffsiteSpec    `json:"spec,omitempty"`
	Queue []OffsiteQueued `json:"queue"`
}

type offsiteModule struct {
	dir string
	// run: proxmox-backup-debug of the PBS of the spec (tests: a fake)
	tool func(container string) pbsRun

	mu       sync.Mutex
	state    offsiteState
	running  []OffsiteRunning
	scanned  int64
	window   bool
	lastErr  string
	failedAt map[string]time.Time // launch failed: not retried before an hour
	sent     string               // last report sent (json)

	sendMu sync.Mutex
	send   func(Outbound) error
	kick   chan struct{}
}

var offsite = newOffsiteModule(stateDir())

func newOffsiteModule(dir string) *offsiteModule {
	o := &offsiteModule{dir: dir, kick: make(chan struct{}, 1), failedAt: map[string]time.Time{},
		tool: func(c string) pbsRun { return pbsTool(c, "proxmox-backup-debug") }}
	if raw, err := os.ReadFile(o.path()); err == nil {
		var st offsiteState
		if json.Unmarshal(raw, &st) == nil {
			o.state = st
		}
	}
	return o
}

func (o *offsiteModule) path() string { return filepath.Join(o.dir, "offsite.json") }

func (o *offsiteModule) saveLocked() {
	raw, _ := json.Marshal(o.state)
	if err := os.MkdirAll(o.dir, 0o700); err != nil {
		log.Printf("offsite state: %v", err)
		return
	}
	if err := writeFileAtomic(o.path(), raw, 0o600); err != nil {
		log.Printf("offsite state: %v", err)
	}
}

// apply stores a new definition sent by the hub; the queue keeps the groups still copied.
func (o *offsiteModule) apply(s *OffsiteSpec) error {
	if err := validateOffsiteSpec(s); err != nil {
		return err
	}
	o.mu.Lock()
	known := map[string]bool{}
	for _, j := range s.Jobs {
		known[j.ID] = true
	}
	q := []OffsiteQueued{}
	for _, e := range o.state.Queue {
		if known[e.JobID] {
			q = append(q, e)
		}
	}
	o.state = offsiteState{Spec: s, Queue: q}
	o.saveLocked()
	o.mu.Unlock()
	o.wake()
	return nil
}

func (o *offsiteModule) wake() {
	select {
	case o.kick <- struct{}{}:
	default:
	}
}

func (o *offsiteModule) spec() *OffsiteSpec {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.state.Spec == nil || len(o.state.Spec.Jobs) == 0 {
		return nil
	}
	s := *o.state.Spec
	return &s
}

// api calls the local API of the PBS; out receives its JSON answer.
func (o *offsiteModule) api(ctx context.Context, s *OffsiteSpec, method, path string, out any, params ...string) error {
	cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	args := append([]string{"api", method, path}, params...)
	raw, err := o.tool(s.Container)(cctx, append(args, "--output-format", "json")...)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(raw)), out); err != nil {
		return fmt.Errorf("%s %s: answer not understood: %v", method, path, err)
	}
	return nil
}

type apiGroup struct {
	Type       string `json:"backup-type"`
	ID         string `json:"backup-id"`
	LastBackup int64  `json:"last-backup"`
}

type apiSyncStatus struct {
	ID       string `json:"id"`
	LastUPID string `json:"last-run-upid"`
	LastEnd  int64  `json:"last-run-endtime"`
}

type apiTask struct {
	UPID       string `json:"upid"`
	WorkerType string `json:"worker_type"`
	WorkerID   string `json:"worker_id"`
	StartTime  int64  `json:"starttime"`
}

// upidStartMs: start of a task from its UPID (UPID:node:pid:pstart:taskid:starttime:...; hexadecimal).
func upidStartMs(upid string) int64 {
	f := strings.Split(upid, ":")
	if len(f) < 7 || f[0] != "UPID" {
		return 0
	}
	t, err := strconv.ParseInt(f[5], 16, 64)
	if err != nil {
		return 0
	}
	return t * 1000
}

// scan reads the groups on both PBS and the last run of each sync job.
func (o *offsiteModule) scan(ctx context.Context, s *OffsiteSpec) (map[string]groupState, error) {
	type key struct{ store, ns string }
	remote := map[key]map[string]int64{}
	local := map[string]map[string]int64{}
	var errs []string
	read := func(path string, params ...string) map[string]int64 {
		var list []apiGroup
		if err := o.api(ctx, s, "get", path, &list, params...); err != nil {
			errs = append(errs, err.Error())
			return nil
		}
		m := map[string]int64{}
		for _, g := range list {
			m[g.Type+"/"+g.ID] = g.LastBackup
		}
		return m
	}
	for _, j := range s.Jobs {
		k := key{j.RemoteStore, j.NS}
		if _, ok := remote[k]; !ok {
			p := []string{}
			if j.NS != "" {
				p = []string{"--namespace", j.NS}
			}
			remote[k] = read(fmt.Sprintf("/config/remote/%s/scan/%s/groups", s.Remote, j.RemoteStore), p...)
		}
		if _, ok := local[j.NS]; !ok {
			p := []string{}
			if j.NS != "" {
				p = []string{"--ns", j.NS}
			}
			// a namespace missing on the secondary: its groups were never copied
			local[j.NS] = read(fmt.Sprintf("/admin/datastore/%s/groups", s.Store), p...)
		}
	}
	var status []apiSyncStatus
	if err := o.api(ctx, s, "get", "/admin/sync", &status); err != nil {
		return nil, err
	}
	runs := map[string]int64{}
	for _, st := range status {
		if t := upidStartMs(st.LastUPID); t > 0 {
			runs[st.ID] = t
		} else if st.LastEnd > 0 {
			runs[st.ID] = st.LastEnd * 1000
		}
	}
	out := map[string]groupState{}
	for _, j := range s.Jobs {
		r, l := remote[key{j.RemoteStore, j.NS}], local[j.NS]
		if r == nil || l == nil {
			continue // unknown: the queue keeps it as it is
		}
		g := j.Type + "/" + j.BackupID
		out[j.ID] = groupState{remoteLast: r[g], localLast: l[g], lastRun: runs[j.ID]}
	}
	if len(errs) > 0 {
		return out, errors.New(strings.Join(errs, " ; "))
	}
	return out, nil
}

// tasks: the heavy tasks running on the PBS (all users: the copies started by the hub count too).
func (o *offsiteModule) tasks(ctx context.Context, s *OffsiteSpec) ([]OffsiteRunning, error) {
	var list []apiTask
	if err := o.api(ctx, s, "get", "/nodes/localhost/tasks", &list, "--running", "1", "--limit", "500"); err != nil {
		return nil, err
	}
	out := []OffsiteRunning{}
	for _, t := range list {
		if heavy(t.WorkerType, s.CountMaintenance) {
			out = append(out, OffsiteRunning{JobID: jobOfTask(t.WorkerID), UPID: t.UPID, Type: t.WorkerType, Start: t.StartTime * 1000})
		}
	}
	return out, nil
}

// launch starts the sync job; returns its task.
func (o *offsiteModule) launch(ctx context.Context, s *OffsiteSpec, jobID string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	raw, err := o.tool(s.Container)(cctx, "api", "create", "/admin/sync/"+jobID+"/run", "--output-format", "json")
	if err != nil {
		return "", err
	}
	upid := upidRe.FindString(raw)
	if upid == "" {
		return "", fmt.Errorf("no task in the answer: %s", strings.TrimSpace(raw))
	}
	return upid, nil
}

const (
	offsiteScanEvery = 5 * time.Minute
	offsiteTick      = time.Minute
	offsiteRetry     = time.Hour
)

// step: a scan when due, then the launches the window and the concurrency allow.
func (o *offsiteModule) step(ctx context.Context, now time.Time, scanDue bool) {
	s := o.spec()
	if s == nil {
		o.mu.Lock()
		changed := len(o.state.Queue) > 0
		o.state.Queue = nil
		o.running, o.lastErr = nil, ""
		if changed {
			o.saveLocked()
		}
		o.mu.Unlock()
		o.report()
		return
	}
	loc, _ := time.LoadLocation(s.TZ)
	var errs []string
	running, err := o.tasks(ctx, s)
	if err != nil {
		errs = append(errs, err.Error())
	}
	busy := map[string]bool{}
	for _, r := range running {
		if r.JobID != "" {
			busy[r.JobID] = true
		}
	}
	if scanDue && err == nil {
		states, serr := o.scan(ctx, s)
		if serr != nil {
			errs = append(errs, serr.Error())
		}
		if states != nil {
			o.mu.Lock()
			o.state.Queue = requeue(o.state.Queue, s.Jobs, states, busy, now, time.Duration(s.MinDelayH)*time.Hour)
			o.scanned = now.UnixMilli()
			o.saveLocked()
			o.mu.Unlock()
		}
	}
	window := inWindow(now, loc, s.WindowStart, s.WindowEnd)
	if window && err == nil {
		for len(running) < s.Concurrency {
			id := o.next(busy, now)
			if id == "" {
				break
			}
			upid, lerr := o.launch(ctx, s, id)
			if lerr != nil {
				errs = append(errs, fmt.Sprintf("%s : %v", id, lerr))
				o.mu.Lock()
				o.failedAt[id] = now
				o.mu.Unlock()
				continue
			}
			log.Printf("offsite: %s started (%s)", id, upid)
			busy[id] = true
			running = append(running, OffsiteRunning{JobID: id, UPID: upid, Type: "syncjob", Start: upidStartMs(upid)})
		}
	}
	o.mu.Lock()
	o.running, o.window = running, window
	o.lastErr = strings.Join(errs, " ; ")
	o.mu.Unlock()
	o.report()
}

// next takes the first queued group that is not running and whose launch did not fail lately.
func (o *offsiteModule) next(busy map[string]bool, now time.Time) string {
	o.mu.Lock()
	defer o.mu.Unlock()
	for i, q := range o.state.Queue {
		if busy[q.JobID] || now.Sub(o.failedAt[q.JobID]) < offsiteRetry {
			continue
		}
		o.state.Queue = append(o.state.Queue[:i:i], o.state.Queue[i+1:]...)
		o.saveLocked()
		return q.JobID
	}
	return ""
}

// loop runs the queue; started once for the whole process.
func (o *offsiteModule) loop(ctx context.Context) {
	t := time.NewTicker(offsiteTick)
	defer t.Stop()
	var last time.Time
	for {
		now := time.Now()
		due := now.Sub(last) >= offsiteScanEvery
		if due {
			last = now
		}
		o.step(ctx, now, due)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-o.kick:
			last = time.Time{} // a new definition: scan now
		}
	}
}

func (o *offsiteModule) snapshot() OffsiteReport {
	o.mu.Lock()
	defer o.mu.Unlock()
	r := OffsiteReport{ScannedAt: o.scanned, Queue: append([]OffsiteQueued{}, o.state.Queue...), Running: append([]OffsiteRunning{}, o.running...), InWindow: o.window, Error: o.lastErr}
	if o.state.Spec != nil {
		r.Hash = o.state.Spec.Hash
	}
	return r
}

// report sends the state to the hub when it changed (force: anyway).
func (o *offsiteModule) report() { o.sendReport(false) }

func (o *offsiteModule) sendReport(force bool) {
	o.sendMu.Lock()
	defer o.sendMu.Unlock()
	if o.send == nil {
		return
	}
	r := o.snapshot()
	if r.Hash == "" && len(r.Queue) == 0 && len(r.Running) == 0 {
		return // never configured
	}
	// the date of the scan changes at each scan: one report per scan at most, plus the changes
	raw, _ := json.Marshal(r)
	if !force && string(raw) == o.sent {
		return
	}
	if o.send(Outbound{Type: "offsite_report", Offsite: &r}) == nil {
		o.sent = string(raw)
	}
}

func (o *offsiteModule) attach(send func(Outbound) error) {
	o.sendMu.Lock()
	o.send = send
	o.sent = ""
	o.sendMu.Unlock()
	go o.sendReport(true)
}

func (o *offsiteModule) detach() {
	o.sendMu.Lock()
	o.send = nil
	o.sendMu.Unlock()
}
