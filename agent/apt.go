package main

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"time"
)

var pkgNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9+.\-:]*$`)

// "libc6/stable-security,stable 2.36-9+deb12u8 amd64 [upgradable from: 2.36-9+deb12u7]"
var upgradableRe = regexp.MustCompile(`^([^/\s]+)/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from: ([^\]]+)\]`)

func aptEnv() []string {
	return append(os.Environ(),
		"LC_ALL=C", "LANG=C",
		"DEBIAN_FRONTEND=noninteractive",
		"NEEDRESTART_MODE=l", // list services to restart, never restart them behind the user's back
	)
}

func parseUpgradable(out string) []Package {
	var pkgs []Package
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		m := upgradableRe.FindStringSubmatch(sc.Text())
		if m == nil {
			continue
		}
		pkgs = append(pkgs, Package{
			Name:      m[1],
			Repo:      m[2],
			Candidate: m[3],
			Current:   m[4],
			Security:  strings.Contains(strings.ToLower(m[2]), "security"),
		})
	}
	sort.Slice(pkgs, func(i, j int) bool {
		if pkgs[i].Security != pkgs[j].Security {
			return pkgs[i].Security
		}
		return pkgs[i].Name < pkgs[j].Name
	})
	return pkgs
}

func listsUpdatedAt() int64 {
	for _, p := range []string{"/var/lib/apt/periodic/update-success-stamp"} {
		if st, err := os.Stat(p); err == nil {
			return st.ModTime().UnixMilli()
		}
	}
	// fall back on the newest file in the lists directory
	var newest time.Time
	entries, _ := os.ReadDir("/var/lib/apt/lists")
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if info, err := e.Info(); err == nil && info.ModTime().After(newest) {
			newest = info.ModTime()
		}
	}
	if newest.IsZero() {
		return 0
	}
	return newest.UnixMilli()
}

func collectAptReport(ctx context.Context) (*AptReport, error) {
	cmd := exec.CommandContext(ctx, "apt", "list", "--upgradable")
	cmd.Env = aptEnv()
	var out bytes.Buffer
	cmd.Stdout = &out // stderr (CLI stability warning) ignored on purpose
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	r := &AptReport{
		CheckedAt:      time.Now().UnixMilli(),
		ListsUpdatedAt: listsUpdatedAt(),
		Upgradable:     parseUpgradable(out.String()),
		Held:           []string{},
		RebootPkgs:     []string{},
		Autoremovable:  []string{},
	}
	if r.Upgradable == nil {
		r.Upgradable = []Package{}
	}
	hc := exec.CommandContext(ctx, "apt-mark", "showhold")
	hc.Env = aptEnv()
	if b, err := hc.Output(); err == nil {
		for _, l := range strings.Fields(string(b)) {
			r.Held = append(r.Held, l)
		}
	}
	// simulation only: nothing is removed, and it works without the dpkg lock
	ac := exec.CommandContext(ctx, "apt-get", "-s", "autoremove")
	ac.Env = aptEnv()
	if b, err := ac.Output(); err == nil {
		r.Autoremovable = parseAutoremove(string(b))
	}
	if _, err := os.Stat("/var/run/reboot-required"); err == nil {
		r.RebootRequired = true
		if b, err := os.ReadFile("/var/run/reboot-required.pkgs"); err == nil {
			r.RebootPkgs = strings.Fields(string(b))
		}
	} else if k := newerKernel(runningKernel(), installedKernels()); k != "" {
		// Debian / Raspberry Pi OS do not create /var/run/reboot-required for a new kernel
		r.RebootRequired = true
		r.RebootPkgs = []string{"linux-image-" + k}
	}
	return r, nil
}

// "Remv linux-image-6.18.33+rpt-rpi-v8 [1:6.18.33-1+rpt1]" lines of `apt-get -s autoremove`
var removeRe = regexp.MustCompile(`^Remv (\S+)`)

func parseAutoremove(out string) []string {
	pkgs := []string{}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		if m := removeRe.FindStringSubmatch(sc.Text()); m != nil {
			pkgs = append(pkgs, m[1])
		}
	}
	sort.Strings(pkgs)
	return pkgs
}

// runStreaming runs a command, forwarding each output line to emit.
func runStreaming(ctx context.Context, emit func(string), name string, args ...string) (int, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = aptEnv()
	pr, pw := io.Pipe()
	cmd.Stdout = pw
	cmd.Stderr = pw
	done := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			// apt redraws progress with carriage returns: keep only the final state of the line
			line := strings.TrimRight(sc.Text(), "\r")
			if i := strings.LastIndexByte(line, '\r'); i >= 0 {
				line = line[i+1:]
			}
			emit(line + "\n")
		}
	}()
	err := cmd.Start()
	if err != nil {
		pw.Close()
		<-done
		return -1, err
	}
	err = cmd.Wait()
	pw.Close()
	<-done
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode(), nil
		}
		return -1, err
	}
	return 0, nil
}

func validPackages(names []string) bool {
	for _, n := range names {
		if !pkgNameRe.MatchString(n) {
			return false
		}
	}
	return true
}
