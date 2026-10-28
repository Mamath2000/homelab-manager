//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// Home Assistant OS: the agent runs in an add-on (homelab-manager-haos), a container on the
// host network with access to the Supervisor API. The container is not the host: its
// os-release, apt-get or useradd say nothing about HAOS, so the host is described by the
// Supervisor and the agent offers no action (updates come with new add-on versions).
var onHAOS = os.Getenv("SUPERVISOR_TOKEN") != ""

func supervisorURL() string {
	return strings.TrimRight(env("SUPERVISOR_URL", "http://supervisor"), "/")
}

// supervisorGet reads one Supervisor endpoint ({"result": "ok", "data": {...}}) into out.
func supervisorGet(ctx context.Context, path string, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, supervisorURL()+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("SUPERVISOR_TOKEN"))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	var body struct {
		Result  string          `json:"result"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return fmt.Errorf("supervisor %s: HTTP %d: %w", path, res.StatusCode, err)
	}
	if res.StatusCode != http.StatusOK || body.Result != "ok" {
		return fmt.Errorf("supervisor %s: HTTP %d: %s", path, res.StatusCode, body.Message)
	}
	return json.Unmarshal(body.Data, out)
}

// haosInfo overrides what the container cannot know about the host: OS name and version,
// hostname and virtualization. Kept as is when the Supervisor does not answer.
func haosInfo(ctx context.Context, info *HostInfo) {
	info.OSID, info.OSName = "haos", "Home Assistant OS"
	var osInfo struct {
		Version string `json:"version"`
	}
	if err := supervisorGet(ctx, "/os/info", &osInfo); err == nil && osInfo.Version != "" {
		info.OSName = "Home Assistant OS " + osInfo.Version
	} else if err != nil {
		log.Printf("%v", err)
	}
	var host struct {
		Hostname       string `json:"hostname"`
		Virtualization string `json:"virtualization"`
	}
	if err := supervisorGet(ctx, "/host/info", &host); err == nil {
		if host.Hostname != "" {
			info.Hostname = host.Hostname
		}
		if host.Virtualization != "" {
			info.Virt = host.Virtualization
		}
	} else {
		log.Printf("%v", err)
	}
}

// Interfaces Supervisor and Docker create on HAOS (hassio and docker0 bridges, veth pairs of
// the containers): their addresses are random and are not the VM's.
func virtualInterface(name string) bool {
	for _, p := range []string{"hassio", "docker", "veth", "br-"} {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}
