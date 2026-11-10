package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// signFor issues a certificate of ca for key, named cn, valid for d.
func (ca testCA) signFor(t *testing.T, key *ecdsa.PrivateKey, cn string, usage x509.ExtKeyUsage, d time.Duration) []byte {
	t.Helper()
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(d),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{usage},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

// longCA: newTestCA lives one hour, too short for the minimum validity of a renewed certificate.
func longCA(t *testing.T) testCA {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test CA"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(10 * 365 * 24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
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

const year = 365 * 24 * time.Hour

// enrolledDir writes an agent identity (key + certificate named host-1) and returns it loaded.
func enrolledDir(t *testing.T, ca testCA) (*agentIdentity, *ecdsa.PrivateKey) {
	t.Helper()
	dir := t.TempDir()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	if err := os.WriteFile(filepath.Join(dir, keyFile), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, certFile), ca.signFor(t, key, "host-1", x509.ExtKeyUsageClientAuth, 5*year), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, caFile), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ca.cert.Raw}), 0o644); err != nil {
		t.Fatal(err)
	}
	id, err := identity(dir)
	if err != nil {
		t.Fatal(err)
	}
	return id, key
}

func leafCN(t *testing.T, c *tls.Certificate) (string, time.Time) {
	t.Helper()
	l, err := leafOf(c)
	if err != nil {
		t.Fatal(err)
	}
	return l.Subject.CommonName, l.NotAfter
}

func TestCertInstallRefusals(t *testing.T) {
	ca := longCA(t)
	id, key := enrolledDir(t, ca)
	otherKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	before, _ := os.ReadFile(filepath.Join(id.dir, certFile))
	cases := map[string][]byte{
		"another key":       ca.signFor(t, otherKey, "host-1", x509.ExtKeyUsageClientAuth, year),
		"another host":      ca.signFor(t, key, "host-2", x509.ExtKeyUsageClientAuth, year),
		"server usage":      ca.signFor(t, key, "host-1", x509.ExtKeyUsageServerAuth, year),
		"another CA":        longCA(t).signFor(t, key, "host-1", x509.ExtKeyUsageClientAuth, year),
		"too short":         ca.signFor(t, key, "host-1", x509.ExtKeyUsageClientAuth, 24*time.Hour),
		"not a certificate": []byte("garbage"),
	}
	for name, pemBytes := range cases {
		if _, err := id.install(pemBytes); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	after, _ := os.ReadFile(filepath.Join(id.dir, certFile))
	if string(after) != string(before) {
		t.Fatal("refused certificate written")
	}
	if _, err := os.Stat(filepath.Join(id.dir, prevCertFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("previous certificate kept for a refused renewal")
	}
}

func TestCertInstallAndConfirm(t *testing.T) {
	ca := longCA(t)
	id, key := enrolledDir(t, ca)
	old, _ := os.ReadFile(filepath.Join(id.dir, certFile))
	renewed := ca.signFor(t, key, "host-1", x509.ExtKeyUsageClientAuth, year)
	notAfter, err := id.install(renewed)
	if err != nil {
		t.Fatal(err)
	}
	if d := time.Until(notAfter); d < year-time.Hour || d > year+time.Hour {
		t.Fatalf("notAfter %s", notAfter)
	}
	onDisk, _ := os.ReadFile(filepath.Join(id.dir, certFile))
	prev, _ := os.ReadFile(filepath.Join(id.dir, prevCertFile))
	if string(onDisk) != string(renewed) || string(prev) != string(old) {
		t.Fatal("files not rotated")
	}
	if _, na := leafCN(t, id.current()); !na.Equal(notAfter) {
		t.Fatal("renewed certificate not presented")
	}
	// a second renewal before confirmation keeps the certificate the hub still knows
	if _, err := id.install(ca.signFor(t, key, "host-1", x509.ExtKeyUsageClientAuth, year)); err != nil {
		t.Fatal(err)
	}
	prev, _ = os.ReadFile(filepath.Join(id.dir, prevCertFile))
	if string(prev) != string(old) {
		t.Fatal("previous certificate overwritten by a second renewal")
	}
	// connected: the previous certificate is no longer needed
	id.dialed(nil, nil)
	if _, err := os.Stat(filepath.Join(id.dir, prevCertFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("previous certificate not dropped after a connection")
	}
}

func TestCertFallbackAfterRefusals(t *testing.T) {
	ca := longCA(t)
	id, key := enrolledDir(t, ca)
	old, _ := os.ReadFile(filepath.Join(id.dir, certFile))
	_, oldNotAfter := leafCN(t, id.current())
	if _, err := id.install(ca.signFor(t, key, "host-1", x509.ExtKeyUsageClientAuth, year)); err != nil {
		t.Fatal(err)
	}
	refused := &http.Response{StatusCode: http.StatusUnauthorized}
	failure := errors.New("401")
	// other failures (hub unreachable) do not count
	id.dialed(nil, errors.New("connection refused"))
	id.dialed(&http.Response{StatusCode: http.StatusBadGateway}, failure)
	for i := 0; i < refusalsBeforeFallback-1; i++ {
		id.dialed(refused, failure)
	}
	if _, na := leafCN(t, id.current()); na.Equal(oldNotAfter) {
		t.Fatal("fallback before the refusals threshold")
	}
	id.dialed(refused, failure)
	if _, na := leafCN(t, id.current()); !na.Equal(oldNotAfter) {
		t.Fatal("previous certificate not presented again")
	}
	onDisk, _ := os.ReadFile(filepath.Join(id.dir, certFile))
	if string(onDisk) != string(old) {
		t.Fatal("previous certificate not written back")
	}
	if _, err := os.Stat(filepath.Join(id.dir, prevCertFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("previous certificate file left")
	}
	// nothing more to fall back to: refusals change nothing
	for i := 0; i < refusalsBeforeFallback; i++ {
		id.dialed(refused, failure)
	}
	if _, na := leafCN(t, id.current()); !na.Equal(oldNotAfter) {
		t.Fatal("certificate changed without a previous one")
	}
}

func TestDialedWithoutIdentity(t *testing.T) {
	var id *agentIdentity
	id.dialed(nil, nil) // tests and enrollment: no identity
}
