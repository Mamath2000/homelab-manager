//go:build !windows

package main

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// Home Assistant backups (HAOS add-on): read only, through the WebSocket API of Core proxied
// by the Supervisor (homeassistant_api: true). Only Core knows the backup agents of the
// integrations (SFTP, cloud...), the Supervisor /backups only sees the local ones.

// One backup present on a destination.
type HaBackup struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Date      int64  `json:"date"` // unix ms
	Size      int64  `json:"size"`
	Automatic bool   `json:"automatic"`
}

// One destination (backup agent of Core: backup.local, sftp...).
type HaBackupAgent struct {
	AgentID string     `json:"agentId"`
	Name    string     `json:"name"`
	Backups []HaBackup `json:"backups"`
	// date of the last automatic backup that failed to reach this destination (unix ms, 0 = none)
	FailedAt int64 `json:"failedAt,omitempty"`
	// destination that could not be listed (unreachable, integration not loaded)
	Error string `json:"error,omitempty"`
}

type HaBackupReport struct {
	CheckedAt int64 `json:"checkedAt"`
	// automatic backups: configured, schedule, destinations
	Configured   bool     `json:"configured"`
	Recurrence   string   `json:"recurrence"` // never | daily | custom_days
	Days         []string `json:"days"`       // mon, tue... (custom_days)
	Time         string   `json:"time"`       // HH:MM, "" = chosen by Home Assistant
	TimeZone     string   `json:"timeZone"`   // of Home Assistant: the schedule is a wall-clock time of it
	AutoAgentIDs []string `json:"autoAgentIds"`
	// unix ms, 0 = unknown
	LastAttempted int64           `json:"lastAttempted"`
	LastCompleted int64           `json:"lastCompleted"`
	Next          int64           `json:"next"`
	State         string          `json:"state"` // idle, create_backup...
	Agents        []HaBackupAgent `json:"agents"`
}

// Core answers of the three commands (only the fields used).
type haAgentsInfo struct {
	Agents []struct {
		AgentID string `json:"agent_id"`
		Name    string `json:"name"`
	} `json:"agents"`
}

type haBackupInfo struct {
	Backups []struct {
		BackupID string `json:"backup_id"`
		Name     string `json:"name"`
		Date     string `json:"date"`
		Agents   map[string]struct {
			Size int64 `json:"size"`
		} `json:"agents"`
		WithAutomaticSettings *bool    `json:"with_automatic_settings"`
		FailedAgentIDs        []string `json:"failed_agent_ids"`
	} `json:"backups"`
	AgentErrors                  map[string]string `json:"agent_errors"`
	LastAttemptedAutomaticBackup string            `json:"last_attempted_automatic_backup"`
	LastCompletedAutomaticBackup string            `json:"last_completed_automatic_backup"`
	NextAutomaticBackup          string            `json:"next_automatic_backup"`
	State                        string            `json:"state"`
}

// the config also holds the backup password: only the fields below are decoded, never sent
type haBackupConfig struct {
	Config struct {
		AutomaticBackupsConfigured bool `json:"automatic_backups_configured"`
		CreateBackup               struct {
			AgentIDs []string `json:"agent_ids"`
		} `json:"create_backup"`
		Schedule struct {
			Recurrence string   `json:"recurrence"`
			Days       []string `json:"days"`
			Time       *string  `json:"time"`
		} `json:"schedule"`
	} `json:"config"`
}

type haCoreConfig struct {
	TimeZone string `json:"time_zone"`
}

// coreWS is a minimal client of the Core WebSocket API: authentication, then commands
// answered by a "result" message with the same id.
type coreWS struct {
	conn *websocket.Conn
	id   int
}

func coreWebsocketURL() string {
	u := supervisorURL()
	if rest, ok := strings.CutPrefix(u, "https://"); ok {
		return "wss://" + rest + "/core/websocket"
	}
	return "ws://" + strings.TrimPrefix(u, "http://") + "/core/websocket"
}

func dialCore(ctx context.Context) (*coreWS, error) {
	conn, _, err := websocket.Dial(ctx, coreWebsocketURL(), nil)
	if err != nil {
		return nil, fmt.Errorf("core websocket: %w", err)
	}
	conn.SetReadLimit(16 << 20) // backup/info lists every backup
	c := &coreWS{conn: conn}
	var msg struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	}
	if err := wsjson.Read(ctx, conn, &msg); err != nil || msg.Type != "auth_required" {
		c.close()
		return nil, fmt.Errorf("core websocket: unexpected greeting %q: %v", msg.Type, err)
	}
	auth := map[string]string{"type": "auth", "access_token": os.Getenv("SUPERVISOR_TOKEN")}
	if err := wsjson.Write(ctx, conn, auth); err != nil {
		c.close()
		return nil, fmt.Errorf("core websocket: %w", err)
	}
	if err := wsjson.Read(ctx, conn, &msg); err != nil {
		c.close()
		return nil, fmt.Errorf("core websocket: %w", err)
	}
	if msg.Type != "auth_ok" {
		c.close()
		return nil, fmt.Errorf("core websocket: authentication refused (%s %s)", msg.Type, msg.Message)
	}
	return c, nil
}

func (c *coreWS) close() { _ = c.conn.Close(websocket.StatusNormalClosure, "") }

// command sends one command and decodes its result into out.
func (c *coreWS) command(ctx context.Context, typ string, out any) error {
	c.id++
	if err := wsjson.Write(ctx, c.conn, map[string]any{"id": c.id, "type": typ}); err != nil {
		return fmt.Errorf("%s: %w", typ, err)
	}
	for {
		var msg struct {
			ID      int             `json:"id"`
			Type    string          `json:"type"`
			Success bool            `json:"success"`
			Result  json.RawMessage `json:"result"`
			Error   *struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := wsjson.Read(ctx, c.conn, &msg); err != nil {
			return fmt.Errorf("%s: %w", typ, err)
		}
		if msg.ID != c.id || msg.Type != "result" {
			continue
		}
		if !msg.Success {
			if msg.Error != nil {
				return fmt.Errorf("%s: %s (%s)", typ, msg.Error.Message, msg.Error.Code)
			}
			return fmt.Errorf("%s: failed", typ)
		}
		return json.Unmarshal(msg.Result, out)
	}
}

// haTime converts a date of Home Assistant (ISO 8601 with offset) to unix ms, 0 if absent.
func haTime(s string) int64 {
	if s == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

// collectHaBackups reads the backups of Home Assistant, grouped by destination.
func collectHaBackups(ctx context.Context) (*HaBackupReport, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	c, err := dialCore(ctx)
	if err != nil {
		return nil, err
	}
	defer c.close()
	var agents haAgentsInfo
	var info haBackupInfo
	var cfg haBackupConfig
	if err := c.command(ctx, "backup/agents/info", &agents); err != nil {
		return nil, err
	}
	if err := c.command(ctx, "backup/info", &info); err != nil {
		return nil, err
	}
	if err := c.command(ctx, "backup/config/info", &cfg); err != nil {
		return nil, err
	}
	var core haCoreConfig
	if err := c.command(ctx, "get_config", &core); err != nil {
		return nil, err
	}
	r := haBackupReport(agents, info, cfg, time.Now())
	r.TimeZone = core.TimeZone
	return r, nil
}

func haBackupReport(agents haAgentsInfo, info haBackupInfo, cfg haBackupConfig, now time.Time) *HaBackupReport {
	sched := cfg.Config.Schedule
	r := &HaBackupReport{
		CheckedAt:     now.UnixMilli(),
		Configured:    cfg.Config.AutomaticBackupsConfigured,
		Recurrence:    sched.Recurrence,
		Days:          sched.Days,
		AutoAgentIDs:  cfg.Config.CreateBackup.AgentIDs,
		LastAttempted: haTime(info.LastAttemptedAutomaticBackup),
		LastCompleted: haTime(info.LastCompletedAutomaticBackup),
		Next:          haTime(info.NextAutomaticBackup),
		State:         info.State,
		Agents:        []HaBackupAgent{},
	}
	if sched.Time != nil {
		r.Time = *sched.Time
	}
	if r.Days == nil {
		r.Days = []string{}
	}
	if r.AutoAgentIDs == nil {
		r.AutoAgentIDs = []string{}
	}
	index := map[string]int{}
	add := func(id, name string) {
		if _, ok := index[id]; ok {
			return
		}
		index[id] = len(r.Agents)
		r.Agents = append(r.Agents, HaBackupAgent{AgentID: id, Name: name, Backups: []HaBackup{}})
	}
	for _, a := range agents.Agents {
		add(a.AgentID, a.Name)
	}
	// a destination of the automatic backups whose integration is not loaded is still
	// reported (with an error), so that it is not taken for removed
	for _, id := range r.AutoAgentIDs {
		if _, ok := index[id]; !ok {
			add(id, id)
			r.Agents[index[id]].Error = "backup agent not loaded"
		}
	}
	for id, msg := range info.AgentErrors {
		if i, ok := index[id]; ok {
			r.Agents[i].Error = msg
		}
	}
	for _, b := range info.Backups {
		date := haTime(b.Date)
		// older Core versions do not tell: automatic when made with the automatic settings
		automatic := b.WithAutomaticSettings != nil && *b.WithAutomaticSettings
		for id, a := range b.Agents {
			if i, ok := index[id]; ok {
				r.Agents[i].Backups = append(r.Agents[i].Backups, HaBackup{ID: b.BackupID, Name: b.Name, Date: date, Size: a.Size, Automatic: automatic})
			}
		}
		if !automatic {
			continue
		}
		for _, id := range b.FailedAgentIDs {
			if i, ok := index[id]; ok && date > r.Agents[i].FailedAt {
				r.Agents[i].FailedAt = date
			}
		}
	}
	for i := range r.Agents {
		slices.SortFunc(r.Agents[i].Backups, func(a, b HaBackup) int { return cmp.Compare(b.Date, a.Date) })
	}
	return r
}

// haBackupsReadable: the last read succeeded, the ha_backups capability is announced.
var haBackupsReadable atomic.Bool

// haBackupReport sends the backups of Home Assistant; the first success re-announces the
// agent with the ha_backups capability.
func (s *session) haBackupReport(ctx context.Context) {
	r, err := collectHaBackups(ctx)
	if err != nil {
		haBackupsReadable.Store(false)
		if !s.haBackupErrLogged { // once per failure streak
			log.Printf("home assistant backups: %v (homeassistant_api missing, or Core starting: retry in %s)", err, haBackupPeriod)
			s.haBackupErrLogged = true
		}
		return
	}
	s.haBackupErrLogged = false
	if !haBackupsReadable.Swap(true) {
		_ = s.hello(ctx)
	}
	_ = s.send(ctx, Outbound{Type: "ha_backups", HaBackups: r})
}

const haBackupPeriod = 15 * time.Minute

// haBackupLoop reports the Home Assistant backups now, then every 15 minutes.
func (s *session) haBackupLoop(ctx context.Context) {
	t := time.NewTicker(haBackupPeriod)
	defer t.Stop()
	for {
		s.haBackupReport(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
