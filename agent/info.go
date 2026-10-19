package main

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
)

// Description of the host, sent in the hello (every platform).
type HostInfo struct {
	Hostname string   `json:"hostname"`
	OSID     string   `json:"osId"`
	OSName   string   `json:"osName"`
	Kernel   string   `json:"kernel"`
	Arch     string   `json:"arch"`
	Uptime   int64    `json:"uptime"` // seconds
	IPs      []string `json:"ips"`
	Virt     string   `json:"virt"` // lxc, kvm, none...
	MACs     []string `json:"macs"` // hardware addresses of the interfaces, link with a Proxmox VE guest
}

// selfHash is the sha256 of the running binary, reported to the hub so that it can
// tell whether this agent matches the binary it distributes.
func selfHash() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	f, err := os.Open(exe)
	if err != nil {
		return ""
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return ""
	}
	return hex.EncodeToString(h.Sum(nil))
}
