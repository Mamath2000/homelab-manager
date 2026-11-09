//go:build !windows

package main

// `homelab-agent install`: the agent installs itself where it runs (systemd hosts, default layout). The agent of a
// PVE node copies its own binary into a CT or onto another node and runs this, instead of a script fetched from
// the hub: nothing that runs as root there comes from the hub, only the enrollment code (agent_install.go).
//
//	homelab-agent install -hub https://hub:3443 -stdin   stdin: the code on the first line, the CA of the hub (PEM),
//	                                                     then the access anchor of the installing node (JSON)

import (
	"bufio"
	"bytes"
	"context"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	installBin   = "/usr/local/bin/homelab-agent"
	installUnit  = "/etc/systemd/system/homelab-agent.service"
	installState = "/var/lib/homelab-agent"
	legacyEnv    = "/etc/homelab-agent.env"
)

const unitContent = `[Unit]
Description=Homelab Manager agent
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=%s/agent.env
ExecStart=%s
Restart=always
RestartSec=5
# restarting the agent must not kill an apt/dpkg run it started
KillMode=process

[Install]
WantedBy=multi-user.target
`

// readInstallInput: the code (first line), the CA certificate of the hub (PEM) and the access anchor (the rest, JSON).
func readInstallInput(r io.Reader) (string, []byte, accessAnchor, error) {
	br := bufio.NewReader(io.LimitReader(r, 64<<10))
	line, err := br.ReadString('\n')
	if err != nil {
		return "", nil, accessAnchor{}, errors.New("no enrollment code on stdin")
	}
	code := strings.TrimSpace(line)
	if !agentCodeRe.MatchString(code) {
		return "", nil, accessAnchor{}, errors.New("invalid enrollment code")
	}
	ca, _ := io.ReadAll(br)
	block, rest := pem.Decode(ca)
	if block == nil || block.Type != "CERTIFICATE" {
		return "", nil, accessAnchor{}, errors.New("no CA certificate on stdin")
	}
	if _, err := x509.ParseCertificate(block.Bytes); err != nil {
		return "", nil, accessAnchor{}, fmt.Errorf("CA certificate: %w", err)
	}
	anchor, err := parseHandedAnchor(bytes.TrimSpace(rest))
	if err != nil {
		return "", nil, accessAnchor{}, err
	}
	return code, pem.EncodeToMemory(block), anchor, nil
}

// existingDir: the agent directory of the installed service ("" when there is none).
func existingDir(unit string) string {
	raw, err := os.ReadFile(unit)
	if err != nil {
		return ""
	}
	for _, l := range strings.Split(string(raw), "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(l), "EnvironmentFile="); ok {
			return filepath.Dir(v)
		}
	}
	return ""
}

func runSelfInstall(ctx context.Context, args []string) {
	fs := flag.NewFlagSet("install", flag.ExitOnError)
	hub := fs.String("hub", "", "agent URL of the hub, e.g. https://hub:3443")
	stdin := fs.Bool("stdin", false, "read the code and the CA of the hub from stdin")
	_ = fs.Parse(args)
	if err := selfInstall(ctx, *hub, *stdin, os.Stdin); err != nil {
		log.Fatalf("install failed: %v", err)
	}
}

func selfInstall(ctx context.Context, hub string, stdin bool, in io.Reader) error {
	if !pveHubRe.MatchString(hub) || !stdin {
		return errors.New("usage: homelab-agent install -hub https://hub:3443 -stdin")
	}
	if os.Geteuid() != 0 {
		return errors.New("must be run as root")
	}
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		return errors.New("systemd is required: use the install command of the hub")
	}
	code, ca, anchor, err := readInstallInput(in)
	if err != nil {
		return err
	}
	dir := defaultDir
	fresh := true
	if old := existingDir(installUnit); old != "" {
		if old != dir {
			return fmt.Errorf("agent already installed in %s: use the install command of the hub", old)
		}
		fresh = false
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := writeFileAtomic(filepath.Join(dir, caFile), ca, 0o644); err != nil {
		return err
	}
	// the anchor of the installing node, before the service starts: no TOFU window (homelab#319)
	if wrote, err := installAnchor(dir, anchor); err != nil {
		return fmt.Errorf("access anchor: %w", err)
	} else if !wrote {
		fmt.Printf("access anchor kept: %s\n", filepath.Join(dir, accessAnchorFile))
	}
	// a new install gets the strict local policy; an existing one keeps its own (or none, see policy.go)
	if fresh {
		if wrote, err := writePolicyIfAbsent(dir); err != nil {
			return err
		} else if wrote {
			fmt.Printf("local policy written: %s\n", filepath.Join(dir, policyFile))
		}
	}
	// the running binary (pushed next to the final one) takes its place
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if self != installBin {
		if err := os.Rename(self, installBin); err != nil {
			return fmt.Errorf("installing the binary: %w", err)
		}
	}
	id, err := enroll(ctx, hub, code, dir)
	if err != nil {
		return err
	}
	env := fmt.Sprintf("HUB_URL=%s\nAGENT_DIR=%s\nAGENT_STATE_DIR=%s\n", hub, dir, installState)
	if err := writeFileAtomic(filepath.Join(dir, "agent.env"), []byte(env), 0o600); err != nil {
		return err
	}
	_ = os.Remove(legacyEnv)
	if err := os.MkdirAll(installState, 0o700); err != nil {
		return err
	}
	if err := writeFileAtomic(installUnit, []byte(fmt.Sprintf(unitContent, dir, installBin)), 0o644); err != nil {
		return err
	}
	for _, c := range [][]string{{"daemon-reload"}, {"enable", "homelab-agent"}, {"restart", "homelab-agent"}} {
		if out, err := exec.CommandContext(ctx, "systemctl", c...).CombinedOutput(); err != nil {
			return fmt.Errorf("systemctl %s: %v: %s", strings.Join(c, " "), err, strings.TrimSpace(string(out)))
		}
	}
	fmt.Printf("homelab-agent %s installed in %s as host %s, reporting to %s (TLS)\n", version, dir, id, hub)
	return nil
}
