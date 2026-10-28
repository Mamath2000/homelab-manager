//go:build !windows

package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
)

// target of /agent/download/<prefix><arch> on the hub (Linux: the arch alone)
const downloadPrefix = ""

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
	// Unraid: the running binary lives in RAM, the one restored at boot on the flash drive
	if keep := os.Getenv("AGENT_PERSIST_BIN"); keep != "" && keep != exe {
		raw, err := os.ReadFile(exe)
		if err == nil {
			err = writeFileAtomic(keep, raw, 0o755)
		}
		if err != nil {
			return fmt.Errorf("binary replaced but not saved to %s: %w", keep, err)
		}
		emit(fmt.Sprintf("copy kept in %s\n", keep))
	}
	emit(fmt.Sprintf("%s replaced, restarting\n", exe))
	return nil
}
