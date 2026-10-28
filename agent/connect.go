package main

import (
	"context"
	"log"
	"math/rand/v2"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// Reconnection: slow exponential growth so a hub restart is caught within a few
// seconds, with jitter so agents do not all reconnect at the same instant.
const (
	backoffMin    = time.Second
	backoffMax    = 30 * time.Second
	backoffFactor = 1.2
	backoffJitter = 0.2 // ±20 %
)

// connectLoop keeps a WebSocket open to the hub until ctx ends; run serves each connection and
// returns when it breaks.
func connectLoop(ctx context.Context, hub string, client *http.Client, run func(context.Context, *websocket.Conn) error) {
	endpoint := wsURL(hub)
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
			sctx, scancel := context.WithCancel(ctx)
			err = run(sctx, conn)
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
