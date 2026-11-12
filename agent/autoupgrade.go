//go:build !windows

package main

import (
	"bufio"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Security updates installed by the host itself (unattended-upgrades), chosen host by host in its options
// (homelab#233). Enabled: the package and a managed apt.conf.d file restricted to the security origins;
// disabled: the file is removed and the host is back to its own configuration.

const (
	autoUpgradePkg  = "unattended-upgrades"
	autoUpgradeFile = "/etc/apt/apt.conf.d/52homelab-unattended-upgrades"
	aptHistoryLog   = "/var/log/apt/history.log"
	// installs reported to the hub: the last 30 days, at most 50
	autoInstalledDays = 30
	autoInstalledMax  = 50
)

// After 20auto-upgrades and 50unattended-upgrades: its values win, and the origin lists of the distribution
// (stable point releases on Debian) are cleared first.
const autoUpgradeConf = "// Géré par Homelab Manager (options de l'hôte) : les modifications locales seront écrasées.\n" +
	`#clear Unattended-Upgrade::Origins-Pattern;
#clear Unattended-Upgrade::Allowed-Origins;
Unattended-Upgrade::Origins-Pattern {
	"origin=Debian,codename=${distro_codename}-security,label=Debian-Security";
	"origin=Debian,codename=${distro_codename},label=Debian-Security";
	"origin=Ubuntu,archive=${distro_codename}-security";
	"origin=UbuntuESMApps,archive=${distro_codename}-apps-security";
	"origin=UbuntuESM,archive=${distro_codename}-infra-security";
};
Unattended-Upgrade::Automatic-Reboot "false";
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
`

// The package enables the updates by itself when installed (debconf default: 20auto-upgrades with all the
// stable origins): answered "no" so that the managed file stays the only switch.
const autoUpgradeDebconf = "unattended-upgrades unattended-upgrades/enable_auto_updates boolean false\n"

func applyAutoUpgrade(ctx context.Context, enabled bool, emit func(string)) (int, error) {
	if !enabled {
		if err := syncFile(autoUpgradeFile, "", 0o644, nil, emit); err != nil {
			return -1, err
		}
		emit("automatic security updates disabled\n")
		return 0, nil
	}
	if !installedPackages(ctx, []string{autoUpgradePkg})[autoUpgradePkg] {
		if code, err := runStreamingIn(ctx, aptEnv(), strings.NewReader(autoUpgradeDebconf), emit, "debconf-set-selections"); err != nil || code != 0 {
			return code, fmt.Errorf("debconf-set-selections failed (%d) %v", code, err)
		}
		if err := aptInstall(ctx, []string{autoUpgradePkg}, emit); err != nil {
			return -1, err
		}
	}
	if err := syncFile(autoUpgradeFile, autoUpgradeConf, 0o644, nil, emit); err != nil {
		return -1, err
	}
	if v := aptConfigValue(ctx, "APT::Periodic::Unattended-Upgrade"); v != "1" {
		return -1, fmt.Errorf("APT::Periodic::Unattended-Upgrade is %q after writing %s: another file overrides it", v, autoUpgradeFile)
	}
	emit("automatic security updates enabled (security origins only, no automatic reboot)\n")
	return 0, nil
}

// aptConfigValue: value of a scalar of the apt configuration ("" when unset or unreadable).
func aptConfigValue(ctx context.Context, key string) string {
	cmd := exec.CommandContext(ctx, "apt-config", "dump", key)
	cmd.Env = aptEnv()
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return parseAptConfigValue(string(out), key)
}

// `apt-config dump KEY` lists KEY and the keys under it: `APT::Periodic::Unattended-Upgrade "1";`
func parseAptConfigValue(out, key string) string {
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		rest, ok := strings.CutPrefix(sc.Text(), key+" ")
		if ok {
			return strings.Trim(strings.TrimSpace(rest), `";`)
		}
	}
	return ""
}

func collectAutoUpgrade(ctx context.Context) *AptAuto {
	a := &AptAuto{Package: installedPackages(ctx, []string{autoUpgradePkg})[autoUpgradePkg]}
	if _, ok := readFile(autoUpgradeFile); ok {
		a.Managed = true
	}
	if a.Package {
		// "1", or a number of days / "always" (apt.systemd.daily): anything but 0 runs it
		v := aptConfigValue(ctx, "APT::Periodic::Unattended-Upgrade")
		a.Enabled = v != "" && v != "0"
	}
	return a
}

// "pkg:amd64 (from, to)" of an Upgrade line, "pkg:amd64 (version, automatic)" of an Install line
var historyPkgRe = regexp.MustCompile(`([a-z0-9][a-z0-9+.\-]*)(?::[a-z0-9]+)? \(([^)]*)\)`)

// parseAutoInstalled reads the apt history (records separated by blank lines) and keeps the packages
// upgraded or installed by unattended-upgrade since `since`.
func parseAutoInstalled(r io.Reader, since time.Time) []AutoInstalled {
	var out []AutoInstalled
	var at time.Time
	auto := false
	var lines []string
	flush := func() {
		if auto && !at.Before(since) {
			for _, l := range lines {
				kind, list, _ := strings.Cut(l, ": ")
				for _, m := range historyPkgRe.FindAllStringSubmatch(list, -1) {
					vers := strings.Split(m[2], ", ")
					p := AutoInstalled{Name: m[1], At: at.UnixMilli()}
					if kind == "Upgrade" && len(vers) >= 2 {
						p.From, p.To = vers[0], vers[1]
					} else {
						p.To = vers[0]
					}
					out = append(out, p)
				}
			}
		}
		at, auto, lines = time.Time{}, false, nil
	}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 4<<20) // an upgrade of many packages is one long line
	for sc.Scan() {
		l := strings.TrimSpace(sc.Text())
		switch {
		case l == "":
			flush()
		case strings.HasPrefix(l, "Start-Date: "):
			at, _ = time.ParseInLocation("2006-01-02  15:04:05", strings.TrimPrefix(l, "Start-Date: "), time.Local)
		case strings.HasPrefix(l, "Commandline: "):
			auto = strings.Contains(l, "unattended-upgrade")
		case strings.HasPrefix(l, "Upgrade: "), strings.HasPrefix(l, "Install: "):
			lines = append(lines, l)
		}
	}
	flush()
	return out
}

// collectAutoInstalled: newest first, from history.log and its last rotations (monthly, gzip).
func collectAutoInstalled(now time.Time) []AutoInstalled {
	since := now.AddDate(0, 0, -autoInstalledDays)
	out := []AutoInstalled{}
	for _, p := range []string{aptHistoryLog, aptHistoryLog + ".1", aptHistoryLog + ".1.gz", aptHistoryLog + ".2.gz"} {
		f, err := os.Open(sysPath(p))
		if err != nil {
			continue
		}
		var r io.Reader = f
		if strings.HasSuffix(p, ".gz") {
			if gz, err := gzip.NewReader(f); err == nil {
				r = gz
			} else {
				f.Close()
				continue
			}
		}
		out = append(out, parseAutoInstalled(r, since)...)
		f.Close()
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At > out[j].At })
	if len(out) > autoInstalledMax {
		out = out[:autoInstalledMax]
	}
	return out
}
