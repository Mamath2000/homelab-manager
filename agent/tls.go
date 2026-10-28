package main

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// Files of the agent identity, in the agent directory (/etc/homelab-agent).
const (
	caFile   = "ca.pem"    // hub CA, written by the install script (pinned)
	keyFile  = "agent.key" // private key, generated on this host, never sent
	certFile = "agent.crt" // client certificate issued by the hub at enrollment
)

func loadCA(dir string) (*x509.CertPool, error) {
	pem, err := os.ReadFile(filepath.Join(dir, caFile))
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("%s: no certificate", caFile)
	}
	return pool, nil
}

// verifyHub accepts the hub only if its certificate chains to the pinned CA and is meant for a
// TLS server. The host name is not checked: the CA is private to the hub, and an agent client
// certificate (issued by the same CA) is rejected by the serverAuth requirement.
func verifyHub(raw [][]byte, roots *x509.CertPool) error {
	if len(raw) == 0 {
		return errors.New("hub sent no certificate")
	}
	certs := make([]*x509.Certificate, 0, len(raw))
	for _, r := range raw {
		c, err := x509.ParseCertificate(r)
		if err != nil {
			return err
		}
		certs = append(certs, c)
	}
	inter := x509.NewCertPool()
	for _, c := range certs[1:] {
		inter.AddCert(c)
	}
	_, err := certs[0].Verify(x509.VerifyOptions{
		Roots:         roots,
		Intermediates: inter,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	})
	if err != nil {
		return fmt.Errorf("hub certificate not trusted: %w", err)
	}
	return nil
}

// tlsConfig trusts only the pinned CA and, once enrolled, presents the agent certificate.
func tlsConfig(roots *x509.CertPool, client *tls.Certificate) *tls.Config {
	cfg := &tls.Config{
		MinVersion: tls.VersionTLS12,
		// the default verification (system CAs + host name) is replaced by verifyHub
		InsecureSkipVerify: true,
		VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
			return verifyHub(raw, roots)
		},
	}
	if client != nil {
		cfg.GetClientCertificate = func(*tls.CertificateRequestInfo) (*tls.Certificate, error) { return client, nil }
	}
	return cfg
}

func httpClient(cfg *tls.Config) *http.Client {
	return &http.Client{
		Timeout:   5 * time.Minute,
		Transport: &http.Transport{TLSClientConfig: cfg, Proxy: http.ProxyFromEnvironment, TLSHandshakeTimeout: 15 * time.Second},
	}
}

// identity loads the CA and the client certificate of an enrolled agent.
func identity(dir string) (*x509.CertPool, *tls.Certificate, error) {
	roots, err := loadCA(dir)
	if err != nil {
		return nil, nil, err
	}
	cert, err := tls.LoadX509KeyPair(filepath.Join(dir, certFile), filepath.Join(dir, keyFile))
	if err != nil {
		return nil, nil, fmt.Errorf("agent not enrolled (%w): run the install command shown by the hub", err)
	}
	return roots, &cert, nil
}

func tlsKeyPair(certPEM, keyPEM []byte) (tls.Certificate, error) {
	return tls.X509KeyPair(certPEM, keyPEM)
}
