//go:build !windows

package main

import (
	"context"
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

func fetchOK(context.Context) ([]byte, error) { return []byte("#!/bin/sh\necho installer\n"), nil }

func TestInstallAgentInLxc(t *testing.T) {
	var ran []ranCmd
	var journal strings.Builder
	// an installer that would print the code must not leak it
	code, err := installAgentInLxc(context.Background(), fakeStream(&ran, 0, "code is "+testCode+"\n"), fetchOK,
		&AgentInstallSpec{Kind: "lxc", VMID: 101, Code: testCode}, func(d string) { journal.WriteString(d) })
	if err != nil || code != 0 {
		t.Fatalf("code %d, err %v", code, err)
	}
	if len(ran) != 1 || ran[0].line != "pct exec 101 -- sh -s" {
		t.Fatalf("commands: %+v", ran)
	}
	if !strings.HasPrefix(ran[0].stdin, "HLM_ENROLL_CODE="+testCode+"; export HLM_ENROLL_CODE\n#!/bin/sh") {
		t.Errorf("stdin: %q", ran[0].stdin)
	}
	if strings.Contains(ran[0].line, testCode) || strings.Contains(journal.String(), testCode) {
		t.Errorf("code leaked: %q / %q", ran[0].line, journal.String())
	}
}

func TestInstallAgentInLxcCurl(t *testing.T) {
	var ran []ranCmd
	_, err := installAgentInLxc(context.Background(), fakeStream(&ran, 0, ""), fetchOK,
		&AgentInstallSpec{Kind: "lxc", VMID: 101, Code: testCode, InstallCurl: true}, func(string) {})
	if err != nil || len(ran) != 2 || !strings.Contains(ran[0].line, "apt-get install -y -q curl") || ran[0].stdin != "" || ran[1].line != "pct exec 101 -- sh -s" {
		t.Fatalf("err %v, commands %+v", err, ran)
	}
	// a failed curl installation stops before the installer
	ran = nil
	if _, err := installAgentInLxc(context.Background(), fakeStream(&ran, 100, ""), fetchOK,
		&AgentInstallSpec{Kind: "lxc", VMID: 101, Code: testCode, InstallCurl: true}, func(string) {}); err == nil || len(ran) != 1 {
		t.Fatalf("err %v, commands %+v", err, ran)
	}
}

func TestInstallAgentInLxcRejects(t *testing.T) {
	for name, s := range map[string]*AgentInstallSpec{
		"nil":        nil,
		"node":       {Kind: "node", VMID: 101, Code: testCode},
		"low id":     {Kind: "lxc", VMID: 7, Code: testCode},
		"short code": {Kind: "lxc", VMID: 101, Code: "abc"},
		"bad code":   {Kind: "lxc", VMID: 101, Code: "abcdefghijklmnop'; rm -rf /"},
	} {
		var ran []ranCmd
		if _, err := installAgentInLxc(context.Background(), fakeStream(&ran, 0, ""), fetchOK, s, func(string) {}); err == nil || len(ran) != 0 {
			t.Errorf("%s: accepted (%v, %+v)", name, err, ran)
		}
	}
}
