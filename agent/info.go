package main

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
