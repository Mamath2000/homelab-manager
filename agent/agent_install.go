//go:build !windows

package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Installation of the agent in a CT of this node (job agent_install), asked by the hub from the PVE inventory.
// The node fetches the installer from its own hub (mutual TLS, so it carries the address and the pinned key
// this node uses) and feeds it to `pct exec <vmid> -- sh -s` together with the single-use enrollment code:
// the code travels on stdin only, never in a command line, a file or the journal of the job.

// AgentInstallSpec is what the hub asks for.
type AgentInstallSpec struct {
	Kind        string `json:"kind"` // lxc
	VMID        int    `json:"vmid"`
	Code        string `json:"code"`
	InstallCurl bool   `json:"installCurl,omitempty"` // apt-get install curl first, in a CT that has none
}

const agentInstallTimeout = 10 * time.Minute

var agentCodeRe = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

// streamIn runs a command with a standard input and forwards its output to emit (runStreamingIn).
type streamIn func(ctx context.Context, env []string, stdin io.Reader, emit func(string), name string, args ...string) (int, error)

func validateAgentInstall(s *AgentInstallSpec) error {
	if s == nil {
		return fmt.Errorf("missing install spec")
	}
	if s.Kind != "lxc" {
		return fmt.Errorf("unsupported install target %q", s.Kind)
	}
	if s.VMID < 100 || s.VMID > 999999999 {
		return fmt.Errorf("invalid CT id %d", s.VMID)
	}
	if !agentCodeRe.MatchString(s.Code) {
		return fmt.Errorf("invalid enrollment code")
	}
	return nil
}

// installAgentInLxc: fetch is the installer of the hub; run executes the (fixed) pct command lines.
func installAgentInLxc(ctx context.Context, run streamIn, fetch func(context.Context) ([]byte, error), s *AgentInstallSpec, emit func(string)) (int, error) {
	if err := validateAgentInstall(s); err != nil {
		return -1, err
	}
	ctx, cancel := context.WithTimeout(ctx, agentInstallTimeout)
	defer cancel()
	// the code must not show up in the journal whatever the installer prints
	safe := func(d string) { emit(strings.ReplaceAll(d, s.Code, "***")) }
	vmid := strconv.Itoa(s.VMID)

	script, err := fetch(ctx)
	if err != nil {
		return -1, fmt.Errorf("installer of the hub: %w", err)
	}
	if s.InstallCurl {
		safe("installing curl in CT " + vmid + "...\n")
		code, err := run(ctx, nil, nil, safe, "pct", "exec", vmid, "--", "env", "DEBIAN_FRONTEND=noninteractive", "sh", "-c",
			"command -v curl >/dev/null 2>&1 || { apt-get update -q && apt-get install -y -q curl; }")
		if err != nil || code != 0 {
			return code, fmt.Errorf("curl could not be installed in CT %s", vmid)
		}
	}
	safe("installing the agent in CT " + vmid + "...\n")
	in := strings.NewReader("HLM_ENROLL_CODE=" + s.Code + "; export HLM_ENROLL_CODE\n" + string(script))
	return run(ctx, nil, in, safe, "pct", "exec", vmid, "--", "sh", "-s")
}

// fetchInstaller downloads install.sh from the hub of this agent.
func fetchInstaller(client *http.Client, hub string) func(context.Context) ([]byte, error) {
	return func(ctx context.Context) ([]byte, error) {
		body, err := get(ctx, client, hub+"/install.sh")
		if err != nil {
			return nil, err
		}
		defer body.Close()
		return io.ReadAll(io.LimitReader(body, 1<<20))
	}
}
