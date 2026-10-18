package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// Proxmox Backup Server administration for the hub (rpc pbs_detect / pbs_token): the PBS runs natively
// on this host or in a container (the image has neither curl nor jq, hence the agent). Secrets of
// the tokens only travel in the rpc result: never logged.

// PbsInfo is the answer of pbs_detect.
type PbsInfo struct {
	Found       bool     `json:"found"`
	Mode        string   `json:"mode,omitempty"`      // native | container
	Container   string   `json:"container,omitempty"` // mode container
	Version     string   `json:"version,omitempty"`
	Datastores  []string `json:"datastores,omitempty"`
	Port        int      `json:"port,omitempty"` // port of the API as reachable from the network
	Fingerprint string   `json:"fingerprint,omitempty"`
}

// PbsACL is one access right granted to the user AND to its token. Path may contain "{store}": one
// right per datastore.
type PbsACL struct {
	Path string `json:"path"`
	Role string `json:"role"`
}

// PbsTokenSpec is what the hub asks for: user, token name and rights.
type PbsTokenSpec struct {
	Container string   `json:"container,omitempty"` // empty: PBS installed on the host
	User      string   `json:"user"`                // name@pbs
	Token     string   `json:"token"`
	ACLs      []PbsACL `json:"acls"`
	// Rotate: an existing token is deleted and created again (the hub does not hold its secret)
	Rotate bool `json:"rotate,omitempty"`
}

// PbsTokenResult: the secret is empty when the token already existed and was kept (its rights are
// updated). Rotated: it existed and was created again, with a new secret.
type PbsTokenResult struct {
	TokenID string   `json:"tokenId"`
	Secret  string   `json:"secret,omitempty"`
	Created bool     `json:"created"`
	Rotated bool     `json:"rotated,omitempty"`
	Applied []string `json:"applied"`
	Removed []string `json:"removed,omitempty"` // rights of the token no longer asked for
}

var (
	pbsUserRe      = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}@pbs$`)
	pbsTokenRe     = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._-]{0,31}$`)
	pbsContainerRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	pbsSecretRe    = regexp.MustCompile(`"value"\s*:\s*"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"`)
	// allowed roles and the paths each one may be granted on (never "/")
	pbsDatastorePathRe = regexp.MustCompile(`^/datastore(/[A-Za-z0-9{}._-]+(/[A-Za-z0-9._-]+)*)?$`)
	pbsRolePaths       = map[string]*regexp.Regexp{
		"DatastoreAudit":  pbsDatastorePathRe,
		"DatastoreBackup": pbsDatastorePathRe,
		"DatastoreReader": pbsDatastorePathRe,
		"RemoteAdmin":     regexp.MustCompile(`^/remote(/[A-Za-z0-9._-]+)?$`),
	}
)

// pbsRun runs a command line tool of the PBS (proxmox-backup-manager by default) with the arguments
// and returns its output.
type pbsRun func(ctx context.Context, args ...string) (string, error)

func pbsRunner(container string) pbsRun { return pbsTool(container, "proxmox-backup-manager") }

func pbsTool(container, bin string) pbsRun {
	return func(ctx context.Context, args ...string) (string, error) {
		var cmd *exec.Cmd
		if container == "" {
			cmd = exec.CommandContext(ctx, bin, args...)
		} else {
			cmd = exec.CommandContext(ctx, "docker", append([]string{"exec", container, bin}, args...)...)
		}
		var out, errb bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &errb
		if err := cmd.Run(); err != nil {
			// stderr of generate-token never holds the secret; the output is not echoed on error
			return "", fmt.Errorf("%s %s: %v: %s", bin, args[0], err, strings.TrimSpace(errb.String()))
		}
		return out.String(), nil
	}
}

var (
	pbsVersionRe     = regexp.MustCompile(`running version:\s*(\S+)`)
	pbsFingerprintRe = regexp.MustCompile(`(?i)fingerprint[^:]*:\s*([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){31})`)
)

// detectPbs looks for a PBS on this host: native first, then a running container that holds
// proxmox-backup-manager.
func detectPbs(ctx context.Context) PbsInfo {
	if _, err := exec.LookPath("proxmox-backup-manager"); err == nil {
		if info, err := describePbs(ctx, "", pbsRunner("")); err == nil {
			info.Port = listeningPort(ctx, 8007)
			return info
		}
	}
	if _, err := exec.LookPath("docker"); err != nil {
		return PbsInfo{}
	}
	out, err := exec.CommandContext(ctx, "docker", "ps", "--format", "{{.Names}}").Output()
	if err != nil {
		return PbsInfo{}
	}
	for _, name := range strings.Fields(string(out)) {
		if !pbsContainerRe.MatchString(name) {
			continue
		}
		cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		err := exec.CommandContext(cctx, "docker", "exec", name, "sh", "-c", "command -v proxmox-backup-manager").Run()
		cancel()
		if err != nil {
			continue
		}
		info, err := describePbs(ctx, name, pbsRunner(name))
		if err != nil {
			continue
		}
		info.Port = containerPort(ctx, name, 8007)
		return info
	}
	return PbsInfo{}
}

// pbsLikeRe: image or name of a container that looks like a PBS (cheap hint for the hello; the real
// check is detectPbs, which execs into the container).
var pbsLikeRe = regexp.MustCompile(`(?i)pbs|proxmox-backup`)

// pbsContainerRunning tells whether a running container looks like a PBS, so the hello only announces
// the "pbs" capability on hosts that may really have one.
func pbsContainerRunning(ctx context.Context) bool {
	if _, err := exec.LookPath("docker"); err != nil {
		return false
	}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, "docker", "ps", "--format", "{{.Names}} {{.Image}}").Output()
	return err == nil && pbsLikeRe.Match(out)
}

func describePbs(ctx context.Context, container string, run pbsRun) (PbsInfo, error) {
	info := PbsInfo{Found: true, Mode: "native", Container: container}
	if container != "" {
		info.Mode = "container"
	}
	ver, err := run(ctx, "versions")
	if err != nil {
		return PbsInfo{}, err
	}
	if m := pbsVersionRe.FindStringSubmatch(ver); m != nil {
		info.Version = m[1]
	}
	if out, err := run(ctx, "cert", "info"); err == nil {
		if m := pbsFingerprintRe.FindStringSubmatch(out); m != nil {
			info.Fingerprint = strings.ToUpper(m[1])
		}
	}
	info.Datastores, _ = pbsDatastores(ctx, run)
	return info, nil
}

func pbsDatastores(ctx context.Context, run pbsRun) ([]string, error) {
	out, err := run(ctx, "datastore", "list", "--output-format", "json")
	if err != nil {
		return nil, err
	}
	var list []struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal([]byte(out), &list); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(list))
	for _, d := range list {
		names = append(names, d.Name)
	}
	return names, nil
}

// pbsListenRe: one line of `ss -H -ltnp` for a socket of the PBS proxy (the process name is cut to
// 15 characters by the kernel, hence "proxmox-backup-"); the local address is not restricted to
// loopback by the caller, see parsePbsPort.
var pbsListenRe = regexp.MustCompile(`^LISTEN\s+\S+\s+\S+\s+(\S+):(\d+)\s.*"proxmox-backup-`)

// parsePbsPort: port the PBS proxy listens on for the network (loopback sockets, such as the private
// API of the PBS, are ignored); 0 when none is found.
func parsePbsPort(ssOut string) int {
	for _, line := range strings.Split(ssOut, "\n") {
		m := pbsListenRe.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil || m[1] == "127.0.0.1" || m[1] == "[::1]" {
			continue
		}
		var p int
		if _, err := fmt.Sscanf(m[2], "%d", &p); err == nil && p > 0 {
			return p
		}
	}
	return 0
}

// listeningPort asks the system which port the PBS answers on (a PBS running on the host, natively or
// in a container in host network mode); def when it cannot tell.
func listeningPort(ctx context.Context, def int) int {
	out, err := exec.CommandContext(ctx, "ss", "-H", "-ltnp").Output()
	if err != nil {
		return def
	}
	if p := parsePbsPort(string(out)); p > 0 {
		return p
	}
	return def
}

// containerPort: host port the container exposes for port (0 = not reachable from the network). In
// host network mode the port is the one the PBS listens on.
func containerPort(ctx context.Context, container string, port int) int {
	if mode, err := exec.CommandContext(ctx, "docker", "inspect", "-f", "{{.HostConfig.NetworkMode}}", container).Output(); err == nil &&
		strings.TrimSpace(string(mode)) == "host" {
		return listeningPort(ctx, port)
	}
	out, err := exec.CommandContext(ctx, "docker", "port", container, fmt.Sprintf("%d/tcp", port)).Output()
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(out), "\n") {
		if i := strings.LastIndex(line, ":"); i >= 0 {
			var p int
			if _, err := fmt.Sscanf(strings.TrimSpace(line[i+1:]), "%d", &p); err == nil && p > 0 {
				return p
			}
		}
	}
	return 0
}

// validatePbsToken checks what comes from the hub before it reaches a command line.
func validatePbsToken(s *PbsTokenSpec) error {
	if s == nil {
		return fmt.Errorf("missing token spec")
	}
	if !pbsUserRe.MatchString(s.User) {
		return fmt.Errorf("invalid user %q (name@pbs)", s.User)
	}
	if !pbsTokenRe.MatchString(s.Token) {
		return fmt.Errorf("invalid token name %q", s.Token)
	}
	if s.Container != "" && !pbsContainerRe.MatchString(s.Container) {
		return fmt.Errorf("invalid container name")
	}
	if len(s.ACLs) == 0 {
		return fmt.Errorf("no ACL")
	}
	for _, a := range s.ACLs {
		re := pbsRolePaths[a.Role]
		if re == nil {
			return fmt.Errorf("role %q not allowed", a.Role)
		}
		if !re.MatchString(a.Path) || strings.Contains(a.Path, "..") {
			return fmt.Errorf("invalid ACL path %q for role %s", a.Path, a.Role)
		}
	}
	return nil
}

// expandPbsACLs: one (path, role) per datastore for the paths with "{store}".
func expandPbsACLs(acls []PbsACL, stores []string) []PbsACL {
	var out []PbsACL
	for _, a := range acls {
		if !strings.Contains(a.Path, "{store}") {
			out = append(out, a)
			continue
		}
		for _, st := range stores {
			out = append(out, PbsACL{Path: strings.ReplaceAll(a.Path, "{store}", st), Role: a.Role})
		}
	}
	return out
}

func pbsTokenExists(ctx context.Context, run pbsRun, user, token string) (bool, error) {
	out, err := run(ctx, "user", "list-tokens", user, "--output-format", "json")
	if err != nil {
		return false, err
	}
	var list []struct {
		TokenID string `json:"tokenid"`
	}
	if err := json.Unmarshal([]byte(out), &list); err != nil {
		return false, err
	}
	for _, t := range list {
		if t.TokenID == token || strings.HasSuffix(t.TokenID, "!"+token) {
			return true, nil
		}
	}
	return false, nil
}

// ensurePbsToken creates user and token when missing (an existing one is created again when asked to
// rotate), grants the rights to the user AND to the token (effective rights are the intersection) and
// removes from the token the rights no longer asked for. A token created here is deleted again if a
// later step fails: its secret would be lost otherwise.
func ensurePbsToken(ctx context.Context, run pbsRun, s *PbsTokenSpec) (res *PbsTokenResult, err error) {
	if err := validatePbsToken(s); err != nil {
		return nil, err
	}
	id := s.User + "!" + s.Token
	acls := s.ACLs
	for _, a := range acls {
		if strings.Contains(a.Path, "{store}") {
			stores, err := pbsDatastores(ctx, run)
			if err != nil {
				return nil, err
			}
			acls = expandPbsACLs(acls, stores)
			break
		}
	}
	if len(acls) == 0 {
		return nil, fmt.Errorf("no datastore on this PBS: no right to grant")
	}
	out, err := run(ctx, "user", "list", "--output-format", "json")
	if err != nil {
		return nil, err
	}
	var users []struct {
		UserID string `json:"userid"`
	}
	if err := json.Unmarshal([]byte(out), &users); err != nil {
		return nil, err
	}
	known := false
	for _, u := range users {
		known = known || u.UserID == s.User
	}
	if !known {
		if _, err := run(ctx, "user", "create", s.User); err != nil {
			return nil, err
		}
	}
	exists, err := pbsTokenExists(ctx, run, s.User, s.Token)
	if err != nil {
		return nil, err
	}
	res = &PbsTokenResult{TokenID: id}
	if exists && s.Rotate {
		// its secret is lost for the hub: a new one is the only way (the rights of the user stay)
		if _, err := run(ctx, "user", "delete-token", s.User, s.Token); err != nil {
			return nil, err
		}
		exists, res.Rotated = false, true
	}
	if !exists {
		var gen string
		if gen, err = run(ctx, "user", "generate-token", s.User, s.Token); err != nil {
			return nil, err
		}
		defer func() {
			if err != nil {
				// the context may be the one that expired: the rollback gets its own
				rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
				defer cancel()
				if _, derr := run(rctx, "user", "delete-token", s.User, s.Token); derr != nil {
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
	for _, a := range acls {
		for _, who := range []string{s.User, id} {
			if _, err := run(ctx, "acl", "update", a.Path, a.Role, "--auth-id", who); err != nil {
				return nil, err
			}
		}
		want[a.Path+" "+a.Role] = true
		res.Applied = append(res.Applied, a.Role+" on "+a.Path)
	}
	// only the token's rights are pruned: the user may carry other tokens of the hub
	if res.Removed, err = prunePbsTokenACLs(ctx, run, id, want); err != nil {
		return nil, err
	}
	return res, nil
}

// prunePbsTokenACLs removes the rights of the token (or user) id whose "path role" is not in want (nil:
// all of them).
func prunePbsTokenACLs(ctx context.Context, run pbsRun, id string, want map[string]bool) ([]string, error) {
	out, err := run(ctx, "acl", "list", "--output-format", "json")
	if err != nil {
		return nil, err
	}
	var list []struct {
		Path   string `json:"path"`
		RoleID string `json:"roleid"`
		UGID   string `json:"ugid"`
	}
	if err := json.Unmarshal([]byte(out), &list); err != nil {
		return nil, err
	}
	var removed []string
	for _, a := range list {
		if a.UGID != id || want[a.Path+" "+a.RoleID] {
			continue
		}
		if _, err := run(ctx, "acl", "update", a.Path, a.RoleID, "--auth-id", id, "--delete", "true"); err != nil {
			return nil, err
		}
		removed = append(removed, a.RoleID+" on "+a.Path)
	}
	return removed, nil
}

// TokenDeleteResult is the answer of pbs_token_delete / pve_token_delete. Deleted: the token was there
// and is gone; UserDeleted: the user had no token left and was deleted too.
type TokenDeleteResult struct {
	TokenID     string   `json:"tokenId"`
	Deleted     bool     `json:"deleted"`
	UserDeleted bool     `json:"userDeleted,omitempty"`
	Removed     []string `json:"removed,omitempty"` // rights removed with them
}

// validatePbsTokenRef: user, token and container of a token to delete (no rights).
func validatePbsTokenRef(s *PbsTokenSpec) error {
	if s == nil {
		return fmt.Errorf("missing token spec")
	}
	if !pbsUserRe.MatchString(s.User) {
		return fmt.Errorf("invalid user %q (name@pbs)", s.User)
	}
	if !pbsTokenRe.MatchString(s.Token) {
		return fmt.Errorf("invalid token name %q", s.Token)
	}
	if s.Container != "" && !pbsContainerRe.MatchString(s.Container) {
		return fmt.Errorf("invalid container name")
	}
	return nil
}

// deletePbsToken revokes a token of the hub: its rights, the token, then the user and its rights when it
// carries no other token. Nothing else is touched (backups, groups and their owner stay). A token or a
// user already gone is not an error.
func deletePbsToken(ctx context.Context, run pbsRun, s *PbsTokenSpec) (*TokenDeleteResult, error) {
	if err := validatePbsTokenRef(s); err != nil {
		return nil, err
	}
	id := s.User + "!" + s.Token
	res := &TokenDeleteResult{TokenID: id}
	out, err := run(ctx, "user", "list", "--output-format", "json")
	if err != nil {
		return nil, err
	}
	var users []struct {
		UserID string `json:"userid"`
	}
	if err := json.Unmarshal([]byte(out), &users); err != nil {
		return nil, err
	}
	known := false
	for _, u := range users {
		known = known || u.UserID == s.User
	}
	if !known {
		return res, nil
	}
	if res.Removed, err = prunePbsTokenACLs(ctx, run, id, nil); err != nil {
		return nil, err
	}
	exists, err := pbsTokenExists(ctx, run, s.User, s.Token)
	if err != nil {
		return nil, err
	}
	if exists {
		if _, err := run(ctx, "user", "delete-token", s.User, s.Token); err != nil {
			return nil, err
		}
		res.Deleted = true
	}
	left, err := run(ctx, "user", "list-tokens", s.User, "--output-format", "json")
	if err != nil {
		return nil, err
	}
	var tokens []json.RawMessage
	if err := json.Unmarshal([]byte(left), &tokens); err != nil {
		return nil, err
	}
	if len(tokens) > 0 {
		return res, nil
	}
	removed, err := prunePbsTokenACLs(ctx, run, s.User, nil)
	if err != nil {
		return nil, err
	}
	res.Removed = append(res.Removed, removed...)
	if _, err := run(ctx, "user", "remove", s.User); err != nil {
		return nil, err
	}
	res.UserDeleted = true
	return res, nil
}

func pbsContainerOf(s *PbsTokenSpec) string {
	if s == nil {
		return ""
	}
	return s.Container
}
