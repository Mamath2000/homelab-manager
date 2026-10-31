//go:build !windows

package main

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Ping on request of the hub (rpc "ping"): a probe measured from this host instead of the hub (homelab#260).
// The agent runs as root, so ICMP is allowed.

// Not an option for the ping command, nor a way into it (same rule as the hub)
var pingHostRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$`)

var pingTimeRe = regexp.MustCompile(`(?i)time[=<]([\d.]+)\s*ms`)

// PingResult is one measure. Up false: the target does not answer (Message says why); an error of
// pingHost means the measure itself is impossible (no ping command).
type PingResult struct {
	Up        bool   `json:"up"`
	LatencyMs int    `json:"latencyMs,omitempty"`
	Message   string `json:"message,omitempty"`
}

type pingRunner func(ctx context.Context, args []string) (stdout string, exit int, err error)

func execPing(ctx context.Context, args []string) (string, int, error) {
	out, err := exec.CommandContext(ctx, "ping", args...).CombinedOutput()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return string(out), ee.ExitCode(), nil
	}
	return string(out), 0, err
}

// from: address of this host the ping leaves with (ping -I), so that it enters the tunnel whose local networks
// hold it (a host with several addresses, homelab#261); empty: the one the routing picks.
func pingHost(ctx context.Context, host, from string, timeoutSec int, run pingRunner) (*PingResult, error) {
	if !pingHostRe.MatchString(host) {
		return &PingResult{Message: "adresse invalide"}, nil
	}
	if from != "" && !pingHostRe.MatchString(from) {
		return &PingResult{Message: "adresse source invalide"}, nil
	}
	if timeoutSec < 1 {
		timeoutSec = 1
	}
	cctx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSec+2)*time.Second)
	defer cancel()
	t0 := time.Now()
	args := []string{"-c", "1", "-W", strconv.Itoa(timeoutSec)}
	if from != "" {
		args = append(args, "-I", from)
	}
	out, exit, err := run(cctx, append(args, host))
	if err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return nil, fmt.Errorf("commande ping absente de l'hôte")
		}
		return nil, err
	}
	low := strings.ToLower(out)
	if strings.Contains(low, "operation not permitted") || strings.Contains(low, "permission denied") {
		return nil, fmt.Errorf("ping non autorisé sur l'hôte")
	}
	if exit == 0 {
		ms := int(time.Since(t0).Milliseconds())
		if m := pingTimeRe.FindStringSubmatch(out); m != nil {
			if f, err := strconv.ParseFloat(m[1], 64); err == nil {
				ms = int(f + 0.5)
			}
		}
		return &PingResult{Up: true, LatencyMs: max(ms, 1)}, nil
	}
	if from != "" && (strings.Contains(low, "cannot assign requested address") || strings.Contains(low, "bind:")) {
		return nil, fmt.Errorf("adresse source %s absente de l'hôte", from)
	}
	if strings.Contains(low, "bad address") || strings.Contains(low, "unknown host") || strings.Contains(low, "name or service not known") || strings.Contains(low, "temporary failure") {
		return &PingResult{Message: "nom introuvable"}, nil
	}
	return &PingResult{Message: fmt.Sprintf("pas de réponse en %d s", timeoutSec)}, nil
}
