package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestInWindow(t *testing.T) {
	loc, _ := time.LoadLocation("Europe/Paris")
	at := func(hm string) time.Time {
		tm, _ := time.ParseInLocation("2006-01-02 15:04", "2026-10-18 "+hm, loc)
		return tm
	}
	cases := []struct {
		start, end, now string
		want            bool
	}{
		{"04:00", "09:00", "03:59", false},
		{"04:00", "09:00", "04:00", true},
		{"04:00", "09:00", "08:59", true},
		{"04:00", "09:00", "09:00", false},
		{"22:00", "06:00", "23:30", true},
		{"22:00", "06:00", "05:59", true},
		{"22:00", "06:00", "12:00", false},
		{"00:00", "00:00", "12:00", true},
	}
	for _, c := range cases {
		if got := inWindow(at(c.now), loc, c.start, c.end); got != c.want {
			t.Errorf("%s-%s at %s: %v", c.start, c.end, c.now, got)
		}
	}
}

func TestGroupWanted(t *testing.T) {
	now := time.Date(2026, 10, 18, 4, 0, 0, 0, time.UTC)
	day := 24 * time.Hour
	ago := func(d time.Duration) int64 { return now.Add(-d).UnixMilli() }
	cases := []struct {
		name string
		g    groupState
		want bool
	}{
		{"nothing on the main PBS", groupState{}, false},
		{"already copied", groupState{remoteLast: 100, localLast: 100}, false},
		{"never copied", groupState{remoteLast: 100}, true},
		{"newer, never run", groupState{remoteLast: 200, localLast: 100}, true},
		{"newer, run 25 h ago", groupState{remoteLast: 200, localLast: 100, lastRun: ago(25 * time.Hour)}, true},
		{"newer, run a day ago minus a few minutes (slack)", groupState{remoteLast: 200, localLast: 100, lastRun: ago(day - 10*time.Minute)}, true},
		{"newer, run 2 h ago", groupState{remoteLast: 200, localLast: 100, lastRun: ago(2 * time.Hour)}, false},
	}
	for _, c := range cases {
		if got := c.g.wanted(now, day); got != c.want {
			t.Errorf("%s: %v", c.name, got)
		}
	}
	if !(groupState{remoteLast: 200, localLast: 100, lastRun: ago(time.Minute)}).wanted(now, 0) {
		t.Error("no minimum delay: wanted at once")
	}
}

func TestRequeue(t *testing.T) {
	now := time.Date(2026, 10, 18, 4, 0, 0, 0, time.UTC)
	jobs := []OffsiteJob{{ID: "hlm-aaaaaaaaaaaa"}, {ID: "hlm-bbbbbbbbbbbb"}, {ID: "hlm-cccccccccccc"}, {ID: "hlm-dddddddddddd"}}
	queue := []OffsiteQueued{{JobID: "hlm-cccccccccccc", Since: 1}, {JobID: "hlm-eeeeeeeeeeee", Since: 2}, {JobID: "hlm-bbbbbbbbbbbb", Since: 3}}
	states := map[string]groupState{
		"hlm-aaaaaaaaaaaa": {remoteLast: 2, localLast: 1}, // new: at the end
		"hlm-bbbbbbbbbbbb": {remoteLast: 2, localLast: 2}, // copied meanwhile: leaves
		"hlm-cccccccccccc": {remoteLast: 2, localLast: 1}, // keeps its place
		"hlm-dddddddddddd": {remoteLast: 2, localLast: 1}, // running: not queued
	}
	got := requeue(queue, jobs, states, map[string]bool{"hlm-dddddddddddd": true}, now, 24*time.Hour)
	ids := []string{}
	for _, q := range got {
		ids = append(ids, q.JobID)
	}
	if strings.Join(ids, ",") != "hlm-cccccccccccc,hlm-aaaaaaaaaaaa" || got[0].Since != 1 || got[1].Since != now.UnixMilli() {
		t.Fatalf("queue: %+v", got)
	}
	// a group whose namespace could not be read keeps its place
	got = requeue(queue[:1], jobs, map[string]groupState{}, nil, now, 0)
	if len(got) != 1 || got[0].JobID != "hlm-cccccccccccc" {
		t.Fatalf("unknown state: %+v", got)
	}
}

func TestHeavyAndJobOfTask(t *testing.T) {
	if !heavy("syncjob", false) || heavy("garbage_collection", false) || !heavy("garbage_collection", true) || !heavy("verificationjob", true) || !heavy("verify", true) || heavy("logrotate", true) {
		t.Fatal("heavy tasks")
	}
	if jobOfTask("hlm-main:ds3:ds9:Hosts:hlm-80b3ff9bf2c0") != "hlm-80b3ff9bf2c0" || jobOfTask("hlm-main:ds3:ds9::other") != "" || jobOfTask("ds9") != "" {
		t.Fatal("job of a task")
	}
	if upidStartMs("UPID:8dfb8d8b5d83:00000022:00612960:00000022:6AD3E559:syncjob:x:homelab@pbs!hub:") != 0x6AD3E559*1000 || upidStartMs("nope") != 0 {
		t.Fatal("start of a task")
	}
}

func validOffsiteSpec() *OffsiteSpec {
	return &OffsiteSpec{
		Hash: "h1", Store: "ds9", Remote: "hlm-main", WindowStart: "04:00", WindowEnd: "09:00", TZ: "Europe/Paris", Concurrency: 1, MinDelayH: 24, CountMaintenance: true,
		Jobs: []OffsiteJob{
			{ID: "hlm-aaaaaaaaaaaa", RemoteStore: "ds0", NS: "Hosts", Type: "host", BackupID: "a"},
			{ID: "hlm-bbbbbbbbbbbb", RemoteStore: "ds3", NS: "Hosts", Type: "host", BackupID: "b"},
			{ID: "hlm-cccccccccccc", RemoteStore: "ds0", NS: "", Type: "vm", BackupID: "100"},
		},
	}
}

func TestValidateOffsiteSpec(t *testing.T) {
	if err := validateOffsiteSpec(validOffsiteSpec()); err != nil {
		t.Fatal(err)
	}
	if err := validateOffsiteSpec(&OffsiteSpec{}); err != nil {
		t.Fatal("no job, nothing to check:", err)
	}
	for name, mut := range map[string]func(*OffsiteSpec){
		"container":   func(s *OffsiteSpec) { s.Container = "a b" },
		"window":      func(s *OffsiteSpec) { s.WindowEnd = "24:00" },
		"tz":          func(s *OffsiteSpec) { s.TZ = "Nowhere/Else" },
		"concurrency": func(s *OffsiteSpec) { s.Concurrency = 0 },
		"job id":      func(s *OffsiteSpec) { s.Jobs[0].ID = "hlm-x; rm" },
		"type":        func(s *OffsiteSpec) { s.Jobs[0].Type = "file" },
		"ns":          func(s *OffsiteSpec) { s.Jobs[0].NS = "../x" },
		"remote":      func(s *OffsiteSpec) { s.Remote = "a/b" },
	} {
		s := validOffsiteSpec()
		mut(s)
		if validateOffsiteSpec(s) == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// fakeDebug answers like proxmox-backup-debug api.
type fakeDebug struct {
	remote  map[string]string // path -> groups json
	local   string
	sync    string
	tasks   []apiTask
	failRun bool
	calls   []string
	started []string
}

func (f *fakeDebug) run(_ context.Context, args ...string) (string, error) {
	cmd := strings.Join(args, " ")
	f.calls = append(f.calls, cmd)
	switch {
	case strings.HasPrefix(cmd, "api get /config/remote/"):
		return f.remote[args[2]], nil
	case strings.HasPrefix(cmd, "api get /admin/datastore/"):
		return f.local, nil
	case strings.HasPrefix(cmd, "api get /admin/sync"):
		return f.sync, nil
	case strings.HasPrefix(cmd, "api get /nodes/localhost/tasks"):
		raw, _ := json.Marshal(f.tasks)
		return string(raw), nil
	case strings.HasPrefix(cmd, "api create /admin/sync/"):
		if f.failRun {
			return "", fmt.Errorf("refused")
		}
		id := strings.TrimSuffix(strings.TrimPrefix(args[2], "/admin/sync/"), "/run")
		f.started = append(f.started, id)
		upid := fmt.Sprintf("UPID:n:1:1:1:6AD3E559:syncjob:hlm\\x2dmain:root@pam:")
		f.tasks = append(f.tasks, apiTask{UPID: upid + id, WorkerType: "syncjob", WorkerID: "hlm-main:x:ds9:Hosts:" + id})
		return `"` + upid + `"`, nil
	}
	return "", fmt.Errorf("unexpected %s", cmd)
}

func newTestOffsite(t *testing.T, f *fakeDebug) *offsiteModule {
	o := newOffsiteModule(t.TempDir())
	o.tool = func(string) pbsRun { return f.run }
	if err := o.apply(validOffsiteSpec()); err != nil {
		t.Fatal(err)
	}
	<-o.kick
	return o
}

func TestOffsiteStep(t *testing.T) {
	f := &fakeDebug{
		remote: map[string]string{
			"/config/remote/hlm-main/scan/ds0/groups": `[{"backup-type":"host","backup-id":"a","last-backup":200},{"backup-type":"vm","backup-id":"100","last-backup":200}]`,
			"/config/remote/hlm-main/scan/ds3/groups": `[{"backup-type":"host","backup-id":"b","last-backup":200}]`,
		},
		local: `[{"backup-type":"host","backup-id":"a","last-backup":100},{"backup-type":"host","backup-id":"b","last-backup":200}]`,
		sync:  `[]`,
	}
	o := newTestOffsite(t, f)
	loc, _ := time.LoadLocation("Europe/Paris")
	night := time.Date(2026, 10, 18, 3, 0, 0, 0, loc)
	o.step(context.Background(), night, true)
	r := o.snapshot()
	// a and the vm are newer on the main PBS, b is copied; outside the window: nothing started
	if len(r.Queue) != 2 || r.Queue[0].JobID != "hlm-aaaaaaaaaaaa" || r.Queue[1].JobID != "hlm-cccccccccccc" || len(f.started) != 0 || r.InWindow {
		t.Fatalf("outside the window: %+v, started %v", r, f.started)
	}
	// in the window: one at a time (N = 1)
	o.step(context.Background(), night.Add(time.Hour), false)
	if strings.Join(f.started, ",") != "hlm-aaaaaaaaaaaa" || len(o.snapshot().Queue) != 1 || len(o.snapshot().Running) != 1 {
		t.Fatalf("first launch: %v %+v", f.started, o.snapshot())
	}
	o.step(context.Background(), night.Add(time.Hour+time.Minute), false)
	if len(f.started) != 1 {
		t.Fatalf("concurrency not kept: %v", f.started)
	}
	// the copy ended: the next one starts
	f.tasks = nil
	o.step(context.Background(), night.Add(time.Hour+2*time.Minute), false)
	if strings.Join(f.started, ",") != "hlm-aaaaaaaaaaaa,hlm-cccccccccccc" || len(o.snapshot().Queue) != 0 {
		t.Fatalf("second launch: %v %+v", f.started, o.snapshot())
	}
	// state kept on disk
	o2 := newOffsiteModule(o.dir)
	if o2.state.Spec == nil || o2.state.Spec.Hash != "h1" {
		t.Fatal("spec not kept")
	}
}

func TestOffsiteMaintenanceCounts(t *testing.T) {
	f := &fakeDebug{
		remote: map[string]string{"/config/remote/hlm-main/scan/ds0/groups": `[{"backup-type":"host","backup-id":"a","last-backup":200}]`, "/config/remote/hlm-main/scan/ds3/groups": `[]`},
		local:  `[]`, sync: `[]`,
		tasks: []apiTask{{UPID: "UPID:gc", WorkerType: "garbage_collection", WorkerID: "ds9"}},
	}
	o := newTestOffsite(t, f)
	loc, _ := time.LoadLocation("Europe/Paris")
	o.step(context.Background(), time.Date(2026, 10, 18, 5, 0, 0, 0, loc), true)
	if len(f.started) != 0 || len(o.snapshot().Queue) != 1 {
		t.Fatalf("GC running: nothing may start: %v", f.started)
	}
}

func TestOffsiteLaunchFailure(t *testing.T) {
	f := &fakeDebug{
		remote: map[string]string{"/config/remote/hlm-main/scan/ds0/groups": `[{"backup-type":"host","backup-id":"a","last-backup":200}]`, "/config/remote/hlm-main/scan/ds3/groups": `[]`},
		local:  `[]`, sync: `[]`, failRun: true,
	}
	o := newTestOffsite(t, f)
	loc, _ := time.LoadLocation("Europe/Paris")
	at := time.Date(2026, 10, 18, 5, 0, 0, 0, loc)
	o.step(context.Background(), at, true)
	if o.snapshot().Error == "" {
		t.Fatal("launch error not reported")
	}
	// queued again by the next scan, not retried before an hour
	f.failRun = false
	o.step(context.Background(), at.Add(5*time.Minute), true)
	if len(f.started) != 0 {
		t.Fatal("retried too soon")
	}
	o.step(context.Background(), at.Add(61*time.Minute), true)
	if len(f.started) != 1 {
		t.Fatalf("not retried: %v", f.started)
	}
}

func TestOffsiteEmptySpecClearsQueue(t *testing.T) {
	f := &fakeDebug{sync: `[]`}
	o := newTestOffsite(t, f)
	o.state.Queue = []OffsiteQueued{{JobID: "hlm-aaaaaaaaaaaa"}}
	if err := o.apply(&OffsiteSpec{Hash: "h2"}); err != nil {
		t.Fatal(err)
	}
	o.step(context.Background(), time.Now(), true)
	if len(o.snapshot().Queue) != 0 || len(f.calls) != 0 {
		t.Fatalf("empty spec: %+v %v", o.snapshot(), f.calls)
	}
}
