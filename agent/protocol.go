package main

// Messages exchanged with the hub over the WebSocket (JSON text frames).

type Package struct {
	Name      string `json:"name"`
	Current   string `json:"current"`
	Candidate string `json:"candidate"`
	Repo      string `json:"repo"`
	Security  bool   `json:"security"`
}

type AptReport struct {
	CheckedAt      int64     `json:"checkedAt"`      // unix ms
	ListsUpdatedAt int64     `json:"listsUpdatedAt"` // unix ms, last successful apt update (0 = unknown)
	Upgradable     []Package `json:"upgradable"`
	Held           []string  `json:"held"`
	RebootRequired bool      `json:"rebootRequired"`
	RebootPkgs     []string  `json:"rebootPkgs"`
	// packages "apt-get autoremove" would remove (no longer needed dependencies, old kernels)
	Autoremovable []string `json:"autoremovable"`
}

type HostInfo struct {
	Hostname string   `json:"hostname"`
	OSID     string   `json:"osId"`
	OSName   string   `json:"osName"`
	Kernel   string   `json:"kernel"`
	Arch     string   `json:"arch"`
	Uptime   int64    `json:"uptime"` // seconds
	IPs      []string `json:"ips"`
	Virt     string   `json:"virt"` // lxc, kvm, none...
}

// agent -> hub
type Outbound struct {
	Type    string    `json:"type"` // hello | apt_report | job_log | job_done
	Version string    `json:"version,omitempty"`
	Info    *HostInfo `json:"info,omitempty"`
	// actions this agent can run, so that the hub only offers those
	Capabilities []string   `json:"capabilities,omitempty"`
	BinaryHash   string     `json:"binaryHash,omitempty"`
	Report       *AptReport `json:"report,omitempty"`
	JobID        string     `json:"jobId,omitempty"`
	Data         string     `json:"data,omitempty"`
	ExitCode     int        `json:"exitCode,omitempty"`
	Error        string     `json:"error,omitempty"`
}

// hub -> agent
type Inbound struct {
	Type     string   `json:"type"` // run
	JobID    string   `json:"jobId"`
	Action   string   `json:"action"` // apt_report | apt_update | apt_upgrade
	Packages []string `json:"packages,omitempty"`
	Sha256   string   `json:"sha256,omitempty"` // agent_update: expected hash of the new binary
}
