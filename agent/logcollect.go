//go:build !windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Capability docker_log_collect (homelab#346): the journals of the containers of this host are sent to a log server, a
// role of the hub (hub/src/dockerLogs.ts). The agent never carries a log. It sets the Docker daemon so that json-file
// copies the compose labels into every line (attrs: stack and service), and runs a Fluent Bit collector that reads
// those files, finds the severity in the text, and sends the lines in syslog (RFC 5424, TCP) to the listener of the
// server that tags them source=docker. The hub sends an address and a port, never a path, a command or a configuration:
// the configuration is fixed here and changes with the versions of the agent.

// LogCollectSpec: where the journals of the containers go. Address "": the collector is removed.
type LogCollectSpec struct {
	Address  string `json:"address"`
	Port     int    `json:"port,omitempty"`
	Protocol string `json:"protocol,omitempty"` // tcp
}

// LogCollectState: what is in place, sent with the Docker report while the collector is set up on this host.
type LogCollectState struct {
	Address string `json:"address"`
	Port    int    `json:"port"`
	// ok | drift: the daemon writes json-file with the compose labels (detail: why not)
	Daemon       string `json:"daemon"`
	DaemonDetail string `json:"daemonDetail,omitempty"`
	// running | stopped | absent
	Collector string `json:"collector"`
	// the server does not accept a connection where the collector sends ("" when it does)
	Unreachable string `json:"unreachable,omitempty"`
}

const (
	daemonConfigPath = "/etc/docker/daemon.json"
	// compose project of the collector: its own containers are not collected
	logCollectorProject = "homelab-log-collector"
	logCollectorImage   = "fluent/fluent-bit:5.1.5@sha256:2740f387f6e68fab66d28e4fa6a853387b9cab6ffb4cb78958f69bba4eb0e7b4"
	// SD-ID of the structured data of each line: the server names the fields <SD-ID>.<param>. Provisional: 32473 is the
	// enterprise number of the documentation (RFC 5612), to replace by the IANA number of Homelab Manager.
	logCollectSDID = "hlm@32473"
	// where the collector reads the files of the containers, inside its container
	collectorContainersDir = "/var/lib/docker/containers"
	logCollectHead         = "# Géré par Homelab Manager (journaux des conteneurs Docker) : les modifications locales seront écrasées.\n"
)

// the labels json-file copies into each line; the lines of containers without them (outside compose) are not sent
var logLabels = []string{labelProject, labelService}

// log-opts json-file knows: the others (journald tag, syslog address...) would keep the daemon from starting
var jsonFileOpts = map[string]bool{"max-size": true, "max-file": true, "labels": true, "labels-regex": true, "env": true, "env-regex": true, "compress": true}

var logHostnameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$`)

func validateLogCollect(l *LogCollectSpec) error {
	if l == nil {
		return fmt.Errorf("docker_log_collect without its server")
	}
	if l.Address == "" {
		return nil
	}
	if !logAddressRe.MatchString(l.Address) || l.Port < 1 || l.Port > 65535 || l.Protocol != "tcp" {
		return fmt.Errorf("invalid log server")
	}
	return nil
}

func logCollectorDir() string { return filepath.Join(stateDir(), "log-collector") }

// --- daemon.json ---------------------------------------------------------------------------------------------------------

// mergeDaemonConfig: daemon.json with (enable) or without the log settings of the collector, every other key kept. Enable:
// json-file (log-opts it does not know dropped, they are returned), rotation 10m x 3 unless already set, the compose
// labels added. Disable: the compose labels removed only. changed: false when the result means the same as cur (the file
// is then left as it is).
func mergeDaemonConfig(cur []byte, enable bool) (out []byte, changed bool, dropped []string, err error) {
	m := map[string]any{}
	if len(bytes.TrimSpace(cur)) > 0 {
		if err := json.Unmarshal(cur, &m); err != nil {
			return nil, false, nil, fmt.Errorf("%s is not valid JSON: %v", daemonConfigPath, err)
		}
	}
	before, _ := json.Marshal(m)
	var orig map[string]any
	_ = json.Unmarshal(before, &orig)

	opts := map[string]any{}
	if o, ok := m["log-opts"].(map[string]any); ok {
		opts = o
	} else if m["log-opts"] != nil {
		return nil, false, nil, fmt.Errorf("%s: log-opts is not an object", daemonConfigPath)
	}
	labels := []string{}
	if s, ok := opts["labels"].(string); ok {
		labels = splitList(s)
	}
	if enable {
		if d, _ := m["log-driver"].(string); d != "json-file" {
			m["log-driver"] = "json-file"
			for k := range opts {
				if !jsonFileOpts[k] {
					dropped = append(dropped, k)
					delete(opts, k)
				}
			}
			sort.Strings(dropped)
		}
		if _, ok := opts["max-size"]; !ok {
			opts["max-size"] = "10m"
		}
		if _, ok := opts["max-file"]; !ok {
			opts["max-file"] = "3"
		}
		for _, l := range logLabels {
			if !contains(labels, l) {
				labels = append(labels, l)
			}
		}
	} else {
		labels = withoutAll(labels, logLabels)
	}
	if len(labels) > 0 {
		opts["labels"] = strings.Join(labels, ",")
	} else {
		delete(opts, "labels")
	}
	if len(opts) > 0 {
		m["log-opts"] = opts
	} else {
		delete(m, "log-opts")
	}
	after, _ := json.Marshal(m)
	var next map[string]any
	_ = json.Unmarshal(after, &next)
	if reflect.DeepEqual(orig, next) {
		return cur, false, dropped, nil
	}
	out, _ = json.MarshalIndent(m, "", "  ")
	return append(out, '\n'), true, dropped, nil
}

// daemonLogDrift: why daemon.json does not write the compose labels with json-file ("" when it does).
func daemonLogDrift(cur []byte) string {
	_, changed, _, err := mergeDaemonConfig(cur, true)
	switch {
	case err != nil:
		return err.Error()
	case changed:
		return daemonConfigPath + " does not set json-file with the compose labels"
	}
	return ""
}

// logFollowed: the container was created with the log settings of the collector (json-file and the compose labels).
func logFollowed(driver string, config map[string]string) bool {
	if driver != "json-file" {
		return false
	}
	labels := splitList(config["labels"])
	for _, l := range logLabels {
		if !contains(labels, l) {
			return false
		}
	}
	return true
}

// validateDaemonConfig: dockerd --validate (Docker 23+); skipped when this dockerd does not know the flag.
func validateDaemonConfig(ctx context.Context, content []byte) error {
	bin, err := exec.LookPath("dockerd")
	if err != nil {
		return nil
	}
	f, err := os.CreateTemp("", "daemon-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(content); err != nil {
		f.Close()
		return err
	}
	f.Close()
	out, err := exec.CommandContext(ctx, bin, "--validate", "--config-file", f.Name()).CombinedOutput()
	if err != nil {
		if strings.Contains(string(out), "unknown flag") {
			return nil
		}
		return fmt.Errorf("dockerd --validate: %s", lastLines(string(out), 3))
	}
	return nil
}

// restartDocker restarts the engine and waits for its API: every container of the host stops and starts again (those
// with a restart policy).
func (d *dockerModule) restartDocker(ctx context.Context, emit func(string)) error {
	emit("$ systemctl restart docker\n")
	if out, err := exec.CommandContext(ctx, "systemctl", "restart", "docker").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl restart docker: %s", lastLines(string(out), 3))
	}
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		if _, _, ok := d.versions(ctx); ok {
			emit("Docker is running again\n")
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return fmt.Errorf("Docker did not come back within 90 s")
}

// writeDaemonConfig writes daemon.json (content nil: removed) and restarts Docker.
func (d *dockerModule) writeDaemonConfig(ctx context.Context, content []byte, emit func(string)) error {
	if content == nil {
		emit("removing " + daemonConfigPath + "\n")
		if err := os.Remove(sysPath(daemonConfigPath)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	} else {
		emit("writing " + daemonConfigPath + "\n")
		if err := writeOwned(daemonConfigPath, string(content), 0o644, nil); err != nil {
			return err
		}
	}
	return d.restartDocker(ctx, emit)
}

// --- collector -------------------------------------------------------------------------------------------------------

func renderCollectorCompose(containersDir string) string {
	return logCollectHead +
		"name: " + logCollectorProject + "\n" +
		"services:\n" +
		"  log-collector:\n" +
		"    image: " + logCollectorImage + "\n" +
		"    container_name: " + logCollectorProject + "\n" +
		"    restart: unless-stopped\n" +
		"    command: [\"/fluent-bit/bin/fluent-bit\", \"-c\", \"/fluent-bit/etc/fluent-bit.yaml\"]\n" +
		"    volumes:\n" +
		"      - ./fluent-bit.yaml:/fluent-bit/etc/fluent-bit.yaml:ro\n" +
		"      - ./parsers.yaml:/fluent-bit/etc/parsers.yaml:ro\n" +
		"      - ./db:/fluent-bit/db\n" +
		"      - " + containersDir + ":" + collectorContainersDir + ":ro\n" +
		"    read_only: true\n" +
		"    cap_drop: [ALL]\n" +
		"    # the files of the containers belong to root\n" +
		"    cap_add: [DAC_READ_SEARCH]\n" +
		"    security_opt:\n" +
		"      - no-new-privileges:true\n"
}

const collectorParsers = `parsers:
  - name: docker_json
    format: json
    time_key: time
    time_format: "%Y-%m-%dT%H:%M:%S.%L"
    time_keep: off
  - name: trim_newline
    format: regex
    regex: '^(?<log>.*?)\r?\n?$'
  - name: docker_path
    format: regex
    regex: '^` + collectorContainersDir + `/(?<container_id>[0-9a-f]{12})[0-9a-f]{52}/'
`

// severity rules: the first that matches wins (modify "add" never overwrites a field). Levels written by the application
// first (pino numbers, MongoDB "s", "level" in JSON or logfmt), then words of the text; info otherwise, whatever the
// stream (many applications write everything to stderr).
var severityRules = []struct{ re, severity string }{
	{`(?i)("level":\s*60|"s":"F"|"level":\s*"(fatal|panic|crit|critical|emerg|alert)"|level=(fatal|panic|crit|critical))`, "2"},
	{`(?i)("level":\s*50|"s":"E"|"level":\s*"(error|err)"|level=(error|err))`, "3"},
	{`(?i)("level":\s*40|"s":"W"|"level":\s*"(warn|warning)"|level=(warn|warning))`, "4"},
	{`(?i)("level":\s*(10|20|30)|"s":"(I|D\d?)"|"level":\s*"(info|debug|trace)"|level=(info|debug|trace))`, "6"},
	{`(?i)\b(fatal|panic|critical)\b`, "2"},
	{`(?i)\b(error|exception|failed|failure)\b`, "3"},
	{`(?i)\b(warn|warning)\b`, "4"},
}

func renderCollectorConfig(hostname string, l *LogCollectSpec) string {
	var b strings.Builder
	b.WriteString(logCollectHead)
	b.WriteString(`service:
  flush: 2
  log_level: warn
  parsers_file: /fluent-bit/etc/parsers.yaml
  storage.path: /fluent-bit/db/storage
  storage.sync: normal

pipeline:
  inputs:
    - name: tail
      tag: docker
      path: ` + collectorContainersDir + `/*/*-json.log
      path_key: filepath
      parser: docker_json
      docker_mode: on
      db: /fluent-bit/db/tail.db
      read_from_head: false
      skip_long_lines: on
      refresh_interval: 2
      mem_buf_limit: 10MB
      storage.type: filesystem

  filters:
    # compose labels (attrs) -> fields of their own
    - name: nest
      match: docker
      operation: lift
      nested_under: attrs
    - name: modify
      match: docker
      rename:
        - ` + labelProject + ` compose_project
        - ` + labelService + ` app_name
    - name: parser
      match: docker
      key_name: filepath
      parser: docker_path
      reserve_data: on
    - name: parser
      match: docker
      key_name: log
      parser: trim_newline
      reserve_data: on
    # containers outside compose (no service) and the collector itself are not sent
    - name: grep
      match: docker
      regex:
        - app_name .+
    - name: grep
      match: docker
      exclude:
        - compose_project ^` + logCollectorProject + `$
`)
	for _, r := range severityRules {
		b.WriteString("    - name: modify\n      match: docker\n      condition:\n        - key_value_matches log " + r.re + "\n      add:\n        - severity " + r.severity + "\n")
	}
	b.WriteString(`    - name: modify
      match: docker
      add:
        - severity 6
        - hostname ` + hostname + `
      remove:
        - filepath
    # the other fields -> structured data of the line, [` + logCollectSDID + ` ...]
    - name: nest
      match: docker
      operation: nest
      wildcard:
        - compose_project
        - container_id
        - stream
      nest_under: ` + logCollectSDID + `

  outputs:
    - name: syslog
      match: docker
      host: ` + l.Address + `
      port: ` + strconv.Itoa(l.Port) + `
      mode: tcp
      syslog_format: rfc5424
      syslog_maxsize: 8192
      syslog_severity_key: severity
      syslog_hostname_key: hostname
      syslog_appname_key: app_name
      syslog_message_key: log
      syslog_sd_key: ` + logCollectSDID + `
      retry_limit: no_limits
      storage.total_limit_size: 100M
`)
	return b.String()
}

// logHostname: the name the lines carry, the one rsyslog gives the journals of the host (without the domain).
func logHostname() (string, error) {
	h, err := os.Hostname()
	if err != nil {
		return "", err
	}
	if i := strings.IndexByte(h, '.'); i > 0 {
		h = h[:i]
	}
	if !logHostnameRe.MatchString(h) {
		return "", fmt.Errorf("host name %q cannot be sent in syslog", h)
	}
	return h, nil
}

// containersDir: where this engine keeps the files of the containers (data-root of daemon.json).
func (d *dockerModule) containersDir(ctx context.Context) string {
	var info struct {
		DockerRootDir string `json:"DockerRootDir"`
	}
	if d.client.get(ctx, "/info", &info) == nil && filepath.IsAbs(info.DockerRootDir) {
		return filepath.Join(info.DockerRootDir, "containers")
	}
	return "/var/lib/docker/containers"
}

type collectorFiles map[string]string // name in logCollectorDir -> content

func readCollectorFiles() collectorFiles {
	out := collectorFiles{}
	for _, n := range []string{"compose.yaml", "fluent-bit.yaml", "parsers.yaml", "state.json"} {
		if b, err := os.ReadFile(filepath.Join(logCollectorDir(), n)); err == nil {
			out[n] = string(b)
		}
	}
	return out
}

func writeCollectorFiles(files collectorFiles) error {
	dir := logCollectorDir()
	if err := os.MkdirAll(filepath.Join(dir, "db"), 0o700); err != nil {
		return err
	}
	for n, c := range files {
		if err := writeFileAtomic(filepath.Join(dir, n), []byte(c), 0o600); err != nil {
			return err
		}
	}
	return nil
}

func (d *dockerModule) collectorCompose(ctx context.Context, emit func(string), args ...string) (int, error) {
	full := append([]string{"compose", "--ansi", "never", "-p", logCollectorProject, "-f", filepath.Join(logCollectorDir(), "compose.yaml")}, args...)
	emit("$ docker compose -p " + logCollectorProject + " " + strings.Join(args, " ") + "\n")
	return runStreaming(ctx, dockerEnv(), emit, "docker", full...)
}

// removeCollector stops the collector and removes its directory (its position in the files with it).
func (d *dockerModule) removeCollector(ctx context.Context, emit func(string)) error {
	if _, err := os.Stat(filepath.Join(logCollectorDir(), "compose.yaml")); err == nil {
		if code, err := d.collectorCompose(ctx, emit, "down", "--remove-orphans"); code != 0 || err != nil {
			return fmt.Errorf("the collector could not be stopped (exit %d): %v", code, err)
		}
	}
	emit("removing " + logCollectorDir() + "\n")
	return os.RemoveAll(logCollectorDir())
}

// --- job -------------------------------------------------------------------------------------------------------------

// applyLogCollect: the job docker_log_collect. Nothing is changed when the server refuses the connection; a step that
// fails puts back what the job changed before it (daemon.json, collector).
func (d *dockerModule) applyLogCollect(ctx context.Context, l *LogCollectSpec, emit func(string)) (int, error) {
	if err := validateLogCollect(l); err != nil {
		return -1, err
	}
	prevDaemon, hadDaemon := readFile(daemonConfigPath)
	if l.Address == "" {
		return d.disableLogCollect(ctx, []byte(prevDaemon), hadDaemon, emit)
	}
	hostname, err := logHostname()
	if err != nil {
		return -1, err
	}
	if err := dialLogServer(ctx, &LogForwardSpec{Address: l.Address, Port: l.Port, Protocol: l.Protocol}); err != nil {
		return -1, err
	}

	// 1. the daemon: json-file with the compose labels, Docker restarted when it changed
	next, changed, dropped, err := mergeDaemonConfig([]byte(prevDaemon), true)
	if err != nil {
		return -1, err
	}
	if changed {
		if len(dropped) > 0 {
			emit("log-opts not known by json-file, removed: " + strings.Join(dropped, ", ") + "\n")
		}
		if err := validateDaemonConfig(ctx, next); err != nil {
			return -1, err
		}
		emit("Docker restarts: every container of the host stops and starts again\n")
		if err := d.writeDaemonConfig(ctx, next, emit); err != nil {
			return -1, d.restoreDaemon(ctx, prevDaemon, hadDaemon, err, emit)
		}
	} else {
		emit(daemonConfigPath + " already sets json-file with the compose labels\n")
	}

	// 2. the collector
	prevFiles := readCollectorFiles()
	state, _ := json.Marshal(map[string]any{"address": l.Address, "port": l.Port})
	files := collectorFiles{
		"compose.yaml":    renderCollectorCompose(d.containersDir(ctx)),
		"fluent-bit.yaml": renderCollectorConfig(hostname, l),
		"parsers.yaml":    collectorParsers,
		"state.json":      string(state) + "\n",
	}
	fail := func(err error) (int, error) {
		emit("putting back the previous state\n")
		if len(prevFiles) > 0 && writeCollectorFiles(prevFiles) == nil {
			_, _ = d.collectorCompose(ctx, emit, "up", "-d", "--force-recreate")
		} else {
			_ = d.removeCollector(ctx, emit)
		}
		if changed {
			return -1, d.restoreDaemon(ctx, prevDaemon, hadDaemon, err, emit)
		}
		return -1, err
	}
	if err := writeCollectorFiles(files); err != nil {
		return fail(err)
	}
	if code, err := d.collectorCompose(ctx, emit, "up", "-d", "--force-recreate", "--remove-orphans"); code != 0 || err != nil {
		if err == nil {
			err = fmt.Errorf("docker compose up exited with %d", code)
		}
		return fail(err)
	}
	emit("the journals of the containers are sent to " + l.Address + ":" + strconv.Itoa(l.Port) + "\n")
	emit("containers created before are sent once recreated (docker compose up -d --force-recreate)\n")
	return 0, nil
}

// disableLogCollect removes the collector and the compose labels of daemon.json. Docker is not restarted for it: the
// labels are harmless, they go at its next restart.
func (d *dockerModule) disableLogCollect(ctx context.Context, prevDaemon []byte, hadDaemon bool, emit func(string)) (int, error) {
	if err := d.removeCollector(ctx, emit); err != nil {
		return -1, err
	}
	if !hadDaemon {
		return 0, nil
	}
	next, changed, _, err := mergeDaemonConfig(prevDaemon, false)
	if err != nil || !changed {
		return 0, err
	}
	emit("writing " + daemonConfigPath + " (applied at the next restart of Docker)\n")
	if err := writeOwned(daemonConfigPath, string(next), 0o644, nil); err != nil {
		return -1, err
	}
	return 0, nil
}

// restoreDaemon puts the previous daemon.json back (removed when there was none) and restarts Docker again.
func (d *dockerModule) restoreDaemon(ctx context.Context, prev string, had bool, cause error, emit func(string)) error {
	var content []byte
	if had {
		content = []byte(prev)
	}
	if err := d.writeDaemonConfig(ctx, content, emit); err != nil {
		return fmt.Errorf("%v; putting back %s failed too: %v", cause, daemonConfigPath, err)
	}
	return cause
}

// --- report ----------------------------------------------------------------------------------------------------------

// logCollectState: the collector as it is, nil when it is not set up on this host.
func (d *dockerModule) logCollectState(ctx context.Context) *LogCollectState {
	raw, ok := readCollectorFiles()["state.json"]
	if !ok {
		return nil
	}
	var spec LogCollectSpec
	if json.Unmarshal([]byte(raw), &spec) != nil {
		return nil
	}
	st := &LogCollectState{Address: spec.Address, Port: spec.Port, Daemon: "ok", Collector: "absent"}
	cur, _ := readFile(daemonConfigPath)
	if why := daemonLogDrift([]byte(cur)); why != "" {
		st.Daemon, st.DaemonDetail = "drift", why
	} else {
		// the file is right but Docker may not have been restarted since
		var info struct {
			LoggingDriver string `json:"LoggingDriver"`
		}
		if d.client.get(ctx, "/info", &info) == nil && info.LoggingDriver != "json-file" {
			st.Daemon, st.DaemonDetail = "drift", "Docker still logs with "+info.LoggingDriver+": restart it"
		}
	}
	var ins struct {
		State struct {
			Running bool `json:"Running"`
		} `json:"State"`
	}
	if err := d.client.get(ctx, "/containers/"+logCollectorProject+"/json", &ins); err == nil {
		st.Collector = "stopped"
		if ins.State.Running {
			st.Collector = "running"
		}
	}
	spec.Protocol = "tcp"
	if err := dialLogServer(ctx, &LogForwardSpec{Address: spec.Address, Port: spec.Port, Protocol: spec.Protocol}); err != nil {
		st.Unreachable = err.Error()
	}
	return st
}

// markLogFollowed tells, for each container of the stacks, whether its lines reach the collector (created with the log
// settings of the collector). Only while the collector is set up: one inspection per container.
func (d *dockerModule) markLogFollowed(ctx context.Context, stacks []DockerStack) {
	for i := range stacks {
		for j := range stacks[i].Services {
			cs := stacks[i].Services[j].Containers
			for k := range cs {
				var ins struct {
					HostConfig struct {
						LogConfig struct {
							Type   string            `json:"Type"`
							Config map[string]string `json:"Config"`
						} `json:"LogConfig"`
					} `json:"HostConfig"`
				}
				if d.client.get(ctx, "/containers/"+cs[k].ID+"/json", &ins) == nil {
					f := logFollowed(ins.HostConfig.LogConfig.Type, ins.HostConfig.LogConfig.Config)
					cs[k].LogFollowed = &f
				}
			}
		}
	}
}
