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
	"strconv"
	"strings"
	"time"
)

// Roles a host may play, detected from what listens on it and reported in the hello: the hub offers them
// to the administrator, who activates them (a role is never created by the agent alone).

// RoleCandidate: a service found listening on this host.
type RoleCandidate struct {
	Type    string `json:"type"`    // mqtt-broker, omada-controller, log-server
	Process string `json:"process"` // name of the listening process (cut to 15 characters by the kernel)
	Port    int    `json:"port"`
	// Scheme guessed from the port (mqtt, mqtts, ws, wss; https for an Omada controller): the TLS settings are not
	// visible from outside. A log server (VictoriaLogs): http for its query API, syslog for a port it receives on
	Scheme string `json:"scheme"`
	// Local: listens on loopback only, so the hub cannot reach it
	Local bool `json:"local,omitempty"`
	// Mosquitto only (mosquitto.go): its version as it prints it ("2.1.2"), and whether the dynamic-security plugin is
	// loaded in the running process. Empty / false when the agent cannot tell.
	Version string `json:"version,omitempty"`
	Dynsec  bool   `json:"dynsec,omitempty"`
	pid     int
}

// mqttBrokerProcesses: names of the listening processes (as `ss` prints them) that are an MQTT broker.
var mqttBrokerProcesses = []string{"mosquitto", "nanomq", "vernemq", "hivemq"}

// ssListenRe: one line of `ss -H -ltnp` with its process.
var ssListenRe = regexp.MustCompile(`^LISTEN\s+\S+\s+\S+\s+(\S+):(\d+)\s+\S+\s+users:\(\("([^"]+)"(?:,pid=(\d+))?`)

// omadaHTTPSPort: the management port (and Open API) of an Omada controller, 8043 by default but changeable. It is the
// port proposed for the candidate, not what tells a controller.
const omadaHTTPSPort = 8043

// omadaServicePorts: the ports the devices reach (adoption, manager v1 and v2): fixed, not changeable in the
// controller, so they tell a controller whatever port its web interface was moved to.
var omadaServicePorts = map[int]bool{8043: true, 29811: true, 29812: true, 29814: true}

// victoriaLogsHTTPPort: the default port of the HTTP API of VictoriaLogs (queries), the one proposed for a log server.
const victoriaLogsHTTPPort = 9428

// logServerScheme: what a port of a log server is, told by its number (the API on its default port, else a syslog input).
func logServerScheme(port int) string {
	if port == victoriaLogsHTTPPort {
		return "http"
	}
	return "syslog"
}

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
		typ  string
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
		var port int
		if _, err := fmt.Sscanf(m[2], "%d", &port); err != nil || port <= 0 {
			continue
		}
		typ, scheme := "", ""
		for _, p := range mqttBrokerProcesses {
			if strings.HasPrefix(proc, p) {
				typ, scheme = "mqtt-broker", mqttScheme(port)
				break
			}
		}
		// the Omada controller is told by its service ports (a java process, or the proxy of its container); the
		// candidate carries the default port of its API, one candidate however many of these ports listen
		if typ == "" && omadaServicePorts[port] {
			typ, scheme, port = "omada-controller", "https", omadaHTTPSPort
		}
		// a log server: the VictoriaLogs process (victoria-logs-prod, cut by the kernel), each of its ports; in a
		// container whose ports are published, only the default port of its API tells it (docker-proxy listens)
		if typ == "" && (strings.HasPrefix(proc, "victoria-logs") || (strings.HasPrefix(proc, "docker-proxy") && port == victoriaLogsHTTPPort)) {
			typ, scheme = "log-server", logServerScheme(port)
		}
		if typ == "" {
			continue
		}
		k := key{typ, proc, port}
		c, ok := found[k]
		if !ok {
			c = &RoleCandidate{Type: typ, Process: proc, Port: port, Scheme: scheme, Local: true}
			if m[4] != "" {
				c.pid, _ = strconv.Atoi(m[4])
			}
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
	for k := range found {
		if k.typ == "log-server" && strings.HasPrefix(k.proc, "docker-proxy") {
			out = append(out, dockerSyslogPorts(ssOut, k.port)...)
			break
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Port < out[j].Port })
	return out
}

// syslogPorts: the ports a log server usually receives on (syslog TCP and its TLS port, and the ones of the examples).
var syslogPorts = map[int]bool{514: true, 601: true, 1514: true, 5514: true, 6514: true, 29514: true}

// dockerSyslogPorts: VictoriaLogs in a container is told by its API port only (docker-proxy listens on the host, not
// its process); the syslog ports docker-proxy publishes next to it are then its inputs.
func dockerSyslogPorts(ssOut string, apiPort int) []RoleCandidate {
	seen := map[int]*RoleCandidate{}
	for _, line := range strings.Split(ssOut, "\n") {
		m := ssListenRe.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil || !strings.HasPrefix(m[3], "docker-proxy") {
			continue
		}
		port, err := strconv.Atoi(m[2])
		if err != nil || !syslogPorts[port] || port == apiPort {
			continue
		}
		c, ok := seen[port]
		if !ok {
			c = &RoleCandidate{Type: "log-server", Process: m[3], Port: port, Scheme: "syslog", Local: true}
			seen[port] = c
		}
		if !isLoopback(m[1]) {
			c.Local = false
		}
	}
	out := make([]RoleCandidate, 0, len(seen))
	for _, c := range seen {
		out = append(out, *c)
	}
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
	cands := append([]RoleCandidate{}, parseRoleCandidates(string(out))...)
	for i := range cands {
		if cands[i].Type == "mqtt-broker" && strings.HasPrefix(cands[i].Process, "mosquitto") {
			describeMosquitto(ctx, &cands[i])
		}
	}
	return cands
}
