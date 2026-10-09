package main

import (
	"bufio"
	"net"
	"os"
	"os/exec"
	"runtime"
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

	info.Kernel = runningKernel()

	if b, err := os.ReadFile("/proc/uptime"); err == nil {
		if f, _, ok := strings.Cut(string(b), "."); ok {
			info.Uptime, _ = strconv.ParseInt(f, 10, 64)
		}
	}

	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok && !ipn.IP.IsLoopback() && ipn.IP.To4() != nil {
				info.IPs = append(info.IPs, ipn.IP.String())
			}
		}
	}

	if out, err := exec.Command("systemd-detect-virt").Output(); err == nil {
		info.Virt = strings.TrimSpace(string(out))
	} else {
		info.Virt = "none"
	}
	return info
}
