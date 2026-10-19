//go:build windows

package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// target of /agent/download/<prefix><arch> on the hub
const downloadPrefix = "windows-"

// selfUpdate downloads the agent binary from the hub, checks it and swaps it with the running
// executable. A running .exe can be renamed but not overwritten: the old one is moved aside to
// <exe>.old (removed at the next start, see cleanOldBinary). The caller then exits with a failure
// code so that the recovery actions of the service start the new binary.
func selfUpdate(ctx context.Context, client *http.Client, hub, expected string, emit func(string)) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return err
	}
	// same directory as the binary so that the renames stay on one volume
	tmp, err := fetchBinary(ctx, client, hub, expected, filepath.Dir(exe), emit)
	if err != nil {
		return err
	}
	defer os.Remove(tmp) // no-op once renamed
	old := exe + ".old"
	_ = os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		return err
	}
	if err := os.Rename(tmp, exe); err != nil {
		// nothing at exe any more: put the running binary back
		if rerr := os.Rename(old, exe); rerr != nil {
			return fmt.Errorf("%w (and restoring the old binary failed: %v)", err, rerr)
		}
		return err
	}
	emit(fmt.Sprintf("%s replaced, restarting\n", exe))
	return nil
}

// cleanOldBinary removes the binary left aside by the previous update.
func cleanOldBinary() {
	if exe, err := os.Executable(); err == nil && strings.HasSuffix(strings.ToLower(exe), ".exe") {
		_ = os.Remove(exe + ".old")
	}
}
