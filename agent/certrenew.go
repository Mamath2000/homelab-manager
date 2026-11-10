package main

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// Renewal of the client certificate (homelab#302). The hub signs a new certificate for the key this agent
// already uses (it sees it in the mutual TLS handshake) and sends it with the cert_install request: the key
// never changes, so only agent.crt is rewritten. The previous certificate is kept in agent.crt.prev until a
// connection succeeds with the new one; the hub accepts both until then.
const (
	prevCertFile = "agent.crt.prev"
	// below this validity a certificate is refused: a mistake of the hub must not leave the agent stranded
	minCertValidity = 7 * 24 * time.Hour
	// refusals (401) with a new certificate before going back to the previous one
	refusalsBeforeFallback = 3
)

// agentIdentity is the client certificate presented to the hub, replaced in place when renewed.
type agentIdentity struct {
	dir   string
	roots *x509.CertPool
	cert  atomic.Pointer[tls.Certificate]
	// serialises install and fallback, which both rewrite agent.crt
	mu       sync.Mutex
	refusals int
}

func newAgentIdentity(dir string, roots *x509.CertPool, cert *tls.Certificate) *agentIdentity {
	id := &agentIdentity{dir: dir, roots: roots}
	id.cert.Store(cert)
	return id
}

func (id *agentIdentity) current() *tls.Certificate { return id.cert.Load() }

func leafOf(c *tls.Certificate) (*x509.Certificate, error) {
	if c == nil || len(c.Certificate) == 0 {
		return nil, errors.New("no certificate")
	}
	if c.Leaf != nil {
		return c.Leaf, nil
	}
	return x509.ParseCertificate(c.Certificate[0])
}

// checkRenewed accepts a certificate of the hub only if it matches the key of this agent, chains to the pinned
// CA for TLS client use, names the same host and is valid long enough.
func (id *agentIdentity) checkRenewed(certPEM []byte, now time.Time) (tls.Certificate, *x509.Certificate, error) {
	keyPEM, err := os.ReadFile(filepath.Join(id.dir, keyFile))
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	pair, err := tlsKeyPair(certPEM, keyPEM)
	if err != nil {
		return tls.Certificate{}, nil, fmt.Errorf("certificate does not match the key: %w", err)
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: id.roots, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}, CurrentTime: now}); err != nil {
		return tls.Certificate{}, nil, fmt.Errorf("certificate not issued by the pinned CA for a client: %w", err)
	}
	cur, err := leafOf(id.current())
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	if leaf.Subject.CommonName != cur.Subject.CommonName {
		return tls.Certificate{}, nil, fmt.Errorf("certificate for %q, this agent is %q", leaf.Subject.CommonName, cur.Subject.CommonName)
	}
	if leaf.NotAfter.Sub(now) < minCertValidity {
		return tls.Certificate{}, nil, fmt.Errorf("certificate valid until %s only", leaf.NotAfter.Format(time.RFC3339))
	}
	pair.Leaf = leaf
	return pair, leaf, nil
}

// install checks and writes a renewed certificate, then presents it from the next connection on.
func (id *agentIdentity) install(certPEM []byte) (time.Time, error) {
	id.mu.Lock()
	defer id.mu.Unlock()
	pair, leaf, err := id.checkRenewed(certPEM, time.Now())
	if err != nil {
		return time.Time{}, err
	}
	old, err := os.ReadFile(filepath.Join(id.dir, certFile))
	if err != nil {
		return time.Time{}, err
	}
	// a renewal not confirmed yet keeps its own previous certificate: the one the hub still knows
	if _, err := os.Stat(filepath.Join(id.dir, prevCertFile)); errors.Is(err, os.ErrNotExist) {
		if err := writeFileAtomic(filepath.Join(id.dir, prevCertFile), old, 0o644); err != nil {
			return time.Time{}, err
		}
	}
	if err := writeFileAtomic(filepath.Join(id.dir, certFile), certPEM, 0o644); err != nil {
		return time.Time{}, err
	}
	id.cert.Store(&pair)
	id.refusals = 0
	log.Printf("client certificate renewed, valid until %s", leaf.NotAfter.Format(time.DateOnly))
	return leaf.NotAfter, nil
}

// dialed follows the connections to the hub: the first success with a renewed certificate drops the previous
// one; repeated refusals (a hub that does not know the new one, such as an older hub put back in place) go back
// to the previous one while it is valid.
func (id *agentIdentity) dialed(res *http.Response, err error) {
	if id == nil {
		return
	}
	prev := filepath.Join(id.dir, prevCertFile)
	if err == nil {
		id.mu.Lock()
		defer id.mu.Unlock()
		id.refusals = 0
		if rmErr := os.Remove(prev); rmErr == nil {
			log.Printf("renewed client certificate accepted by the hub")
		}
		return
	}
	if res == nil || res.StatusCode != http.StatusUnauthorized {
		return
	}
	id.mu.Lock()
	defer id.mu.Unlock()
	if _, statErr := os.Stat(prev); statErr != nil {
		return
	}
	id.refusals++
	if id.refusals < refusalsBeforeFallback {
		return
	}
	id.refusals = 0
	if fbErr := id.fallback(); fbErr != nil {
		log.Printf("renewed certificate refused, previous one not usable: %v", fbErr)
	}
}

// fallback puts the previous certificate back (caller holds mu).
func (id *agentIdentity) fallback() error {
	prev := filepath.Join(id.dir, prevCertFile)
	certPEM, err := os.ReadFile(prev)
	if err != nil {
		return err
	}
	keyPEM, err := os.ReadFile(filepath.Join(id.dir, keyFile))
	if err != nil {
		return err
	}
	pair, err := tlsKeyPair(certPEM, keyPEM)
	if err != nil {
		return err
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return err
	}
	if time.Now().After(leaf.NotAfter) {
		_ = os.Remove(prev)
		return errors.New("previous certificate expired")
	}
	if err := writeFileAtomic(filepath.Join(id.dir, certFile), certPEM, 0o644); err != nil {
		return err
	}
	_ = os.Remove(prev)
	pair.Leaf = leaf
	id.cert.Store(&pair)
	log.Printf("renewed certificate refused by the hub: back to the previous one (valid until %s)", leaf.NotAfter.Format(time.DateOnly))
	return nil
}

// certInstall answers the cert_install request of the hub.
func certInstall(id *agentIdentity, client *http.Client, certPEM string) (any, error) {
	if id == nil {
		return nil, errors.New("no identity")
	}
	notAfter, err := id.install([]byte(certPEM))
	if err != nil {
		return nil, err
	}
	// pooled TLS connections still carry the previous certificate
	client.CloseIdleConnections()
	return map[string]int64{"notAfter": notAfter.UnixMilli()}, nil
}

// reconnectWithNewCert closes the connection once the answer is sent: the next one presents the renewed
// certificate, which the hub then makes the only valid one.
func reconnectWithNewCert(conn *websocket.Conn) {
	_ = conn.Close(websocket.StatusNormalClosure, "client certificate renewed")
}
