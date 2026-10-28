//go:build !windows

package main

import (
	"bufio"
	"context"
	"net"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

func collectInfo() *HostInfo {
	h, _ := os.Hostname()
	info := &HostInfo{Hostname: h, Arch: runtime.GOARCH}

	if f, err := os.Open("/etc/os-release"); err == nil {
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			k, v, ok := strings.Cut(sc.Text(), "=")
			if !ok {
				continue
			}
			v = strings.Trim(v, `"`)
			switch k {
			case "ID":
				info.OSID = v
			case "PRETTY_NAME":
				info.OSName = v
			}
		}
		f.Close()
	}

	// Unraid (Slackware based) describes itself in /etc/unraid-version: version="6.12.13"
	if b, err := os.ReadFile("/etc/unraid-version"); err == nil {
		v := strings.Trim(strings.TrimPrefix(strings.TrimSpace(string(b)), "version="), `"`)
		info.OSID, info.OSName = "unraid", strings.TrimSpace("Unraid "+v)
	}

	info.Kernel = runningKernel()
	if isWSL(info.Kernel) {
		info.OSName = strings.TrimSpace(info.OSName + " (WSL)")
	}

	if b, err := os.ReadFile("/proc/uptime"); err == nil {
		if f, _, ok := strings.Cut(string(b), "."); ok {
			info.Uptime, _ = strconv.ParseInt(f, 10, 64)
		}
	}

	info.IPs = interfaceIPs()
	info.MACs = interfaceMACs()

	if out, err := exec.Command("systemd-detect-virt").Output(); err == nil {
		info.Virt = strings.TrimSpace(string(out))
	} else {
		info.Virt = "none"
	}
	if onHAOS {
		haosInfo(context.Background(), info)
	}
	return info
}

// IPv4 addresses of the host. On HAOS, those of the Supervisor and Docker bridges
// (172.30.32.1...) are left out: they are not reachable from the network.
func interfaceIPs() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	out := []string{}
	for _, i := range ifaces {
		if onHAOS && virtualInterface(i.Name) {
			continue
		}
		addrs, err := i.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok && !ipn.IP.IsLoopback() && ipn.IP.To4() != nil {
				out = append(out, ipn.IP.String())
			}
		}
	}
	return out
}

// Hardware addresses of the interfaces that are up (not loopback, not Docker or Supervisor
// bridges and veth): the hub finds the Proxmox VE guest this host is by them. Sorted, so that
// the hello only changes when they do.
func interfaceMACs() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	out := []string{}
	for _, i := range ifaces {
		if i.Flags&net.FlagLoopback != 0 || i.Flags&net.FlagUp == 0 || len(i.HardwareAddr) != 6 || virtualInterface(i.Name) {
			continue
		}
		m := i.HardwareAddr.String()
		if !seen[m] {
			seen[m] = true
			out = append(out, m)
		}
	}
	sort.Strings(out)
	return out
}
