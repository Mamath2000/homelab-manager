//go:build !windows

package main

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Read-only check of the containers (CT) of this node, before an agent is installed in them (rpc pve_guest_check):
// `pct status`, then a fixed script run with `pct exec` that only reads. Nothing is written in the CT.

// PveGuestCheck is the state of one CT: what decides whether the agent can be installed in it.
type PveGuestCheck struct {
	VMID           int    `json:"vmid"`
	Status         string `json:"status"` // running | stopped | unknown
	OSID           string `json:"osId,omitempty"`
	IDLike         string `json:"idLike,omitempty"`
	VersionID      string `json:"versionId,omitempty"`
	Arch           string `json:"arch,omitempty"`
	Systemd        bool   `json:"systemd"`
	Curl           bool   `json:"curl"`
	Apt            bool   `json:"apt"`
	AgentInstalled bool   `json:"agentInstalled"`
	HubReachable   *bool  `json:"hubReachable,omitempty"` // nil: not tested (no curl in the CT)
	Error          string `json:"error,omitempty"`
}

const (
	pveGuestMaxVmids   = 50
	pveGuestCheckLimit = 30 * time.Second
)

var pveHubRe = regexp.MustCompile(`^https://[A-Za-z0-9.\-\[\]:]+$`)

// pveGuestScript is the only thing run in a CT by the check: key=value lines on stdout, $1 is the agent address of the hub.
const pveGuestScript = `
sed 's/^/osr:/' /etc/os-release 2>/dev/null
echo "arch=$(uname -m)"
[ -d /run/systemd/system ] && echo systemd=1
command -v apt-get >/dev/null 2>&1 && echo apt=1
[ -e /etc/systemd/system/homelab-agent.service ] && echo agent=1
if command -v curl >/dev/null 2>&1; then
  echo curl=1
  if curl -sk -m 5 -o /dev/null "$1/agent/ca.pem"; then echo hub=1; else echo hub=0; fi
fi
exit 0
`

// checkPveGuests inspects the given CT, one after the other. A CT that cannot be inspected is reported with an Error.
func checkPveGuests(ctx context.Context, run pveRun, vmids []int, hub string) ([]PveGuestCheck, error) {
	if len(vmids) == 0 || len(vmids) > pveGuestMaxVmids {
		return nil, fmt.Errorf("between 1 and %d CT per check", pveGuestMaxVmids)
	}
	if !pveHubRe.MatchString(hub) {
		return nil, fmt.Errorf("invalid hub address")
	}
	out := make([]PveGuestCheck, 0, len(vmids))
	for _, id := range vmids {
		if id < 100 || id > 999999999 {
			return nil, fmt.Errorf("invalid CT id %d", id)
		}
		out = append(out, checkPveGuest(ctx, run, id, hub))
	}
	return out, nil
}

func checkPveGuest(ctx context.Context, run pveRun, id int, hub string) PveGuestCheck {
	g := PveGuestCheck{VMID: id, Status: "unknown"}
	cctx, cancel := context.WithTimeout(ctx, pveGuestCheckLimit)
	defer cancel()
	vmid := strconv.Itoa(id)
	st, err := run(cctx, "pct", "status", vmid)
	if err != nil {
		g.Error = err.Error()
		return g
	}
	g.Status = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(st), "status:"))
	if g.Status != "running" {
		return g
	}
	res, err := run(cctx, "pct", "exec", vmid, "--", "sh", "-c", pveGuestScript, "sh", hub)
	if err != nil {
		g.Error = err.Error()
		return g
	}
	parsePveGuest(&g, res)
	return g
}

// parsePveGuest reads the output of pveGuestScript.
func parsePveGuest(g *PveGuestCheck, out string) {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if rest, ok := strings.CutPrefix(line, "osr:"); ok {
			k, v, _ := strings.Cut(rest, "=")
			v = strings.Trim(v, `"'`)
			switch k {
			case "ID":
				g.OSID = v
			case "ID_LIKE":
				g.IDLike = v
			case "VERSION_ID":
				g.VersionID = v
			}
			continue
		}
		k, v, _ := strings.Cut(line, "=")
		switch k {
		case "arch":
			g.Arch = v
		case "systemd":
			g.Systemd = v == "1"
		case "curl":
			g.Curl = v == "1"
		case "apt":
			g.Apt = v == "1"
		case "agent":
			g.AgentInstalled = v == "1"
		case "hub":
			ok := v == "1"
			g.HubReachable = &ok
		}
	}
}
