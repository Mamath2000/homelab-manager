//go:build windows

package main

// Windows agent (homelab#183): presence, host info, sessions, self-update (homelab#207) and backups of
// directories to the PBS (homelab#208). Every other file of the package is Linux code (//go:build !windows)
// except the shared core: config.go, connect.go, enroll.go, tls.go, info.go, backup.go, calendar.go,
// stream.go.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/sys/windows/svc"
)

var defaultDir = filepath.Join(env("ProgramData", `C:\ProgramData`), "homelab-agent")

var binaryHash = selfHash()

// sessionKick: a session changed (service notification), report it now.
var sessionKick = make(chan struct{}, 1)

func kickSessions() {
	select {
	case sessionKick <- struct{}{}:
	default:
	}
}

// restartKick: the binary was replaced, the service must exit so that its recovery actions start the new one.
var restartKick = make(chan struct{}, 1)

func main() {
	// the helper of the service in a user session (idle_windows.go): nothing else to do as that user
	if len(os.Args) == 2 && os.Args[1] == "idle-probe" {
		runIdleProbe()
		return
	}
	// the helper that locks the session it runs in (power_windows.go)
	if len(os.Args) == 2 && os.Args[1] == "lock-session" {
		if err := lockWorkStation(); err != nil {
			log.Fatal(err)
		}
		return
	}
	cleanOldBinary()
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "install":
			ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
			defer stop()
			if err := runInstall(ctx, os.Args[2:]); err != nil {
				log.Fatal(err)
			}
			return
		case "uninstall":
			if err := runUninstall(); err != nil {
				log.Fatal(err)
			}
			return
		case "enroll":
			ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
			defer stop()
			runEnroll(ctx, os.Args[2:])
			return
		}
	}
	cfg, _ := loadConfig(os.Args[1:])
	if isService, err := svc.IsWindowsService(); err == nil && isService {
		logToFile(cfg.Dir)
		probes.helpers = true
		if err := svc.Run(serviceName, &service{cfg: cfg}); err != nil {
			log.Fatalf("service: %v", err)
		}
		return
	}
	// console: for a test by hand, with the identity of the installation
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	go func() {
		select {
		case <-restartKick:
			stop() // no service manager to restart it: an updated console run just ends
		case <-ctx.Done():
		}
	}()
	runAgent(ctx, cfg)
}

// Log of the service in its directory, started afresh when it grows beyond 1 MB.
func logToFile(dir string) {
	path := filepath.Join(dir, "agent.log")
	flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if st, err := os.Stat(path); err == nil && st.Size() > 1<<20 {
		flags |= os.O_TRUNC
	}
	if f, err := os.OpenFile(path, flags, 0o600); err == nil {
		log.SetOutput(f)
	}
}

type service struct{ cfg config }

func (s *service) Execute(_ []string, req <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		runAgent(ctx, s.cfg)
		close(done)
	}()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown | svc.AcceptSessionChange}
	for {
		select {
		case <-done:
			// the agent gave up (identity missing...): a failure, so that the recovery actions restart it
			return false, 1
		case <-restartKick:
			// a failure exit code: the recovery actions (installed with the service) restart it
			cancel()
			// the helpers end with the agent: they hold the old binary
			select {
			case <-done:
			case <-time.After(10 * time.Second):
			}
			return false, 1
		case c := <-req:
			switch c.Cmd {
			case svc.Interrogate:
				status <- c.CurrentStatus
			case svc.SessionChange:
				// WTS_SESSION_LOCK / WTS_SESSION_UNLOCK; EventData: WTSSESSION_NOTIFICATION
				if n := sessionNotification(c.EventData); n != nil {
					switch c.EventType {
					case 0x7:
						noteLock(n.SessionID, true)
					case 0x8:
						noteLock(n.SessionID, false)
					}
				}
				kickSessions()
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				select {
				case <-done:
				case <-time.After(10 * time.Second):
				}
				return false, 0
			}
		}
	}
}

func runAgent(ctx context.Context, cfg config) {
	log.Printf("homelab-agent %s (windows)", version)
	defer probes.stop()
	roots, cert, err := identity(cfg.Dir)
	if err != nil {
		log.Printf("identity: %v", err)
		return
	}
	client := httpClient(tlsConfig(roots, cert))
	// scheduled backups run whether the hub is reachable or not
	backups = newBackupModule(cfg.Dir)
	go backups.loop(ctx)
	connectLoop(ctx, cfg.Hub, client, func(ctx context.Context, conn *websocket.Conn) error {
		return (&session{conn: conn, http: client, hub: cfg.Hub, healthCfg: defaultHealthConfig(), healthChanged: make(chan struct{}, 1)}).loop(ctx)
	})
}

type session struct {
	conn          *websocket.Conn
	http          *http.Client
	hub           string
	mu            sync.Mutex // serialises writes
	healthMu      sync.RWMutex
	healthCfg     HealthConfig
	healthChanged chan struct{}
	healthSmartMu sync.Mutex
	last          []byte // last session report sent (JSON of the sessions)
	// backup client present in the last hello: a definition that changes it calls for a new hello
	client bool
}

func (s *session) send(ctx context.Context, m Outbound) error {
	b, _ := json.Marshal(m)
	s.mu.Lock()
	defer s.mu.Unlock()
	wctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return s.conn.Write(wctx, websocket.MessageText, b)
}

func (s *session) hello(ctx context.Context) error {
	// backups: backup_setup (the hub may send definitions), backup_connect (jobs run on connection),
	// "backup" and backup:cli once the CLI named by the definition is there
	caps := []string{"refresh", "session", "health", "agent_update", "reboot", "shutdown", "lock", "backup_setup", "backup_connect", "backup_retry"}
	if _, err := findSmartctl(); err == nil {
		caps = append(caps, "smart")
	}
	client := backups.clientPresent()
	if client {
		caps = append(caps, "backup", "backup:cli")
	}
	s.mu.Lock()
	s.client = client
	s.mu.Unlock()
	return s.send(ctx, Outbound{Type: "hello", Version: version, Info: collectInfo(), Capabilities: caps, BinaryHash: binaryHash})
}

// backupSync applies a definition of the hub; a new client path that changes what the hello says sends it again.
func (s *session) backupSync(ctx context.Context, in Inbound) {
	o := Outbound{Type: "backup_synced"}
	if in.Backup == nil {
		o.Error = "missing definition"
	} else if err := backups.apply(in.Backup); err != nil {
		o.Error = err.Error()
	} else {
		o.Data = in.Backup.Hash
	}
	_ = s.send(ctx, o)
	s.mu.Lock()
	changed := s.client != backups.clientPresent()
	s.mu.Unlock()
	if changed {
		_ = s.hello(ctx)
	}
}

// sessions reports the sessions; unchanged ones are only sent when forced.
func (s *session) sessions(ctx context.Context, force bool) {
	r, err := collectSessions()
	if err != nil {
		log.Printf("sessions: %v", err)
		return
	}
	// idleSec changes at every read: only the transitions (state, interactive) are worth a report
	stable := make([]Session, len(r.Sessions))
	for i, x := range r.Sessions {
		x.IdleSec = nil
		stable[i] = x
	}
	cur, _ := json.Marshal(stable)
	s.mu.Lock()
	same := string(cur) == string(s.last)
	s.last = cur
	s.mu.Unlock()
	if same && !force {
		return
	}
	_ = s.send(ctx, Outbound{Type: "session_report", Sessions: r})
}

func (s *session) loop(ctx context.Context) error {
	if err := s.hello(ctx); err != nil {
		return err
	}
	s.setHealthConfig(defaultHealthConfig())
	go s.healthLoop(ctx)
	// pending backup results go to this connection
	backups.attach(func(o Outbound) error { return s.send(ctx, o) })
	defer backups.detach()
	s.sessions(ctx, true)
	go func() {
		helloT := time.NewTicker(30 * time.Minute)
		// safety net behind the notifications of the service (and the only source in a console)
		pollT := time.NewTicker(15 * time.Second)
		defer helloT.Stop()
		defer pollT.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-helloT.C:
				_ = s.hello(ctx)
			case <-pollT.C:
				s.sessions(ctx, false)
			case <-sessionKick:
				// unlock + logon come in bursts: report once things settle
				select {
				case <-ctx.Done():
					return
				case <-time.After(time.Second):
				}
				s.sessions(ctx, false)
			}
		}
	}()
	for {
		_, data, err := s.conn.Read(ctx)
		if err != nil {
			return err
		}
		var in Inbound
		if json.Unmarshal(data, &in) != nil {
			continue
		}
		switch in.Type {
		case "health_config":
			s.setHealthConfig(in.HealthConfig)
		case "rpc":
			out := Outbound{Type: "rpc_result", ReqID: in.ReqID}
			if in.Op == "refresh" {
				_ = s.hello(ctx)
				s.sessions(ctx, true)
				out.Result = map[string][]string{"scopes": {"info", "session"}}
			} else if in.Op == "smart_scan" {
				if list, err := listSmartCandidates(ctx); err != nil {
					out.Error = err.Error()
				} else {
					out.Result = map[string][]SmartCandidate{"candidates": list}
				}
			} else {
				out.Error = fmt.Sprintf("unknown request %q", in.Op)
			}
			_ = s.send(ctx, out)
		case "run":
			s.run(ctx, in)
		case "backup_sync":
			go s.backupSync(ctx, in)
		case "backup_result_ack":
			backups.ack(in.ReqID)
		}
	}
}

// run executes a job of the hub. Only agent_update, backup_run and the power actions exist on Windows; any
// other action must not stay pending on the hub.
func (s *session) run(ctx context.Context, in Inbound) {
	emit := func(d string) { _ = s.send(ctx, Outbound{Type: "job_log", JobID: in.JobID, Data: d}) }
	if in.Action == "backup_run" {
		// a backup can take hours: it has its own lock (runJob)
		go func() {
			o := Outbound{Type: "job_done", JobID: in.JobID}
			code, err := backups.runJob(ctx, in.BackupJob, "manual", in.JobID, emit)
			o.ExitCode = code
			if err != nil {
				o.Error = err.Error()
			}
			_ = s.send(ctx, o)
		}()
		return
	}
	switch in.Action {
	case "reboot", "shutdown":
		go s.power(ctx, in, emit)
		return
	case "lock":
		go s.lock(ctx, in, emit)
		return
	}
	if in.Action != "agent_update" {
		_ = s.send(ctx, Outbound{Type: "job_done", JobID: in.JobID, ExitCode: -1,
			Error: fmt.Sprintf("action %q not supported on Windows", in.Action)})
		return
	}
	go func() {
		if err := selfUpdate(ctx, s.http, s.hub, in.Sha256, emit); err != nil {
			_ = s.send(ctx, Outbound{Type: "job_done", JobID: in.JobID, ExitCode: -1, Error: err.Error()})
			return
		}
		_ = s.send(ctx, Outbound{Type: "job_done", JobID: in.JobID})
		time.Sleep(time.Second) // let job_done reach the hub
		log.Printf("agent updated, exiting so that the service manager starts the new binary")
		select {
		case restartKick <- struct{}{}:
		default:
		}
	}()
}
