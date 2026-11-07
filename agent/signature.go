package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// releasePubKey is the base64 Ed25519 public key of the release signatures, injected at build time
// (-X main.releasePubKey=…, see agent/release.pub). Empty in development builds: updates are then
// accepted on their sha256 alone.
var releasePubKey string

// minVersion is the version floor of the updates (agent/MIN_VERSION, -X main.minVersion=…): a release agent refuses
// any binary whose signed version is below it, so that a hub cannot bring it back to a signed version that still
// has a fixed flaw (anti-rollback). Above the floor, going back stays possible (a hub rolled back to its previous
// release). It is raised by hand, in the release that fixes a flaw of the agent (make agent-floor).
var minVersion string

// updateFloor: the floor reported to the hub (none for a development agent, which checks nothing).
func updateFloor() string {
	if releasePubKey == "" {
		return ""
	}
	return minVersion
}

// The v1 signature (sha256 alone, .sig) is still written by cmd/hm-sign for the agents older than the version floor;
// the release agents check v2 only. Must match cmd/hm-sign.
// v2 binds the signature to the target (os/arch) and to the version of the binary: the hub cannot pass an old signed
// binary off as a new one, nor serve the binary of another platform.
func signedMessageV2(target, version, sha256hex string) []byte {
	return []byte("homelab-agent/v2:" + target + ":" + version + ":" + sha256hex)
}

// verifySignatureV2 checks a .sig2 file ("v2 <version> <base64 signature>") for the binary of target with this sha256,
// and returns the version it signs.
func verifySignatureV2(pub, target, sha256hex string, file []byte) (string, error) {
	key, err := releaseKey(pub)
	if err != nil {
		return "", err
	}
	fields := strings.Fields(string(file))
	if len(fields) != 3 || fields[0] != "v2" {
		return "", errors.New("invalid signature file: expected « v2 <version> <signature> »")
	}
	version := fields[1]
	if _, ok := parseVersion(version); !ok {
		return "", fmt.Errorf("invalid signature file: version %q", version)
	}
	raw, err := base64.StdEncoding.DecodeString(fields[2])
	if err != nil || !ed25519.Verify(key, signedMessageV2(target, version, sha256hex), raw) {
		return "", fmt.Errorf("invalid signature: binary not signed by the release key for %s %s", target, version)
	}
	return version, nil
}

func releaseKey(pub string) (ed25519.PublicKey, error) {
	key, err := base64.StdEncoding.DecodeString(pub)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return nil, errors.New("invalid release public key")
	}
	return ed25519.PublicKey(key), nil
}

// checkFloor: a signed version below the floor of this agent is refused. A release agent built without a floor
// refuses every update (a build that went around the Dockerfile checks), rather than accepting any version.
func checkFloor(floor, version string) error {
	f, ok := parseVersion(floor)
	if !ok {
		return fmt.Errorf("agent built without a valid version floor (MIN_VERSION %q): update refused, reinstall the agent", floor)
	}
	v, ok := parseVersion(version)
	if !ok {
		return fmt.Errorf("invalid version %q", version)
	}
	if compareParsed(v, f) < 0 {
		return fmt.Errorf("version %s below the floor %s of this agent: refused (going back to a version with a known flaw)", version, floor)
	}
	return nil
}

// parseVersion reads X.Y.Z (numbers only: development versions such as 1.0.12-dev are not release versions).
func parseVersion(s string) ([3]int, bool) {
	var v [3]int
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return v, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || p == "" || (len(p) > 1 && p[0] == '0') || strings.ContainsAny(p, "+-") {
			return v, false
		}
		v[i] = n
	}
	return v, true
}

func compareParsed(a, b [3]int) int {
	for i := range a {
		if a[i] != b[i] {
			if a[i] < b[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}
