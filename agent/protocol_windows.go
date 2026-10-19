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
}

type SessionReport struct {
	CheckedAt int64     `json:"checkedAt"` // unix ms
	Sessions  []Session `json:"sessions"`
}

// agent -> hub
type Outbound struct {
	Type         string         `json:"type"` // hello | session_report | rpc_result | job_log | job_done
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
	Type   string   `json:"type"` // run | rpc (anything else is ignored)
	JobID  string   `json:"jobId"`
	Action string   `json:"action"`
	ReqID  string   `json:"reqId,omitempty"`
	Op     string   `json:"op,omitempty"`
	Scopes []string `json:"scopes,omitempty"`
	Sha256 string   `json:"sha256,omitempty"` // agent_update: expected hash of the new binary
}
