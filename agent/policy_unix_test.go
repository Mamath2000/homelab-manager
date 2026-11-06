//go:build !windows

package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplySetupPolicy(t *testing.T) {
	defer func(d string) { agentDir = d }(agentDir)
	agentDir = t.TempDir()
	os.WriteFile(filepath.Join(agentDir, policyFile), []byte(`{"setup":"basic"}`), 0o644)
	var log strings.Builder
	key := "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq0u7W3X9cY5bQk0m8m3Yp0m2b9Zq2Yb0m8m3Yp0m2b attacker"
	code, err := applySetup(context.Background(), &SetupSpec{Modules: []string{"root_keys"}, Root: AccountSpec{SSHKeys: []string{key}}}, func(s string) { log.WriteString(s) })
	if code == 0 || err == nil || !strings.Contains(err.Error(), "root_keys") || !strings.Contains(log.String(), "refused") {
		t.Fatalf("code %d, err %v, log %q", code, err, log.String())
	}
}
