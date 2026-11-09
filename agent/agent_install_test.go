//go:build !windows

package main

import (
	"context"
	"fmt"
	"io"
	"strings"
	"testing"
)

const testCode = "AbCdEfGhIjKlMnOp-_0123"

type ranCmd struct {
	line  string
	stdin string
}

func fakeStream(ran *[]ranCmd, exit int, echo string) streamIn {
	return func(_ context.Context, _ []string, stdin io.Reader, emit func(string), name string, args ...string) (int, error) {
		c := ranCmd{line: strings.Join(append([]string{name}, args...), " ")}
		if stdin != nil {
			b, _ := io.ReadAll(stdin)
			c.stdin = string(b)
		}
		*ran = append(*ran, c)
		emit(echo)
		return exit, nil
	}
}

const installCA = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"

var installAnchorJSON = `{"signers":["` + testKey + `"],"pinnedAt":1700000000}`

func testSource(allow bool) installSource {
	return installSource{
		hub:    "https://192.168.1.5:3443",
		ca:     func() ([]byte, error) { return []byte(installCA), nil },
		anchor: func() ([]byte, error) { return []byte(installAnchorJSON), nil },
		binary: func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader("ELF-binary")), nil },
		policy: func() Policy { p := legacyPolicy(); p.AgentInstall = &allow; return p },
	}
}

// the target of the tests: pct exec for a CT, a fixed ssh destination for a node
func fakeTarget(_ context.Context, s *AgentInstallSpec) (string, []string, string, error) {
	if s.Kind == "node" {
		return "ssh", []string{"-o", "BatchMode=yes", "root@10.0.0.2"}, "node " + s.Node, nil
	}
	return "pct", []string{"exec", fmt.Sprint(s.VMID), "--"}, "CT " + fmt.Sprint(s.VMID), nil
}

func installAgentInLxc(ctx context.Context, run streamIn, s *AgentInstallSpec, emit func(string)) (int, error) {
	return installAgent(ctx, run, testSource(true), fakeTarget, s, emit)
}

func TestInstallAgentInLxc(t *testing.T) {
	var ran []ranCmd
	var journal strings.Builder
	// a target that would print the code must not leak it
	code, err := installAgentInLxc(context.Background(), fakeStream(&ran, 0, "code is "+testCode+"\n"),
		&AgentInstallSpec{Kind: "lxc", VMID: 101, Code: testCode, InstallCurl: true}, func(d string) { journal.WriteString(d) })
	if err != nil || code != 0 {
		t.Fatalf("code %d, err %v", code, err)
	}
	// its own binary copied, then installed: no script of the hub, no curl
	if len(ran) != 2 || ran[0].line != "pct exec 101 -- sh -c "+pushScript || ran[0].stdin != "ELF-binary" {
		t.Fatalf("copy: %+v", ran)
	}
	if ran[1].line != "pct exec 101 -- sh -c "+pushedBin+" install -hub 'https://192.168.1.5:3443' -stdin" || ran[1].stdin != testCode+"\n"+installCA+"\n"+installAnchorJSON+"\n" {
		t.Fatalf("install: %+v", ran[1])
	}
	for _, c := range ran {
		if strings.Contains(c.line, testCode) {
			t.Errorf("code in a command line: %q", c.line)
		}
	}
	if strings.Contains(journal.String(), testCode) {
		t.Errorf("code leaked in the journal: %q", journal.String())
	}
}

func TestInstallAgentFailedCopy(t *testing.T) {
	var ran []ranCmd
	if _, err := installAgentInLxc(context.Background(), fakeStream(&ran, 1, ""), &AgentInstallSpec{Kind: "lxc", VMID: 101, Code: testCode}, func(string) {}); err == nil || len(ran) != 1 {
		t.Fatalf("err %v, commands %+v", err, ran)
	}
}

func TestInstallAgentPolicy(t *testing.T) {
	var ran []ranCmd
	_, err := installAgent(context.Background(), fakeStream(&ran, 0, ""), testSource(false), fakeTarget, &AgentInstallSpec{Kind: "lxc", VMID: 101, Code: testCode}, func(string) {})
	if err == nil || !strings.Contains(err.Error(), "agentInstall") || len(ran) != 0 {
		t.Fatalf("err %v, commands %+v", err, ran)
	}
}

// a node without anchor installs nothing: the new agent would open a TOFU window (homelab#319)
func TestInstallAgentNoAnchor(t *testing.T) {
	src := testSource(true)
	src.anchor = func() ([]byte, error) { return handoverAnchor(t.TempDir()) }
	var ran []ranCmd
	_, err := installAgent(context.Background(), fakeStream(&ran, 0, ""), src, fakeTarget, &AgentInstallSpec{Kind: "lxc", VMID: 101, Code: testCode}, func(string) {})
	if err == nil || !strings.Contains(err.Error(), "access anchor") || len(ran) != 0 {
		t.Fatalf("err %v, commands %+v", err, ran)
	}
}

func TestInstallAgentInLxcRejects(t *testing.T) {
	for name, s := range map[string]*AgentInstallSpec{
		"nil":        nil,
		"unknown":    {Kind: "vm", VMID: 101, Code: testCode},
		"bad node":   {Kind: "node", Node: "pve; rm -rf /", Code: testCode},
		"no node":    {Kind: "node", Code: testCode},
		"low id":     {Kind: "lxc", VMID: 7, Code: testCode},
		"short code": {Kind: "lxc", VMID: 101, Code: "abc"},
		"bad code":   {Kind: "lxc", VMID: 101, Code: "abcdefghijklmnop'; rm -rf /"},
	} {
		var ran []ranCmd
		if _, err := installAgentInLxc(context.Background(), fakeStream(&ran, 0, ""), s, func(string) {}); err == nil || len(ran) != 0 {
			t.Errorf("%s: accepted (%v, %+v)", name, err, ran)
		}
	}
}

func TestInstallAgentOnNode(t *testing.T) {
	var ran []ranCmd
	code, err := installAgent(context.Background(), fakeStream(&ran, 0, ""), testSource(true), fakeTarget,
		&AgentInstallSpec{Kind: "node", Node: "pve", Code: testCode}, func(string) {})
	// ssh: the remote command is one argument, fixed
	if err != nil || code != 0 || len(ran) != 2 || ran[0].line != "ssh -o BatchMode=yes root@10.0.0.2 "+pushScript ||
		ran[1].line != "ssh -o BatchMode=yes root@10.0.0.2 "+pushedBin+" install -hub 'https://192.168.1.5:3443' -stdin" || !strings.HasPrefix(ran[1].stdin, testCode+"\n") {
		t.Fatalf("code %d, err %v, commands %+v", code, err, ran)
	}
	// an unknown host key is explained
	ran = nil
	_, err = installAgent(context.Background(), fakeStream(&ran, 255, "Host key verification failed.\n"), testSource(true), fakeTarget,
		&AgentInstallSpec{Kind: "node", Node: "pve", Code: testCode}, func(string) {})
	if err == nil || !strings.Contains(err.Error(), "pvecm updatecerts") {
		t.Fatalf("err %v", err)
	}
}
