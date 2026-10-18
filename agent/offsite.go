package main

import (
	"context"
	"encoding/json"
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

// Copy to a secondary PBS ("copie déportée") started by the agent of that PBS: the hub keeps one sync job
// per datastore and namespace copied (hlm-*, no schedule of the PBS) and sends their list with the start
// time (offsite_sync); every day at that time the agent starts them one after the other, never while
// another sync task runs, and skips a job already running. The definition and the series in progress
// are kept on disk: the copies go on while the hub is down. The PBS is reached through
// proxmox-backup-debug (local API as root, no token), natively or in its container; the hub follows the
// tasks (offsite.ts).

type OffsiteSpec struct {
	Hash      string   `json:"hash"`
	Container string   `json:"container"` // PBS in this container; empty: installed on the host
	Jobs      []string `json:"jobs"`      // sync jobs, in the order they run
	Start     string   `json:"start"`     // HH:MM, daily start of the series
	TZ        string   `json:"tz"`
}

type OffsiteRunning struct {
	JobID string `json:"jobId,omitempty"` // empty: a sync task that is not one of ours
	UPID  string `json:"upid"`
	Start int64  `json:"start"` // unix ms
}

// OffsiteReport: state of the series, sent to the hub when it changes.
type OffsiteReport struct {
	Hash      string          `json:"hash"`
	Day       string          `json:"day"`               // day of the last series started (YYYY-MM-DD), "": never
	Total     int             `json:"total"`             // jobs of that series
	Pending   []string        `json:"pending"`           // not started yet
	Running   *OffsiteRunning `json:"running,omitempty"` // sync task running on the PBS
	NextStart int64           `json:"nextStart"`         // next series (unix ms), 0: nothing to copy
	Error     string          `json:"error,omitempty"`   // last read or launch failed
}

var (
	offsiteJobIDRe = regexp.MustCompile(`^hlm-[A-Za-z0-9._-]{1,28}$`)
	hhmmRe         = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
	upidRe         = regexp.MustCompile(`UPID:[^\s"]+`)
)

func validateOffsiteSpec(s *OffsiteSpec) error {
	if s.Container != "" && !pbsContainerRe.MatchString(s.Container) {
		return fmt.Errorf("invalid container %q", s.Container)
	}
	if len(s.Jobs) == 0 {
		return nil // nothing to copy: the series is emptied
	}
	if !hhmmRe.MatchString(s.Start) {
		return fmt.Errorf("invalid start %q", s.Start)
	}
	if _, err := time.LoadLocation(s.TZ); err != nil || s.TZ == "" {
		return fmt.Errorf("time zone %q", s.TZ)
	}
	seen := map[string]bool{}
	for _, j := range s.Jobs {
		if !offsiteJobIDRe.MatchString(j) || seen[j] {
			return fmt.Errorf("invalid job %q", j)
		}
		seen[j] = true
	}
	return nil
}

// --- rules of the series (pure) ------------------------------------------------------------

func minutesOf(hhmm string) int {
	h, _ := strconv.Atoi(hhmm[:2])
	m, _ := strconv.Atoi(hhmm[3:])
	return h*60 + m
}

// startOf: the start time on the day of t, in loc.
func startOf(t time.Time, loc *time.Location, hhmm string) time.Time {
	d := t.In(loc)
	m := minutesOf(hhmm)
	return time.Date(d.Year(), d.Month(), d.Day(), m/60, m%60, 0, 0, loc)
}

// seriesDue: the series of the day of now is due (start passed) and not started yet.
func seriesDue(now time.Time, loc *time.Location, start, lastDay string) bool {
	return lastDay != now.In(loc).Format(time.DateOnly) && !now.Before(startOf(now, loc, start))
}

// nextStart: the next series after now (today's when not started yet, else tomorrow's).
func nextStart(now time.Time, loc *time.Location, start, lastDay string) time.Time {
	today := startOf(now, loc, start)
	if lastDay != now.In(loc).Format(time.DateOnly) && now.Before(today) {
		return today
	}
	d := now.In(loc).AddDate(0, 0, 1)
	return startOf(d, loc, start)
}

// jobOfTask: the sync job of a task, from its worker id (remote:store:target:ns:job).
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
	Spec    *OffsiteSpec `json:"spec,omitempty"`
	Day     string       `json:"day"`     // last series started
	Total   int          `json:"total"`   // jobs of that series
	Pending []string     `json:"pending"` // jobs of that series not started yet
}

type offsiteModule struct {
	dir string
	// run: proxmox-backup-debug of the PBS of the spec (tests: a fake)
	tool func(container string) pbsRun

	mu      sync.Mutex
	state   offsiteState
	running *OffsiteRunning
	lastErr string
	sent    string // last report sent (json)

	sendMu sync.Mutex
	send   func(Outbound) error
	kick   chan struct{}
}

var offsite = newOffsiteModule(stateDir())

func newOffsiteModule(dir string) *offsiteModule {
	o := &offsiteModule{dir: dir, kick: make(chan struct{}, 1),
		tool: func(c string) pbsRun { return pbsTool(c, "proxmox-backup-debug") }}
	// queue of before (#185): replaced by the series
	_ = os.Remove(filepath.Join(dir, "offsite.json"))
	if raw, err := os.ReadFile(o.path()); err == nil {
		var st offsiteState
		if json.Unmarshal(raw, &st) == nil {
			o.state = st
		}
	}
	return o
}

func (o *offsiteModule) path() string { return filepath.Join(o.dir, "offsite-series.json") }

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

// apply stores a new definition sent by the hub; the series in progress keeps the jobs still copied.
func (o *offsiteModule) apply(s *OffsiteSpec) error {
	if err := validateOffsiteSpec(s); err != nil {
		return err
	}
	o.mu.Lock()
	known := map[string]bool{}
	for _, j := range s.Jobs {
		known[j] = true
	}
	pending := []string{}
	for _, j := range o.state.Pending {
		if known[j] {
			pending = append(pending, j)
		}
	}
	day := o.state.Day
	// First definition, or a new start time: a start already passed today waits for tomorrow, one still to
	// come today fires today (the series of the day already done must not block it)
	if prev := o.state.Spec; len(s.Jobs) > 0 && (prev == nil && day == "" || prev != nil && prev.Start != s.Start) {
		loc, _ := time.LoadLocation(s.TZ)
		day = ""
		if now := time.Now(); !now.Before(startOf(now, loc, s.Start)) {
			day = now.In(loc).Format(time.DateOnly)
		}
	}
	o.state = offsiteState{Spec: s, Day: day, Total: o.state.Total, Pending: pending}
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

// syncTasks: the sync tasks running on the PBS (all users: the copies started by the hub count too).
func (o *offsiteModule) syncTasks(ctx context.Context, s *OffsiteSpec) ([]OffsiteRunning, error) {
	cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	raw, err := o.tool(s.Container)(cctx, "api", "get", "/nodes/localhost/tasks", "--running", "1", "--limit", "500", "--output-format", "json")
	if err != nil {
		return nil, err
	}
	var list []apiTask
	if err := json.Unmarshal([]byte(strings.TrimSpace(raw)), &list); err != nil {
		return nil, fmt.Errorf("tasks: answer not understood: %v", err)
	}
	out := []OffsiteRunning{}
	for _, t := range list {
		if t.WorkerType == "syncjob" {
			out = append(out, OffsiteRunning{JobID: jobOfTask(t.WorkerID), UPID: t.UPID, Start: t.StartTime * 1000})
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
	// a JSON string: its backslashes (hlm\x2dmain…) are escaped, the UPID is the decoded value
	var upid string
	if json.Unmarshal([]byte(strings.TrimSpace(raw)), &upid) != nil || !strings.HasPrefix(upid, "UPID:") {
		upid = upidRe.FindString(raw)
	}
	if upid == "" {
		return "", fmt.Errorf("no task in the answer: %s", strings.TrimSpace(raw))
	}
	return upid, nil
}

const offsiteTick = 30 * time.Second

// step: starts the series when due, then the next job of the series once no sync task runs. A job of
// the series already running (started by the hub) leaves the series; a launch refused is skipped.
func (o *offsiteModule) step(ctx context.Context, now time.Time) {
	s := o.spec()
	if s == nil {
		o.mu.Lock()
		changed := len(o.state.Pending) > 0
		o.state.Pending = nil
		o.running, o.lastErr = nil, ""
		if changed {
			o.saveLocked()
		}
		o.mu.Unlock()
		o.report()
		return
	}
	loc, _ := time.LoadLocation(s.TZ)
	o.mu.Lock()
	if seriesDue(now, loc, s.Start, o.state.Day) {
		o.state.Day = now.In(loc).Format(time.DateOnly)
		o.state.Pending = append([]string{}, s.Jobs...)
		o.state.Total = len(s.Jobs)
		o.lastErr = ""
		o.saveLocked()
		log.Printf("offsite: series of %d sync job(s) started", len(s.Jobs))
	}
	idle := len(o.state.Pending) == 0 && o.running == nil
	o.mu.Unlock()
	if idle {
		o.report()
		return
	}
	tasks, err := o.syncTasks(ctx, s)
	if err != nil {
		o.mu.Lock()
		o.lastErr = err.Error()
		o.mu.Unlock()
		o.report()
		return
	}
	var running *OffsiteRunning
	if len(tasks) > 0 {
		running = &tasks[0]
		for i := range tasks {
			if tasks[i].JobID != "" {
				running = &tasks[i]
				break
			}
		}
	}
	o.mu.Lock()
	// a job of the series already running: done by that task
	busy := map[string]bool{}
	for _, t := range tasks {
		busy[t.JobID] = true
	}
	pending := []string{}
	for _, j := range o.state.Pending {
		if !busy[j] {
			pending = append(pending, j)
		}
	}
	if len(pending) != len(o.state.Pending) {
		o.state.Pending = pending
		o.saveLocked()
	}
	o.mu.Unlock()
	var errs []string
	// never two copies at a time: the next job waits for any sync task to end
	for running == nil {
		id := o.pop()
		if id == "" {
			break
		}
		upid, lerr := o.launch(ctx, s, id)
		if lerr != nil {
			errs = append(errs, fmt.Sprintf("%s : %v", id, lerr))
			continue
		}
		log.Printf("offsite: %s started (%s)", id, upid)
		running = &OffsiteRunning{JobID: id, UPID: upid, Start: upidStartMs(upid)}
	}
	o.mu.Lock()
	o.running = running
	if len(errs) > 0 {
		o.lastErr = strings.Join(errs, " ; ")
	}
	o.mu.Unlock()
	o.report()
}

// pop takes the next job of the series.
func (o *offsiteModule) pop() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.state.Pending) == 0 {
		return ""
	}
	id := o.state.Pending[0]
	o.state.Pending = o.state.Pending[1:]
	o.saveLocked()
	return id
}

// loop runs the series; started once for the whole process.
func (o *offsiteModule) loop(ctx context.Context) {
	t := time.NewTicker(offsiteTick)
	defer t.Stop()
	for {
		o.step(ctx, time.Now())
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-o.kick:
		}
	}
}

func (o *offsiteModule) snapshot(now time.Time) OffsiteReport {
	o.mu.Lock()
	defer o.mu.Unlock()
	r := OffsiteReport{Day: o.state.Day, Total: o.state.Total, Pending: append([]string{}, o.state.Pending...), Running: o.running, Error: o.lastErr}
	if s := o.state.Spec; s != nil {
		r.Hash = s.Hash
		if len(s.Jobs) > 0 {
			loc, _ := time.LoadLocation(s.TZ)
			r.NextStart = nextStart(now, loc, s.Start, o.state.Day).UnixMilli()
		}
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
	r := o.snapshot(time.Now())
	if r.Hash == "" && len(r.Pending) == 0 && r.Running == nil {
		return // never configured
	}
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
