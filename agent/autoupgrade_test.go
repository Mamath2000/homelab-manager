//go:build !windows

package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// records as written by apt on Debian 13 (postgres CT, homelab#233)
const historySample = `
Start-Date: 2026-10-02  06:29:51
Commandline: /usr/bin/unattended-upgrade
Upgrade: libpng16-16t64:amd64 (1.6.48-1+deb13u5, 1.6.48-1+deb13u6)
End-Date: 2026-10-02  06:29:52

Start-Date: 2026-10-05  10:00:00
Commandline: apt-get -y upgrade --with-new-pkgs
Upgrade: vim:amd64 (2:9.1-1, 2:9.1-2)
End-Date: 2026-10-05  10:00:10

Start-Date: 2026-10-08  06:15:11
Commandline: /usr/bin/unattended-upgrade
Install: linux-image-6.12.57+deb13-amd64:amd64 (6.12.57-1, automatic)
Upgrade: liblzma5:amd64 (5.8.1-1+deb13u1, 5.8.1-1+deb13u2), xz-utils:amd64 (5.8.1-1+deb13u1, 5.8.1-1+deb13u2)
End-Date: 2026-10-08  06:15:20
`

func TestParseAutoInstalled(t *testing.T) {
	since := time.Date(2026, 10, 1, 0, 0, 0, 0, time.Local)
	got := parseAutoInstalled(strings.NewReader(historySample), since)
	if len(got) != 4 {
		t.Fatalf("want 4 packages (manual upgrade left out), got %+v", got)
	}
	if got[0].Name != "libpng16-16t64" || got[0].From != "1.6.48-1+deb13u5" || got[0].To != "1.6.48-1+deb13u6" {
		t.Fatalf("upgrade: %+v", got[0])
	}
	if got[1].Name != "linux-image-6.12.57+deb13-amd64" || got[1].From != "" || got[1].To != "6.12.57-1" {
		t.Fatalf("install: %+v", got[1])
	}
	if want := time.Date(2026, 10, 8, 6, 15, 11, 0, time.Local).UnixMilli(); got[3].Name != "xz-utils" || got[3].At != want {
		t.Fatalf("date: %+v", got[3])
	}
	// older than since: left out
	if n := len(parseAutoInstalled(strings.NewReader(historySample), time.Date(2026, 10, 3, 0, 0, 0, 0, time.Local))); n != 3 {
		t.Fatalf("since: %d", n)
	}
}

func TestCollectAutoInstalledRotations(t *testing.T) {
	fsRoot = t.TempDir()
	defer func() { fsRoot = "" }()
	dir := filepath.Join(fsRoot, filepath.Dir(aptHistoryLog))
	_ = os.MkdirAll(dir, 0o755)
	recent := "Start-Date: 2026-11-10  06:00:00\nCommandline: /usr/bin/unattended-upgrade\nUpgrade: curl:amd64 (8.14.1-1, 8.14.1-2)\nEnd-Date: 2026-11-10  06:00:05\n"
	_ = os.WriteFile(filepath.Join(fsRoot, aptHistoryLog), []byte(recent), 0o644)
	var gz bytes.Buffer
	w := gzip.NewWriter(&gz)
	_, _ = w.Write([]byte(historySample))
	_ = w.Close()
	_ = os.WriteFile(filepath.Join(fsRoot, aptHistoryLog+".1.gz"), gz.Bytes(), 0o644)

	got := collectAutoInstalled(time.Date(2026, 11, 5, 12, 0, 0, 0, time.Local))
	// 30 days: the 2026-10-08 run and the recent one; newest first
	if len(got) != 4 || got[0].Name != "curl" || got[3].Name != "xz-utils" {
		t.Fatalf("%+v", got)
	}
}

func TestParseAptConfigValue(t *testing.T) {
	out := "APT::Periodic::Unattended-Upgrade \"1\";\n"
	if v := parseAptConfigValue(out, "APT::Periodic::Unattended-Upgrade"); v != "1" {
		t.Fatalf("got %q", v)
	}
	if v := parseAptConfigValue("", "APT::Periodic::Unattended-Upgrade"); v != "" {
		t.Fatalf("unset: %q", v)
	}
}

func TestAutoUpgradeConf(t *testing.T) {
	for _, want := range []string{"#clear Unattended-Upgrade::Origins-Pattern;", "label=Debian-Security", `Automatic-Reboot "false"`, `APT::Periodic::Unattended-Upgrade "1"`} {
		if !strings.Contains(autoUpgradeConf, want) {
			t.Fatalf("missing %q", want)
		}
	}
	// stable point releases are not security updates
	if strings.Contains(autoUpgradeConf, "label=Debian\"") || strings.Contains(autoUpgradeConf, "-updates") {
		t.Fatal("non-security origin")
	}
}

func TestApplyAutoUpgradeDisable(t *testing.T) {
	fsRoot = t.TempDir()
	defer func() { fsRoot = "" }()
	if err := writeOwned(autoUpgradeFile, autoUpgradeConf, 0o644, nil); err != nil {
		t.Fatal(err)
	}
	if code, err := applyAutoUpgrade(context.Background(), false, func(string) {}); code != 0 || err != nil {
		t.Fatal(code, err)
	}
	if _, ok := readFile(autoUpgradeFile); ok {
		t.Fatal("managed file left in place")
	}
	// already absent: nothing to do
	if code, err := applyAutoUpgrade(context.Background(), false, func(string) {}); code != 0 || err != nil {
		t.Fatal(code, err)
	}
}
