//go:build !windows

package main

import (
	"context"
	"slices"
)

// Refresh on request of the hub (rpc "refresh"): the agent reads again what it reports on its own
// periodically and sends the usual messages (hello, apt_report, docker_report, ha_backups, ups_report).
// Local state only: the registry check of the images stays the docker_check job.

// refreshScopes, in the order they are refreshed
var refreshScopes = []string{"info", "apt", "docker", "ha_backups", "ups"}

// availableScopes: what this agent can read, given its platform.
func availableScopes(apt, docker, haos bool) []string {
	out := []string{"info"}
	if apt {
		out = append(out, "apt")
	}
	if docker {
		out = append(out, "docker")
	}
	if haos {
		out = append(out, "ha_backups")
	} else {
		out = append(out, "ups")
	}
	return out
}

// wantedScopes: the scopes asked that this agent can read (none asked: all of them), in refresh order.
func wantedScopes(asked, available []string) []string {
	out := []string{}
	for _, s := range refreshScopes {
		if slices.Contains(available, s) && (len(asked) == 0 || slices.Contains(asked, s)) {
			out = append(out, s)
		}
	}
	return out
}

// refresh sends the reports of the scopes asked; returns the scopes refreshed.
func (s *session) refresh(ctx context.Context, asked []string) []string {
	docker := !onWSL && !onHAOS && dock.available(ctx)
	scopes := wantedScopes(asked, availableScopes(hasApt(), docker, onHAOS))
	for _, sc := range scopes {
		switch sc {
		case "info":
			_ = s.hello(ctx)
		case "apt":
			s.report(ctx)
		case "docker":
			s.dockerReport(ctx)
		case "ha_backups":
			s.haBackupReport(ctx)
		case "ups":
			if r := collectUps(ctx); r != nil {
				_ = s.send(ctx, Outbound{Type: "ups_report", Ups: r})
			}
		}
	}
	return scopes
}
