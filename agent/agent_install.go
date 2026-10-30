//go:build !windows

package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Installation of the agent in a CT of this node (job agent_install), asked by the hub from the PVE inventory.
// The node fetches the installer from its own hub (mutual TLS, so it carries the address and the pinned key
// this node uses) and feeds it to `pct exec <vmid> -- sh -s` together with the single-use enrollment code:
// the code travels on stdin only, never in a command line, a file or the journal of the job.

// AgentInstallSpec is what the hub asks for.
type AgentInstallSpec struct {
	Kind        string `json:"kind"`           // lxc | node
	VMID        int    `json:"vmid,omitempty"` // lxc: the CT of this node
	Node        string `json:"node,omitempty"` // node: another node of the cluster, reached by SSH
	Code        string `json:"code"`
	InstallCurl bool   `json:"installCurl,omitempty"` // apt-get install curl first, where there is none
}

const agentInstallTimeout = 10 * time.Minute

var agentCodeRe = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

// streamIn runs a command with a standard input and forwards its output to emit (runStreamingIn).
type streamIn func(ctx context.Context, env []string, stdin io.Reader, emit func(string), name string, args ...string) (int, error)

func validateAgentInstall(s *AgentInstallSpec) error {
	if s == nil {
		return fmt.Errorf("missing install spec")
	}
	switch s.Kind {
	case "lxc":
		if s.VMID < 100 || s.VMID > 999999999 {
			return fmt.Errorf("invalid CT id %d", s.VMID)
		}
	case "node":
		if !pveNodeRe.MatchString(s.Node) {
			return fmt.Errorf("invalid node name")
		}
	default:
		return fmt.Errorf("unsupported install target %q", s.Kind)
	}
	if !agentCodeRe.MatchString(s.Code) {
		return fmt.Errorf("invalid enrollment code")
	}
	return nil
}

// installCurlScript runs where the agent goes, when it has no curl (fed on stdin: nothing to quote for pct or ssh)
const installCurlScript = "command -v curl >/dev/null 2>&1 || { apt-get update -q && apt-get install -y -q curl; }\n"

// installAgent: fetch is the installer of the hub; target says how to run a command in the CT (pct exec) or on the other node
// (ssh): fixed command lines, what is run travels on stdin.
func installAgent(ctx context.Context, run streamIn, fetch func(context.Context) ([]byte, error), target func(context.Context, *AgentInstallSpec) (string, []string, string, error), s *AgentInstallSpec, emit func(string)) (int, error) {
	if err := validateAgentInstall(s); err != nil {
		return -1, err
	}
	ctx, cancel := context.WithTimeout(ctx, agentInstallTimeout)
	defer cancel()
	// the code must not show up in the journal whatever the installer prints
	var out strings.Builder
	safe := func(d string) {
		d = strings.ReplaceAll(d, s.Code, "***")
		out.WriteString(d)
		emit(d)
	}
	name, prefix, label, err := target(ctx, s)
	if err != nil {
		return -1, err
	}
	script, err := fetch(ctx)
	if err != nil {
		return -1, fmt.Errorf("installer of the hub: %w", err)
	}
	args := func(more ...string) []string { return append(append([]string{}, prefix...), more...) }
	if s.InstallCurl {
		safe("installing curl in " + label + "...\n")
		code, err := run(ctx, nil, strings.NewReader(installCurlScript), safe, name, args("env", "DEBIAN_FRONTEND=noninteractive", "sh", "-s")...)
		if err != nil || code != 0 {
			return code, fmt.Errorf("curl could not be installed in %s", label)
		}
	}
	safe("installing the agent in " + label + "...\n")
	in := strings.NewReader("HLM_ENROLL_CODE=" + s.Code + "; export HLM_ENROLL_CODE\n" + string(script))
	code, err := run(ctx, nil, in, safe, name, args("sh", "-s")...)
	if code != 0 && strings.Contains(out.String(), "Host key verification failed") {
		return code, fmt.Errorf("host key of %s unknown: run « pvecm updatecerts » on that node", s.Node)
	}
	return code, err
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
