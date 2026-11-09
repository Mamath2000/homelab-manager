//go:build !windows

package main

// Access options of the standardisation (root keys, the sudo user and its keys): their values come from the hub like
// the other options (homelab#320: the hub is root-equivalent on the fleet, it is protected as such). This file keeps
// what the agent added (access-state.json, owned by root) to remove a key once the configuration drops it, and reports
// the authorized_keys of root and of the user so that a key nobody configured is flagged.

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	accessStateFile = "access-state.json"
	// files of the signed access manifest (homelab#312), removed at start
	legacyAnchorFile = "access-anchor.json"
)

// --- state (agent directory, owned by root) ---------------------------------------------------

type accessState struct {
	Root     []string `json:"root,omitempty"`     // key ids (type + base64) this agent added to root
	User     []string `json:"user,omitempty"`     // idem for UserName
	UserName string   `json:"userName,omitempty"` // account the User list belongs to
}

func accessPath(name string) string { return filepath.Join(agentDir, name) }

func readJSONFile(p string, v any) error {
	raw, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, v)
}

func writeJSONFile(p string, v any) error {
	raw, _ := json.MarshalIndent(v, "", "  ")
	return writeFileAtomic(p, append(raw, '\n'), 0o600)
}

// loadAccessState: the state written by a version with the signed manifest is read the same way (its serial ignored).
func loadAccessState() accessState {
	var s accessState
	_ = readJSONFile(accessPath(accessStateFile), &s)
	return s
}

func saveAccessState(st accessState) error { return writeJSONFile(accessPath(accessStateFile), st) }

// removeLegacyAnchor, at start: the trust anchor of the signed manifest is not used any more.
func removeLegacyAnchor(dir string) {
	file := filepath.Join(dir, legacyAnchorFile)
	if err := os.Remove(file); err == nil {
		log.Printf("access: %s removed (signed access manifest retired)", file)
	}
}

func blobFingerprint(blob []byte) string {
	h := sha256.Sum256(blob)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(h[:])
}

func keyIDs(lines []string) []string {
	var out []string
	for _, l := range lines {
		if id := keyID(strings.TrimSpace(l)); id != "" {
			out = append(out, id)
		}
	}
	return out
}

// --- application -------------------------------------------------------------------------------

// accessCtx: what this agent added earlier, for the key options.
type accessCtx struct {
	state    accessState
	userName string
	prevRoot []string
	prevUser []string
}

func isAccessModule(m string) bool {
	return m == "user" || m == "root_keys" || strings.HasPrefix(m, "user_")
}

// resolveAccess prepares the removal of the keys added earlier: those of the user only when it is the same account.
func resolveAccess(s *SetupSpec) {
	st := loadAccessState()
	c := &accessCtx{state: st, prevRoot: st.Root}
	if s.User != nil {
		c.userName = s.User.Name
		if st.UserName == s.User.Name {
			c.prevUser = st.User
		}
	}
	s.access = c
}

func (c *accessCtx) prev(prefix string) []string {
	if c == nil {
		return nil
	}
	if prefix == "root" {
		return c.prevRoot
	}
	return c.prevUser
}

// record keeps the ids of the keys written, to remove them when the configuration drops them.
func (c *accessCtx) record(prefix string, keys []string) {
	if c == nil {
		return
	}
	ids := keyIDs(keys)
	if prefix == "root" {
		c.state.Root, c.prevRoot = ids, ids
	} else {
		c.state.User, c.state.UserName, c.prevUser = ids, c.userName, ids
	}
	if err := saveAccessState(c.state); err != nil {
		log.Printf("access: state not saved: %v", err)
	}
}

// staleKeys: keys this agent added earlier (prev) that the wanted list no longer has and that are still in content.
func staleKeys(content string, prev, want []string) []string {
	if len(prev) == 0 {
		return nil
	}
	keep := map[string]bool{}
	for _, id := range keyIDs(want) {
		keep[id] = true
	}
	old := map[string]bool{}
	for _, id := range prev {
		if !keep[id] {
			old[id] = true
		}
	}
	var out []string
	for _, l := range strings.Split(content, "\n") {
		if id := keyID(strings.TrimSpace(l)); id != "" && old[id] {
			delete(old, id) // one id per key, however many lines repeat it
			out = append(out, id)
		}
	}
	return out
}

// --- report (inventory) ------------------------------------------------------------------------

type AuthorizedKey struct {
	Account     string `json:"account"`
	Type        string `json:"type"`
	Fingerprint string `json:"fingerprint"`
	Comment     string `json:"comment,omitempty"`
	Options     bool   `json:"options,omitempty"` // the line has options (command=, from=…)
	Managed     bool   `json:"managed"`           // in the configuration or added by this agent earlier
}

type AccessReport struct {
	Status string          `json:"status"` // ok (kept for the hubs that read it)
	Keys   []AuthorizedKey `json:"keys"`   // authorized_keys of root and of the user
}

var keyTypeRe = regexp.MustCompile(`^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)$`)

// parseAuthorizedLine reads a line of authorized_keys: options, type, key, comment.
func parseAuthorizedLine(line string) (typ, blob, comment string, options, ok bool) {
	line = strings.TrimSpace(line)
	if line == "" || strings.HasPrefix(line, "#") {
		return
	}
	f := strings.Fields(line)
	for i := 0; i < len(f) && i < 8; i++ {
		if keyTypeRe.MatchString(f[i]) && i+1 < len(f) {
			return f[i], f[i+1], strings.Join(f[i+2:], " "), i > 0, true
		}
	}
	return
}

func inventoryKeys(account, home string, managed []string) []AuthorizedKey {
	cur, _ := readFile(filepath.Join(home, ".ssh", "authorized_keys"))
	known := map[string]bool{}
	for _, id := range managed {
		known[id] = true
	}
	out := []AuthorizedKey{}
	seen := map[string]bool{}
	for _, l := range strings.Split(cur, "\n") {
		typ, b64, comment, opts, ok := parseAuthorizedLine(l)
		if !ok {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			continue
		}
		fp := blobFingerprint(raw)
		if seen[fp] { // a key repeated in the file is one key (the id of the list is account + fingerprint)
			continue
		}
		seen[fp] = true
		out = append(out, AuthorizedKey{Account: account, Type: typ, Fingerprint: fp, Comment: comment, Options: opts, Managed: known[typ+" "+b64]})
	}
	return out
}

// accessReport: the keys of root and of the user, managed when the configuration lists them or this agent added them.
// Without key option for an account, its keys are still listed (nothing configured: all of them are flagged).
func accessReport(s *SetupSpec) *AccessReport {
	st := loadAccessState()
	r := &AccessReport{Status: "ok", Keys: []AuthorizedKey{}}
	managedRoot := append(append([]string{}, st.Root...), keyIDs(s.Root.SSHKeys)...)
	userName, managedUser := st.UserName, st.User
	if s.User != nil {
		if s.User.Name != st.UserName {
			managedUser = nil
		}
		userName, managedUser = s.User.Name, append(append([]string{}, managedUser...), keyIDs(s.User.SSHKeys)...)
	}
	if a, err := lookupAccount("root"); err == nil {
		r.Keys = append(r.Keys, inventoryKeys("root", a.home, managedRoot)...)
	}
	if userName != "" {
		if a, err := lookupAccount(userName); err == nil {
			r.Keys = append(r.Keys, inventoryKeys(userName, a.home, managedUser)...)
		}
	}
	return r
}
