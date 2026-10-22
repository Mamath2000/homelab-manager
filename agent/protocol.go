//go:build !windows

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
	// container with the project label but outside the compose file (created by another
	// container, as Nextcloud AIO does): named after the container, logs only
	External bool `json:"external,omitempty"`
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
	// every registry digest of the local image (Digest is the first one, kept for older hubs)
	Digests []string `json:"digests"`
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
	Type    string    `json:"type"` // hello | apt_report | docker_report | docker_updates | job_log | job_done | rpc_result | backup_synced | backup_result | ha_backups | offsite_synced | offsite_report
	Version string    `json:"version,omitempty"`
	Info    *HostInfo `json:"info,omitempty"`
	// actions this agent can run, so that the hub only offers those
	Capabilities []string        `json:"capabilities,omitempty"`
	BinaryHash   string          `json:"binaryHash,omitempty"`
	Report       *AptReport      `json:"report,omitempty"`
	Docker       *DockerReport   `json:"docker,omitempty"`
	Updates      *DockerUpdates  `json:"updates,omitempty"`
	HaBackups    *HaBackupReport `json:"haBackups,omitempty"`
	Ups          *UpsReport      `json:"ups,omitempty"`
	HealthSystem *HealthSystem   `json:"healthSystem,omitempty"`
	HealthDisks  *HealthDisks    `json:"healthDisks,omitempty"`
	HealthSmart  *HealthSmart    `json:"healthSmart,omitempty"`
	Offsite      *OffsiteReport  `json:"offsite,omitempty"`
	ReqID        string          `json:"reqId,omitempty"`
	Result       any             `json:"result,omitempty"`
	JobID        string          `json:"jobId,omitempty"`
	Data         string          `json:"data,omitempty"`
	ExitCode     int             `json:"exitCode,omitempty"`
	Error        string          `json:"error,omitempty"`
}

// hub -> agent
type Inbound struct {
	Type     string   `json:"type"` // run | rpc | backup_sync | backup_result_ack | offsite_sync
	JobID    string   `json:"jobId"`
	Action   string   `json:"action"` // apt_update, apt_upgrade, docker_up...
	Packages []string `json:"packages,omitempty"`
	Sha256   string   `json:"sha256,omitempty"` // agent_update: expected hash of the new binary
	// docker actions: target stack and optional service
	Stack   string `json:"stack,omitempty"`
	Service string `json:"service,omitempty"`
	// rpc: request answered with rpc_result, outside the job queue
	ReqID string `json:"reqId,omitempty"`
	Op    string `json:"op,omitempty"` // docker_logs | docker_compose_file | docker_forget | setup_check | backup_database_check | backup_estimate | nextcloud_discover | ups_command | pbs_detect | pbs_token | pbs_token_delete | pbs_mount | pbs_umount | pbs_mount_status | pbs_mount_check | pve_detect | pve_token | pve_token_delete | refresh
	Tail  int    `json:"tail,omitempty"`
	// ups_command: NUT instant command (fixed list on the agent side)
	UpsCmd string `json:"upsCmd,omitempty"`
	// setup_apply / setup_check: modules of the standardisation and their parameters
	Setup *SetupSpec `json:"setup,omitempty"`
	// backup_sync: definition of the backups of this host; backup_run: the job to run
	Backup    *BackupSpec `json:"backup,omitempty"`
	BackupJob string      `json:"backupJob,omitempty"`
	// backup_database_check: the database job to check on the host (form of a backup job);
	// nextcloud_discover: its work directory only
	BackupKind string        `json:"backupKind,omitempty"`
	Database   *DatabaseDump `json:"database,omitempty"`
	// backup_estimate: the directories and exclusions of the job form
	EstArchives []BackupArchive `json:"estArchives,omitempty"`
	EstExcludes []string        `json:"estExcludes,omitempty"`
	// backup_install: apt | docker
	Method string `json:"method,omitempty"`
	// pbs_token: user, token and rights to create on the PBS of this host (pbs_token_delete: to revoke)
	Pbs *PbsTokenSpec `json:"pbs,omitempty"`
	// pbs_mount: the snapshot to mount here and the volatile token (pbs_mount_check: the PBS address only)
	PbsMount *PbsMountSpec `json:"pbsMount,omitempty"`
	// pve_token: user, token and rights to create on the Proxmox VE cluster of this node (pve_token_delete: to revoke)
	Pve *PveTokenSpec `json:"pve,omitempty"`
	// offsite_sync: the copy to this secondary PBS (offsite.go)
	Offsite *OffsiteSpec `json:"offsite,omitempty"`
	// refresh: info | apt | docker | ha_backups | ups; empty: all the agent can read
	Scopes       []string     `json:"scopes,omitempty"`
	HealthConfig HealthConfig `json:"healthConfig,omitempty"`
}
