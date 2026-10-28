package main

import (
	"context"
	"encoding/json"
	"time"
)

// sendUps reports the UPS right now, after a command (the NUT driver takes a moment to reflect it).
func (s *session) sendUps(ctx context.Context) {
	select {
	case <-ctx.Done():
		return
	case <-time.After(3 * time.Second):
	}
	if r := collectUps(ctx); r != nil {
		_ = s.send(ctx, Outbound{Type: "ups_report", Ups: r})
	}
}

// upsLoop polls every minute; a report goes to the hub when something changed, and at least every
// 5 minutes.
func (s *session) upsLoop(ctx context.Context) {
	var lastKey string
	var lastSent time.Time
	poll := func() {
		r := collectUps(ctx)
		if r == nil {
			return
		}
		at := r.CheckedAt
		r.CheckedAt = 0
		b, _ := json.Marshal(r)
		r.CheckedAt = at
		if string(b) == lastKey && time.Since(lastSent) < 5*time.Minute {
			return
		}
		if s.send(ctx, Outbound{Type: "ups_report", Ups: r}) == nil {
			lastKey, lastSent = string(b), time.Now()
		}
	}
	poll()
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			poll()
		}
	}
}
