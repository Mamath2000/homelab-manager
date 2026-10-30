//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// The other nodes of the cluster, reached by SSH from this node (job agent_install kind node, rpc pve_node_check): the
// root keys of the nodes are shared by the cluster; the host key of the node is checked against the files PVE keeps for
// it (pvecm updatecerts), never accepted blindly.

var pveNodeRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,62}$`)

// pveRemoteNode: the address of a node of this cluster other than this one, and its state.
func pveRemoteNode(ctx context.Context, run pveRun, node string) (ip string, err error) {
	out, err := run(ctx, "pvesh", "get", "/cluster/status", "--output-format", "json")
	if err != nil {
		return "", err
	}
	var list []struct {
		Type   string `json:"type"`
		Name   string `json:"name"`
		IP     string `json:"ip"`
		Local  int    `json:"local"`
		Online int    `json:"online"`
	}
	if err := json.Unmarshal([]byte(out), &list); err != nil {
		return "", err
	}
	for _, e := range list {
		if e.Type != "node" || e.Name != node {
			continue
		}
		switch {
		case e.Local == 1:
			return "", fmt.Errorf("%s is this node", node)
		case e.Online != 1:
			return "", fmt.Errorf("node %s is offline", node)
		case net.ParseIP(e.IP) == nil:
			return "", fmt.Errorf("no address for node %s", node)
		}
		return e.IP, nil
	}
	return "", fmt.Errorf("node %s is not in this cluster", node)
}

// pveSSHArgs: the options and destination of the ssh command to a node. The host key is looked up under the name of the node
// (the address is not what PVE records) in the file of the node, then in the shared one.
func pveSSHArgs(node, ip string, exists func(string) bool) ([]string, error) {
	var files []string
	for _, f := range []string{"/etc/pve/nodes/" + node + "/ssh_known_hosts", "/etc/pve/priv/known_hosts"} {
		if exists(f) {
			files = append(files, f)
		}
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("no host key known for node %s: run « pvecm updatecerts » on it", node)
	}
	return []string{
		"-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes",
		"-o", "HostKeyAlias=" + node, "-o", "UserKnownHostsFile=" + strings.Join(files, " "),
		"root@" + ip,
	}, nil
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// nodeTarget is the `target` of installAgent for a node: ssh; for a CT: pct exec.
func installTarget(run pveRun) func(context.Context, *AgentInstallSpec) (string, []string, string, error) {
	return func(ctx context.Context, s *AgentInstallSpec) (string, []string, string, error) {
		if s.Kind == "lxc" {
			return "pct", []string{"exec", strconv.Itoa(s.VMID), "--"}, "CT " + strconv.Itoa(s.VMID), nil
		}
		ip, err := pveRemoteNode(ctx, run, s.Node)
		if err != nil {
			return "", nil, "", err
		}
		args, err := pveSSHArgs(s.Node, ip, fileExists)
		return "ssh", args, "node " + s.Node, err
	}
}

// checkPveNodes inspects the given nodes through ssh, with the same read-only script as the CT (PveGuestCheck, VMID 0).
func checkPveNodes(ctx context.Context, run streamIn, target func(context.Context, *AgentInstallSpec) (string, []string, string, error), nodes []string, hub string) ([]PveGuestCheck, error) {
	if len(nodes) == 0 || len(nodes) > pveGuestMaxVmids {
		return nil, fmt.Errorf("between 1 and %d nodes per check", pveGuestMaxVmids)
	}
	if !pveHubRe.MatchString(hub) {
		return nil, fmt.Errorf("invalid hub address")
	}
	out := make([]PveGuestCheck, 0, len(nodes))
	for _, n := range nodes {
		if !pveNodeRe.MatchString(n) {
			return nil, fmt.Errorf("invalid node name %q", n)
		}
		g := PveGuestCheck{Node: n, Status: "unknown"}
		func() {
			cctx, cancel := context.WithTimeout(ctx, pveGuestCheckLimit)
			defer cancel()
			name, prefix, _, err := target(cctx, &AgentInstallSpec{Kind: "node", Node: n})
			if err != nil {
				g.Error = err.Error()
				return
			}
			var b strings.Builder
			code, err := run(cctx, nil, strings.NewReader("set -- '"+hub+"'\n"+pveGuestScript), func(d string) { b.WriteString(d) }, name, append(append([]string{}, prefix...), "sh", "-s")...)
			if err != nil || code != 0 {
				g.Error = fmt.Sprintf("ssh to %s failed (%d): %s", n, code, strings.TrimSpace(b.String()))
				if strings.Contains(b.String(), "Host key verification failed") {
					g.Error = fmt.Sprintf("host key of %s unknown: run « pvecm updatecerts » on that node", n)
				}
				return
			}
			g.Status = "running"
			parsePveGuest(&g, b.String())
		}()
		out = append(out, g)
	}
	return out, nil
}
