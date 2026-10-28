//go:build windows

package main

import (
	"fmt"
	"net"
	"os"
	"runtime"
	"sort"
	"strings"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var procGetTickCount64 = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetTickCount64")

func collectInfo() *HostInfo {
	host, _ := os.Hostname()
	name, kernel := windowsVersion()
	ticks, _, _ := procGetTickCount64.Call() // ms since boot
	return &HostInfo{
		Hostname: host,
		OSID:     "windows",
		OSName:   name,
		Kernel:   kernel,
		Arch:     runtime.GOARCH,
		Uptime:   int64(ticks / 1000),
		IPs:      interfaceIPs(),
		Virt:     "",
		MACs:     interfaceMACs(),
	}
}

// windowsVersion: "Windows 11 Pro 24H2" and "10.0.26100.4061". ProductName still says
// "Windows 10" on Windows 11: the build number tells them apart.
func windowsVersion() (name, kernel string) {
	v := windows.RtlGetVersion()
	kernel = fmt.Sprintf("%d.%d.%d", v.MajorVersion, v.MinorVersion, v.BuildNumber)
	name = "Windows"
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows NT\CurrentVersion`, registry.QUERY_VALUE)
	if err != nil {
		return name, kernel
	}
	defer k.Close()
	if p, _, err := k.GetStringValue("ProductName"); err == nil && p != "" {
		name = p
	}
	if v.MajorVersion == 10 && v.BuildNumber >= 22000 {
		name = strings.Replace(name, "Windows 10", "Windows 11", 1)
	}
	if d, _, err := k.GetStringValue("DisplayVersion"); err == nil && d != "" {
		name += " " + d
	}
	if ubr, _, err := k.GetIntegerValue("UBR"); err == nil {
		kernel += fmt.Sprintf(".%d", ubr)
	}
	return name, kernel
}

// Adapters of hypervisors and VPNs: their addresses say nothing about the host on the LAN,
// and their MACs must not link it to a Proxmox VE guest.
func virtualAdapter(name string) bool {
	n := strings.ToLower(name)
	for _, p := range []string{"vethernet", "vmware", "virtualbox", "loopback", "bluetooth"} {
		if strings.Contains(n, p) {
			return true
		}
	}
	return false
}

func upAdapters() []net.Interface {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	out := []net.Interface{}
	for _, i := range ifaces {
		if i.Flags&net.FlagLoopback != 0 || i.Flags&net.FlagUp == 0 || virtualAdapter(i.Name) {
			continue
		}
		out = append(out, i)
	}
	return out
}

func interfaceIPs() []string {
	out := []string{}
	for _, i := range upAdapters() {
		addrs, err := i.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok && ipn.IP.To4() != nil && !ipn.IP.IsLinkLocalUnicast() {
				out = append(out, ipn.IP.String())
			}
		}
	}
	return out
}

// Sorted, so that the hello only changes when they do.
func interfaceMACs() []string {
	seen := map[string]bool{}
	out := []string{}
	for _, i := range upAdapters() {
		if len(i.HardwareAddr) != 6 {
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
