//go:build !windows

package main

import "testing"

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

func TestParseRoleCandidatesNone(t *testing.T) {
	if got := parseRoleCandidates(`LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))`); len(got) != 0 {
		t.Fatalf("candidates = %+v, want none", got)
	}
}
