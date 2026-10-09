package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
)

// selfHash is the sha256 of the running binary, reported to the hub so that it can
// tell whether this agent matches the binary it distributes.
func selfHash() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	f, err := os.Open(exe)
	if err != nil {
		return ""
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return ""
	}
	return hex.EncodeToString(h.Sum(nil))
}

// selfUpdate downloads the agent binary from the hub, checks it and atomically replaces the running
// executable. The caller exits afterwards: systemd (Restart=always) starts the new binary.
func selfUpdate(ctx context.Context, client *http.Client, hub, expected string, emit func(string)) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return err
	}
	// same directory as the binary so that the final rename is atomic
	tmp, err := fetchBinary(ctx, client, hub, expected, filepath.Dir(exe), emit)
	if err != nil {
		return err
	}
	defer os.Remove(tmp) // no-op once renamed
	if err := os.Rename(tmp, exe); err != nil {
		return err
	}
	emit(fmt.Sprintf("%s replaced, restarting\n", exe))
	return nil
}

// fetchBinary downloads the binary into dir and checks it against the sha256 sent by the hub and,
// in release builds, against its signature by the release key: a hub (or anyone in its place)
// cannot push a binary that was not built and signed by the release process.
func fetchBinary(ctx context.Context, client *http.Client, hub, expected, dir string, emit func(string)) (string, error) {
	if len(expected) != 64 {
		return "", fmt.Errorf("missing or invalid expected sha256")
	}
	url := fmt.Sprintf("%s/agent/download/%s", hub, runtime.GOARCH)
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
		sig, err := get(ctx, client, url+".sig")
		if err != nil {
			return "", fmt.Errorf("signature: %w", err)
		}
		raw, err := io.ReadAll(io.LimitReader(sig, 1024))
		sig.Close()
		if err != nil {
			return "", fmt.Errorf("signature: %w", err)
		}
		if err := verifySignature(releasePubKey, got, raw); err != nil {
			return "", err
		}
		emit("signature ok\n")
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
