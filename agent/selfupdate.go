package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
)

// fetchBinary downloads the binary into dir and checks it against the sha256 sent by the hub and,
// in release builds, against its signature by the release key: a hub (or anyone in its place)
// cannot push a binary that was not built and signed by the release process.
func fetchBinary(ctx context.Context, client *http.Client, hub, expected, dir string, emit func(string)) (string, error) {
	if len(expected) != 64 {
		return "", fmt.Errorf("missing or invalid expected sha256")
	}
	url := fmt.Sprintf("%s/agent/download/%s%s", hub, downloadPrefix, runtime.GOARCH)
	emit(fmt.Sprintf("downloading %s\n", url))
	body, err := get(ctx, client, url)
	if err != nil {
		return "", err
	}
	defer body.Close()

	tmp, err := os.CreateTemp(dir, ".homelab-agent-*")
	if err != nil {
		return "", err
	}
	ok := false
	defer func() {
		if !ok {
			os.Remove(tmp.Name())
		}
	}()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), body)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", err
	}
	got := hex.EncodeToString(h.Sum(nil))
	if got != expected {
		return "", fmt.Errorf("checksum mismatch: got %s, expected %s", got, expected)
	}
	emit(fmt.Sprintf("downloaded %d bytes, checksum ok\n", n))

	if releasePubKey == "" {
		emit("development build: signature not checked\n")
	} else {
		// v2 only: the signed version is checked against the floor (the v1 .sig stays for the agents below it)
		sig, err := get(ctx, client, url+".sig2")
		if err != nil {
			return "", fmt.Errorf("signature: %w", err)
		}
		raw, err := io.ReadAll(io.LimitReader(sig, 1024))
		sig.Close()
		if err != nil {
			return "", fmt.Errorf("signature: %w", err)
		}
		version, err := verifySignatureV2(releasePubKey, runtime.GOOS+"/"+runtime.GOARCH, got, raw)
		if err != nil {
			return "", err
		}
		if err := checkFloor(minVersion, version); err != nil {
			return "", err
		}
		emit(fmt.Sprintf("signature ok (version %s, floor %s)\n", version, minVersion))
	}
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		return "", err
	}
	ok = true
	return tmp.Name(), nil
}

func get(ctx context.Context, client *http.Client, url string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		res.Body.Close()
		return nil, fmt.Errorf("download of %s failed: HTTP %d", url, res.StatusCode)
	}
	return res.Body, nil
}
