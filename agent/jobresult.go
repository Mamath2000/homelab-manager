//go:build !windows

package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Jobs survive a lost connection (hub restarted by the very stack update it asked for, network...): each
// job has a file from its start, its result is written there before being sent, and the file is removed
// when the hub acknowledges it (job_done_ack). On each connection, the results not acknowledged yet are
// sent again and the hub is told which jobs this agent knows (jobs_known), so it can close the others.
type jobRecord struct {
	JobID     string `json:"jobId"`
	StartedAt int64  `json:"startedAt"` // unix ms
	Done      bool   `json:"done"`
	ExitCode  int    `json:"exitCode"`
	Error     string `json:"error,omitempty"`
	// output the hub may not have received (emitted while disconnected), sent before the result
	Log string `json:"log,omitempty"`
}

const (
	jobMissedMax  = 64 * 1024
	jobRecordKeep = 7 * 24 * time.Hour
)

type jobStore struct {
	dir string
	mu  sync.Mutex // files and missed output
	// output emitted while no connection could take it, per job
	missed map[string]*tailBuffer

	sendMu sync.Mutex
	send   func(Outbound) error
}

var jobResults = newJobStore(filepath.Join(stateDir(), "job-results"))

func newJobStore(dir string) *jobStore {
	return &jobStore{dir: dir, missed: map[string]*tailBuffer{}}
}

// recover, at start-up of the agent service: a job file still "running" belongs to a previous process,
// the job was cut short.
func (j *jobStore) recover() {
	j.mu.Lock()
	defer j.mu.Unlock()
	for _, r := range j.records() {
		if !r.Done {
			r.Done, r.ExitCode, r.Error = true, -1, "agent arrêté pendant le job"
			j.write(r)
		}
	}
}

func (j *jobStore) path(id string) string { return filepath.Join(j.dir, id+".json") }

func (j *jobStore) write(r jobRecord) {
	if err := os.MkdirAll(j.dir, 0o700); err != nil {
		log.Printf("job record: %v", err)
		return
	}
	raw, _ := json.Marshal(r)
	if err := writeFileAtomic(j.path(r.JobID), raw, 0o600); err != nil {
		log.Printf("job record: %v", err)
	}
}

// records lists the job files, oldest first; those older than a week are dropped (hub gone for good).
func (j *jobStore) records() []jobRecord {
	entries, err := os.ReadDir(j.dir)
	if err != nil {
		return nil
	}
	list := []jobRecord{}
	for _, e := range entries {
		n := e.Name()
		if !strings.HasSuffix(n, ".json") || strings.HasPrefix(n, ".") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(j.dir, n))
		if err != nil {
			continue
		}
		var r jobRecord
		if json.Unmarshal(raw, &r) != nil || !jobIDRe.MatchString(r.JobID) || time.Since(time.UnixMilli(r.StartedAt)) > jobRecordKeep {
			_ = os.Remove(filepath.Join(j.dir, n))
			continue
		}
		list = append(list, r)
	}
	sort.Slice(list, func(a, b int) bool { return list[a].StartedAt < list[b].StartedAt })
	return list
}

func (j *jobStore) sender() func(Outbound) error {
	j.sendMu.Lock()
	defer j.sendMu.Unlock()
	return j.send
}

func (j *jobStore) start(id string) {
	if !jobIDRe.MatchString(id) {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	j.write(jobRecord{JobID: id, StartedAt: time.Now().UnixMilli()})
}

// emit sends a line of output to the current connection; without one, the line is kept for the result.
func (j *jobStore) emit(id, data string) {
	if send := j.sender(); send != nil && send(Outbound{Type: "job_log", JobID: id, Data: data}) == nil {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	t := j.missed[id]
	if t == nil {
		t = newTail(jobMissedMax)
		j.missed[id] = t
	}
	t.write(data)
}

func (j *jobStore) done(id string, code int, err error) {
	if !jobIDRe.MatchString(id) {
		return
	}
	j.mu.Lock()
	r := jobRecord{JobID: id, StartedAt: time.Now().UnixMilli(), Done: true, ExitCode: code}
	if raw, rerr := os.ReadFile(j.path(id)); rerr == nil {
		var cur jobRecord
		if json.Unmarshal(raw, &cur) == nil && cur.StartedAt > 0 {
			r.StartedAt = cur.StartedAt
		}
	}
	if err != nil {
		r.Error = err.Error()
	}
	if t := j.missed[id]; t != nil {
		r.Log = "[sortie émise pendant la coupure avec le hub]\n" + t.String()
		delete(j.missed, id)
	}
	j.write(r)
	j.mu.Unlock()
	j.flush(false)
}

// flush sends the results not acknowledged yet; on a new connection, then the list of the jobs this
// agent knows.
func (j *jobStore) flush(known bool) {
	send := j.sender()
	if send == nil {
		return
	}
	j.mu.Lock()
	list := j.records()
	j.mu.Unlock()
	ids := []string{}
	for _, r := range list {
		ids = append(ids, r.JobID)
		if !r.Done {
			continue
		}
		if r.Log != "" && send(Outbound{Type: "job_log", JobID: r.JobID, Data: r.Log}) != nil {
			return
		}
		if send(Outbound{Type: "job_done", JobID: r.JobID, ExitCode: r.ExitCode, Error: r.Error}) != nil {
			return
		}
	}
	if known {
		_ = send(Outbound{Type: "jobs_known", Jobs: ids})
	}
}

func (j *jobStore) ack(id string) {
	if !jobIDRe.MatchString(id) {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	raw, err := os.ReadFile(j.path(id))
	if err != nil {
		return
	}
	// a job still running keeps its file (ack of an earlier result with the same id: none expected)
	var r jobRecord
	if json.Unmarshal(raw, &r) == nil && !r.Done {
		return
	}
	_ = os.Remove(j.path(id))
}

func (j *jobStore) attach(send func(Outbound) error) {
	j.sendMu.Lock()
	j.send = send
	j.sendMu.Unlock()
	go j.flush(true)
}

func (j *jobStore) detach() {
	j.sendMu.Lock()
	j.send = nil
	j.sendMu.Unlock()
}
