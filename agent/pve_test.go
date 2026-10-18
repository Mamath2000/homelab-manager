package main

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

// fakePve answers like pveum / pvesh / pvenode; calls records the commands.
type fakePve struct {
	users, tokens []string
	acls          [][4]string // path, role, type, ugid
	failOn        string      // commands with this prefix fail
	calls         []string
}

func (f *fakePve) run(_ context.Context, bin string, args ...string) (string, error) {
	cmd := strings.Join(append([]string{bin}, args...), " ")
	f.calls = append(f.calls, cmd)
	if f.failOn != "" && strings.HasPrefix(cmd, f.failOn) {
		return "", fmt.Errorf("%s: failed", cmd)
	}
	switch {
	case strings.HasPrefix(cmd, "pveum acl list"):
		var b []string
		for _, a := range f.acls {
			b = append(b, fmt.Sprintf(`{"path":%q,"roleid":%q,"type":%q,"ugid":%q,"propagate":1}`, a[0], a[1], a[2], a[3]))
		}
		return "[" + strings.Join(b, ",") + "]", nil
	case strings.HasPrefix(cmd, "pveum user token list"):
		var b []string
		for _, t := range f.tokens {
			b = append(b, fmt.Sprintf(`{"tokenid":%q,"privsep":1,"expire":0}`, t))
		}
		return "[" + strings.Join(b, ",") + "]", nil
	case strings.HasPrefix(cmd, "pveum user list"):
		var b []string
		for _, u := range f.users {
			b = append(b, fmt.Sprintf(`{"userid":%q}`, u))
		}
		return "[" + strings.Join(b, ",") + "]", nil
	case strings.HasPrefix(cmd, "pveum user token add"):
		return `{"full-tokenid":"homelab@pve!monitor","info":{"privsep":"1"},"value":"0B1C2D3E-1111-2222-3333-444455556666"}`, nil
	}
	return "", nil
}

var pveAuditor = []PveACL{{Path: "/", Role: "PVEAuditor"}}

func TestEnsurePveTokenCreates(t *testing.T) {
	f := &fakePve{}
	r, err := ensurePveToken(context.Background(), f.run, &PveTokenSpec{User: "homelab@pve", Token: "monitor", ACLs: pveAuditor})
	if err != nil {
		t.Fatal(err)
	}
	if !r.Created || r.Rotated || r.Secret != "0b1c2d3e-1111-2222-3333-444455556666" || r.TokenID != "homelab@pve!monitor" {
		t.Fatalf("result %+v", r)
	}
	got := strings.Join(f.calls, "\n")
	for _, w := range []string{
		"pveum user add homelab@pve",
		"pveum user token add homelab@pve monitor --privsep 1 --output-format json",
		"pveum acl modify / --roles PVEAuditor --users homelab@pve",
		"pveum acl modify / --roles PVEAuditor --tokens homelab@pve!monitor",
	} {
		if !strings.Contains(got, w) {
			t.Errorf("missing call %q in\n%s", w, got)
		}
	}
}

func TestEnsurePveTokenExisting(t *testing.T) {
	f := &fakePve{users: []string{"homelab@pve"}, tokens: []string{"homelab"}}
	r, err := ensurePveToken(context.Background(), f.run, &PveTokenSpec{User: "homelab@pve", Token: "homelab", ACLs: pveAuditor})
	if err != nil {
		t.Fatal(err)
	}
	if r.Created || r.Secret != "" {
		t.Fatalf("existing token must not return a secret: %+v", r)
	}
	for _, c := range f.calls {
		if strings.HasPrefix(c, "pveum user add") || strings.HasPrefix(c, "pveum user token add") || strings.HasPrefix(c, "pveum user token remove") {
			t.Errorf("unexpected call %q", c)
		}
	}
}

func TestEnsurePveTokenRotates(t *testing.T) {
	f := &fakePve{users: []string{"homelab@pve"}, tokens: []string{"homelab"}}
	r, err := ensurePveToken(context.Background(), f.run, &PveTokenSpec{User: "homelab@pve", Token: "homelab", Rotate: true, ACLs: pveAuditor})
	if err != nil {
		t.Fatal(err)
	}
	if !r.Created || !r.Rotated || r.Secret == "" {
		t.Fatalf("rotated token must return a new secret: %+v", r)
	}
	if !strings.Contains(strings.Join(f.calls, "\n"), "pveum user token remove homelab@pve homelab\npveum user token add homelab@pve homelab") {
		t.Fatalf("token not created again:\n%s", strings.Join(f.calls, "\n"))
	}
}

func TestEnsurePveTokenPrunesTokenACLs(t *testing.T) {
	f := &fakePve{users: []string{"homelab@pve"}, tokens: []string{"monitor"}}
	f.acls = [][4]string{
		{"/vms", "PVEAuditor", "token", "homelab@pve!monitor"}, // former right: removed
		{"/", "PVEAuditor", "token", "homelab@pve!monitor"},    // still asked for: kept
		{"/vms", "PVEAuditor", "user", "homelab@pve"},          // user's: left alone
		{"/vms", "PVEAuditor", "token", "homelab@pve!other"},   // another token: left alone
	}
	r, err := ensurePveToken(context.Background(), f.run, &PveTokenSpec{User: "homelab@pve", Token: "monitor", ACLs: pveAuditor})
	if err != nil {
		t.Fatal(err)
	}
	var deletes []string
	for _, c := range f.calls {
		if strings.HasPrefix(c, "pveum acl delete") {
			deletes = append(deletes, c)
		}
	}
	if len(deletes) != 1 || deletes[0] != "pveum acl delete /vms --roles PVEAuditor --tokens homelab@pve!monitor" || len(r.Removed) != 1 {
		t.Fatalf("deletes %q, removed %q", deletes, r.Removed)
	}
}

func TestEnsurePveTokenRollsBackOnFailure(t *testing.T) {
	f := &fakePve{failOn: "pveum acl modify"}
	r, err := ensurePveToken(context.Background(), f.run, &PveTokenSpec{User: "homelab@pve", Token: "monitor", ACLs: pveAuditor})
	if err == nil || r != nil {
		t.Fatalf("expected an error and no result: %+v %v", r, err)
	}
	if last := f.calls[len(f.calls)-1]; last != "pveum user token remove homelab@pve monitor" {
		t.Fatalf("token not deleted, last call %q", last)
	}
}

func TestValidatePveToken(t *testing.T) {
	ok := func() *PveTokenSpec {
		return &PveTokenSpec{User: "homelab@pve", Token: "monitor", ACLs: []PveACL{{Path: "/", Role: "PVEAuditor"}}}
	}
	if err := validatePveToken(ok()); err != nil {
		t.Fatal(err)
	}
	bad := map[string]func(s *PveTokenSpec){
		"user realm":     func(s *PveTokenSpec) { s.User = "root@pam" },
		"user injection": func(s *PveTokenSpec) { s.User = "a b@pve" },
		"token":          func(s *PveTokenSpec) { s.Token = "1x" },
		"role":           func(s *PveTokenSpec) { s.ACLs[0].Role = "Administrator" },
		"path":           func(s *PveTokenSpec) { s.ACLs[0].Path = "/vms" },
		"empty":          func(s *PveTokenSpec) { s.ACLs = nil },
	}
	for name, mut := range bad {
		s := ok()
		mut(s)
		if validatePveToken(s) == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestDescribePve(t *testing.T) {
	run := func(_ context.Context, bin string, args ...string) (string, error) {
		switch bin {
		case "pveversion":
			return "pve-manager/9.2.21/4f6e0ac86f9e8c7f (running kernel: 7.0.14-24-pve)\n", nil
		case "pvesh":
			return `[{"id":"cluster","name":"home","nodes":2,"type":"cluster"},{"id":"node/pve1","ip":"192.168.0.241","local":1,"name":"pve1","type":"node"},{"id":"node/pve2","local":0,"name":"pve2","type":"node"}]`, nil
		case "pvenode":
			return `[{"filename":"pve-root-ca.pem","fingerprint":"91:03"},{"filename":"pve-ssl.pem","fingerprint":"ca:43:59"}]`, nil
		}
		return "", nil
	}
	info := describePve(context.Background(), run)
	if info.Version != "9.2.21" || info.Cluster != "home" || info.Node != "pve1" || strings.Join(info.Nodes, ",") != "pve1,pve2" || info.Fingerprint != "CA:43:59" || info.Port != 8006 {
		t.Fatalf("info %+v", info)
	}
	if fp := pveProxyFingerprint(`[{"filename":"pve-ssl.pem","fingerprint":"AA"},{"filename":"pveproxy-ssl.pem","fingerprint":"BB"}]`); fp != "BB" {
		t.Fatalf("custom certificate first, got %q", fp)
	}
}

func TestParseDefaultRoute(t *testing.T) {
	route := "Iface\tDestination\tGateway\tFlags\n vmbr1\t0064A8C0\t00000000\t0001\nvmbr0\t00000000\t0100A8C0\t0003\n"
	if got := parseDefaultRoute(strings.NewReader(route)); got != "vmbr0" {
		t.Fatalf("default route on %q", got)
	}
}
