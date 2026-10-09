package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestKeygenAndSign(t *testing.T) {
	dir := t.TempDir()
	keyFile, pubFile := filepath.Join(dir, "conf", "release.key"), filepath.Join(dir, "release.pub")
	if err := run([]string{"keygen", "-key", keyFile, "-pub", pubFile}); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(keyFile); st.Mode().Perm() != 0o600 {
		t.Fatalf("key file mode %v, want 0600", st.Mode().Perm())
	}
	if run([]string{"keygen", "-key", keyFile, "-pub", pubFile}) == nil {
		t.Fatal("an existing key was overwritten")
	}
	if run([]string{"keygen", "-key", filepath.Join(dir, "other.key"), "-pub", pubFile}) == nil {
		t.Fatal("the committed public key was replaced")
	}

	bin := filepath.Join(dir, "homelab-agent-linux-amd64")
	os.WriteFile(bin, []byte("binary"), 0o755)
	if err := run([]string{"sign", "-key", keyFile, bin}); err != nil {
		t.Fatal(err)
	}

	// the format the agent verifies (agent/signature.go)
	rawPub, _ := os.ReadFile(pubFile)
	pub, _ := base64.StdEncoding.DecodeString(strings.TrimSpace(string(rawPub)))
	rawSig, _ := os.ReadFile(bin + ".sig")
	sig, _ := base64.StdEncoding.DecodeString(strings.TrimSpace(string(rawSig)))
	h := sha256.Sum256([]byte("binary"))
	if !ed25519.Verify(pub, []byte("homelab-agent/v1:"+hex.EncodeToString(h[:])), sig) {
		t.Fatal("signature does not verify with the public key")
	}
}
