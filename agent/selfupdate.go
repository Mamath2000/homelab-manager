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

// selfUpdate downloads the agent binary from the hub, checks it against the hash sent by the hub
// and atomically replaces the running executable. The caller exits afterwards: systemd
// (Restart=always) starts the new binary.
func selfUpdate(ctx context.Context, client *http.Client, hub, expected string, emit func(string)) error {
	if len(expected) != 64 {
		return fmt.Errorf("missing or invalid expected sha256")
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return err
	}
	url := fmt.Sprintf("%s/agent/download/%s", hub, runtime.GOARCH)
	emit(fmt.Sprintf("downloading %s\n", url))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("download failed: HTTP %d", res.StatusCode)
	}

	// same directory as the binary so that the final rename is atomic
	tmp, err := os.CreateTemp(filepath.Dir(exe), ".homelab-agent-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // no-op once renamed
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), res.Body)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	got := hex.EncodeToString(h.Sum(nil))
	if got != expected {
		return fmt.Errorf("checksum mismatch: got %s, expected %s", got, expected)
	}
	emit(fmt.Sprintf("downloaded %d bytes, checksum ok\n", n))
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), exe); err != nil {
		return err
	}
	emit(fmt.Sprintf("%s replaced, restarting\n", exe))
	return nil
}
