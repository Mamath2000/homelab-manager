//go:build !windows

package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
)

func fixedAddrs(ips ...string) ownAddrs {
	return func() ([]net.IP, error) {
		var out []net.IP
		for _, s := range ips {
			out = append(out, net.ParseIP(s))
		}
		return out, nil
	}
}

func TestTlsTarget(t *testing.T) {
	own := fixedAddrs("192.168.0.8", "fd00::8")
	for _, c := range []struct {
		host string
		want string
	}{
		{"192.168.0.8", "192.168.0.8:8043"},
		{"[fd00::8]", "[fd00::8]:8043"},
		{"::1", "[::1]:8043"},
		// never another machine: the loopback instead
		{"192.168.0.9", "127.0.0.1:8043"},
		{"omada.lan", "127.0.0.1:8043"},
	} {
		got, err := tlsTarget(c.host, 8043, own)
		if err != nil || got != c.want {
			t.Errorf("%s: %q %v, want %q", c.host, got, err, c.want)
		}
	}
	if _, err := tlsTarget("192.168.0.8", 0, own); err == nil {
		t.Error("port 0 accepted")
	}
}

func TestReadTlsFingerprint(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	r, err := readTlsFingerprint(context.Background(), "127.0.0.1", port, fixedAddrs())
	if err != nil {
		t.Fatal(err)
	}
	if want := certFingerprint(srv.Certificate().Raw); r.Fingerprint != want {
		t.Fatalf("fingerprint %s, want %s", r.Fingerprint, want)
	}
	if _, err := readTlsFingerprint(context.Background(), "127.0.0.1", 1, fixedAddrs()); err == nil {
		t.Fatal("closed port: no error")
	}
}
