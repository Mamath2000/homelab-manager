package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// fakeCore answers like the Core WebSocket API proxied by the Supervisor: authentication with
// the Supervisor token, then one result per command (an error when the command is unknown).
func fakeCore(t *testing.T, results map[string]string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/core/websocket" {
			http.NotFound(w, r)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx := r.Context()
		_ = wsjson.Write(ctx, c, map[string]string{"type": "auth_required", "ha_version": "2026.10.0"})
		var auth struct {
			Type        string `json:"type"`
			AccessToken string `json:"access_token"`
		}
		if wsjson.Read(ctx, c, &auth) != nil {
			return
		}
		if auth.Type != "auth" || auth.AccessToken != "test-token" {
			_ = wsjson.Write(ctx, c, map[string]string{"type": "auth_invalid", "message": "Invalid access token"})
			return
		}
		_ = wsjson.Write(ctx, c, map[string]string{"type": "auth_ok"})
		for {
			var cmd struct {
				ID   int    `json:"id"`
				Type string `json:"type"`
			}
			if wsjson.Read(ctx, c, &cmd) != nil {
				return
			}
			// an unrelated message first: the client waits for its own result
			_ = c.Write(ctx, websocket.MessageText, []byte(`{"id":999,"type":"event","event":{}}`))
			res, ok := results[cmd.Type]
			var msg string
			if ok {
				msg = `{"id":` + strconv.Itoa(cmd.ID) + `,"type":"result","success":true,"result":` + res + `}`
			} else {
				msg = `{"id":` + strconv.Itoa(cmd.ID) + `,"type":"result","success":false,"error":{"code":"unauthorized","message":"Unauthorized"}}`
			}
			_ = c.Write(ctx, websocket.MessageText, []byte(msg))
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("SUPERVISOR_URL", srv.URL)
	t.Setenv("SUPERVISOR_TOKEN", "test-token")
}

const (
	haAgentsJSON = `{"agents":[{"agent_id":"backup.local","name":"local"},{"agent_id":"sftp_storage.nas","name":"NAS"}]}`
	haInfoJSON   = `{
		"backups": [
			{"backup_id":"b3","name":"Automatic backup 2026.10.0","date":"2026-10-12T04:45:10.123456+02:00",
			 "agents":{"backup.local":{"size":3000,"protected":true}},"with_automatic_settings":true,
			 "failed_agent_ids":["sftp_storage.nas"],"failed_addons":[],"failed_folders":[]},
			{"backup_id":"b2","name":"Automatic backup 2026.10.0","date":"2026-10-11T04:45:00+02:00",
			 "agents":{"backup.local":{"size":2000,"protected":true},"sftp_storage.nas":{"size":2000,"protected":true}},
			 "with_automatic_settings":true,"failed_agent_ids":[]},
			{"backup_id":"b1","name":"Manual","date":"2026-10-01T10:00:00+02:00",
			 "agents":{"backup.local":{"size":1000,"protected":false}},"with_automatic_settings":false,
			 "failed_agent_ids":["sftp_storage.nas"]}
		],
		"agent_errors": {},
		"last_attempted_automatic_backup":"2026-10-12T04:45:00+02:00",
		"last_completed_automatic_backup":"2026-10-12T04:46:00+02:00",
		"next_automatic_backup":"2026-10-13T04:45:00+02:00",
		"state":"idle"
	}`
	haConfigJSON = `{"config":{"automatic_backups_configured":true,
		"create_backup":{"agent_ids":["backup.local","sftp_storage.nas","hassio.old"],"password":"secret"},
		"schedule":{"recurrence":"daily","days":[],"time":"04:45"},"retention":{"copies":3,"days":null}}}`
)

func TestCollectHaBackups(t *testing.T) {
	fakeCore(t, map[string]string{
		"backup/agents/info": haAgentsJSON,
		"backup/info":        haInfoJSON,
		"backup/config/info": haConfigJSON,
		"get_config":         `{"time_zone":"Europe/Paris","version":"2026.10.0"}`,
	})
	r, err := collectHaBackups(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	ms := func(s string) int64 { tm, _ := time.Parse(time.RFC3339, s); return tm.UnixMilli() }
	if !r.Configured || r.Recurrence != "daily" || r.Time != "04:45" || r.TimeZone != "Europe/Paris" || len(r.AutoAgentIDs) != 3 {
		t.Errorf("schedule = %+v", r)
	}
	if r.LastAttempted != ms("2026-10-12T04:45:00+02:00") || r.LastCompleted != ms("2026-10-12T04:46:00+02:00") || r.Next != ms("2026-10-13T04:45:00+02:00") {
		t.Errorf("dates = %d %d %d", r.LastAttempted, r.LastCompleted, r.Next)
	}
	if len(r.Agents) != 3 {
		t.Fatalf("agents = %+v", r.Agents)
	}
	local, nas, old := r.Agents[0], r.Agents[1], r.Agents[2]
	if local.AgentID != "backup.local" || len(local.Backups) != 3 || local.Backups[0].ID != "b3" || local.Backups[0].Size != 3000 || !local.Backups[0].Automatic || local.Backups[2].Automatic {
		t.Errorf("local = %+v", local)
	}
	if local.FailedAt != 0 {
		t.Errorf("local failedAt = %d", local.FailedAt)
	}
	// failed on the last automatic backup; the manual failure does not count
	if nas.Name != "NAS" || len(nas.Backups) != 1 || nas.Backups[0].ID != "b2" || nas.FailedAt != haTime("2026-10-12T04:45:10.123456+02:00") {
		t.Errorf("nas = %+v", nas)
	}
	// destination of the automatic backups whose integration is not loaded
	if old.AgentID != "hassio.old" || old.Error == "" || len(old.Backups) != 0 {
		t.Errorf("old = %+v", old)
	}
}

func TestCollectHaBackupsAgentError(t *testing.T) {
	info := `{"backups":[],"agent_errors":{"sftp_storage.nas":"Connection refused"},"state":"idle",
		"last_attempted_automatic_backup":null,"last_completed_automatic_backup":null,"next_automatic_backup":null}`
	fakeCore(t, map[string]string{
		"backup/agents/info": haAgentsJSON,
		"backup/info":        info,
		"backup/config/info": `{"config":{"automatic_backups_configured":false,"create_backup":{"agent_ids":[]},"schedule":{"recurrence":"never","days":[],"time":null}}}`,
		"get_config":         `{"time_zone":"UTC"}`,
	})
	r, err := collectHaBackups(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if r.Configured || r.Recurrence != "never" || r.Time != "" || r.LastAttempted != 0 || r.Next != 0 {
		t.Errorf("report = %+v", r)
	}
	if r.Agents[1].Error != "Connection refused" || r.Agents[0].Error != "" {
		t.Errorf("agents = %+v", r.Agents)
	}
}

// Core refusing a command (no admin right): an error, no report.
func TestCollectHaBackupsRefused(t *testing.T) {
	fakeCore(t, map[string]string{"backup/agents/info": haAgentsJSON})
	if _, err := collectHaBackups(t.Context()); err == nil {
		t.Fatal("expected an error")
	}
}

func TestCollectHaBackupsBadToken(t *testing.T) {
	fakeCore(t, nil)
	t.Setenv("SUPERVISOR_TOKEN", "wrong")
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if _, err := collectHaBackups(ctx); err == nil {
		t.Fatal("expected an authentication error")
	}
}
