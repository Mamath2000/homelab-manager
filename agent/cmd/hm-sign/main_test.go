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
	if run([]string{"sign", "-key", keyFile, bin}) == nil {
		t.Fatal("signed without a version")
	}
	if run([]string{"sign", "-key", keyFile, "-version", "1.0.13-dev", bin}) == nil {
		t.Fatal("signed a development version")
	}
	if err := run([]string{"sign", "-key", keyFile, "-version", "1.0.13", bin}); err != nil {
		t.Fatal(err)
	}
	odd := filepath.Join(dir, "agent.bin")
	os.WriteFile(odd, []byte("binary"), 0o755)
	if run([]string{"sign", "-key", keyFile, "-version", "1.0.13", odd}) == nil {
		t.Fatal("signed a file whose target is unknown")
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
	// v2: target and version signed with the hash, « v2 <version> <signature> »
	rawSig2, _ := os.ReadFile(bin + ".sig2")
	f := strings.Fields(string(rawSig2))
	if len(f) != 3 || f[0] != "v2" || f[1] != "1.0.13" {
		t.Fatalf("v2 signature file %q", rawSig2)
	}
	sig2, _ := base64.StdEncoding.DecodeString(f[2])
	if !ed25519.Verify(pub, []byte("homelab-agent/v2:linux/amd64:1.0.13:"+hex.EncodeToString(h[:])), sig2) {
		t.Fatal("v2 signature does not verify with the public key")
	}
}
