//go:build !windows

package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// What the agent tells about a Mosquitto broker it found listening (roles.go): its version and whether the
// dynamic-security plugin is loaded in the running process. The hub offers the management of the accounts only then.

// dynsecLib: the plugin as the process maps it (mosquitto_dynamic_security.so).
const dynsecLib = "mosquitto_dynamic_security"

var mosquittoVersionRe = regexp.MustCompile(`(?i)mosquitto version (\d+\.\d+(?:\.\d+)?)`)

// parseMosquittoVersion reads the first line of `mosquitto -h` ("mosquitto version 2.1.2"); "" when it is not one.
func parseMosquittoVersion(out string) string {
	if m := mosquittoVersionRe.FindStringSubmatch(out); m != nil {
		return m[1]
	}
	return ""
}

// mapsHaveDynsec: a /proc/<pid>/maps that shows the plugin, that is loaded and not only configured.
func mapsHaveDynsec(r io.Reader) bool {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		if strings.Contains(sc.Text(), dynsecLib) {
			return true
		}
	}
	return false
}

// describeMosquitto fills the version and the plugin state of a candidate. Reading the process needs root (the agent
// is); whatever cannot be read stays empty: the hub then tells "unknown" and offers nothing.
func describeMosquitto(ctx context.Context, c *RoleCandidate) {
	if c.pid <= 0 {
		return
	}
	if f, err := os.Open(fmt.Sprintf("/proc/%d/maps", c.pid)); err == nil {
		c.Dynsec = mapsHaveDynsec(f)
		f.Close()
	}
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	// the executable of the running process, so that the version is the one that runs, not the one a PATH finds
	if out, err := exec.CommandContext(cctx, fmt.Sprintf("/proc/%d/exe", c.pid), "-h").CombinedOutput(); err == nil || len(out) > 0 {
		c.Version = parseMosquittoVersion(string(out))
	}
}
