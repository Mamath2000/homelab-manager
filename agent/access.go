//go:build !windows

package main

// Signed access manifest (issue #312): the SSH keys of root, the sudo user and its keys are no longer values the hub
// pushes. They come from a manifest signed OFFLINE by an administration key the hub does not hold (SSHSIG, namespace
// accessNamespace, produced by tools/access-manifest.sh). The hub only stores and relays the bundle; this agent
// checks the signature against its own anchor (access-anchor.json, owned by root, never writable by the hub) before
// it touches authorized_keys or sudoers.
//
// Trust anchor: the signers allowed to sign. A new agent has none and a window (accessWindow, from its first start)
// during which the signers listed in the first valid manifest are pinned (trust on first use, for the migration).
// Once the window is closed, a host without anchor refuses every manifest until root edits the anchor by hand.
// A manifest lists the signers allowed afterwards (key rotation, backup key) and a serial that only goes up: an
// older manifest replayed by a compromised hub is refused.

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	accessNamespace  = "homelab-manager-access"
	accessAnchorFile = "access-anchor.json"
	accessStateFile  = "access-state.json"
	accessWindow     = 14 * 24 * time.Hour
	maxAccessPayload = 256 << 10
	maxAccessKeys    = 50
	maxAccessSigners = 10

	keyTypeEd25519   = "ssh-ed25519"
	keyTypeSKEd25519 = "sk-ssh-ed25519@openssh.com"
)

var nowFn = time.Now

// --- manifest ----------------------------------------------------------------------------------

// AccessBundle is what the hub relays: the manifest (base64 of the exact signed bytes) and its SSHSIG signature.
type AccessBundle struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

type AccessRoot struct {
	SSHKeys []string `json:"sshKeys"`
}

type AccessUser struct {
	Name           string   `json:"name"`
	SudoNoPassword bool     `json:"sudoNoPassword"`
	SSHKeys        []string `json:"sshKeys"`
}

type AccessManifest struct {
	V         int         `json:"v"`
	Serial    int64       `json:"serial"`
	IssuedAt  int64       `json:"issuedAt"`
	ExpiresAt int64       `json:"expiresAt,omitempty"` // 0: never
	Signers   []string    `json:"signers"`             // allowed from now on (replaces the anchor)
	Root      AccessRoot  `json:"root"`
	User      *AccessUser `json:"user,omitempty"`
}

func validateManifest(m *AccessManifest) error {
	if m.V != 1 {
		return fmt.Errorf("unsupported manifest version %d", m.V)
	}
	if m.Serial < 1 {
		return errors.New("invalid serial")
	}
	if len(m.Signers) == 0 || len(m.Signers) > maxAccessSigners {
		return errors.New("signers: 1 to 10 required")
	}
	for _, s := range m.Signers {
		if _, err := parsePublicKeyLine(s); err != nil {
			return fmt.Errorf("signers: %w", err)
		}
	}
	check := func(who string, keys []string) error {
		if len(keys) > maxAccessKeys {
			return fmt.Errorf("%s: too many keys", who)
		}
		for _, k := range keys {
			if !sshKeyRe.MatchString(k) {
				return fmt.Errorf("%s: invalid ssh key", who)
			}
		}
		return nil
	}
	if err := check("root", m.Root.SSHKeys); err != nil {
		return err
	}
	if m.User != nil {
		if !userNameRe.MatchString(m.User.Name) || m.User.Name == "root" {
			return errors.New("invalid user name")
		}
		if err := check("user", m.User.SSHKeys); err != nil {
			return err
		}
	}
	return nil
}

// --- SSH wire format and SSHSIG ----------------------------------------------------------------

type wireReader struct {
	b   []byte
	err error
}

func (r *wireReader) take(n int) []byte {
	if r.err != nil || n < 0 || len(r.b) < n {
		r.err = errors.New("truncated data")
		return nil
	}
	out := r.b[:n]
	r.b = r.b[n:]
	return out
}

func (r *wireReader) u32() uint32 {
	if b := r.take(4); b != nil {
		return binary.BigEndian.Uint32(b)
	}
	return 0
}

func (r *wireReader) byte() byte {
	if b := r.take(1); b != nil {
		return b[0]
	}
	return 0
}

func (r *wireReader) str() []byte {
	n := r.u32()
	if r.err != nil || uint64(n) > uint64(len(r.b)) {
		r.err = errors.New("truncated data")
		return nil
	}
	return r.take(int(n))
}

func appendWireString(dst, s []byte) []byte {
	dst = binary.BigEndian.AppendUint32(dst, uint32(len(s)))
	return append(dst, s...)
}

// sshPub is an Ed25519 public key (plain or FIDO "sk-").
type sshPub struct {
	typ  string
	key  ed25519.PublicKey
	app  []byte // sk- keys: application (relying party)
	blob []byte
}

func parsePublicBlob(blob []byte) (*sshPub, error) {
	r := &wireReader{b: blob}
	typ := string(r.str())
	key := r.str()
	p := &sshPub{typ: typ, blob: blob}
	switch typ {
	case keyTypeEd25519:
	case keyTypeSKEd25519:
		p.app = r.str()
	default:
		return nil, fmt.Errorf("unsupported key type %q (ed25519 and sk-ed25519 only)", typ)
	}
	if r.err != nil || len(key) != ed25519.PublicKeySize || len(r.b) != 0 {
		return nil, errors.New("malformed public key")
	}
	p.key = ed25519.PublicKey(key)
	return p, nil
}

// parsePublicKeyLine reads "ssh-ed25519 AAAA… comment".
func parsePublicKeyLine(line string) (*sshPub, error) {
	f := strings.Fields(line)
	if len(f) < 2 {
		return nil, errors.New("malformed public key")
	}
	blob, err := base64.StdEncoding.DecodeString(f[1])
	if err != nil {
		return nil, errors.New("malformed public key")
	}
	p, err := parsePublicBlob(blob)
	if err != nil {
		return nil, err
	}
	if p.typ != f[0] {
		return nil, errors.New("public key type mismatch")
	}
	return p, nil
}

func (p *sshPub) fingerprint() string { return blobFingerprint(p.blob) }

func blobFingerprint(blob []byte) string {
	h := sha256.Sum256(blob)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(h[:])
}

// verify checks a signature (SSH wire format: format, blob [, flags, counter] for sk- keys) over signed.
func (p *sshPub) verify(signed, sig []byte) error {
	r := &wireReader{b: sig}
	format, raw := string(r.str()), r.str()
	if r.err != nil || format != p.typ || len(raw) != ed25519.SignatureSize {
		return errors.New("malformed signature")
	}
	msg := signed
	if p.typ == keyTypeSKEd25519 {
		flags, counter := r.byte(), r.u32()
		if r.err != nil {
			return errors.New("malformed signature")
		}
		// the security key must have checked the presence of its holder (touch)
		if flags&0x01 == 0 {
			return errors.New("security key: user presence (touch) missing")
		}
		appHash := sha256.Sum256(p.app)
		dataHash := sha256.Sum256(signed)
		msg = append(append(append(append([]byte{}, appHash[:]...), flags), binary.BigEndian.AppendUint32(nil, counter)...), dataHash[:]...)
	}
	if !ed25519.Verify(p.key, msg, raw) {
		return errors.New("invalid signature")
	}
	return nil
}

// verifySSHSig checks an armored SSHSIG over message for the given namespace and returns the key that signed it.
func verifySSHSig(armored string, message []byte, namespace string) (*sshPub, error) {
	var body []string
	for _, l := range strings.Split(armored, "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "-----") {
			continue
		}
		body = append(body, l)
	}
	raw, err := base64.StdEncoding.DecodeString(strings.Join(body, ""))
	if err != nil || !bytes.HasPrefix(raw, []byte("SSHSIG")) {
		return nil, errors.New("malformed signature")
	}
	r := &wireReader{b: raw[6:]}
	if r.u32() != 1 {
		return nil, errors.New("unsupported signature version")
	}
	pubBlob, ns, reserved, hashAlg, sig := r.str(), r.str(), r.str(), r.str(), r.str()
	if r.err != nil || len(r.b) != 0 {
		return nil, errors.New("malformed signature")
	}
	if string(ns) != namespace {
		return nil, errors.New("signature made for another namespace")
	}
	var digest []byte
	switch string(hashAlg) {
	case "sha256":
		h := sha256.Sum256(message)
		digest = h[:]
	case "sha512":
		h := sha512.Sum512(message)
		digest = h[:]
	default:
		return nil, errors.New("unsupported hash algorithm")
	}
	signed := []byte("SSHSIG")
	for _, s := range [][]byte{ns, reserved, hashAlg, digest} {
		signed = appendWireString(signed, s)
	}
	pub, err := parsePublicBlob(pubBlob)
	if err != nil {
		return nil, err
	}
	if err := pub.verify(signed, sig); err != nil {
		return nil, err
	}
	return pub, nil
}

// --- anchor and state (agent directory, owned by root) ----------------------------------------

type accessAnchor struct {
	Signers   []string `json:"signers"`             // allowed signers (public key lines)
	TofuUntil int64    `json:"tofuUntil,omitempty"` // unix seconds: until then the first valid manifest pins its signers
	PinnedAt  int64    `json:"pinnedAt,omitempty"`
}

type accessState struct {
	Serial   int64    `json:"serial"`             // highest manifest serial applied
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

// loadAnchor: a missing or unreadable file is a closed anchor (no signer, no window).
func loadAnchor() accessAnchor {
	var a accessAnchor
	if err := readJSONFile(accessPath(accessAnchorFile), &a); err != nil {
		return accessAnchor{}
	}
	return a
}

func loadAccessState() accessState {
	var s accessState
	_ = readJSONFile(accessPath(accessStateFile), &s)
	return s
}

// ensureAccessAnchor, at start: a host without anchor gets an empty one and the migration window. An existing file is
// never replaced, so the window cannot be reopened by the hub nor by a restart.
func ensureAccessAnchor(dir string) {
	file := filepath.Join(dir, accessAnchorFile)
	if _, err := os.Stat(file); err == nil {
		return
	}
	a := accessAnchor{Signers: []string{}, TofuUntil: nowFn().Add(accessWindow).Unix()}
	if err := writeJSONFile(file, a); err != nil {
		log.Printf("access: cannot write %s: %v (signed access manifests will be refused)", file, err)
		return
	}
	log.Printf("access: no anchor yet: the first valid signed manifest received before %s pins its signers", time.Unix(a.TofuUntil, 0).Format(time.RFC3339))
}

// --- verification ------------------------------------------------------------------------------

func containsBlob(lines []string, blob []byte) bool {
	for _, l := range lines {
		if p, err := parsePublicKeyLine(l); err == nil && bytes.Equal(p.blob, blob) {
			return true
		}
	}
	return false
}

// verifyAccess checks a bundle: signature, anchor, expiry and serial. pinning: the signers come from the manifest
// itself (open migration window), they are recorded when the manifest is applied.
func verifyAccess(b *AccessBundle, anchor accessAnchor, st accessState) (m *AccessManifest, pinning bool, err error) {
	if b == nil || b.Payload == "" || b.Signature == "" {
		return nil, false, errors.New("no signed access manifest published on the hub")
	}
	if len(b.Payload) > maxAccessPayload*2 {
		return nil, false, errors.New("manifest too large")
	}
	payload, err := base64.StdEncoding.DecodeString(b.Payload)
	if err != nil || len(payload) > maxAccessPayload {
		return nil, false, errors.New("malformed manifest")
	}
	var mf AccessManifest
	dec := json.NewDecoder(bytes.NewReader(payload))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&mf); err != nil {
		return nil, false, fmt.Errorf("malformed manifest: %w", err)
	}
	if err := validateManifest(&mf); err != nil {
		return nil, false, err
	}
	signer, err := verifySSHSig(b.Signature, payload, accessNamespace)
	if err != nil {
		return nil, false, err
	}
	switch {
	case len(anchor.Signers) > 0:
		if !containsBlob(anchor.Signers, signer.blob) {
			return nil, false, fmt.Errorf("signer %s is not in the anchor of this host", signer.fingerprint())
		}
	case anchor.TofuUntil > 0 && nowFn().Unix() < anchor.TofuUntil:
		if !containsBlob(mf.Signers, signer.blob) {
			return nil, false, errors.New("the signer must be listed in the manifest signers")
		}
		pinning = true
	default:
		return nil, false, errors.New("no anchor on this host and the migration window is closed: set the signers in " + accessPath(accessAnchorFile))
	}
	if mf.ExpiresAt > 0 && nowFn().Unix() > mf.ExpiresAt {
		return nil, false, errors.New("manifest expired")
	}
	if mf.Serial < st.Serial {
		return nil, false, fmt.Errorf("manifest serial %d is older than the one applied (%d)", mf.Serial, st.Serial)
	}
	return &mf, pinning, nil
}

// --- resolution of a setup spec ----------------------------------------------------------------

// accessCtx: the verified manifest and what this agent added earlier, for the options that use them.
type accessCtx struct {
	manifest *AccessManifest
	state    accessState
	pinning  bool
	prevRoot []string
	prevUser []string
}

func isAccessModule(m string) bool {
	return m == "user" || m == "root_keys" || strings.HasPrefix(m, "user_")
}

// keyIDs of key lines: type + " " + base64
func keyIDs(lines []string) []string {
	var out []string
	for _, l := range lines {
		if id := keyID(strings.TrimSpace(l)); id != "" {
			out = append(out, id)
		}
	}
	return out
}

// resolveAccess replaces what the hub sent for root keys, the user and its keys by the content of the verified
// manifest. The options that cannot be served (no valid manifest, no user in it) are removed from the spec and
// returned with the reason. commit (apply only) records the signers and the serial.
func resolveAccess(s *SetupSpec, commit bool) (blocked []SetupCheck, reason string) {
	hub := s.User
	s.Root.SSHKeys = nil
	s.User = nil
	s.access = nil
	var concerned []string
	for _, m := range s.Modules {
		if isAccessModule(m) {
			concerned = append(concerned, m)
		}
	}
	if len(concerned) == 0 {
		return nil, ""
	}
	block := func(why string, only func(string) bool) {
		var keep []string
		for _, m := range s.Modules {
			if isAccessModule(m) && only(m) {
				blocked = append(blocked, SetupCheck{Module: m, State: "error", Detail: why})
			} else {
				keep = append(keep, m)
			}
		}
		s.Modules = keep
	}
	all := func(string) bool { return true }
	anchor, st := loadAnchor(), loadAccessState()
	m, pinning, err := verifyAccess(s.Access, anchor, st)
	if err != nil {
		block(err.Error(), all)
		return blocked, err.Error()
	}
	s.Root.SSHKeys = m.Root.SSHKeys
	ctx := &accessCtx{manifest: m, state: st, pinning: pinning, prevRoot: st.Root}
	if m.User == nil {
		block("the access manifest defines no user", func(x string) bool { return strings.HasPrefix(x, "user") })
	} else {
		u := &UserSpec{Name: m.User.Name, SudoNoPassword: m.User.SudoNoPassword, AccountSpec: AccountSpec{SSHKeys: m.User.SSHKeys}}
		if hub != nil {
			u.Aliases, u.Prompt, u.Motd = hub.Aliases, hub.Prompt, hub.Motd
		}
		s.User = u
		if st.UserName == m.User.Name {
			ctx.prevUser = st.User
		}
	}
	s.access = ctx
	if commit {
		if err := commitAccess(ctx, anchor); err != nil {
			s.access = nil
			s.Root.SSHKeys, s.User = nil, nil
			block(err.Error(), all)
			return blocked, err.Error()
		}
	}
	return blocked, ""
}

// commitAccess records what a verified manifest changes: the signers (pinning or rotation) and the serial.
func commitAccess(c *accessCtx, anchor accessAnchor) error {
	m := c.manifest
	if anchor.TofuUntil > 0 || !sameLines(anchor.Signers, m.Signers) {
		anchor.Signers, anchor.PinnedAt = m.Signers, nowFn().Unix()
		if c.pinning {
			log.Printf("access: signers pinned from manifest %d", m.Serial)
		}
		if err := writeJSONFile(accessPath(accessAnchorFile), anchor); err != nil {
			return fmt.Errorf("anchor: %w", err)
		}
	}
	if m.Serial > c.state.Serial {
		c.state.Serial = m.Serial
		return saveAccessState(c.state)
	}
	return nil
}

func sameLines(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if strings.TrimSpace(a[i]) != strings.TrimSpace(b[i]) {
			return false
		}
	}
	return true
}

func saveAccessState(st accessState) error { return writeJSONFile(accessPath(accessStateFile), st) }

func (c *accessCtx) prev(prefix string) []string {
	if c == nil {
		return nil
	}
	if prefix == "root" {
		return c.prevRoot
	}
	return c.prevUser
}

// record keeps the ids of the keys written, to remove them when a later manifest drops them.
func (c *accessCtx) record(prefix string, keys []string) {
	if c == nil {
		return
	}
	ids := keyIDs(keys)
	if prefix == "root" {
		c.state.Root, c.prevRoot = ids, ids
	} else {
		c.state.User, c.state.UserName, c.prevUser = ids, c.manifest.User.Name, ids
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

// --- report (inventory and drift) --------------------------------------------------------------

type AuthorizedKey struct {
	Account     string `json:"account"`
	Type        string `json:"type"`
	Fingerprint string `json:"fingerprint"`
	Comment     string `json:"comment,omitempty"`
	Options     bool   `json:"options,omitempty"` // the line has options (command=, from=…)
	Managed     bool   `json:"managed"`           // listed by the manifest or added by this agent earlier
}

type AccessReport struct {
	Status    string          `json:"status"`              // ok | error
	Detail    string          `json:"detail,omitempty"`    // why the manifest is not usable
	Serial    int64           `json:"serial,omitempty"`    // serial of the manifest in use
	Applied   int64           `json:"applied"`             // highest serial applied on this host
	Signers   []string        `json:"signers"`             // fingerprints of the anchor
	TofuUntil int64           `json:"tofuUntil,omitempty"` // ms: migration window open until then (no anchor yet)
	Keys      []AuthorizedKey `json:"keys"`                // authorized_keys of root and of the user
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

func accessReport(s *SetupSpec, reason string) *AccessReport {
	anchor, st := loadAnchor(), loadAccessState()
	r := &AccessReport{Status: "ok", Applied: st.Serial, Signers: []string{}, Keys: []AuthorizedKey{}}
	for _, l := range anchor.Signers {
		if p, err := parsePublicKeyLine(l); err == nil {
			r.Signers = append(r.Signers, p.fingerprint())
		}
	}
	if len(anchor.Signers) == 0 && anchor.TofuUntil > 0 && nowFn().Unix() < anchor.TofuUntil {
		r.TofuUntil = anchor.TofuUntil * 1000
	}
	if reason != "" {
		r.Status, r.Detail = "error", reason
	}
	managedRoot, managedUser, userName := st.Root, st.User, st.UserName
	if s.access != nil {
		r.Serial = s.access.manifest.Serial
		managedRoot = append(append([]string{}, st.Root...), keyIDs(s.access.manifest.Root.SSHKeys)...)
		if u := s.access.manifest.User; u != nil {
			userName, managedUser = u.Name, append(append([]string{}, st.User...), keyIDs(u.SSHKeys)...)
		}
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
