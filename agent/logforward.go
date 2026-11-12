//go:build !windows

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

// Option log_forward of the standardisation (setup.go): the journals of the host are sent in syslog to a log server, a
// role of the hub (hub/src/logs.ts). The agent never carries a log: it installs rsyslog, writes its drop-in and checks
// both. The hub sends an address, a port and a protocol, never a path or a command.

// LogForwardSpec: where the journals go. Address "": no forwarding, the drop-in is removed.
type LogForwardSpec struct {
	Address  string `json:"address"`
	Port     int    `json:"port,omitempty"`
	Protocol string `json:"protocol,omitempty"` // tcp
}

const (
	rsyslogDropIn  = "/etc/rsyslog.d/90-homelab.conf"
	rsyslogPackage = "rsyslog"
)

// a name or an IP address (v4, v6), nothing that ends the quoted value of the drop-in
var logAddressRe = regexp.MustCompile(`^[A-Za-z0-9.:_-]{1,253}$`)

func validateLogForward(l *LogForwardSpec) error {
	if l == nil {
		return fmt.Errorf("log_forward without its server")
	}
	if l.Address == "" {
		return nil
	}
	if !logAddressRe.MatchString(l.Address) || l.Port < 1 || l.Port > 65535 || l.Protocol != "tcp" {
		return fmt.Errorf("invalid log server")
	}
	return nil
}

// renderLogForward: the drop-in of rsyslog. RFC 5424 (the host name, the application and the severity are fields of
// their own on the server); a queue on disk keeps the journals while the server is away, and sends them when it is back.
func renderLogForward(l *LogForwardSpec) string {
	if l == nil || l.Address == "" {
		return ""
	}
	return managedHead +
		`action(type="omfwd" target="` + l.Address + `" port="` + strconv.Itoa(l.Port) + `" protocol="` + l.Protocol + `"` + "\n" +
		`       template="RSYSLOG_SyslogProtocol23Format"` + "\n" +
		`       queue.type="LinkedList" queue.filename="homelab_fwd" queue.maxDiskSpace="100m"` + "\n" +
		`       queue.saveOnShutdown="on" action.resumeRetryCount="-1")` + "\n"
}

func rsyslogdBinary() string {
	if p, err := exec.LookPath("rsyslogd"); err == nil {
		return p
	}
	if _, err := os.Stat("/usr/sbin/rsyslogd"); err == nil {
		return "/usr/sbin/rsyslogd"
	}
	return ""
}

func rsyslogActive(ctx context.Context) bool {
	return exec.CommandContext(ctx, "systemctl", "is-active", "--quiet", "rsyslog.service").Run() == nil
}

func restartRsyslog(ctx context.Context, emit func(string)) error {
	emit("restarting rsyslog\n")
	_ = exec.CommandContext(ctx, "systemctl", "enable", "rsyslog.service").Run()
	if out, err := exec.CommandContext(ctx, "systemctl", "restart", "rsyslog.service").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl restart rsyslog: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

func applyLogForward(ctx context.Context, s *SetupSpec, emit func(string)) error {
	want := renderLogForward(s.LogForward)
	prev, had := readFile(rsyslogDropIn)
	if want == "" {
		if !had {
			emit("journals not forwarded\n")
			return nil
		}
		if err := syncFile(rsyslogDropIn, "", 0o644, nil, emit); err != nil {
			return err
		}
		if rsyslogActive(ctx) {
			return restartRsyslog(ctx, emit)
		}
		return nil
	}
	if err := aptInstall(ctx, []string{rsyslogPackage}, emit); err != nil {
		return err
	}
	bin := rsyslogdBinary()
	if bin == "" {
		return fmt.Errorf("rsyslogd not found after the installation of %s", rsyslogPackage)
	}
	if had && prev == want && rsyslogActive(ctx) {
		emit(rsyslogDropIn + " already up to date\n")
		return nil
	}
	if err := syncFile(rsyslogDropIn, want, 0o644, nil, emit); err != nil {
		return err
	}
	if out, err := exec.CommandContext(ctx, bin, "-N1").CombinedOutput(); err != nil {
		// put the previous configuration back: never leave rsyslog unable to start
		if had {
			_ = writeOwned(rsyslogDropIn, prev, 0o644, nil)
		} else {
			_ = os.Remove(sysPath(rsyslogDropIn))
		}
		return fmt.Errorf("rsyslogd -N1: %s", lastLines(string(out), 3))
	}
	return restartRsyslog(ctx, emit)
}

// lastLines: the last n non-empty lines of a command output, on one line.
func lastLines(out string, n int) string {
	var kept []string
	for _, l := range strings.Split(out, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			kept = append(kept, l)
		}
	}
	if len(kept) > n {
		kept = kept[len(kept)-n:]
	}
	return strings.Join(kept, " | ")
}

func checkLogForward(ctx context.Context, s *SetupSpec) (string, string) {
	want := renderLogForward(s.LogForward)
	if want == "" {
		return checkFile(rsyslogDropIn, "")
	}
	if len(missingPackages(ctx, []string{rsyslogPackage})) > 0 {
		return "drift", rsyslogPackage + " not installed"
	}
	if state, detail := checkFile(rsyslogDropIn, want); state != "ok" {
		return state, detail
	}
	if !rsyslogActive(ctx) {
		return "drift", "rsyslog not running"
	}
	return "ok", ""
}
