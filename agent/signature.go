package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"strings"
)

// releasePubKey is the base64 Ed25519 public key of the release signatures, injected at build time
// (-X main.releasePubKey=…, see agent/release.pub). Empty in development builds: updates are then
// accepted on their sha256 alone.
var releasePubKey string

// Must match cmd/hm-sign.
func signedMessage(sha256hex string) []byte {
	return []byte("homelab-agent/v1:" + sha256hex)
}

// verifySignature checks the base64 signature of a binary, given by its sha256, against pub.
func verifySignature(pub, sha256hex string, sig []byte) error {
	key, err := base64.StdEncoding.DecodeString(pub)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return errors.New("invalid release public key")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sig)))
	if err != nil || !ed25519.Verify(ed25519.PublicKey(key), signedMessage(sha256hex), raw) {
		return errors.New("invalid signature: binary not signed by the release key")
	}
	return nil
}
