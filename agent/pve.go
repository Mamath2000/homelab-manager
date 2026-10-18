package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// Proxmox VE administration for the hub (rpc pve_detect / pve_token), on a node of the cluster: what
// the hub needs to declare the cluster, and its read-only API token. Secrets of the tokens only travel
// in the rpc result: never logged.

// PveIface: an interface of the node with its IPv4 addresses, one of which the hub will reach the API at.
type PveIface struct {
	Name    string   `json:"name"`
	IPs     []string `json:"ips"`
	Default bool     `json:"default,omitempty"` // carries the default route
}

// PveInfo is the answer of pve_detect.
type PveInfo struct {
	Found       bool       `json:"found"`
	Version     string     `json:"version,omitempty"`
	Cluster     string     `json:"cluster,omitempty"` // empty: standalone node
	Node        string     `json:"node,omitempty"`
	Nodes       []string   `json:"nodes,omitempty"`
	Interfaces  []PveIface `json:"interfaces,omitempty"`
	Port        int        `json:"port,omitempty"`
	Fingerprint string     `json:"fingerprint,omitempty"` // certificate presented by pveproxy on this node
}

// PveACL is one access right granted to the user AND to its token.
type PveACL struct {
	Path string `json:"path"`
	Role string `json:"role"`
}

// PveTokenSpec is what the hub asks for: user, token name and rights.
type PveTokenSpec struct {
	User   string   `json:"user"` // name@pve
	Token  string   `json:"token"`
	ACLs   []PveACL `json:"acls"`
	Rotate bool     `json:"rotate,omitempty"` // an existing token is created again (the hub does not hold its secret)
}

// PveTokenResult: same answer as for a PBS.
type PveTokenResult = PbsTokenResult

var (
	pveUserRe    = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}@pve$`)
	pveVersionRe = regexp.MustCompile(`pve-manager/(\S+?)/`)
	// allowed roles and the exact paths each one may be granted on
	pveRolePaths = map[string][]string{"PVEAuditor": {"/"}}
)

// pveRun runs a command line tool of Proxmox VE (pveum, pvesh…) and returns its output.
type pveRun func(ctx context.Context, bin string, args ...string) (string, error)

func pveExec(ctx context.Context, bin string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		// stderr of token add never holds the secret; the output is not echoed on error
		return "", fmt.Errorf("%s %s: %v: %s", bin, strings.Join(args[:min(len(args), 2)], " "), err, strings.TrimSpace(errb.String()))
	}
	return out.String(), nil
}

func hasPve() bool {
	_, err := exec.LookPath("pveum")
	return err == nil
}

// detectPve describes the Proxmox VE node this agent runs on.
func detectPve(ctx context.Context, run pveRun) PveInfo {
	if !hasPve() {
		return PveInfo{}
	}
	info := describePve(ctx, run)
	info.Interfaces = pveInterfaces(defaultRouteIface())
	return info
}

func describePve(ctx context.Context, run pveRun) PveInfo {
	info := PveInfo{Found: true, Port: 8006}
	if out, err := run(ctx, "pveversion"); err == nil {
		if m := pveVersionRe.FindStringSubmatch(out); m != nil {
			info.Version = m[1]
		}
	}
	if out, err := run(ctx, "pvesh", "get", "/cluster/status", "--output-format", "json"); err == nil {
		var list []struct {
			Type  string `json:"type"`
			Name  string `json:"name"`
			Local int    `json:"local"`
		}
		if json.Unmarshal([]byte(out), &list) == nil {
			for _, e := range list {
				switch e.Type {
				case "cluster":
					info.Cluster = e.Name
				case "node":
					info.Nodes = append(info.Nodes, e.Name)
					if e.Local == 1 {
						info.Node = e.Name
					}
				}
			}
		}
	}
	if info.Node == "" {
		info.Node, _ = os.Hostname()
	}
	if out, err := run(ctx, "pvenode", "cert", "info", "--output-format", "json"); err == nil {
		info.Fingerprint = pveProxyFingerprint(out)
	}
	return info
}

// pveProxyFingerprint: the certificate pveproxy presents, pveproxy-ssl.pem (custom or ACME) when there is
// one, pve-ssl.pem (signed by the cluster CA) otherwise.
func pveProxyFingerprint(certInfo string) string {
	var list []struct {
		Filename    string `json:"filename"`
		Fingerprint string `json:"fingerprint"`
	}
	if json.Unmarshal([]byte(certInfo), &list) != nil {
		return ""
	}
	fp := map[string]string{}
	for _, c := range list {
		fp[c.Filename] = strings.ToUpper(c.Fingerprint)
	}
	if v := fp["pveproxy-ssl.pem"]; v != "" {
		return v
	}
	return fp["pve-ssl.pem"]
}

// defaultRouteIface: interface of the IPv4 default route (/proc/net/route), empty when unknown.
func defaultRouteIface() string {
	f, err := os.Open("/proc/net/route")
	if err != nil {
		return ""
	}
	defer f.Close()
	return parseDefaultRoute(f)
}

func parseDefaultRoute(r io.Reader) string {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) > 2 && f[1] == "00000000" && f[0] != "Iface" {
			return f[0]
		}
	}
	return ""
}

// pveInterfaces: the interfaces of the node that are up with an IPv4 address (loopback and link-local
// left out), the bridges of the node in practice.
func pveInterfaces(def string) []PveIface {
	list, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var out []PveIface
	for _, ifc := range list {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		var ips []string
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok || ipn.IP.To4() == nil || ipn.IP.IsLinkLocalUnicast() {
				continue
			}
			ips = append(ips, ipn.IP.String())
		}
		if len(ips) > 0 {
			out = append(out, PveIface{Name: ifc.Name, IPs: ips, Default: ifc.Name == def})
		}
	}
	return out
}

// validatePveToken checks what comes from the hub before it reaches a command line.
func validatePveToken(s *PveTokenSpec) error {
	if s == nil {
		return fmt.Errorf("missing token spec")
	}
	if !pveUserRe.MatchString(s.User) {
		return fmt.Errorf("invalid user %q (name@pve)", s.User)
	}
	if !pbsTokenRe.MatchString(s.Token) {
		return fmt.Errorf("invalid token name %q", s.Token)
	}
	if len(s.ACLs) == 0 {
		return fmt.Errorf("no ACL")
	}
	for _, a := range s.ACLs {
		paths, ok := pveRolePaths[a.Role]
		if !ok {
			return fmt.Errorf("role %q not allowed", a.Role)
		}
		allowed := false
		for _, p := range paths {
			allowed = allowed || p == a.Path
		}
		if !allowed {
			return fmt.Errorf("invalid ACL path %q for role %s", a.Path, a.Role)
		}
	}
	return nil
}

func pveListed(ctx context.Context, run pveRun, field, want string, args ...string) (bool, error) {
	out, err := run(ctx, "pveum", append(args, "--output-format", "json")...)
	if err != nil {
		return false, err
	}
	var list []map[string]any
	if err := json.Unmarshal([]byte(out), &list); err != nil {
		return false, err
	}
	for _, e := range list {
		if v, _ := e[field].(string); v == want {
			return true, nil
		}
	}
	return false, nil
}

// ensurePveToken creates user and token when missing (an existing one is created again when asked to
// rotate), grants the rights to the user AND to the token (privilege separation: effective rights are
// the intersection) and removes from the token the rights no longer asked for. A token created here is
// deleted again if a later step fails: its secret would be lost otherwise.
func ensurePveToken(ctx context.Context, run pveRun, s *PveTokenSpec) (res *PveTokenResult, err error) {
	if err := validatePveToken(s); err != nil {
		return nil, err
	}
	id := s.User + "!" + s.Token
	known, err := pveListed(ctx, run, "userid", s.User, "user", "list")
	if err != nil {
		return nil, err
	}
	if !known {
		if _, err := run(ctx, "pveum", "user", "add", s.User); err != nil {
			return nil, err
		}
	}
	exists, err := pveListed(ctx, run, "tokenid", s.Token, "user", "token", "list", s.User)
	if err != nil {
		return nil, err
	}
	res = &PveTokenResult{TokenID: id}
	if exists && s.Rotate {
		// its secret is lost for the hub: a new one is the only way (the rights of the user stay)
		if _, err := run(ctx, "pveum", "user", "token", "remove", s.User, s.Token); err != nil {
			return nil, err
		}
		exists, res.Rotated = false, true
	}
	if !exists {
		var gen string
		if gen, err = run(ctx, "pveum", "user", "token", "add", s.User, s.Token, "--privsep", "1", "--output-format", "json"); err != nil {
			return nil, err
		}
		defer func() {
			if err != nil {
				// the context may be the one that expired: the rollback gets its own
				rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
				defer cancel()
				if _, derr := run(rctx, "pveum", "user", "token", "remove", s.User, s.Token); derr != nil {
					err = fmt.Errorf("%v; token %s could not be deleted, delete it and retry: %v", err, id, derr)
				}
				res = nil
			}
		}()
		m := pbsSecretRe.FindStringSubmatch(gen)
		if m == nil {
			return nil, fmt.Errorf("token %s created but its secret was not found in the output", id)
		}
		res.Created, res.Secret = true, strings.ToLower(m[1])
	}
	want := map[string]bool{}
	for _, a := range s.ACLs {
		if _, err := run(ctx, "pveum", "acl", "modify", a.Path, "--roles", a.Role, "--users", s.User); err != nil {
			return nil, err
		}
		if _, err := run(ctx, "pveum", "acl", "modify", a.Path, "--roles", a.Role, "--tokens", id); err != nil {
			return nil, err
		}
		want[a.Path+" "+a.Role] = true
		res.Applied = append(res.Applied, a.Role+" on "+a.Path)
	}
	// only the token's rights are pruned: the user may carry other tokens
	if res.Removed, err = prunePveTokenACLs(ctx, run, id, want); err != nil {
		return nil, err
	}
	return res, nil
}

// prunePveTokenACLs removes the rights of the token whose "path role" is not in want.
func prunePveTokenACLs(ctx context.Context, run pveRun, id string, want map[string]bool) ([]string, error) {
	out, err := run(ctx, "pveum", "acl", "list", "--output-format", "json")
	if err != nil {
		return nil, err
	}
	var list []struct {
		Path   string `json:"path"`
		RoleID string `json:"roleid"`
		Type   string `json:"type"`
		UGID   string `json:"ugid"`
	}
	if err := json.Unmarshal([]byte(out), &list); err != nil {
		return nil, err
	}
	var removed []string
	for _, a := range list {
		if a.Type != "token" || a.UGID != id || want[a.Path+" "+a.RoleID] {
			continue
		}
		if _, err := run(ctx, "pveum", "acl", "delete", a.Path, "--roles", a.RoleID, "--tokens", id); err != nil {
			return nil, err
		}
		removed = append(removed, a.RoleID+" on "+a.Path)
	}
	return removed, nil
}
