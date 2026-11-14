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

// upsGoneAfter: consecutive failed polls (one per minute) after which the UPS is declared gone.
const upsGoneAfter = 3

// upsLoop polls every minute; a report goes to the hub when something changed, and at least every
// 5 minutes.
func (s *session) upsLoop(ctx context.Context) {
	var lastKey string
	var lastSent time.Time
	goneSent := false // the hub was told, in this session, that there is no UPS
	missed := 0
	poll := func() {
		r := collectUps(ctx)
		if r == nil {
			// a few polls in a row, not one NUT hiccup, before the hub is told the UPS is gone; asked even
			// when this session never saw one: the hub may still hold a report from before a restart
			if missed++; !goneSent && missed >= upsGoneAfter {
				if s.send(ctx, Outbound{Type: "ups_report", UpsGone: true}) == nil {
					goneSent, lastKey = true, ""
				}
			}
			return
		}
		missed, goneSent = 0, false
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
