package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
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
	Hub   string // http(s)://host:port
	Token string // <hostId>.<secret>
}

func loadConfig() config {
	hub := flag.String("hub", os.Getenv("HUB_URL"), "hub URL, e.g. http://hub:3000")
	token := flag.String("token", os.Getenv("AGENT_TOKEN"), "agent token")
	ver := flag.Bool("version", false, "print version")
	flag.Parse()
	if *ver {
		fmt.Println(version)
		os.Exit(0)
	}
	if *hub == "" || *token == "" {
		log.Fatal("HUB_URL and AGENT_TOKEN are required (flags -hub / -token or environment)")
	}
	return config{Hub: strings.TrimRight(*hub, "/"), Token: *token}
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

type session struct {
	conn *websocket.Conn
	mu   sync.Mutex // serialises writes
}

var capabilities = []string{"apt_report", "apt_update", "apt_upgrade", "apt_autoremove", "reboot"}

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
			args = append(args, "upgrade")
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
	if err := s.send(ctx, Outbound{Type: "hello", Version: version, Info: collectInfo(), Capabilities: capabilities}); err != nil {
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
				_ = s.send(ctx, Outbound{Type: "hello", Version: version, Info: collectInfo(), Capabilities: capabilities})
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

func main() {
	cfg := loadConfig()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	endpoint := wsURL(cfg.Hub)
	backoff := time.Second
	for ctx.Err() == nil {
		dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		conn, _, err := websocket.Dial(dctx, endpoint, &websocket.DialOptions{
			HTTPHeader: http.Header{"Authorization": []string{"Bearer " + cfg.Token}},
		})
		cancel()
		if err != nil {
			log.Printf("connect failed: %v (retry in %s)", err, backoff)
		} else {
			conn.SetReadLimit(1 << 20)
			log.Printf("connected to %s", endpoint)
			backoff = time.Second
			s := &session{conn: conn}
			sctx, scancel := context.WithCancel(ctx)
			err = s.loop(sctx)
			scancel()
			conn.CloseNow()
			log.Printf("disconnected: %v", err)
		}
		select {
		case <-ctx.Done():
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}
