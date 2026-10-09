package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

var version = "dev"

type config struct {
	Hub string // https://host:port of the agent TLS server
	Dir string // CA, key and certificate of the agent
}

const defaultDir = "/etc/homelab-agent"

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

// usage:
//
//	homelab-agent [-hub URL] [-dir DIR]          run (HUB_URL / AGENT_DIR in the environment)
//	homelab-agent enroll -hub URL -code CODE      exchange an install code for a certificate
//	homelab-agent -version
func loadConfig(args []string) (config, string) {
	fs := flag.NewFlagSet("homelab-agent", flag.ExitOnError)
	hub := fs.String("hub", os.Getenv("HUB_URL"), "agent URL of the hub, e.g. https://hub:3443")
	dir := fs.String("dir", env("AGENT_DIR", defaultDir), "directory of the agent identity")
	code := fs.String("code", "", "enroll: single-use code of the install command")
	ver := fs.Bool("version", false, "print version")
	_ = fs.Parse(args)
	if *ver {
		fmt.Println(version)
		os.Exit(0)
	}
	cfg := config{Hub: strings.TrimRight(*hub, "/"), Dir: *dir}
	if !strings.HasPrefix(cfg.Hub, "https://") {
		log.Fatal("HUB_URL must be the https:// agent address of the hub (flag -hub or environment)")
	}
	return cfg, *code
}

func wsURL(hub string) string {
	u, err := url.Parse(hub)
	if err != nil {
		log.Fatalf("invalid hub url: %v", err)
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = "/agent/ws"
	return u.String()
}

func runEnroll(ctx context.Context, args []string) {
	cfg, code := loadConfig(args)
	if code == "" {
		log.Fatal("usage: homelab-agent enroll -hub https://hub:3443 -code CODE")
	}
	id, err := enroll(ctx, cfg.Hub, code, cfg.Dir)
	if err != nil {
		log.Fatalf("enrollment failed: %v", err)
	}
	fmt.Printf("enrolled as host %s\n", id)
}

type session struct {
	hub  string
	http *http.Client // pinned TLS + client certificate, for downloads from the hub
	conn *websocket.Conn
	mu   sync.Mutex // serialises writes
}

var capabilities = []string{"apt_report", "apt_update", "apt_upgrade", "apt_autoremove", "reboot", "agent_update"}

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

func (s *session) report(ctx context.Context) {
	cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	r, err := collectAptReport(cctx)
	if err != nil {
		log.Printf("apt report failed: %v", err)
		return
	}
	_ = s.send(ctx, Outbound{Type: "apt_report", Report: r})
}

func (s *session) runJob(ctx context.Context, in Inbound) {
	jobLock.Lock()
	defer jobLock.Unlock()

	emit := func(d string) { _ = s.send(ctx, Outbound{Type: "job_log", JobID: in.JobID, Data: d}) }
	done := func(code int, err error) {
		o := Outbound{Type: "job_done", JobID: in.JobID, ExitCode: code}
		if err != nil {
			o.Error = err.Error()
		}
		_ = s.send(ctx, o)
	}

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
		code, err = runStreaming(jctx, emit, "apt-get", "update")
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
		code, err = runStreaming(jctx, emit, "apt-get", args...)
	case "reboot":
		path, lerr := exec.LookPath("systemctl")
		if lerr != nil {
			done(-1, fmt.Errorf("systemctl not found"))
			return
		}
		// report success first: the reboot stops this agent before it could answer
		emit("rebooting in 3 seconds...\n")
		done(0, nil)
		go func() {
			time.Sleep(3 * time.Second)
			if out, err := exec.Command(path, "reboot").CombinedOutput(); err != nil {
				log.Printf("reboot failed: %v: %s", err, out)
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
	case "apt_autoremove":
		code, err = runStreaming(jctx, emit, "apt-get", "-y", "autoremove")
	default:
		done(-1, fmt.Errorf("unknown action %q", in.Action))
		return
	}
	// always refresh the state after a job so the UI reflects reality
	s.report(ctx)
	done(code, err)
}

func (s *session) loop(ctx context.Context) error {
	if err := s.send(ctx, Outbound{Type: "hello", Version: version, Info: collectInfo(), Capabilities: capabilities, BinaryHash: binaryHash}); err != nil {
		return err
	}
	go s.report(ctx)

	// periodic refresh of system info + cached apt state (cheap, no network)
	go func() {
		t := time.NewTicker(30 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				_ = s.send(ctx, Outbound{Type: "hello", Version: version, Info: collectInfo(), Capabilities: capabilities, BinaryHash: binaryHash})
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
		if in.Type == "run" {
			go s.runJob(ctx, in)
		}
	}
}

// Reconnection: slow exponential growth so a hub restart is caught within a few
// seconds, with jitter so agents do not all reconnect at the same instant.
const (
	backoffMin    = time.Second
	backoffMax    = 30 * time.Second
	backoffFactor = 1.2
	backoffJitter = 0.2 // ±20 %
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if len(os.Args) > 1 && os.Args[1] == "enroll" {
		runEnroll(ctx, os.Args[2:])
		return
	}
	cfg, _ := loadConfig(os.Args[1:])
	roots, cert, err := identity(cfg.Dir)
	if err != nil {
		log.Fatal(err)
	}
	client := httpClient(tlsConfig(roots, cert))

	endpoint := wsURL(cfg.Hub)
	backoff := backoffMin
	for ctx.Err() == nil {
		dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		// mutual TLS: the hub knows the agent by its certificate, no secret is sent
		conn, _, err := websocket.Dial(dctx, endpoint, &websocket.DialOptions{HTTPClient: client})
		cancel()
		// jitter on the wait only, so the backoff progression itself does not drift
		wait := time.Duration(float64(backoff) * (1 - backoffJitter + 2*backoffJitter*rand.Float64()))
		if err != nil {
			log.Printf("connect failed: %v (retry in %s)", err, wait.Round(100*time.Millisecond))
		} else {
			conn.SetReadLimit(1 << 20)
			log.Printf("connected to %s", endpoint)
			backoff = backoffMin
			s := &session{hub: cfg.Hub, http: client, conn: conn}
			sctx, scancel := context.WithCancel(ctx)
			err = s.loop(sctx)
			scancel()
			conn.CloseNow()
			log.Printf("disconnected: %v", err)
		}
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
		backoff = min(time.Duration(float64(backoff)*backoffFactor), backoffMax)
	}
}
