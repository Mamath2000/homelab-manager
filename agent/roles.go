//go:build !windows

package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Roles a host may play, detected from what listens on it and reported in the hello: the hub offers them
// to the administrator, who activates them (a role is never created by the agent alone).

// RoleCandidate: a service found listening on this host.
type RoleCandidate struct {
	Type    string `json:"type"`    // mqtt-broker
	Process string `json:"process"` // name of the listening process (cut to 15 characters by the kernel)
	Port    int    `json:"port"`
	// Scheme guessed from the port (mqtt, mqtts, ws, wss): the TLS settings are not visible from outside
	Scheme string `json:"scheme"`
	// Local: listens on loopback only, so the hub cannot reach it
	Local bool `json:"local,omitempty"`
}

// mqttBrokerProcesses: names of the listening processes (as `ss` prints them) that are an MQTT broker.
var mqttBrokerProcesses = []string{"mosquitto", "nanomq", "vernemq", "hivemq"}

// ssListenRe: one line of `ss -H -ltnp` with its process.
var ssListenRe = regexp.MustCompile(`^LISTEN\s+\S+\s+\S+\s+(\S+):(\d+)\s+\S+\s+users:\(\("([^"]+)"`)

func mqttScheme(port int) string {
	switch port {
	case 8883:
		return "mqtts"
	case 9001, 8083:
		return "ws"
	case 8084:
		return "wss"
	}
	return "mqtt"
}

func isLoopback(addr string) bool {
	return strings.HasPrefix(addr, "127.") || addr == "[::1]"
}

// parseRoleCandidates reads the output of `ss -H -ltnp`. IPv4 and IPv6 sockets of one port make one
// candidate, local only when none of them is reachable from the network.
func parseRoleCandidates(ssOut string) []RoleCandidate {
	type key struct {
		proc string
		port int
	}
	found := map[key]*RoleCandidate{}
	for _, line := range strings.Split(ssOut, "\n") {
		m := ssListenRe.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil {
			continue
		}
		proc := m[3]
		known := false
		for _, p := range mqttBrokerProcesses {
			if strings.HasPrefix(proc, p) {
				known = true
				break
			}
		}
		if !known {
			continue
		}
		var port int
		if _, err := fmt.Sscanf(m[2], "%d", &port); err != nil || port <= 0 {
			continue
		}
		k := key{proc, port}
		c, ok := found[k]
		if !ok {
			c = &RoleCandidate{Type: "mqtt-broker", Process: proc, Port: port, Scheme: mqttScheme(port), Local: true}
			found[k] = c
		}
		if !isLoopback(m[1]) {
			c.Local = false
		}
	}
	out := make([]RoleCandidate, 0, len(found))
	for _, c := range found {
		out = append(out, *c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Port < out[j].Port })
	return out
}

// MQTT ports recognised without the name of the process: the standard ones only.
var mqttStandardPorts = map[int]bool{1883: true, 8883: true}

// parseProcNetListen reads /proc/net/tcp or tcp6: the services of the host network that listen on a standard MQTT
// port. The process is unknown (an add-on cannot see the processes of the others), so the candidate is told by its port.
func parseProcNetListen(r io.Reader) []RoleCandidate {
	found := map[int]*RoleCandidate{}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		// sl local_address rem_address st ...; st 0A = LISTEN
		if len(f) < 4 || f[3] != "0A" {
			continue
		}
		i := strings.LastIndex(f[1], ":")
		if i < 0 {
			continue
		}
		var port int
		if _, err := fmt.Sscanf(f[1][i+1:], "%X", &port); err != nil || !mqttStandardPorts[port] {
			continue
		}
		addr := f[1][:i]
		// 127.x.x.x (little-endian hex ends with 7F) or ::1
		loop := (len(addr) == 8 && strings.HasSuffix(addr, "7F")) || addr == "00000000000000000000000001000000"
		c, ok := found[port]
		if !ok {
			c = &RoleCandidate{Type: "mqtt-broker", Port: port, Scheme: mqttScheme(port), Local: true}
			found[port] = c
		}
		if !loop {
			c.Local = false
		}
	}
	out := make([]RoleCandidate, 0, len(found))
	for _, c := range found {
		out = append(out, *c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Port < out[j].Port })
	return out
}

// collectRoleCandidatesByPort: Home Assistant OS, where the agent is an add-on on the host network (haos.go).
func collectRoleCandidatesByPort() []RoleCandidate {
	var all []RoleCandidate
	read := false
	for _, p := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		read = true
		all = append(all, parseProcNetListen(f)...)
		f.Close()
	}
	if !read {
		return nil
	}
	// the same port on IPv4 and IPv6 makes one candidate, reachable when one of them is
	merged := map[int]RoleCandidate{}
	for _, c := range all {
		if m, ok := merged[c.Port]; ok {
			c.Local = c.Local && m.Local
		}
		merged[c.Port] = c
	}
	out := make([]RoleCandidate, 0, len(merged))
	for _, c := range merged {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Port < out[j].Port })
	return out
}

// collectRoleCandidates: nil when the sockets cannot be listed (no `ss`), so that the hub keeps what it knew
// instead of concluding that every service is gone.
func collectRoleCandidates(ctx context.Context) []RoleCandidate {
	if onHAOS {
		return collectRoleCandidatesByPort()
	}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, "ss", "-H", "-ltnp").Output()
	if err != nil {
		return nil
	}
	return append([]RoleCandidate{}, parseRoleCandidates(string(out))...)
}
