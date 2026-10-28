package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type testCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pool *x509.CertPool
}

func newTestCA(t *testing.T) testCA {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "test CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	return testCA{cert, key, pool}
}

func (ca testCA) issue(t *testing.T, usage x509.ExtKeyUsage) tls.Certificate {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "whatever"},
		DNSNames:     []string{"homelab-manager"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{usage},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func TestVerifyHub(t *testing.T) {
	ca := newTestCA(t)
	other := newTestCA(t)
	server := ca.issue(t, x509.ExtKeyUsageServerAuth)
	if err := verifyHub(server.Certificate, ca.pool); err != nil {
		t.Fatalf("hub certificate refused: %v", err)
	}
	// an agent certificate of the same CA must not pass for the hub
	if err := verifyHub(ca.issue(t, x509.ExtKeyUsageClientAuth).Certificate, ca.pool); err == nil {
		t.Fatal("client certificate accepted as hub")
	}
	if err := verifyHub(other.issue(t, x509.ExtKeyUsageServerAuth).Certificate, ca.pool); err == nil {
		t.Fatal("certificate of another CA accepted")
	}
	if err := verifyHub(nil, ca.pool); err == nil {
		t.Fatal("no certificate accepted")
	}
}

// Full handshake: pinned CA, no host name check (the test server is reached by IP), client
// certificate sent and seen by the server.
func TestMutualTLS(t *testing.T) {
	ca := newTestCA(t)
	client := ca.issue(t, x509.ExtKeyUsageClientAuth)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(r.TLS.PeerCertificates) == 0 {
			http.Error(w, "no client cert", http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	srv.TLS = &tls.Config{
		Certificates: []tls.Certificate{ca.issue(t, x509.ExtKeyUsageServerAuth)},
		ClientAuth:   tls.VerifyClientCertIfGiven,
		ClientCAs:    ca.pool,
	}
	srv.StartTLS()
	defer srv.Close()

	res, err := httpClient(tlsConfig(ca.pool, &client)).Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("status %d", res.StatusCode)
	}
	// another CA pinned: the hub is refused
	if _, err := httpClient(tlsConfig(newTestCA(t).pool, &client)).Get(srv.URL); err == nil {
		t.Fatal("hub accepted with a different pinned CA")
	}
}
