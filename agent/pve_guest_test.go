//go:build !windows

package main

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

const debianCT = `osr:PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
osr:ID=debian
osr:VERSION_ID="12"
arch=x86_64
systemd=1
apt=1
curl=1
hub=1
`

func TestCheckPveGuests(t *testing.T) {
	var calls []string
	run := func(_ context.Context, bin string, args ...string) (string, error) {
		calls = append(calls, strings.Join(append([]string{bin}, args[:min(len(args), 3)]...), " "))
		switch {
		case args[0] == "status" && args[1] == "101":
			return "status: running\n", nil
		case args[0] == "status" && args[1] == "102":
			return "status: stopped\n", nil
		case args[0] == "status":
			return "", fmt.Errorf("pct status: no such CT")
		}
		if args[len(args)-1] != "https://hub:3443" {
			t.Errorf("hub address not passed as $1: %v", args)
		}
		return debianCT, nil
	}
	got, err := checkPveGuests(context.Background(), run, []int{101, 102, 103}, "https://hub:3443")
	if err != nil {
		t.Fatal(err)
	}
	g := got[0]
	if g.Status != "running" || g.OSID != "debian" || g.VersionID != "12" || g.Arch != "x86_64" || !g.Systemd || !g.Curl || !g.Apt || g.AgentInstalled || g.HubReachable == nil || !*g.HubReachable {
		t.Errorf("CT 101: %+v", g)
	}
	if got[1].Status != "stopped" || got[1].OSID != "" {
		t.Errorf("CT 102: %+v", got[1])
	}
	if got[2].Error == "" || got[2].Status != "unknown" {
		t.Errorf("CT 103: %+v", got[2])
	}
	// exec only on the running one, with a fixed command line
	var execs []string
	for _, c := range calls {
		if strings.HasPrefix(c, "pct exec") {
			execs = append(execs, c)
		}
	}
	if len(execs) != 1 || execs[0] != "pct exec 101 --" {
		t.Errorf("exec calls: %v", execs)
	}
}

func TestCheckPveGuestsRejects(t *testing.T) {
	run := func(context.Context, string, ...string) (string, error) { t.Fatal("nothing must run"); return "", nil }
	for name, tc := range map[string]struct {
		ids []int
		hub string
	}{
		"empty":    {nil, "https://hub:3443"},
		"low id":   {[]int{5}, "https://hub:3443"},
		"bad hub":  {[]int{101}, "https://hub:3443/$(id)"},
		"http hub": {[]int{101}, "http://hub:3443"},
	} {
		if _, err := checkPveGuests(context.Background(), run, tc.ids, tc.hub); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestParsePveGuestNoCurl(t *testing.T) {
	var g PveGuestCheck
	parsePveGuest(&g, "osr:ID=alpine\nosr:ID_LIKE=\"x y\"\narch=aarch64\nagent=1\n")
	if g.OSID != "alpine" || g.IDLike != "x y" || g.Systemd || g.Curl || g.HubReachable != nil || !g.AgentInstalled {
		t.Errorf("%+v", g)
	}
}
