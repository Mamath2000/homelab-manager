package main

// Shared by every platform: command line, hub address, enrollment.

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net/url"
	"os"
	"strings"
)

var version = "dev"

type config struct {
	Hub string // https://host:port of the agent TLS server
	Dir string // CA, key and certificate of the agent
}

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
//	homelab-agent enroll -hub URL -code-stdin     same, the code is read from stdin (not visible in ps)
//	homelab-agent -version
func loadConfig(args []string) (config, string) {
	fs := flag.NewFlagSet("homelab-agent", flag.ExitOnError)
	hub := fs.String("hub", os.Getenv("HUB_URL"), "agent URL of the hub, e.g. https://hub:3443")
	dir := fs.String("dir", env("AGENT_DIR", defaultDir), "directory of the agent identity")
	code := fs.String("code", "", "enroll: single-use code of the install command")
	codeStdin := fs.Bool("code-stdin", false, "enroll: read the code from stdin instead of -code")
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
	if *codeStdin {
		c, err := readCode(os.Stdin)
		if err != nil {
			log.Fatalf("reading the enrollment code from stdin: %v", err)
		}
		return cfg, c
	}
	return cfg, *code
}

// readCode reads the single-use code: the first line of r, trimmed (the code is base64url, no space inside).
func readCode(r io.Reader) (string, error) {
	b, err := io.ReadAll(io.LimitReader(r, 4096))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(strings.SplitN(string(b), "\n", 2)[0]), nil
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
