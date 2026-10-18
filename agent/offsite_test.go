package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var paris, _ = time.LoadLocation("Europe/Paris")

func at(day, hm string) time.Time {
	t, _ := time.ParseInLocation("2006-01-02 15:04", day+" "+hm, paris)
	return t
}

func TestSeriesDueAndNextStart(t *testing.T) {
	cases := []struct {
		now, lastDay string
		due          bool
		next         string
	}{
		{"2026-10-18 03:59", "2026-10-17", false, "2026-10-18 04:00"},
		{"2026-10-18 04:00", "2026-10-17", true, "2026-10-19 04:00"},
		{"2026-10-18 09:30", "2026-10-17", true, "2026-10-19 04:00"}, // missed (agent down): caught up the same day
		{"2026-10-18 04:30", "2026-10-18", false, "2026-10-19 04:00"},
		{"2026-10-18 03:00", "", false, "2026-10-18 04:00"},
	}
	for _, c := range cases {
		now := at(c.now[:10], c.now[11:])
		if got := seriesDue(now, paris, "04:00", c.lastDay); got != c.due {
			t.Errorf("%s after %q: due %v", c.now, c.lastDay, got)
		}
		if got := nextStart(now, paris, "04:00", c.lastDay); !got.Equal(at(c.next[:10], c.next[11:])) {
			t.Errorf("%s after %q: next %s", c.now, c.lastDay, got)
		}
	}
	// change of time (DST ends on 2026-10-25): still 04:00 wall clock
	if got := nextStart(at("2026-10-24", "05:00"), paris, "04:00", "2026-10-24"); !got.Equal(at("2026-10-25", "04:00")) {
		t.Errorf("DST: %s", got)
	}
}

func TestJobOfTask(t *testing.T) {
	if jobOfTask("hlm-main:ds0:ds9:Hosts:hlm-ds0-Hosts") != "hlm-ds0-Hosts" || jobOfTask("hlm-main:ds3:ds9::hlm-ds3") != "hlm-ds3" || jobOfTask("r:ds0:ds9::other") != "" || jobOfTask("ds9") != "" {
		t.Fatal("job of a task")
	}
	if upidStartMs("UPID:8dfb8d8b5d83:00000022:00612960:00000022:6AD3E559:syncjob:x:homelab@pbs!hub:") != 0x6AD3E559*1000 || upidStartMs("nope") != 0 {
		t.Fatal("start of a task")
	}
}

func validOffsiteSpec() *OffsiteSpec {
	return &OffsiteSpec{Hash: "h1", Start: "04:00", TZ: "Europe/Paris", Jobs: []string{"hlm-ds0-Hosts", "hlm-ds0", "hlm-ds3-Sites.Jarsay"}}
}

func TestValidateOffsiteSpec(t *testing.T) {
	if err := validateOffsiteSpec(validOffsiteSpec()); err != nil {
		t.Fatal(err)
	}
	if err := validateOffsiteSpec(&OffsiteSpec{}); err != nil {
		t.Fatal("no job, nothing to check:", err)
	}
	for name, mut := range map[string]func(*OffsiteSpec){
		"container": func(s *OffsiteSpec) { s.Container = "a b" },
		"start":     func(s *OffsiteSpec) { s.Start = "24:00" },
		"tz":        func(s *OffsiteSpec) { s.TZ = "Nowhere/Else" },
		"job id":    func(s *OffsiteSpec) { s.Jobs[0] = "hlm-x; rm" },
		"not ours":  func(s *OffsiteSpec) { s.Jobs[0] = "manual-sync" },
		"twice":     func(s *OffsiteSpec) { s.Jobs[1] = s.Jobs[0] },
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
	tasks   []apiTask
	failRun map[string]bool
	calls   []string
	started []string
}

func (f *fakeDebug) run(_ context.Context, args ...string) (string, error) {
	cmd := strings.Join(args, " ")
	f.calls = append(f.calls, cmd)
	switch {
	case strings.HasPrefix(cmd, "api get /nodes/localhost/tasks"):
		raw, _ := json.Marshal(f.tasks)
		return string(raw), nil
	case strings.HasPrefix(cmd, "api create /admin/sync/"):
		id := strings.TrimSuffix(strings.TrimPrefix(args[2], "/admin/sync/"), "/run")
		if f.failRun[id] {
			return "", fmt.Errorf("refused")
		}
		f.started = append(f.started, id)
		upid := "UPID:n:1:1:1:6AD3E559:syncjob:hlm\\x2dmain:root@pam:"
		f.tasks = append(f.tasks, apiTask{UPID: upid + id, WorkerType: "syncjob", WorkerID: "hlm-main:ds0:ds9:x:" + id})
		// JSON output: the backslashes of the worker id come escaped
		raw, _ := json.Marshal(upid + id)
		return string(raw), nil
	}
	return "", fmt.Errorf("unexpected %s", cmd)
}

// newTestOffsite: a module with the spec applied, its last series yesterday.
func newTestOffsite(t *testing.T, f *fakeDebug) *offsiteModule {
	o := newOffsiteModule(t.TempDir())
	o.tool = func(string) pbsRun { return f.run }
	if err := o.apply(validOffsiteSpec()); err != nil {
		t.Fatal(err)
	}
	<-o.kick
	o.state.Day = "2026-10-17"
	return o
}

func TestOffsiteSeries(t *testing.T) {
	f := &fakeDebug{}
	o := newTestOffsite(t, f)
	ctx := context.Background()
	// before the start: nothing, not even a read of the PBS
	o.step(ctx, at("2026-10-18", "03:59"))
	if len(f.calls) != 0 || o.snapshot(at("2026-10-18", "03:59")).NextStart != at("2026-10-18", "04:00").UnixMilli() {
		t.Fatalf("before the start: %v", f.calls)
	}
	// the start: the first job only
	o.step(ctx, at("2026-10-18", "04:00"))
	r := o.snapshot(at("2026-10-18", "04:00"))
	if strings.Join(f.started, ",") != "hlm-ds0-Hosts" || strings.Join(r.Pending, ",") != "hlm-ds0,hlm-ds3-Sites.Jarsay" || r.Day != "2026-10-18" || r.Total != 3 {
		t.Fatalf("start: %v %+v", f.started, r)
	}
	// the UPID reported is the one of the PBS (the hub follows it), not its JSON form
	if r.Running == nil || r.Running.UPID != "UPID:n:1:1:1:6AD3E559:syncjob:hlm\\x2dmain:root@pam:hlm-ds0-Hosts" || r.Running.JobID != "hlm-ds0-Hosts" {
		t.Fatalf("running: %+v", r.Running)
	}
	// still running: the next one waits
	o.step(ctx, at("2026-10-18", "04:01"))
	if len(f.started) != 1 {
		t.Fatalf("two at a time: %v", f.started)
	}
	// ended: the next one
	f.tasks = nil
	o.step(ctx, at("2026-10-18", "04:20"))
	if strings.Join(f.started, ",") != "hlm-ds0-Hosts,hlm-ds0" {
		t.Fatalf("second: %v", f.started)
	}
	// another sync task of the PBS (not ours): waits for it too
	f.tasks = []apiTask{{UPID: "UPID:other", WorkerType: "syncjob", WorkerID: "r:ds0:ds9::manual-sync"}}
	o.step(ctx, at("2026-10-18", "04:40"))
	if len(f.started) != 2 || o.snapshot(at("2026-10-18", "04:40")).Running.UPID != "UPID:other" {
		t.Fatalf("other sync: %v", f.started)
	}
	f.tasks = nil
	o.step(ctx, at("2026-10-18", "05:00"))
	if strings.Join(f.started, ",") != "hlm-ds0-Hosts,hlm-ds0,hlm-ds3-Sites.Jarsay" {
		t.Fatalf("third: %v", f.started)
	}
	f.tasks = nil
	o.step(ctx, at("2026-10-18", "05:30"))
	r = o.snapshot(at("2026-10-18", "05:30"))
	if r.Running != nil || len(r.Pending) != 0 || r.NextStart != at("2026-10-19", "04:00").UnixMilli() {
		t.Fatalf("series done: %+v", r)
	}
	// done for the day
	n := len(f.calls)
	o.step(ctx, at("2026-10-18", "12:00"))
	if len(f.calls) != n {
		t.Fatal("a second series the same day")
	}
}

func TestOffsiteSkipsRunningAndRefused(t *testing.T) {
	// the second job already runs (started by the hub): it leaves the series; the third is refused
	f := &fakeDebug{failRun: map[string]bool{"hlm-ds3-Sites.Jarsay": true}}
	o := newTestOffsite(t, f)
	ctx := context.Background()
	o.step(ctx, at("2026-10-18", "04:00"))
	f.tasks = []apiTask{{UPID: "UPID:hub", WorkerType: "syncjob", WorkerID: "hlm-main:ds0:ds9::hlm-ds0"}}
	o.step(ctx, at("2026-10-18", "04:10"))
	if strings.Join(o.snapshot(at("2026-10-18", "04:10")).Pending, ",") != "hlm-ds3-Sites.Jarsay" {
		t.Fatalf("running job kept in the series: %+v", o.snapshot(at("2026-10-18", "04:10")))
	}
	f.tasks = nil
	o.step(ctx, at("2026-10-18", "04:30"))
	r := o.snapshot(at("2026-10-18", "04:30"))
	if strings.Join(f.started, ",") != "hlm-ds0-Hosts" || len(r.Pending) != 0 || !strings.Contains(r.Error, "hlm-ds3-Sites.Jarsay") {
		t.Fatalf("refused: %v %+v", f.started, r)
	}
}

func TestOffsiteStateKept(t *testing.T) {
	f := &fakeDebug{}
	o := newTestOffsite(t, f)
	o.step(context.Background(), at("2026-10-18", "04:00"))
	// restart of the agent: the series goes on
	o2 := newOffsiteModule(o.dir)
	if o2.state.Spec == nil || o2.state.Spec.Hash != "h1" || o2.state.Day != "2026-10-18" || strings.Join(o2.state.Pending, ",") != "hlm-ds0,hlm-ds3-Sites.Jarsay" {
		t.Fatalf("not kept: %+v", o2.state)
	}
	// a new definition: the series keeps the jobs still copied
	if err := o2.apply(&OffsiteSpec{Hash: "h2", Start: "04:00", TZ: "Europe/Paris", Jobs: []string{"hlm-ds3-Sites.Jarsay"}}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(o2.state.Pending, ",") != "hlm-ds3-Sites.Jarsay" || o2.state.Day != "2026-10-18" {
		t.Fatalf("new definition: %+v", o2.state)
	}
}

func TestOffsiteOldQueueRemoved(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "offsite.json")
	if err := os.WriteFile(old, []byte(`{"spec":{"jobs":[{"id":"hlm-aaaaaaaaaaaa"}]},"queue":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	o := newOffsiteModule(dir)
	if _, err := os.Stat(old); !os.IsNotExist(err) || o.state.Spec != nil {
		t.Fatal("queue of before kept")
	}
}

func TestOffsiteEmptySpecClearsSeries(t *testing.T) {
	f := &fakeDebug{}
	o := newTestOffsite(t, f)
	o.state.Pending = []string{"hlm-ds0"}
	if err := o.apply(&OffsiteSpec{Hash: "h2"}); err != nil {
		t.Fatal(err)
	}
	o.step(context.Background(), at("2026-10-18", "04:00"))
	if len(o.snapshot(time.Now()).Pending) != 0 || len(f.calls) != 0 {
		t.Fatalf("empty spec: %+v %v", o.snapshot(time.Now()), f.calls)
	}
}

func TestOffsiteNewStartRearmsToday(t *testing.T) {
	f := &fakeDebug{}
	o := newTestOffsite(t, f)
	now := time.Now().In(paris)
	today := now.Format(time.DateOnly)
	o.state.Day = today // the series of the day is done
	later := now.Add(2 * time.Hour)
	if later.Day() != now.Day() {
		t.Skip("too close to midnight")
	}
	// a start still to come today: fires today
	if err := o.apply(&OffsiteSpec{Hash: "h2", Start: later.Format("15:04"), TZ: "Europe/Paris", Jobs: []string{"hlm-ds0"}}); err != nil {
		t.Fatal(err)
	}
	if o.state.Day != "" {
		t.Fatalf("not re-armed: %q", o.state.Day)
	}
	// a start already passed today: waits for tomorrow
	earlier := now.Add(-2 * time.Hour)
	if earlier.Day() != now.Day() {
		t.Skip("too close to midnight")
	}
	if err := o.apply(&OffsiteSpec{Hash: "h3", Start: earlier.Format("15:04"), TZ: "Europe/Paris", Jobs: []string{"hlm-ds0"}}); err != nil {
		t.Fatal(err)
	}
	if o.state.Day != today {
		t.Fatalf("fired at once: %q", o.state.Day)
	}
	// same start: nothing changes
	o.state.Day = ""
	if err := o.apply(&OffsiteSpec{Hash: "h4", Start: earlier.Format("15:04"), TZ: "Europe/Paris", Jobs: []string{"hlm-ds0", "hlm-ds1"}}); err != nil {
		t.Fatal(err)
	}
	if o.state.Day != "" {
		t.Fatalf("same start re-armed: %q", o.state.Day)
	}
}
