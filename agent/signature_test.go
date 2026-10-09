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

func signB64(key ed25519.PrivateKey, b []byte) string {
	return base64.StdEncoding.EncodeToString(ed25519.Sign(key, []byte("homelab-agent/v1:"+sum(b))))
}

func TestVerifySignature(t *testing.T) {
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	pubB64 := base64.StdEncoding.EncodeToString(pub)
	bin := []byte("agent binary")
	if err := verifySignature(pubB64, sum(bin), []byte(signB64(key, bin)+"\n")); err != nil {
		t.Fatalf("valid signature refused: %v", err)
	}
	if verifySignature(pubB64, sum([]byte("other binary")), []byte(signB64(key, bin))) == nil {
		t.Fatal("signature of another binary accepted")
	}
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	if verifySignature(pubB64, sum(bin), []byte(signB64(other, bin))) == nil {
		t.Fatal("signature by another key accepted")
	}
	if verifySignature("not a key", sum(bin), []byte(signB64(key, bin))) == nil {
		t.Fatal("invalid public key accepted")
	}
}

// A hub serving a binary and, optionally, its signature.
func binaryServer(t *testing.T, bin []byte, sig string) *httptest.Server {
	path := "/agent/download/" + runtime.GOARCH
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == path:
			w.Write(bin)
		case r.URL.Path == path+".sig" && sig != "":
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
	defer func(k string) { releasePubKey = k }(releasePubKey)
	bin := []byte("signed agent")
	forged := []byte("modified agent")
	emit := func(string) {}
	fetch := func(srv *httptest.Server, b []byte) (string, error) {
		// the hub announces the hash of what it serves: only the signature can catch a forged binary
		return fetchBinary(context.Background(), srv.Client(), srv.URL, sum(b), t.TempDir(), emit)
	}

	releasePubKey = base64.StdEncoding.EncodeToString(pub)
	file, err := fetch(binaryServer(t, bin, signB64(key, bin)), bin)
	if err != nil {
		t.Fatalf("signed binary refused: %v", err)
	}
	if got, _ := os.ReadFile(file); string(got) != string(bin) {
		t.Fatal("downloaded file differs")
	}
	if _, err := fetch(binaryServer(t, forged, signB64(key, bin)), forged); err == nil || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("modified binary accepted: %v", err)
	}
	if _, err := fetch(binaryServer(t, bin, ""), bin); err == nil {
		t.Fatal("binary without signature accepted by a release build")
	}

	// development build: no key, the sha256 is enough
	releasePubKey = ""
	if _, err := fetch(binaryServer(t, bin, ""), bin); err != nil {
		t.Fatalf("development build refused an unsigned binary: %v", err)
	}
}
