//go:build !windows

package main

import (
	"errors"
	"os"
	"testing"
)

const (
	jobA = "0123456789abcdef01234567"
	jobB = "0123456789abcdef01234568"
)

type sink struct{ out []Outbound }

func (s *sink) send(o Outbound) error { s.out = append(s.out, o); return nil }

func TestJobResultKeptUntilAcknowledged(t *testing.T) {
	j := newJobStore(t.TempDir())
	j.start(jobA)
	// hub gone (restarted by the stack update): output and result kept
	j.emit(jobA, "pulling\n")
	j.done(jobA, 0, nil)

	s := &sink{}
	j.send = s.send // next connection
	j.flush(true)
	if len(s.out) != 3 {
		t.Fatalf("want log, done, known: %+v", s.out)
	}
	if s.out[0].Type != "job_log" || s.out[0].Data != "[sortie émise pendant la coupure avec le hub]\npulling\n" {
		t.Fatalf("missed output: %+v", s.out[0])
	}
	if s.out[1].Type != "job_done" || s.out[1].JobID != jobA || s.out[1].ExitCode != 0 {
		t.Fatalf("result: %+v", s.out[1])
	}
	if s.out[2].Type != "jobs_known" || len(s.out[2].Jobs) != 1 || s.out[2].Jobs[0] != jobA {
		t.Fatalf("known: %+v", s.out[2])
	}

	j.ack(jobA)
	if _, err := os.Stat(j.path(jobA)); !os.IsNotExist(err) {
		t.Fatalf("acknowledged result still on disk: %v", err)
	}
}

func TestRunningJobKnownButNotSent(t *testing.T) {
	j := newJobStore(t.TempDir())
	j.start(jobA)
	s := &sink{}
	j.send = s.send
	j.flush(true)
	if len(s.out) != 1 || s.out[0].Type != "jobs_known" || len(s.out[0].Jobs) != 1 {
		t.Fatalf("a running job is only listed: %+v", s.out)
	}
	// an ack does not drop the record of a job still running
	j.ack(jobA)
	if _, err := os.Stat(j.path(jobA)); err != nil {
		t.Fatal(err)
	}
	// live output goes straight to the connection
	j.emit(jobA, "line\n")
	if s.out[len(s.out)-1].Type != "job_log" || j.missed[jobA] != nil {
		t.Fatalf("live output: %+v", s.out)
	}
}

func TestJobCutByAgentRestart(t *testing.T) {
	dir := t.TempDir()
	newJobStore(dir).start(jobA)
	j := newJobStore(dir) // next process
	j.recover()
	s := &sink{}
	j.send = s.send
	j.flush(false)
	if len(s.out) != 1 || s.out[0].Type != "job_done" || s.out[0].ExitCode != -1 || s.out[0].Error == "" {
		t.Fatalf("interrupted job: %+v", s.out)
	}
}

func TestJobResultError(t *testing.T) {
	j := newJobStore(t.TempDir())
	s := &sink{}
	j.send = s.send
	j.start(jobB)
	j.done(jobB, 3, errors.New("boom"))
	if len(s.out) != 1 || s.out[0].ExitCode != 3 || s.out[0].Error != "boom" {
		t.Fatalf("result: %+v", s.out)
	}
	// ids that are not hub job ids are ignored
	j.start("../x")
	if len(j.records()) != 1 {
		t.Fatal("invalid id recorded")
	}
}
