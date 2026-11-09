//go:build !windows

package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

// Fingerprint of the certificate a service of this host presents (rpc "tls_fingerprint", homelab#300): read here and
// not across the network, so the hub offers the admin a fingerprint nobody in between could have swapped before it is
// pinned (Omada controller). Only this host is reached: the address of the URL when it is one of its own, the
// loopback otherwise; never another machine.

// TlsFingerprint is the answer of tls_fingerprint: the SHA-256 of the certificate and the address it was read at.
type TlsFingerprint struct {
	Fingerprint string `json:"fingerprint"`
	Address     string `json:"address"`
}

type ownAddrs func() ([]net.IP, error)

func localIPs() ([]net.IP, error) {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil, err
	}
	var ips []net.IP
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok {
			ips = append(ips, n.IP)
		}
	}
	return ips, nil
}

// tlsTarget: host:port to dial, host being the one of the URL the hub reaches the service at.
func tlsTarget(host string, port int, own ownAddrs) (string, error) {
	if port < 1 || port > 65535 {
		return "", errors.New("port invalide")
	}
	p := strconv.Itoa(port)
	if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil {
		if ip.IsLoopback() {
			return net.JoinHostPort(ip.String(), p), nil
		}
		if ips, err := own(); err == nil {
			for _, o := range ips {
				if o.Equal(ip) {
					return net.JoinHostPort(ip.String(), p), nil
				}
			}
		}
	}
	return net.JoinHostPort("127.0.0.1", p), nil
}

func readTlsFingerprint(ctx context.Context, host string, port int, own ownAddrs) (*TlsFingerprint, error) {
	addr, err := tlsTarget(host, port, own)
	if err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	d := &net.Dialer{Timeout: 5 * time.Second}
	raw, err := d.DialContext(cctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("%s injoignable depuis l'hôte : %v", addr, err)
	}
	defer raw.Close()
	// the fingerprint is what is checked: the certificate is self-signed most of the time
	cfg := &tls.Config{InsecureSkipVerify: true}
	if net.ParseIP(strings.Trim(host, "[]")) == nil {
		cfg.ServerName = host
	}
	conn := tls.Client(raw, cfg)
	if err := conn.HandshakeContext(cctx); err != nil {
		return nil, fmt.Errorf("%s : TLS : %v", addr, err)
	}
	certs := conn.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return nil, fmt.Errorf("%s : aucun certificat présenté", addr)
	}
	return &TlsFingerprint{Fingerprint: certFingerprint(certs[0].Raw), Address: addr}, nil
}
