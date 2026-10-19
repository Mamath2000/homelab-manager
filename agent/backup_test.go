//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func testSpec() *BackupSpec {
	return &BackupSpec{
		Hash:        "h1",
		Server:      "192.168.100.8:8007",
		Fingerprint: "AB:CD",
		TokenID:     "host-x4@pbs!backup",
		TokenSecret: "secret",
		Image:       "mathmath350/pbs-client:4.0",
		Jobs: []BackupJob{{
			ID: "0123456789abcdef01234567", Name: "home", Archives: []BackupArchive{{Name: "home", Path: "/home"}, {Name: "etc", Path: "/etc"}},
			Excludes: []string{"**/.cache"}, Store: "ds2", NS: "Hosts", BackupID: "x4", Schedule: "03:00", TZ: "Europe/Paris", Enabled: true,
		}},
	}
}

func TestValidateBackupSpec(t *testing.T) {
	if err := validateBackupSpec(testSpec()); err != nil {
		t.Fatal(err)
	}
	// no job: nothing else is needed
	if err := validateBackupSpec(&BackupSpec{}); err != nil {
		t.Fatal(err)
	}
	bad := []func(s *BackupSpec){
		func(s *BackupSpec) { s.Jobs[0].Archives[0].Path = "home" },
		func(s *BackupSpec) { s.Jobs[0].Archives[0].Path = "/home/../etc" },
		func(s *BackupSpec) { s.Jobs[0].Archives[0].Path = "/mnt/a:b" },
		func(s *BackupSpec) { s.Jobs[0].Archives[0].Name = "home.pxar" },
		func(s *BackupSpec) { s.Jobs[0].BackupID = "../x" },
		func(s *BackupSpec) { s.Jobs[0].Schedule = "2026-10-11 03:00" },
		func(s *BackupSpec) { s.Jobs[0].TZ = "Mars/Olympus" },
		func(s *BackupSpec) { s.Jobs[0].NS = "/Hosts" },
		func(s *BackupSpec) { s.TokenSecret = "" },
		func(s *BackupSpec) { s.Image = "evil image" },
		func(s *BackupSpec) { s.Jobs[0].Archives = nil },
	}
	for i, f := range bad {
		s := testSpec()
		f(s)
		if validateBackupSpec(s) == nil {
			t.Errorf("case %d accepted", i)
		}
	}
}

func TestBackupArgsAndEnv(t *testing.T) {
	s := testSpec()
	got := strings.Join(backupArgs(s.Jobs[0]), " ")
	want := "backup home.pxar:/home etc.pxar:/etc --backup-type host --backup-id x4 --ns Hosts --exclude **/.cache"
	if got != want {
		t.Fatalf("args = %q", got)
	}
	env := strings.Join(backupEnv(s, s.Jobs[0]), "\n")
	if !strings.Contains(env, "PBS_REPOSITORY=host-x4@pbs!backup@192.168.100.8:8007:ds2") || !strings.Contains(env, "PBS_PASSWORD=secret") {
		t.Fatal("repository or password missing from the environment")
	}
	for _, a := range backupArgs(s.Jobs[0]) {
		if strings.Contains(a, "secret") {
			t.Fatal("secret on the command line")
		}
	}
}

func TestBackupDueAndCatchUp(t *testing.T) {
	dir := t.TempDir()
	b := newBackupModule(dir)
	if err := b.apply(testSpec()); err != nil {
		t.Fatal(err)
	}
	id := testSpec().Jobs[0].ID
	paris, _ := time.LoadLocation("Europe/Paris")
	appeared := time.Date(2026, 10, 11, 15, 0, 0, 0, paris)
	b.state.FirstSeen[id] = appeared.UnixMilli()
	// a job created at 15:00 does not run for the 03:00 of the same day
	if len(b.due(appeared.Add(time.Hour))) != 0 {
		t.Fatal("ran before its first scheduled time")
	}
	// next day 03:00 passed: due
	next := time.Date(2026, 10, 12, 3, 0, 30, 0, paris)
	if len(b.due(next)) != 1 {
		t.Fatal("not due after its scheduled time")
	}
	// ran at 03:00: not due again until the next day
	b.state.LastRun[id] = next.UnixMilli()
	if len(b.due(next.Add(20*time.Hour))) != 0 {
		t.Fatal("due twice")
	}
	// agent stopped for two days: one catch-up run
	if len(b.due(next.Add(50*time.Hour))) != 1 {
		t.Fatal("missed run not caught up")
	}
	// disabled
	s := testSpec()
	s.Jobs[0].Enabled = false
	_ = b.apply(s)
	if len(b.due(next.Add(50*time.Hour))) != 0 {
		t.Fatal("disabled job due")
	}
	// state survives a restart, secret file is private
	b2 := newBackupModule(dir)
	if b2.hash() != "h1" || b2.state.LastRun[id] != next.UnixMilli() {
		t.Fatal("state not reloaded")
	}
	if fi, err := os.Stat(filepath.Join(dir, "backup.json")); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("state file mode: %v %v", fi.Mode(), err)
	}
	// removed job: its state goes
	_ = b.apply(&BackupSpec{Hash: "h2"})
	if _, ok := b.state.LastRun[id]; ok {
		t.Fatal("state of a removed job kept")
	}
}

func TestBackupResultsQueue(t *testing.T) {
	b := newBackupModule(t.TempDir())
	r := BackupResult{ID: randomID(), JobID: "j", OK: true}
	b.keep(r)
	var mu sync.Mutex
	var sent []BackupResult
	b.sendMu.Lock()
	b.send = func(o Outbound) error {
		mu.Lock()
		defer mu.Unlock()
		sent = append(sent, o.Result.(BackupResult))
		return nil
	}
	b.sendMu.Unlock()
	b.flush()
	if len(sent) != 1 || sent[0].ID != r.ID {
		t.Fatal("result not sent")
	}
	b.ack(r.ID)
	sent = nil
	b.flush()
	if len(sent) != 0 {
		t.Fatal("acknowledged result sent again")
	}
	if len(randomID()) != 32 {
		t.Fatal("result id length")
	}
}

func TestBackupDueOnConnect(t *testing.T) {
	b := newBackupModule(t.TempDir())
	s := testSpec()
	s.Jobs[0].Schedule = ""
	s.Jobs[0].ConnectEveryDays = 3
	if err := b.apply(s); err != nil {
		t.Fatal(err)
	}
	id := s.Jobs[0].ID
	now := time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC)
	if len(b.due(now)) != 0 {
		t.Fatal("due while disconnected")
	}
	b.connectedAt = now.UnixMilli()
	if len(b.due(now)) != 1 {
		t.Fatal("never backed up: due on connection")
	}
	// a run started during this connection (even failed) is not retried until the next one
	b.state.LastRun[id] = now.UnixMilli() + 1
	if len(b.due(now.Add(time.Hour))) != 0 {
		t.Fatal("retried within the same connection")
	}
	// reconnection two days after a success: too early; four days: due
	b.state.LastOK[id] = now.UnixMilli()
	b.connectedAt = now.Add(48 * time.Hour).UnixMilli()
	if len(b.due(now.Add(48*time.Hour))) != 0 {
		t.Fatal("ran before the delay")
	}
	b.connectedAt = now.Add(96 * time.Hour).UnixMilli()
	if len(b.due(now.Add(96*time.Hour))) != 1 {
		t.Fatal("not due after the delay")
	}
}
