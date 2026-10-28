package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// enroll exchanges the single-use code of the install command for a client certificate.
// The private key is generated here and never leaves the host; files are written only once
// the hub has accepted the request.
func enroll(ctx context.Context, hub, code, dir string) (string, error) {
	roots, err := loadCA(dir)
	if err != nil {
		return "", fmt.Errorf("hub CA missing (%w): run the install command", err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", err
	}
	host, _ := os.Hostname()
	csrDER, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: host}}, key)
	if err != nil {
		return "", err
	}
	body, _ := json.Marshal(map[string]string{
		"code": code,
		"csr":  string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csrDER})),
	})
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, hub+"/agent/enroll", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := httpClient(tlsConfig(roots, nil)).Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if res.StatusCode != http.StatusOK {
		var e struct{ Error string }
		_ = json.Unmarshal(raw, &e)
		return "", fmt.Errorf("enrollment refused (HTTP %d): %s", res.StatusCode, e.Error)
	}
	var out struct {
		HostID string `json:"hostId"`
		Cert   string `json:"cert"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.Cert == "" {
		return "", fmt.Errorf("invalid enrollment response")
	}
	// the certificate must match our key before anything is written
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return "", err
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	if _, err := tlsKeyPair([]byte(out.Cert), keyPEM); err != nil {
		return "", fmt.Errorf("certificate does not match the key: %w", err)
	}
	if err := writeFileAtomic(filepath.Join(dir, keyFile), keyPEM, 0o600); err != nil {
		return "", err
	}
	if err := writeFileAtomic(filepath.Join(dir, certFile), []byte(out.Cert), 0o644); err != nil {
		return "", err
	}
	return out.HostID, nil
}

func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	// a FAT filesystem (Unraid flash drive) has no permissions: the file keeps the 0600 of
	// CreateTemp, which is what matters for the key
	_ = tmp.Chmod(mode)
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
