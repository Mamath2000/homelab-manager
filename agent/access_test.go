//go:build !windows

package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
)

// newTestKey: an ed25519 public key line, without ssh-keygen.
func newTestKey(t *testing.T, comment string) string {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	wire := func(b []byte) []byte { return append(binary.BigEndian.AppendUint32(nil, uint32(len(b))), b...) }
	blob := append(wire([]byte("ssh-ed25519")), wire(pub)...)
	return "ssh-ed25519 " + base64.StdEncoding.EncodeToString(blob) + " " + comment
}

// setupAgentDir isolates the state of a test.
func setupAgentDir(t *testing.T) {
	t.Helper()
	old := agentDir
	agentDir = t.TempDir()
	t.Cleanup(func() { agentDir = old })
}

func TestParseAuthorizedLine(t *testing.T) {
	typ, blob, comment, opts, ok := parseAuthorizedLine(`command="x",no-pty ssh-ed25519 AAAAC3 me@pc extra`)
	if !ok || typ != "ssh-ed25519" || blob != "AAAAC3" || comment != "me@pc extra" || !opts {
		t.Fatalf("%v %v %v %v %v", typ, blob, comment, opts, ok)
	}
	if _, _, _, _, ok := parseAuthorizedLine("# comment"); ok {
		t.Fatal("comment")
	}
}

// Apply and check through the user account of the test (its home is rewritten under fsRoot).
func TestAccessKeysLifecycle(t *testing.T) {
	cur, err := user.Current()
	if err != nil || !userNameRe.MatchString(cur.Username) || cur.Username == "root" {
		t.Skip("needs a regular user with a valid name")
	}
	setupAgentDir(t)
	fsRoot = t.TempDir()
	defer func() { fsRoot = "" }()

	k1, k2, foreign := newTestKey(t, "one"), newTestKey(t, "two"), newTestKey(t, "local")
	home := filepath.Join(fsRoot, cur.HomeDir, ".ssh")
	_ = os.MkdirAll(home, 0o700)
	_ = os.WriteFile(filepath.Join(home, "authorized_keys"), []byte(foreign+"\n"), 0o600)

	// the values of the hub are applied as they come
	mk := func(name string, keys ...string) *SetupSpec {
		return &SetupSpec{Modules: []string{"user_keys"}, User: &UserSpec{Name: name, AccountSpec: AccountSpec{SSHKeys: keys}}}
	}
	authorized := func() string { b, _ := os.ReadFile(filepath.Join(home, "authorized_keys")); return string(b) }
	apply := func(s *SetupSpec) {
		t.Helper()
		resolveAccess(s)
		if err := applyAccountOption(t.Context(), s, "user_keys", func(string) {}); err != nil {
			t.Fatal(err)
		}
	}

	apply(mk(cur.Username, k1, k2))
	got := authorized()
	if !strings.Contains(got, foreign) || !strings.Contains(got, k1) || !strings.Contains(got, k2) {
		t.Fatalf("keys not applied:\n%s", got)
	}
	if st := loadAccessState(); st.UserName != cur.Username || len(st.User) != 2 {
		t.Fatalf("state: %+v", st)
	}

	// the configuration drops k1: drift, then removed; the foreign key stays
	s2 := mk(cur.Username, k2)
	resolveAccess(s2)
	if c := checkModule(t.Context(), s2, "user_keys"); c.State != "drift" || !strings.Contains(c.Detail, "to remove") {
		t.Fatalf("stale key must drift: %+v", c)
	}
	apply(mk(cur.Username, k2))
	got = authorized()
	if strings.Contains(got, k1) || !strings.Contains(got, k2) || !strings.Contains(got, foreign) {
		t.Fatalf("k1 must be removed, the others kept:\n%s", got)
	}

	// inventory: the foreign key is the only unknown one
	rep := accessReport(s2)
	var unknown int
	for _, k := range rep.Keys {
		if k.Account == cur.Username && !k.Managed {
			unknown++
		}
	}
	if unknown != 1 || rep.Status != "ok" {
		t.Fatalf("inventory: %+v", rep)
	}

	// another account: the keys recorded for the previous one are not removed from it
	other := mk("someone-else")
	resolveAccess(other)
	if p := other.access.prev("user"); len(p) != 0 {
		t.Fatalf("keys of another account: %v", p)
	}
}

// The state written by a version with the signed manifest is read, its anchor removed.
func TestLegacyAccessFiles(t *testing.T) {
	setupAgentDir(t)
	k := newTestKey(t, "admin")
	_ = os.WriteFile(accessPath(accessStateFile), []byte(`{"serial":4,"root":["`+keyID(k)+`"],"userName":"ops"}`), 0o600)
	_ = os.WriteFile(accessPath(legacyAnchorFile), []byte(`{"signers":[]}`), 0o600)
	if st := loadAccessState(); len(st.Root) != 1 || st.UserName != "ops" {
		t.Fatalf("state: %+v", st)
	}
	removeLegacyAnchor(agentDir)
	if _, err := os.Stat(accessPath(legacyAnchorFile)); !os.IsNotExist(err) {
		t.Fatal("the anchor must be removed")
	}
}
