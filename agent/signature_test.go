//go:build !windows

package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"testing"
)

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

var hostTarget = runtime.GOOS + "/" + runtime.GOARCH

// sig2 builds a .sig2 file, as cmd/hm-sign writes it.
func sig2(key ed25519.PrivateKey, target, version string, b []byte) string {
	sig := ed25519.Sign(key, []byte("homelab-agent/v2:"+target+":"+version+":"+sum(b)))
	return "v2 " + version + " " + base64.StdEncoding.EncodeToString(sig) + "\n"
}

func TestVerifySignatureV2(t *testing.T) {
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	pubB64 := base64.StdEncoding.EncodeToString(pub)
	bin := []byte("agent binary")
	v, err := verifySignatureV2(pubB64, "linux/amd64", sum(bin), []byte(sig2(key, "linux/amd64", "1.0.13", bin)))
	if err != nil || v != "1.0.13" {
		t.Fatalf("valid signature refused: %v (version %q)", err, v)
	}
	// the version written next to the signature is the one signed: changing it breaks the signature
	forgedVersion := strings.Replace(sig2(key, "linux/amd64", "1.0.5", bin), "1.0.5", "1.0.13", 1)
	cases := map[string]struct{ target, sha, file string }{
		"other binary":   {"linux/amd64", sum([]byte("other binary")), sig2(key, "linux/amd64", "1.0.13", bin)},
		"other target":   {"linux/arm64", sum(bin), sig2(key, "linux/amd64", "1.0.13", bin)},
		"forged version": {"linux/amd64", sum(bin), forgedVersion},
		"v1 file":        {"linux/amd64", sum(bin), base64.StdEncoding.EncodeToString(ed25519.Sign(key, []byte("homelab-agent/v1:"+sum(bin))))},
		"bad version":    {"linux/amd64", sum(bin), sig2(key, "linux/amd64", "1.0.13-dev", bin)},
		"empty":          {"linux/amd64", sum(bin), ""},
	}
	for name, c := range cases {
		if _, err := verifySignatureV2(pubB64, c.target, c.sha, []byte(c.file)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	if _, err := verifySignatureV2(pubB64, "linux/amd64", sum(bin), []byte(sig2(other, "linux/amd64", "1.0.13", bin))); err == nil {
		t.Fatal("signature by another key accepted")
	}
	if _, err := verifySignatureV2("not a key", "linux/amd64", sum(bin), []byte(sig2(key, "linux/amd64", "1.0.13", bin))); err == nil {
		t.Fatal("invalid public key accepted")
	}
}

func TestCheckFloor(t *testing.T) {
	ok := [][2]string{{"1.0.12", "1.0.12"}, {"1.0.12", "1.0.13"}, {"1.0.9", "1.0.10"}, {"1.0.12", "2.0.0"}, {"1.9.0", "1.10.0"}}
	for _, c := range ok {
		if err := checkFloor(c[0], c[1]); err != nil {
			t.Errorf("floor %s, version %s refused: %v", c[0], c[1], err)
		}
	}
	refused := [][2]string{{"1.0.12", "1.0.11"}, {"1.0.10", "1.0.9"}, {"2.0.0", "1.99.99"}, {"", "1.0.13"}, {"1.0", "1.0.13"}, {"1.0.12", "1.0.13-dev"}, {"1.0.12", "01.0.13"}}
	for _, c := range refused {
		if checkFloor(c[0], c[1]) == nil {
			t.Errorf("floor %q, version %q accepted", c[0], c[1])
		}
	}
}

// A hub serving a binary and, optionally, its v2 signature.
func binaryServer(t *testing.T, bin []byte, sig string) *httptest.Server {
	path := "/agent/download/" + runtime.GOARCH
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == path:
			w.Write(bin)
		case r.URL.Path == path+".sig2" && sig != "":
			w.Write([]byte(sig))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestFetchBinarySignature(t *testing.T) {
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	defer func(k, f string) { releasePubKey, minVersion = k, f }(releasePubKey, minVersion)
	bin := []byte("signed agent")
	forged := []byte("modified agent")
	emit := func(string) {}
	fetch := func(srv *httptest.Server, b []byte) (string, error) {
		// the hub announces the hash of what it serves: only the signature can catch a forged binary
		return fetchBinary(context.Background(), srv.Client(), srv.URL, sum(b), t.TempDir(), emit)
	}

	releasePubKey = base64.StdEncoding.EncodeToString(pub)
	minVersion = "1.0.12"
	file, err := fetch(binaryServer(t, bin, sig2(key, hostTarget, "1.0.13", bin)), bin)
	if err != nil {
		t.Fatalf("signed binary refused: %v", err)
	}
	if got, _ := os.ReadFile(file); string(got) != string(bin) {
		t.Fatal("downloaded file differs")
	}
	if _, err := fetch(binaryServer(t, forged, sig2(key, hostTarget, "1.0.13", bin)), forged); err == nil || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("modified binary accepted: %v", err)
	}
	if _, err := fetch(binaryServer(t, bin, ""), bin); err == nil {
		t.Fatal("binary without signature accepted by a release build")
	}
	// anti-rollback: a genuinely signed binary below the floor is refused, the floor itself is accepted
	if _, err := fetch(binaryServer(t, bin, sig2(key, hostTarget, "1.0.11", bin)), bin); err == nil || !strings.Contains(err.Error(), "floor") {
		t.Fatalf("signed binary below the floor accepted: %v", err)
	}
	if _, err := fetch(binaryServer(t, bin, sig2(key, hostTarget, "1.0.12", bin)), bin); err != nil {
		t.Fatalf("binary at the floor refused: %v", err)
	}
	// the binary of another platform, even signed, is refused
	if _, err := fetch(binaryServer(t, bin, sig2(key, "windows/amd64", "1.0.13", bin)), bin); err == nil {
		t.Fatal("binary signed for another platform accepted")
	}
	// release build without a floor: every update is refused
	minVersion = ""
	if _, err := fetch(binaryServer(t, bin, sig2(key, hostTarget, "1.0.13", bin)), bin); err == nil {
		t.Fatal("release build without a floor accepted an update")
	}

	// development build: no key, the sha256 is enough
	releasePubKey = ""
	if _, err := fetch(binaryServer(t, bin, ""), bin); err != nil {
		t.Fatalf("development build refused an unsigned binary: %v", err)
	}
}

// agent/MIN_VERSION is what the release embeds (Dockerfile): a release version, not above the agent's own.
func TestMinVersionFile(t *testing.T) {
	read := func(name string) string {
		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(string(raw))
	}
	floor, version := read("MIN_VERSION"), read("VERSION")
	if err := checkFloor(floor, version); err != nil {
		t.Fatalf("agent/MIN_VERSION %q with agent/VERSION %q: %v", floor, version, err)
	}
}
