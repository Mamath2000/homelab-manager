//go:build windows

package main

// Messages of the Windows agent: the subset of protocol.go it uses, plus the sessions.

// A user session open on the host (console, fast user switching, remote desktop).
type Session struct {
	ID      uint32 `json:"id"`
	User    string `json:"user"`
	Domain  string `json:"domain,omitempty"`
	Station string `json:"station,omitempty"` // Console, RDP-Tcp#0...
	State   string `json:"state"`             // active | locked | disconnected
	LogonAt int64  `json:"logonAt,omitempty"` // unix ms
	// unix ms of the last change of State (logon, lock, unlock, disconnection); first sight of the session when
	// the agent started after it (the date is kept in memory only)
	StateAt int64 `json:"stateAt,omitempty"`
	// keyboard/mouse input within idleThreshold in an active (unlocked) session
	Interactive bool `json:"interactive"`
	// seconds since the last input; nil when unknown. Not part of the change detection (it moves all the time).
	IdleSec *int64 `json:"idleSec,omitempty"`
}

type SessionReport struct {
	CheckedAt int64     `json:"checkedAt"` // unix ms
	Sessions  []Session `json:"sessions"`
}

// agent -> hub
type Outbound struct {
	Type         string         `json:"type"` // hello | session_report | rpc_result | job_log | job_done | backup_synced | backup_result
	Version      string         `json:"version,omitempty"`
	Info         *HostInfo      `json:"info,omitempty"`
	Capabilities []string       `json:"capabilities,omitempty"`
	BinaryHash   string         `json:"binaryHash,omitempty"`
	Sessions     *SessionReport `json:"sessions,omitempty"`
	ReqID        string         `json:"reqId,omitempty"`
	Result       any            `json:"result,omitempty"`
	JobID        string         `json:"jobId,omitempty"`
	Data         string         `json:"data,omitempty"`
	ExitCode     int            `json:"exitCode,omitempty"`
	Error        string         `json:"error,omitempty"`
}

// hub -> agent
type Inbound struct {
	Type   string   `json:"type"` // run | rpc | backup_sync | backup_result_ack (anything else is ignored)
	JobID  string   `json:"jobId"`
	Action string   `json:"action"`
	ReqID  string   `json:"reqId,omitempty"`
	Op     string   `json:"op,omitempty"`
	Scopes []string `json:"scopes,omitempty"`
	Sha256 string   `json:"sha256,omitempty"` // agent_update: expected hash of the new binary
	// backup_sync: the whole definition of the backups of this host (backup.go)
	Backup *BackupSpec `json:"backup,omitempty"`
	// backup_run: the backup job to run now
	BackupJob string `json:"backupJob,omitempty"`
}
