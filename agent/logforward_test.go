//go:build !windows

package main

import (
	"strings"
	"testing"
)

func TestValidateLogForward(t *testing.T) {
	for _, ok := range []*LogForwardSpec{
		{},
		{Address: "192.168.100.21", Port: 29514, Protocol: "tcp"},
		{Address: "logs.lan", Port: 514, Protocol: "tcp"},
		{Address: "fd00::21", Port: 6514, Protocol: "tcp"},
	} {
		if err := validateLogForward(ok); err != nil {
			t.Errorf("%+v refused: %v", ok, err)
		}
	}
	for _, bad := range []*LogForwardSpec{
		nil,
		{Address: `10.0.0.1" port="1`, Port: 514, Protocol: "tcp"},
		{Address: "10.0.0.1\n$IncludeConfig /tmp/x", Port: 514, Protocol: "tcp"},
		{Address: "10.0.0.1", Port: 0, Protocol: "tcp"},
		{Address: "10.0.0.1", Port: 70000, Protocol: "tcp"},
		{Address: "10.0.0.1", Port: 514, Protocol: "udp"},
		{Address: "10.0.0.1", Port: 514},
	} {
		if err := validateLogForward(bad); err == nil {
			t.Errorf("%+v accepted", bad)
		}
	}
	// the module needs its server, and is refused with an invalid one
	if err := validateSetup(&SetupSpec{Modules: []string{"log_forward"}}); err == nil {
		t.Error("log_forward accepted without its server")
	}
	if err := validateSetup(&SetupSpec{Modules: []string{"log_forward"}, LogForward: &LogForwardSpec{Address: "a b", Port: 514, Protocol: "tcp"}}); err == nil {
		t.Error("invalid address accepted")
	}
	if err := validateSetup(&SetupSpec{Modules: []string{"log_forward"}, LogForward: &LogForwardSpec{Address: "10.0.0.1", Port: 514, Protocol: "tcp"}}); err != nil {
		t.Error(err)
	}
}

func TestRenderLogForward(t *testing.T) {
	if got := renderLogForward(&LogForwardSpec{}); got != "" {
		t.Errorf("no server must give no file, got %q", got)
	}
	got := renderLogForward(&LogForwardSpec{Address: "192.168.100.21", Port: 29514, Protocol: "tcp"})
	for _, want := range []string{managedHead, `target="192.168.100.21"`, `port="29514"`, `protocol="tcp"`, "RSYSLOG_SyslogProtocol23Format", `queue.filename="homelab_fwd"`, `action.resumeRetryCount="-1"`} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in\n%s", want, got)
		}
	}
	if !strings.HasSuffix(got, ")\n") {
		t.Errorf("unterminated action:\n%s", got)
	}
}

func TestCheckLogForwardFile(t *testing.T) {
	fsRoot = t.TempDir()
	defer func() { fsRoot = "" }()
	// no forwarding wanted: fine without the file, a drift with one left behind
	s := &SetupSpec{LogForward: &LogForwardSpec{}}
	if state, _ := checkLogForward(t.Context(), s); state != "ok" {
		t.Errorf("no file, no forwarding: %s", state)
	}
	if err := writeOwned(rsyslogDropIn, "x", 0o644, nil); err != nil {
		t.Fatal(err)
	}
	if state, detail := checkLogForward(t.Context(), s); state != "drift" || !strings.Contains(detail, "present") {
		t.Errorf("file left behind: %s %s", state, detail)
	}
}

func TestLastLines(t *testing.T) {
	if got := lastLines("a\n\n b \nc\n", 2); got != "b | c" {
		t.Errorf("got %q", got)
	}
}
