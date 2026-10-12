package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// fakeSupervisor answers like the Supervisor API, with the token check.
func fakeSupervisor(t *testing.T, routes map[string]string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"result":"error","message":"Unauthorized"}`))
			return
		}
		body, ok := routes[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"result":"error","message":"Forbidden"}`))
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	t.Setenv("SUPERVISOR_URL", srv.URL)
	t.Setenv("SUPERVISOR_TOKEN", "test-token")
}

func TestHaosInfo(t *testing.T) {
	fakeSupervisor(t, map[string]string{
		"/os/info":   `{"result":"ok","data":{"version":"16.2","version_latest":"16.3","update_available":true,"board":"ova"}}`,
		"/host/info": `{"result":"ok","data":{"hostname":"homeassistant","virtualization":"kvm","kernel":"6.12.41-haos"}}`,
	})
	info := &HostInfo{Hostname: "a1b2c3-homelab-agent", OSID: "debian", OSName: "Debian GNU/Linux 12", Virt: "none"}
	haosInfo(t.Context(), info)
	if info.OSID != "haos" || info.OSName != "Home Assistant OS 16.2" {
		t.Errorf("os = %q %q", info.OSID, info.OSName)
	}
	if info.Hostname != "homeassistant" || info.Virt != "kvm" {
		t.Errorf("host = %q %q", info.Hostname, info.Virt)
	}
}

// Supervisor refusing (role, outage): the host is still HAOS, the rest is kept.
func TestHaosInfoSupervisorDown(t *testing.T) {
	fakeSupervisor(t, map[string]string{})
	info := &HostInfo{Hostname: "a1b2c3-homelab-agent", Virt: "none"}
	haosInfo(t.Context(), info)
	if info.OSID != "haos" || info.OSName != "Home Assistant OS" || info.Hostname != "a1b2c3-homelab-agent" || info.Virt != "none" {
		t.Errorf("info = %+v", info)
	}
}

func TestVirtualInterface(t *testing.T) {
	for name, want := range map[string]bool{
		"hassio":          true,
		"docker0":         true,
		"veth1a2b3c":      true,
		"br-5f2e8a1c9d01": true,
		"enp0s18":         false,
		"eth0":            false,
		"vmbr0":           false, // Proxmox VE bridge: carries the NIC address
		"wlan0":           false,
	} {
		if got := virtualInterface(name); got != want {
			t.Errorf("virtualInterface(%q) = %v, want %v", name, got, want)
		}
	}
}
