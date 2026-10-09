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

// Docker compose stacks, discovered from the labels compose puts on its containers.
type DockerContainer struct {
	ID      string `json:"id"` // short id
	Name    string `json:"name"`
	State   string `json:"state"`  // running, exited, restarting, paused, created, dead
	Status  string `json:"status"` // "Up 3 hours (healthy)"
	Health  string `json:"health,omitempty"`
	ImageID string `json:"imageId"`
}

type DockerService struct {
	Name       string            `json:"name"`
	Image      string            `json:"image"` // reference as written in the compose file
	Containers []DockerContainer `json:"containers"`
}

type DockerStack struct {
	Name        string          `json:"name"`
	WorkingDir  string          `json:"workingDir"`
	ConfigFiles []string        `json:"configFiles"`
	EnvFiles    []string        `json:"envFiles"`
	Status      string          `json:"status"` // running | partial | stopped | down
	Services    []DockerService `json:"services"`
}

// Local state of an image reference used by a stack.
type DockerImage struct {
	Ref string `json:"ref"`
	ID  string `json:"id"` // image the tag currently points to ("" if absent)
	// digest of the registry manifest the local image was pulled from ("" for local builds)
	Digest string `json:"digest"`
}

type DockerReport struct {
	CheckedAt int64         `json:"checkedAt"` // unix ms
	Engine    string        `json:"engine"`
	Compose   string        `json:"compose"`
	Stacks    []DockerStack `json:"stacks"`
	Images    []DockerImage `json:"images"`
}

// Result of a registry check: digest the tag points to on the registry.
type ImageCheck struct {
	Ref    string `json:"ref"`
	Digest string `json:"digest,omitempty"`
	Error  string `json:"error,omitempty"`
}

type DockerUpdates struct {
	CheckedAt int64        `json:"checkedAt"`
	Images    []ImageCheck `json:"images"`
}

// agent -> hub
type Outbound struct {
	Type    string    `json:"type"` // hello | apt_report | docker_report | docker_updates | job_log | job_done | rpc_result
	Version string    `json:"version,omitempty"`
	Info    *HostInfo `json:"info,omitempty"`
	// actions this agent can run, so that the hub only offers those
	Capabilities []string       `json:"capabilities,omitempty"`
	BinaryHash   string         `json:"binaryHash,omitempty"`
	Report       *AptReport     `json:"report,omitempty"`
	Docker       *DockerReport  `json:"docker,omitempty"`
	Updates      *DockerUpdates `json:"updates,omitempty"`
	ReqID        string         `json:"reqId,omitempty"`
	Result       any            `json:"result,omitempty"`
	JobID        string         `json:"jobId,omitempty"`
	Data         string         `json:"data,omitempty"`
	ExitCode     int            `json:"exitCode,omitempty"`
	Error        string         `json:"error,omitempty"`
}

// hub -> agent
type Inbound struct {
	Type     string   `json:"type"` // run | rpc
	JobID    string   `json:"jobId"`
	Action   string   `json:"action"` // apt_update, apt_upgrade, docker_up...
	Packages []string `json:"packages,omitempty"`
	Sha256   string   `json:"sha256,omitempty"` // agent_update: expected hash of the new binary
	// docker actions: target stack and optional service
	Stack   string `json:"stack,omitempty"`
	Service string `json:"service,omitempty"`
	// rpc: request answered with rpc_result, outside the job queue
	ReqID string `json:"reqId,omitempty"`
	Op    string `json:"op,omitempty"` // docker_logs | docker_compose_file | docker_forget
	Tail  int    `json:"tail,omitempty"`
}
