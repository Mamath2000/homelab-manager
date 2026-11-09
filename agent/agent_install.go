//go:build !windows

package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"
)

// Installation of the agent in a CT of this node or on another node of the cluster (job agent_install), asked by
// the hub from the PVE inventory. Nothing that runs there comes from the hub: this agent copies its own binary
// (already checked, a release one is signed) and runs `homelab-agent install` (selfinstall_unix.go), fed on stdin
// with the single-use enrollment code, the CA of the hub this node trusts and the access anchor of this node (no TOFU
// window on the new agent, homelab#319). The code travels on stdin only, never in a command line, a file or the
// journal of the job. The hub address is the one of this node.

// AgentInstallSpec is what the hub asks for.
type AgentInstallSpec struct {
	Kind        string `json:"kind"`           // lxc | node
	VMID        int    `json:"vmid,omitempty"` // lxc: the CT of this node
	Node        string `json:"node,omitempty"` // node: another node of the cluster, reached by SSH
	Code        string `json:"code"`
	InstallCurl bool   `json:"installCurl,omitempty"` // sent by older hubs: curl is not needed any more
}

const agentInstallTimeout = 10 * time.Minute

var agentCodeRe = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

// where the binary is copied, next to the final one: `install` moves it in place
const pushedBin = "/usr/local/bin/homelab-agent.new"

// pushScript receives the binary on stdin (fixed: nothing to quote for pct or ssh)
const pushScript = "umask 022; mkdir -p /usr/local/bin && cat > " + pushedBin + " && chmod 0755 " + pushedBin

// streamIn runs a command with a standard input and forwards its output to emit (runStreamingIn).
type streamIn func(ctx context.Context, env []string, stdin io.Reader, emit func(string), name string, args ...string) (int, error)

// installSource: what this agent hands over to the new one.
type installSource struct {
	hub    string                        // agent address of the hub, the one this node uses
	ca     func() ([]byte, error)        // CA of the hub, pinned by this node
	anchor func() ([]byte, error)        // access anchor of this node (signers of the access manifests)
	binary func() (io.ReadCloser, error) // the binary of this agent
	policy func() Policy                 // local policy of this node
}

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

// installAgent: target says how to run a command in the CT (pct exec) or on the other node (ssh): fixed command
// lines, what is run or copied travels on stdin.
func installAgent(ctx context.Context, run streamIn, src installSource, target func(context.Context, *AgentInstallSpec) (string, []string, string, error), s *AgentInstallSpec, emit func(string)) (int, error) {
	if err := validateAgentInstall(s); err != nil {
		return -1, err
	}
	if p := src.policy(); !p.agentInstallAllowed() {
		return -1, fmt.Errorf("installation d'agents refusée par la %s (agentInstall)", p.where())
	}
	if !pveHubRe.MatchString(src.hub) {
		return -1, fmt.Errorf("invalid hub address %q", src.hub)
	}
	anchor, err := src.anchor()
	if err != nil {
		return -1, err
	}
	ctx, cancel := context.WithTimeout(ctx, agentInstallTimeout)
	defer cancel()
	// the code must not show up in the journal whatever the target prints
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
	ca, err := src.ca()
	if err != nil {
		return -1, fmt.Errorf("CA of the hub: %w", err)
	}
	bin, err := src.binary()
	if err != nil {
		return -1, fmt.Errorf("binary of this agent: %w", err)
	}
	defer bin.Close()
	// ssh joins its arguments into one remote command line; pct exec runs them as they are
	shell := func(script string) []string {
		args := append([]string{}, prefix...)
		if name == "ssh" {
			return append(args, script)
		}
		return append(args, "sh", "-c", script)
	}
	hostKey := func(code int, err error) (int, error) {
		if code != 0 && strings.Contains(out.String(), "Host key verification failed") {
			return code, fmt.Errorf("host key of %s unknown: run « pvecm updatecerts » on that node", s.Node)
		}
		return code, err
	}
	if s.InstallCurl {
		safe("curl is not needed any more: skipped\n")
	}
	safe(fmt.Sprintf("copying the agent %s to %s...\n", version, label))
	code, err := run(ctx, nil, bin, safe, name, shell(pushScript)...)
	if err != nil || code != 0 {
		code, err = hostKey(code, err)
		if err == nil {
			err = fmt.Errorf("copy of the agent to %s failed (code %d)", label, code)
		}
		return code, err
	}
	safe("installing the agent in " + label + "...\n")
	in := strings.NewReader(s.Code + "\n" + string(ca) + "\n" + string(anchor) + "\n")
	code, err = run(ctx, nil, in, safe, name, shell(pushedBin+" install -hub '"+src.hub+"' -stdin")...)
	if code != 0 && strings.Contains(out.String(), "exec format error") {
		return code, fmt.Errorf("%s has another architecture than this node: use the install command of the hub", label)
	}
	return hostKey(code, err)
}

// nodeInstallSource: this agent, its hub and its CA.
func nodeInstallSource(hub, dir string) installSource {
	return installSource{
		hub:    hub,
		ca:     func() ([]byte, error) { return os.ReadFile(dir + "/" + caFile) },
		anchor: func() ([]byte, error) { return handoverAnchor(dir) },
		binary: func() (io.ReadCloser, error) { return os.Open("/proc/self/exe") },
		policy: currentPolicy,
	}
}
