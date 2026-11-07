//go:build !windows

package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type testSigner struct {
	priv string // private key file
	pub  string // public key line
}

func newTestSigner(t *testing.T, name string) testSigner {
	t.Helper()
	if _, err := exec.LookPath("ssh-keygen"); err != nil {
		t.Skip("ssh-keygen not available")
	}
	priv := filepath.Join(t.TempDir(), name)
	if out, err := exec.Command("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", name, "-f", priv).CombinedOutput(); err != nil {
		t.Fatalf("ssh-keygen: %v %s", err, out)
	}
	pub, _ := os.ReadFile(priv + ".pub")
	return testSigner{priv: priv, pub: strings.TrimSpace(string(pub))}
}

// sign makes a bundle the way tools/access-manifest.sh does.
func (s testSigner) sign(t *testing.T, ns string, m AccessManifest) *AccessBundle {
	t.Helper()
	payload, _ := json.Marshal(m)
	return s.signRaw(t, ns, payload)
}

func (s testSigner) signRaw(t *testing.T, ns string, payload []byte) *AccessBundle {
	t.Helper()
	f := filepath.Join(t.TempDir(), "payload")
	_ = os.WriteFile(f, payload, 0o600)
	if out, err := exec.Command("ssh-keygen", "-Y", "sign", "-f", s.priv, "-n", ns, f).CombinedOutput(); err != nil {
		t.Fatalf("sign: %v %s", err, out)
	}
	sig, _ := os.ReadFile(f + ".sig")
	return &AccessBundle{Payload: base64.StdEncoding.EncodeToString(payload), Signature: string(sig)}
}

func manifest(serial int64, signers []string, rootKeys ...string) AccessManifest {
	if rootKeys == nil {
		rootKeys = []string{}
	}
	return AccessManifest{V: 1, Serial: serial, IssuedAt: time.Now().Unix(), Signers: signers, Root: AccessRoot{SSHKeys: rootKeys}}
}

// setupAgentDir isolates the anchor and the state of a test.
func setupAgentDir(t *testing.T) {
	t.Helper()
	old := agentDir
	agentDir = t.TempDir()
	t.Cleanup(func() { agentDir = old; nowFn = time.Now })
}

func TestVerifyAccessWindowAndAnchor(t *testing.T) {
	setupAgentDir(t)
	admin, other := newTestSigner(t, "admin"), newTestSigner(t, "other")
	b := admin.sign(t, accessNamespace, manifest(1, []string{admin.pub}, testKey))

	// no anchor file: closed
	if _, _, err := verifyAccess(b, loadAnchor(), accessState{}); err == nil {
		t.Fatal("a host without anchor file must refuse")
	}
	// fresh agent: window open, the signer pins itself
	ensureAccessAnchor(agentDir)
	m, pinning, err := verifyAccess(b, loadAnchor(), accessState{})
	if err != nil || !pinning || m.Serial != 1 {
		t.Fatalf("window open: %v pinning=%v", err, pinning)
	}
	// a signer that does not list itself cannot pin
	if _, _, err := verifyAccess(other.sign(t, accessNamespace, manifest(1, []string{admin.pub}, testKey)), loadAnchor(), accessState{}); err == nil {
		t.Fatal("signer missing from the manifest signers must be refused")
	}
	// window closed: nothing is accepted without anchor
	nowFn = func() time.Time { return time.Now().Add(accessWindow + time.Hour) }
	if _, _, err := verifyAccess(b, loadAnchor(), accessState{}); err == nil {
		t.Fatal("closed window must refuse")
	}
	nowFn = time.Now

	// anchored
	anchor := accessAnchor{Signers: []string{admin.pub}}
	if _, pinning, err := verifyAccess(b, anchor, accessState{}); err != nil || pinning {
		t.Fatalf("anchored: %v", err)
	}
	if _, _, err := verifyAccess(other.sign(t, accessNamespace, manifest(1, []string{other.pub}, testKey)), anchor, accessState{}); err == nil {
		t.Fatal("unknown signer must be refused even if it lists itself")
	}
	if _, _, err := verifyAccess(b, anchor, accessState{Serial: 2}); err == nil {
		t.Fatal("older serial must be refused")
	}
	if _, _, err := verifyAccess(b, anchor, accessState{Serial: 1}); err != nil {
		t.Fatalf("same serial must be accepted (idempotent): %v", err)
	}
	if _, _, err := verifyAccess(admin.sign(t, "other-namespace", manifest(1, []string{admin.pub})), anchor, accessState{}); err == nil {
		t.Fatal("signature for another namespace must be refused")
	}
	exp := manifest(1, []string{admin.pub})
	exp.ExpiresAt = time.Now().Add(-time.Minute).Unix()
	if _, _, err := verifyAccess(admin.sign(t, accessNamespace, exp), anchor, accessState{}); err == nil {
		t.Fatal("expired manifest must be refused")
	}
	// tampered payload keeps the signature of the original
	forged := *b
	forged.Payload = base64.StdEncoding.EncodeToString([]byte(strings.Replace(string(mustDecode(t, b.Payload)), testKey, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEvilEvilEvilEvilEvilEvilEvilEvilEvilEvilEvil", 1)))
	if _, _, err := verifyAccess(&forged, anchor, accessState{}); err == nil {
		t.Fatal("tampered payload must be refused")
	}
	if _, _, err := verifyAccess(&AccessBundle{Payload: b.Payload, Signature: "-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----"}, anchor, accessState{}); err == nil {
		t.Fatal("garbage signature must be refused")
	}
	if _, _, err := verifyAccess(nil, anchor, accessState{}); err == nil {
		t.Fatal("no bundle must be refused")
	}
}

func mustDecode(t *testing.T, s string) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestValidateManifest(t *testing.T) {
	good := manifest(1, []string{newTestSigner(t, "s").pub}, testKey)
	good.User = &AccessUser{Name: "ops", SSHKeys: []string{testKey}}
	if err := validateManifest(&good); err != nil {
		t.Fatal(err)
	}
	bad := []func(m *AccessManifest){
		func(m *AccessManifest) { m.V = 2 },
		func(m *AccessManifest) { m.Serial = 0 },
		func(m *AccessManifest) { m.Signers = nil },
		func(m *AccessManifest) { m.Signers = []string{"ssh-rsa AAAA"} },
		func(m *AccessManifest) { m.Root.SSHKeys = []string{`command="x" ` + testKey} },
		func(m *AccessManifest) { m.User.Name = "root" },
		func(m *AccessManifest) { m.User.Name = "Bad;Name" },
		func(m *AccessManifest) { m.User.SSHKeys = []string{"ssh-ed25519 AAAA\nssh-rsa BBBB"} },
	}
	for i, mut := range bad {
		m := good
		u := *good.User
		m.User = &u
		mut(&m)
		if validateManifest(&m) == nil {
			t.Errorf("case %d accepted", i)
		}
	}
}

// A security key signature: the authenticator signs sha256(app) || flags || counter || sha256(data).
func TestSecurityKeySignature(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	app := []byte("ssh:")
	blob := appendWireString(nil, []byte(keyTypeSKEd25519))
	blob = appendWireString(blob, pub)
	blob = appendWireString(blob, app)
	p, err := parsePublicBlob(blob)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("signed data")
	sign := func(flags byte) []byte {
		ah, dh := sha256.Sum256(app), sha256.Sum256(data)
		msg := append(append(append(append([]byte{}, ah[:]...), flags), binary.BigEndian.AppendUint32(nil, 7)...), dh[:]...)
		sig := appendWireString(nil, []byte(keyTypeSKEd25519))
		sig = appendWireString(sig, ed25519.Sign(priv, msg))
		sig = append(sig, flags)
		return binary.BigEndian.AppendUint32(sig, 7)
	}
	if err := p.verify(data, sign(0x01)); err != nil {
		t.Fatalf("touch + valid: %v", err)
	}
	if err := p.verify(data, sign(0x00)); err == nil {
		t.Fatal("a signature without user presence must be refused")
	}
	if err := p.verify([]byte("other"), sign(0x01)); err == nil {
		t.Fatal("wrong data must be refused")
	}
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
	ensureAccessAnchor(agentDir)

	admin := newTestSigner(t, "admin")
	k1, k2, foreign := newTestSigner(t, "one").pub, newTestSigner(t, "two").pub, newTestSigner(t, "local").pub
	home := filepath.Join(fsRoot, cur.HomeDir, ".ssh")
	_ = os.MkdirAll(home, 0o700)
	_ = os.WriteFile(filepath.Join(home, "authorized_keys"), []byte(foreign+"\n"), 0o600)

	mk := func(serial int64, keys ...string) *SetupSpec {
		m := manifest(serial, []string{admin.pub})
		m.User = &AccessUser{Name: cur.Username, SSHKeys: keys}
		// what the hub sends is ignored: keys and user name
		return &SetupSpec{
			Modules: []string{"user_keys"}, Access: admin.sign(t, accessNamespace, m),
			Root: AccountSpec{SSHKeys: []string{testKey}},
			User: &UserSpec{Name: "hub-chosen", AccountSpec: AccountSpec{SSHKeys: []string{testKey}}},
		}
	}
	authorized := func() string { b, _ := os.ReadFile(filepath.Join(home, "authorized_keys")); return string(b) }
	apply := func(s *SetupSpec) {
		t.Helper()
		if blocked, why := resolveAccess(s, true); len(blocked) > 0 {
			t.Fatalf("blocked: %v %s", blocked, why)
		}
		if s.User.Name != cur.Username || len(s.Root.SSHKeys) != 0 {
			t.Fatalf("the hub values must be replaced: %+v", s.User)
		}
		if err := applyAccountOption(t.Context(), s, "user_keys", func(string) {}); err != nil {
			t.Fatal(err)
		}
	}

	apply(mk(1, k1, k2))
	got := authorized()
	if !strings.Contains(got, foreign) || !strings.Contains(got, k1) || !strings.Contains(got, k2) {
		t.Fatalf("keys not applied:\n%s", got)
	}
	if loadAnchor().Signers[0] != admin.pub {
		t.Fatal("the signers must be pinned")
	}
	if st := loadAccessState(); st.Serial != 1 || st.UserName != cur.Username || len(st.User) != 2 {
		t.Fatalf("state: %+v", st)
	}

	// the next manifest drops k1: removed, the foreign key stays
	s2 := mk(2, k2)
	if blocked, _ := resolveAccess(s2, false); len(blocked) != 0 {
		t.Fatal(blocked)
	}
	if c := checkModule(t.Context(), s2, "user_keys"); c.State != "drift" || !strings.Contains(c.Detail, "to remove") {
		t.Fatalf("stale key must drift: %+v", c)
	}
	apply(mk(2, k2))
	got = authorized()
	if strings.Contains(got, k1) || !strings.Contains(got, k2) || !strings.Contains(got, foreign) {
		t.Fatalf("k1 must be removed, the others kept:\n%s", got)
	}
	if loadAccessState().Serial != 2 {
		t.Fatal("serial")
	}

	// replay of the first manifest: refused, nothing changes
	old := mk(1, k1, k2)
	if blocked, why := resolveAccess(old, true); len(blocked) == 0 || !strings.Contains(why, "older") {
		t.Fatalf("replay must be blocked: %v %s", blocked, why)
	}
	if strings.Contains(authorized(), k1) {
		t.Fatal("a replayed manifest must not bring a key back")
	}

	// inventory
	rep := accessReport(s2, "")
	var unknown int
	for _, k := range rep.Keys {
		if k.Account == cur.Username && !k.Managed {
			unknown++
		}
	}
	if unknown != 1 || rep.Applied != 2 {
		t.Fatalf("inventory: %+v", rep)
	}

	// a spec without valid manifest blocks the access modules and leaves the others
	s3 := &SetupSpec{Modules: []string{"packages", "root_keys", "user", "user_keys"}, User: &UserSpec{Name: "hub-chosen"}}
	blocked, _ := resolveAccess(s3, true)
	if len(blocked) != 3 || len(s3.Modules) != 1 || s3.User != nil {
		t.Fatalf("blocked=%v modules=%v", blocked, s3.Modules)
	}
}

// tools/access-manifest.sh produces what the agent accepts.
func TestAccessManifestScript(t *testing.T) {
	for _, bin := range []string{"jq", "ssh-keygen", "bash"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skip(bin + " not available")
		}
	}
	script, _ := filepath.Abs("../tools/access-manifest.sh")
	if _, err := os.Stat(script); err != nil {
		t.Skip("script not found")
	}
	admin, backup := newTestSigner(t, "admin"), newTestSigner(t, "backup")
	dir := t.TempDir()
	cfg := map[string]any{
		"signers": []string{admin.pub, backup.pub},
		"root":    map[string]any{"sshKeys": []string{testKey}},
		"user":    map[string]any{"name": "ops", "sudoNoPassword": true, "sshKeys": []string{testKey}},
	}
	raw, _ := json.Marshal(cfg)
	cfgFile, out := filepath.Join(dir, "access.json"), filepath.Join(dir, "manifest.sig.json")
	_ = os.WriteFile(cfgFile, raw, 0o600)
	run := func() {
		t.Helper()
		if o, err := exec.Command("bash", script, "-c", cfgFile, "-k", admin.priv, "-o", out).CombinedOutput(); err != nil {
			t.Fatalf("script: %v\n%s", err, o)
		}
	}
	read := func() (*AccessBundle, *AccessManifest) {
		var b AccessBundle
		raw, _ := os.ReadFile(out)
		if err := json.Unmarshal(raw, &b); err != nil {
			t.Fatal(err)
		}
		m, _, err := verifyAccess(&b, accessAnchor{Signers: []string{admin.pub}}, accessState{})
		if err != nil {
			t.Fatalf("the agent refuses the script output: %v", err)
		}
		return &b, m
	}
	run()
	if _, m := read(); m.Serial != 1 || m.User == nil || !m.User.SudoNoPassword || len(m.Signers) != 2 {
		t.Fatalf("%+v", m)
	}
	run() // serial goes up from the previous bundle
	if _, m := read(); m.Serial != 2 {
		t.Fatalf("serial %d", m.Serial)
	}
	// a signing key that is not in signers is refused by the script
	other := newTestSigner(t, "other")
	if o, err := exec.Command("bash", script, "-c", cfgFile, "-k", other.priv, "-o", filepath.Join(dir, "x.json")).CombinedOutput(); err == nil {
		t.Fatalf("script must refuse a key outside signers:\n%s", o)
	}
}
