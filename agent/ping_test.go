//go:build !windows

package main

import (
	"context"
	"os/exec"
	"strings"
	"testing"
)

func fakePing(out string, exit int, err error) pingRunner {
	return func(ctx context.Context, args []string) (string, int, error) { return out, exit, err }
}

func TestPingHost(t *testing.T) {
	ctx := context.Background()
	up, err := pingHost(ctx, "192.168.10.5", "", 5, fakePing("64 bytes from 192.168.10.5: icmp_seq=1 ttl=63 time=12.4 ms", 0, nil))
	if err != nil || !up.Up || up.LatencyMs != 12 {
		t.Fatalf("up: %+v %v", up, err)
	}
	down, err := pingHost(ctx, "192.168.10.5", "", 5, fakePing("1 packets transmitted, 0 received", 1, nil))
	if err != nil || down.Up || !strings.Contains(down.Message, "pas de réponse") {
		t.Fatalf("down: %+v %v", down, err)
	}
	bad, _ := pingHost(ctx, "nope.invalid", "", 5, fakePing("ping: nope.invalid: Name or service not known", 2, nil))
	if bad.Up || bad.Message != "nom introuvable" {
		t.Fatalf("bad name: %+v", bad)
	}
}

func TestPingHostRefusals(t *testing.T) {
	ctx := context.Background()
	r, _ := pingHost(ctx, "-f", "", 5, fakePing("", 0, nil))
	if r.Up || r.Message != "adresse invalide" {
		t.Fatalf("option must be refused: %+v", r)
	}
	if _, err := pingHost(ctx, "10.0.0.1", "", 5, fakePing("", 0, exec.ErrNotFound)); err == nil {
		t.Fatal("missing command must be an error (measure impossible)")
	}
	if _, err := pingHost(ctx, "10.0.0.1", "", 5, fakePing("ping: socket: Operation not permitted", 2, nil)); err == nil {
		t.Fatal("not permitted must be an error (measure impossible)")
	}
}

func TestPingHostFrom(t *testing.T) {
	ctx := context.Background()
	var got []string
	run := func(ctx context.Context, args []string) (string, int, error) {
		got = args
		return "time=3 ms", 0, nil
	}
	if r, _ := pingHost(ctx, "192.168.2.1", "192.168.100.241", 2, run); !r.Up {
		t.Fatalf("up expected: %+v", r)
	}
	if strings.Join(got, " ") != "-c 1 -W 2 -I 192.168.100.241 192.168.2.1" {
		t.Fatalf("args: %v", got)
	}
	if r, _ := pingHost(ctx, "192.168.2.1", "-f", 2, run); r.Up || r.Message != "adresse source invalide" {
		t.Fatalf("option as source must be refused: %+v", r)
	}
	if _, err := pingHost(ctx, "192.168.2.1", "10.9.9.9", 2, fakePing("ping: bind: Cannot assign requested address", 2, nil)); err == nil {
		t.Fatal("a source the host does not have is a measure impossible")
	}
}
