//go:build !windows

package main

import (
	"context"
	"strings"
	"testing"
)

const clusterStatus = `[{"type":"cluster","name":"c"},
{"type":"node","name":"pve-test","ip":"192.168.100.103","local":1,"online":1},
{"type":"node","name":"pve","ip":"192.168.100.110","local":0,"online":1},
{"type":"node","name":"down","ip":"192.168.100.111","local":0,"online":0}]`

func TestPveRemoteNode(t *testing.T) {
	run := func(context.Context, string, ...string) (string, error) { return clusterStatus, nil }
	if ip, err := pveRemoteNode(context.Background(), run, "pve"); err != nil || ip != "192.168.100.110" {
		t.Errorf("pve: %q, %v", ip, err)
	}
	for _, n := range []string{"pve-test", "down", "unknown"} {
		if ip, err := pveRemoteNode(context.Background(), run, n); err == nil || ip != "" {
			t.Errorf("%s accepted: %q", n, ip)
		}
	}
}

func TestPveSSHArgs(t *testing.T) {
	both := func(string) bool { return true }
	args, err := pveSSHArgs("pve", "192.168.100.110", both)
	if err != nil {
		t.Fatal(err)
	}
	line := strings.Join(args, " ")
	for _, want := range []string{"BatchMode=yes", "StrictHostKeyChecking=yes", "HostKeyAlias=pve", "UserKnownHostsFile=/etc/pve/nodes/pve/ssh_known_hosts /etc/pve/priv/known_hosts", "root@192.168.100.110"} {
		if !strings.Contains(line, want) {
			t.Errorf("%q missing from %q", want, line)
		}
	}
	// only the shared file
	args, _ = pveSSHArgs("pve", "192.168.100.110", func(f string) bool { return f == "/etc/pve/priv/known_hosts" })
	if l := strings.Join(args, " "); strings.Contains(l, "nodes/pve") || !strings.Contains(l, "UserKnownHostsFile=/etc/pve/priv/known_hosts") {
		t.Errorf("%q", l)
	}
	if _, err := pveSSHArgs("pve", "192.168.100.110", func(string) bool { return false }); err == nil || !strings.Contains(err.Error(), "pvecm updatecerts") {
		t.Errorf("err %v", err)
	}
}

func TestCheckPveNodes(t *testing.T) {
	var ran []ranCmd
	target := func(_ context.Context, s *AgentInstallSpec) (string, []string, string, error) {
		return "ssh", []string{"root@10.0.0.2"}, "node " + s.Node, nil
	}
	got, err := checkPveNodes(context.Background(), fakeStream(&ran, 0, debianCT), target, []string{"pve"}, "https://hub:3443")
	if err != nil || len(got) != 1 {
		t.Fatalf("%v %+v", err, got)
	}
	g := got[0]
	if g.Node != "pve" || g.Status != "running" || g.OSID != "debian" || !g.Systemd || !g.Curl {
		t.Errorf("%+v", g)
	}
	if ran[0].line != "ssh root@10.0.0.2 sh -s" || !strings.HasPrefix(ran[0].stdin, "set -- 'https://hub:3443'\n") {
		t.Errorf("%+v", ran[0])
	}
	// failures are reported per node
	got, _ = checkPveNodes(context.Background(), fakeStream(&ran, 255, "Host key verification failed.\n"), target, []string{"pve"}, "https://hub:3443")
	if !strings.Contains(got[0].Error, "pvecm updatecerts") {
		t.Errorf("%+v", got[0])
	}
	for _, bad := range [][]string{nil, {"pve; id"}} {
		if _, err := checkPveNodes(context.Background(), fakeStream(&ran, 0, ""), target, bad, "https://hub:3443"); err == nil {
			t.Errorf("%v accepted", bad)
		}
	}
	if _, err := checkPveNodes(context.Background(), fakeStream(&ran, 0, ""), target, []string{"pve"}, "https://hub:3443/$(id)"); err == nil {
		t.Error("bad hub accepted")
	}
}
