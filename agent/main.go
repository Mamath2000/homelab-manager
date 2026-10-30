//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

const defaultDir = "/etc/homelab-agent"

type session struct {
	hub           string
	http          *http.Client // pinned TLS + client certificate, for downloads from the hub
	conn          *websocket.Conn
	mu            sync.Mutex // serialises writes
	healthMu      sync.RWMutex
	healthCfg     HealthConfig
	healthChanged chan struct{}
	healthSmartMu sync.Mutex
	// a failure to read the Home Assistant backups is logged once per streak
	haBackupErrLogged bool
}

// Actions this host supports: APT only where apt-get exists (not on Unraid), reboot and shutdown through
// systemd only (on Unraid a reboot from the shell could skip the array shutdown) and not on WSL
// (a stopped distribution only starts again from Windows).
func platformCapabilities() []string {
	// refresh: rpc reading again what the agent reports on its own (refresh.go)
	caps := []string{"refresh"}
	// results of jobs sent again after a lost connection (jobresult.go)
	caps = append(caps, "job_replay")
	caps = append(caps, "health")
	if _, err := findSmartctl(); err == nil {
		caps = append(caps, "smart")
	}
	if hasHealthRaid() {
		caps = append(caps, "raid")
	}
	if hasApt() {
		caps = append(caps, "apt_report", "apt_update", "apt_upgrade", "apt_autoremove")
	}
	if _, err := exec.LookPath("systemctl"); err == nil && !onWSL {
		caps = append(caps, "reboot", "shutdown")
	}
	// standardisation (setup.go): Debian-like hosts only
	if _, err := exec.LookPath("useradd"); err == nil && hasApt() {
		caps = append(caps, "setup")
	}
	// AGENT_NO_SELFUPDATE: the binary is updated by its packaging (HAOS add-on image)
	if os.Getenv("AGENT_NO_SELFUPDATE") == "" {
		caps = append(caps, "agent_update")
	}
	return caps
}

// apt-get of the host itself: in the HAOS add-on, the one of the container image does not count.
func hasApt() bool {
	if onHAOS {
		return false
	}
	_, err := exec.LookPath("apt-get")
	return err == nil
}

// Docker stacks module, active when the engine and the compose v2 plugin are available.
var dock = newDockerModule()

// WSL: Docker is not managed (Docker Desktop may expose its socket in the distribution).
var onWSL = isWSL(runningKernel())

var binaryHash = selfHash()

// One job at a time per host, across reconnections.
var jobLock sync.Mutex

func (s *session) send(ctx context.Context, m Outbound) error {
	b, _ := json.Marshal(m)
	s.mu.Lock()
	defer s.mu.Unlock()
	wctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return s.conn.Write(wctx, websocket.MessageText, b)
}

// hello announces the agent; the docker capability is re-evaluated each time, so a Docker
// installed later is picked up by the next periodic hello.
func (s *session) hello(ctx context.Context) error {
	// HAOS add-on: no action on the host at this stage, it only describes itself (haos.go)
	if onHAOS {
		caps := []string{"haos", "refresh", "health"}
		if haBackupsReadable.Load() {
			caps = append(caps, "ha_backups")
		}
		hello := Outbound{Type: "hello", Version: version, Info: collectInfo(), Capabilities: caps, BinaryHash: binaryHash}
		if rc := collectRoleCandidates(ctx); rc != nil {
			hello.RoleCandidates = &rc
		}
		return s.send(ctx, hello)
	}
	caps := platformCapabilities()
	if !onWSL && dock.available(ctx) {
		caps = append(caps, "docker")
	}
	// Proxmox Backup Server administration (pbs.go): installed here, or in a running container
	if _, err := exec.LookPath("proxmox-backup-manager"); err == nil || pbsContainerRunning(ctx) {
		caps = append(caps, "pbs", "pbs_token_delete")
		// secondary PBS: the agent starts the daily series of the copy (offsite.go)
		caps = append(caps, "offsite_series")
	}
	// Proxmox VE administration (pve.go): a node of a cluster
	if hasPve() {
		caps = append(caps, "pve", "pve_token_delete")
		if _, err := exec.LookPath("pct"); err == nil {
			caps = append(caps, "pve_guest_check", "agent_install:lxc")
		}
		// the hub does not offer a node of a cluster it already follows: the cluster name rides along
		if cluster, _, _ := pveClusterStatus(ctx, pveExec); cluster != "" {
			caps = append(caps, "pve_cluster:"+cluster)
		}
	}
	// read-only mount of a snapshot (pbsmount.go): native client, FUSE, systemd
	if pbsMountCapable() {
		caps = append(caps, "pbs_mount")
	}
	// backups to the PBS: backup_setup (the hub may send definitions), "backup" and how the client
	// runs (backup:native, backup:docker), and how it can be installed (backup_install:apt|docker)
	caps = append(caps, "backup_setup")
	mode := backupMode(ctx)
	if mode != "" {
		caps = append(caps, "backup", "backup:"+mode)
	}
	for _, m := range backupInstallOptions(ctx, mode) {
		caps = append(caps, "backup_install:"+m)
	}
	// backups of databases (database.go): backup_database, and the kinds with a running engine here
	caps = append(caps, "backup_database")
	// jobs of kind nextcloud known (nextcloud.go); backup_database:nextcloud when the instance runs here
	caps = append(caps, "backup_nextcloud")
	// jobs run on connection to the hub (connectEveryDays, backup.go)
	caps = append(caps, "backup_connect")
	// second pass of a failed job (retryAfterMin, backup.go)
	caps = append(caps, "backup_retry")
	// UPS monitored by NUT (ups.go), re-evaluated at each hello
	if hasUps(ctx) {
		caps = append(caps, "ups")
		if canControlUps(ctx) {
			caps = append(caps, "ups_control")
		}
	}
	for _, k := range runningDatabaseKinds(ctx) {
		caps = append(caps, "backup_database:"+k)
	}
	hello := Outbound{Type: "hello", Version: version, Info: collectInfo(), Capabilities: caps, BinaryHash: binaryHash}
	if rc := collectRoleCandidates(ctx); rc != nil {
		hello.RoleCandidates = &rc
	}
	return s.send(ctx, hello)
}

// dockerReport sends the state of the compose stacks (nothing when Docker is unavailable).
func (s *session) dockerReport(ctx context.Context) {
	cctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	r, err := dock.collect(cctx)
	if err != nil {
		return
	}
	motdState.setDocker(r)
	_ = s.send(ctx, Outbound{Type: "docker_report", Docker: r})
}

// dockerLoop reports the stacks every 5 minutes and shortly after container events.
func (s *session) dockerLoop(ctx context.Context) {
	kick := make(chan struct{}, 1)
	go dock.watchEvents(ctx, func() {
		select {
		case kick <- struct{}{}:
		default:
		}
	})
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-kick:
			// events come in bursts (stop, die, start...): report once things settle
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
			select {
			case <-kick:
			default:
			}
		}
		s.dockerReport(ctx)
	}
}

// rpc answers a request of the hub outside the job queue (logs, compose files...).
func (s *session) rpc(ctx context.Context, in Inbound) {
	out := Outbound{Type: "rpc_result", ReqID: in.ReqID}
	var err error
	switch in.Op {
	case "docker_logs":
		var logs string
		if logs, err = dock.logs(ctx, in.Stack, in.Service, in.Tail); err == nil {
			out.Result = map[string]string{"logs": logs}
		}
	case "docker_compose_file":
		var files []composeFile
		if files, err = dock.composeFiles(ctx, in.Stack); err == nil {
			out.Result = map[string]any{"files": files}
		}
	case "setup_check":
		if in.Setup == nil {
			err = fmt.Errorf("missing setup")
			break
		}
		var r *SetupReport
		if r, err = checkSetup(ctx, in.Setup); err == nil {
			out.Result = r
		}
	case "backup_estimate":
		out.Result, err = estimateDirectories(ctx, in.EstArchives, in.EstExcludes)
	case "backup_database_check":
		if in.Database == nil {
			err = fmt.Errorf("missing database settings")
			break
		}
		cctx, cancel := context.WithTimeout(ctx, time.Minute)
		var r *DatabaseCheck
		if r, err = checkDatabaseOnHost(cctx, in.BackupKind, in.Database); err == nil {
			out.Result = r
		}
		cancel()
	case "nextcloud_discover":
		// form of the Nextcloud AIO plugin: instance, users, free space of the work directory (optional)
		workDir := ""
		if in.Database != nil {
			workDir = in.Database.WorkDir
		}
		cctx, cancel := context.WithTimeout(ctx, time.Minute)
		var r *NextcloudAIO
		if r, err = checkNextcloudOnHost(cctx, workDir); err == nil {
			out.Result = r
		}
		cancel()
	case "ups_command":
		if err = runUpsCommand(ctx, in.UpsCmd); err == nil {
			out.Result = map[string]bool{"ok": true}
			go s.sendUps(ctx) // beeper state and test result without waiting for the next poll
		}
	case "pbs_detect":
		cctx, cancel := context.WithTimeout(ctx, time.Minute)
		out.Result = detectPbs(cctx)
		cancel()
	case "pbs_token":
		cctx, cancel := context.WithTimeout(ctx, time.Minute)
		var r *PbsTokenResult
		if r, err = ensurePbsToken(cctx, pbsRunner(pbsContainerOf(in.Pbs)), in.Pbs); err == nil {
			out.Result = r
		}
		cancel()
	case "pbs_token_delete":
		cctx, cancel := context.WithTimeout(ctx, time.Minute)
		var r *TokenDeleteResult
		if r, err = deletePbsToken(cctx, pbsRunner(pbsContainerOf(in.Pbs)), in.Pbs); err == nil {
			out.Result = r
		}
		cancel()
	case "pbs_mount":
		// the client waits for the PBS (TimeoutStartSec of the unit)
		cctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
		var r *PbsMountState
		if r, err = mountPbsSnapshot(cctx, in.PbsMount); err == nil {
			out.Result = r
		}
		cancel()
	case "pbs_umount":
		cctx, cancel := context.WithTimeout(ctx, time.Minute)
		var paths []string
		root := ""
		if in.PbsMount != nil {
			root = in.PbsMount.MountRoot
		}
		if paths, err = unmountPbs(cctx, root); err == nil {
			out.Result = map[string][]string{"unmounted": paths}
		}
		cancel()
	case "pbs_mount_status":
		cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		root := defaultPbsMountRoot
		if in.PbsMount != nil {
			root = pbsMountRootFor(in.PbsMount)
		}
		out.Result = pbsMountStatus(cctx, root)
		cancel()
	case "pbs_mount_check":
		out.Result = checkPbsReach(ctx, in.PbsMount)
	case "pve_token_delete":
		cctx, cancel := context.WithTimeout(ctx, time.Minute)
		var r *TokenDeleteResult
		if r, err = deletePveToken(cctx, pveExec, in.Pve); err == nil {
			out.Result = r
		}
		cancel()
	case "pve_detect":
		cctx, cancel := context.WithTimeout(ctx, time.Minute)
		out.Result = detectPve(cctx, pveExec)
		cancel()
	case "pve_guest_check":
		var r []PveGuestCheck
		if r, err = checkPveGuests(ctx, pveExec, in.PveVmids, s.hub); err == nil {
			out.Result = map[string][]PveGuestCheck{"guests": r}
		}
	case "pve_token":
		cctx, cancel := context.WithTimeout(ctx, time.Minute)
		var r *PveTokenResult
		if r, err = ensurePveToken(cctx, pveExec, in.Pve); err == nil {
			out.Result = r
		}
		cancel()
	case "refresh":
		// reports sent before the answer: the hub has them when the request settles
		out.Result = map[string][]string{"scopes": s.refresh(ctx, in.Scopes)}
	case "smart_scan":
		var list []SmartCandidate
		if list, err = listSmartCandidates(ctx); err == nil {
			out.Result = map[string][]SmartCandidate{"candidates": list}
		}
	case "docker_forget":
		if err = dock.forget(ctx, in.Stack); err == nil {
			out.Result = map[string]bool{"ok": true}
			go s.dockerReport(ctx)
		}
	default:
		err = fmt.Errorf("unknown request %q", in.Op)
	}
	if err != nil {
		out.Error = err.Error()
	}
	_ = s.send(ctx, out)
}

func (s *session) report(ctx context.Context) {
	if !hasApt() {
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	r, err := collectAptReport(cctx)
	if err != nil {
		log.Printf("apt report failed: %v", err)
		return
	}
	motdState.setApt(r)
	_ = s.send(ctx, Outbound{Type: "apt_report", Report: r})
}

func (s *session) runJob(ctx context.Context, in Inbound) {
	// through the connection of the moment, the result kept until the hub acknowledges it (jobresult.go)
	jobResults.start(in.JobID)
	emit := func(d string) { jobResults.emit(in.JobID, d) }
	done := func(code int, err error) { jobResults.done(in.JobID, code, err) }

	// a backup can take hours: it has its own lock and does not hold the other jobs back
	if in.Action == "backup_run" {
		code, err := backups.runJob(ctx, in.BackupJob, "manual", in.JobID, emit)
		done(code, err)
		return
	}

	jobLock.Lock()
	defer jobLock.Unlock()

	// Deliberately not derived from the session: losing the hub connection must never
	// interrupt dpkg halfway through an upgrade.
	jctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
	defer cancel()

	var code int
	var err error
	switch in.Action {
	case "apt_report":
		emit("collecting package state...\n")
	case "apt_update":
		code, err = runStreaming(jctx, aptEnv(), emit, "apt-get", "update")
	case "apt_upgrade":
		if !validPackages(in.Packages) {
			done(-1, fmt.Errorf("invalid package name"))
			return
		}
		args := []string{"-y", "-o", "Dpkg::Options::=--force-confold", "-o", "Dpkg::Options::=--force-confdef"}
		if len(in.Packages) == 0 {
			// like `apt upgrade`: a kernel update needs to install a new package, plain
			// `apt-get upgrade` would keep it back
			args = append(args, "upgrade", "--with-new-pkgs")
		} else {
			args = append(args, "install", "--only-upgrade")
			args = append(args, in.Packages...)
		}
		code, err = runStreaming(jctx, aptEnv(), emit, "apt-get", args...)
	case "reboot", "shutdown":
		path, lerr := exec.LookPath("systemctl")
		if lerr != nil {
			done(-1, fmt.Errorf("systemctl not found"))
			return
		}
		verb, msg := "reboot", "rebooting"
		if in.Action == "shutdown" {
			verb, msg = "poweroff", "powering off"
		}
		// report success first: the reboot stops this agent before it could answer
		emit(msg + " in 3 seconds...\n")
		done(0, nil)
		go func() {
			time.Sleep(3 * time.Second)
			if out, err := exec.Command(path, verb).CombinedOutput(); err != nil {
				log.Printf("%s failed: %v: %s", verb, err, out)
			}
		}()
		return
	case "agent_update":
		if err := selfUpdate(jctx, s.http, s.hub, in.Sha256, emit); err != nil {
			done(-1, err)
			return
		}
		done(0, nil)
		go func() {
			time.Sleep(time.Second) // let job_done reach the hub
			log.Printf("agent updated, exiting so that systemd starts the new binary")
			os.Exit(0)
		}()
		return
	case "setup_apply":
		if in.Setup == nil {
			done(-1, fmt.Errorf("missing setup"))
			return
		}
		code, err = applySetup(jctx, in.Setup, emit)
	case "apt_autoremove":
		code, err = runStreaming(jctx, aptEnv(), emit, "apt-get", "-y", "autoremove")
	case "docker_check":
		var upd *DockerUpdates
		if upd, err = dock.check(jctx, emit); err == nil {
			_ = s.send(ctx, Outbound{Type: "docker_updates", Updates: upd})
		} else {
			code = -1
		}
	case "docker_up", "docker_stop", "docker_restart", "docker_update":
		code, err = dock.runAction(jctx, emit, in.Action, in.Stack, in.Service)
	case "agent_install":
		code, err = installAgentInLxc(jctx, runStreamingIn, fetchInstaller(s.http, s.hub), in.Install, emit)
	case "backup_install":
		code, err = installBackupClient(jctx, in.Method, emit)
		// the hub learns the new mode from the capabilities
		_ = s.hello(ctx)
	default:
		done(-1, fmt.Errorf("unknown action %q", in.Action))
		return
	}
	// always refresh the state after a job so the UI reflects reality
	if strings.HasPrefix(in.Action, "docker_") {
		s.dockerReport(ctx)
	} else {
		s.report(ctx)
	}
	done(code, err)
}

// helloWhenBackupReady: at boot the connection can come up before Docker (Unraid), so the first hello
// has no backup capability; sends another one as soon as the client becomes usable.
func (s *session) helloWhenBackupReady(ctx context.Context) {
	if backupMode(ctx) != "" {
		return
	}
	if _, err := exec.LookPath("docker"); err != nil {
		return
	}
	deadline := time.Now().Add(15 * time.Minute) // Docker start-up + possible pull of the client image
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return
		case <-time.After(dockerWaitStep):
		}
		if backupMode(ctx) != "" {
			_ = s.hello(ctx)
			return
		}
	}
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
	offsite.attach(func(o Outbound) error { return s.send(ctx, o) })
	defer offsite.detach()
	jobResults.attach(func(o Outbound) error { return s.send(ctx, o) })
	defer jobResults.detach()
	go s.report(ctx)
	go s.helloWhenBackupReady(ctx)
	if !onWSL && !onHAOS { // WSL, HAOS: Docker is not managed
		go s.dockerReport(ctx)
		go s.dockerLoop(ctx)
	}
	if onHAOS {
		go s.haBackupLoop(ctx)
	} else {
		go s.upsLoop(ctx)
	}

	// periodic refresh of system info + cached apt state (cheap, no network)
	go func() {
		t := time.NewTicker(30 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				_ = s.hello(ctx)
				s.report(ctx)
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
		case "run":
			go s.runJob(ctx, in)
		case "rpc":
			go s.rpc(ctx, in)
		case "backup_sync":
			go func() {
				o := Outbound{Type: "backup_synced"}
				if in.Backup == nil {
					o.Error = "missing definition"
				} else if err := backups.apply(in.Backup); err != nil {
					o.Error = err.Error()
				} else {
					o.Data = in.Backup.Hash
				}
				_ = s.send(ctx, o)
			}()
		case "offsite_sync":
			go func() {
				o := Outbound{Type: "offsite_synced"}
				if in.Offsite == nil {
					o.Error = "missing definition"
				} else if err := offsite.apply(in.Offsite); err != nil {
					o.Error = err.Error()
				} else {
					o.Data = in.Offsite.Hash
				}
				_ = s.send(ctx, o)
			}()
		case "backup_result_ack":
			backups.ack(in.ReqID)
		case "job_done_ack":
			jobResults.ack(in.JobID)
		case "health_config":
			s.setHealthConfig(in.HealthConfig)
		}
	}
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if len(os.Args) > 1 && os.Args[1] == "enroll" {
		runEnroll(ctx, os.Args[2:])
		return
	}
	cfg, _ := loadConfig(os.Args[1:])
	upsPassPath = filepath.Join(cfg.Dir, upsPassFile)
	if releasePubKey == "" {
		log.Printf("development build: agent updates are not signature-checked")
	}
	roots, cert, err := identity(cfg.Dir)
	if err != nil {
		log.Fatal(err)
	}
	client := httpClient(tlsConfig(roots, cert))

	jobResults.recover()
	// scheduled backups run whether the hub is reachable or not
	go backups.loop(ctx)
	go backups.ensureClientImage(ctx)
	// and so do the copies to this secondary PBS
	go offsite.loop(ctx)

	connectLoop(ctx, cfg.Hub, client, func(ctx context.Context, conn *websocket.Conn) error {
		s := &session{hub: cfg.Hub, http: client, conn: conn, healthCfg: defaultHealthConfig(), healthChanged: make(chan struct{}, 1)}
		return s.loop(ctx)
	})
}
