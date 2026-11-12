//go:build !windows

package main

import (
	"strings"
	"testing"
)

func TestParseRoleCandidates(t *testing.T) {
	out := `LISTEN 0 100 0.0.0.0:1883 0.0.0.0:* users:(("mosquitto",pid=210,fd=5))
LISTEN 0 100 [::]:1883 [::]:* users:(("mosquitto",pid=210,fd=6))
LISTEN 0 100 127.0.0.1:9001 0.0.0.0:* users:(("mosquitto",pid=210,fd=7))
LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))
LISTEN 0 4096 *:8883 *:* users:(("docker-proxy",pid=900,fd=4))`
	got := parseRoleCandidates(out)
	if len(got) != 2 {
		t.Fatalf("candidates = %+v, want 2", got)
	}
	if c := got[0]; c.Port != 1883 || c.Scheme != "mqtt" || c.Local || c.Type != "mqtt-broker" {
		t.Fatalf("1883: %+v", c)
	}
	if c := got[1]; c.Port != 9001 || c.Scheme != "ws" || !c.Local {
		t.Fatalf("9001: %+v", c)
	}
}

func TestParseRoleCandidatesOmada(t *testing.T) {
	out := `LISTEN 0 100 *:8043 *:* users:(("java",pid=300,fd=12))
LISTEN 0 100 *:8088 *:* users:(("java",pid=300,fd=11))
LISTEN 0 4096 0.0.0.0:1883 0.0.0.0:* users:(("mosquitto",pid=210,fd=5))`
	got := parseRoleCandidates(out)
	if len(got) != 2 {
		t.Fatalf("candidates = %+v, want 2", got)
	}
	if c := got[0]; c.Type != "mqtt-broker" || c.Port != 1883 {
		t.Fatalf("1883: %+v", c)
	}
	if c := got[1]; c.Type != "omada-controller" || c.Port != 8043 || c.Scheme != "https" || c.Local || c.Process != "java" {
		t.Fatalf("8043: %+v", c)
	}
}

func TestParseRoleCandidatesOmadaMovedPort(t *testing.T) {
	out := `LISTEN 0 100 *:9443 *:* users:(("java",pid=300,fd=12))
LISTEN 0 100 *:29812 *:* users:(("java",pid=300,fd=13))
LISTEN 0 100 *:29814 *:* users:(("java",pid=300,fd=14))`
	got := parseRoleCandidates(out)
	if len(got) != 1 {
		t.Fatalf("candidates = %+v, want 1", got)
	}
	if c := got[0]; c.Type != "omada-controller" || c.Port != 8043 || c.Scheme != "https" || c.Local {
		t.Fatalf("moved port: %+v", c)
	}
}

func TestParseRoleCandidatesNone(t *testing.T) {
	if got := parseRoleCandidates(`LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))`); len(got) != 0 {
		t.Fatalf("candidates = %+v, want none", got)
	}
}

func TestParseProcNetListen(t *testing.T) {
	out := `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:075B 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0000000000000000 100 0 0 10 0
   1: 0100007F:22B8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2 1 0000000000000000 100 0 0 10 0
   2: 0100007F:075B 0100007F:9C40 01 00000000:00000000 00:00000000 00000000     0        0 3 1 0000000000000000 100 0 0 10 0
   3: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4 1 0000000000000000 100 0 0 10 0`
	got := parseProcNetListen(strings.NewReader(out))
	if len(got) != 1 || got[0].Port != 1883 || got[0].Local || got[0].Scheme != "mqtt" || got[0].Process != "" {
		t.Fatalf("candidates = %+v, want 1883 only, reachable", got)
	}
	loop := parseProcNetListen(strings.NewReader("   0: 0100007F:075B 00000000:0000 0A 0\n"))
	if len(loop) != 1 || !loop[0].Local {
		t.Fatalf("loopback = %+v, want local", loop)
	}
}

func TestParseRoleCandidatesPid(t *testing.T) {
	got := parseRoleCandidates(`LISTEN 0 100 0.0.0.0:1883 0.0.0.0:* users:(("mosquitto",pid=701,fd=5))`)
	if len(got) != 1 || got[0].pid != 701 {
		t.Fatalf("pid = %+v", got)
	}
}

func TestParseMosquittoVersion(t *testing.T) {
	for in, want := range map[string]string{
		"mosquitto version 2.1.2\n\nmosquitto is an MQTT v5.0/v3.1.1/v3.1 message broker.": "2.1.2",
		"mosquitto version 2.0.21": "2.0.21",
		"usage: nope":              "",
	} {
		if got := parseMosquittoVersion(in); got != want {
			t.Errorf("%q = %q, want %q", in, got, want)
		}
	}
}

func TestMapsHaveDynsec(t *testing.T) {
	with := "7f1 r-xp 0 08:01 12 /usr/lib/x86_64-linux-gnu/mosquitto_dynamic_security.so\n"
	without := "7f1 r-xp 0 08:01 12 /usr/lib/x86_64-linux-gnu/libssl.so.3\n"
	if !mapsHaveDynsec(strings.NewReader(with)) || mapsHaveDynsec(strings.NewReader(without)) {
		t.Fatal("maps detection")
	}
}

func TestParseRoleCandidatesLogServer(t *testing.T) {
	// VictoriaLogs on the host: its API and its syslog input; in a container: only the default port of the API tells it
	out := `LISTEN 0 4096 *:9428 *:* users:(("victoria-logs-p",pid=410,fd=8))
LISTEN 0 4096 *:29514 *:* users:(("victoria-logs-p",pid=410,fd=9))
LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:* users:(("docker-proxy",pid=500,fd=7))`
	got := parseRoleCandidates(out)
	if len(got) != 2 {
		t.Fatalf("candidates = %+v, want 2", got)
	}
	if c := got[0]; c.Type != "log-server" || c.Port != 9428 || c.Scheme != "http" || c.Local {
		t.Fatalf("api: %+v", c)
	}
	if c := got[1]; c.Type != "log-server" || c.Port != 29514 || c.Scheme != "syslog" {
		t.Fatalf("syslog: %+v", c)
	}
	got = parseRoleCandidates(`LISTEN 0 4096 0.0.0.0:9428 0.0.0.0:* users:(("docker-proxy",pid=500,fd=7))`)
	if len(got) != 1 || got[0].Type != "log-server" || got[0].Scheme != "http" {
		t.Fatalf("container: %+v", got)
	}
}
