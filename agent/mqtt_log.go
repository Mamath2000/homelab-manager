//go:build !windows

package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
)

// The end of the log file of a Mosquitto broker of this host (log_dest file), so that the hub knows who is connected and who
// was refused before it started to read the log the broker publishes on $SYS/broker/log/# (hub/src/refusedLog.ts).

const (
	logTailBytes = 768 * 1024
	logTailLines = 3000
)

// logFileOf: the last `log_dest file <path>` of the configuration, "" when the broker does not log to a file.
func logFileOf(conf []confLine) string {
	path := ""
	for _, l := range conf {
		if l.Key != "log_dest" {
			continue
		}
		if rest, ok := strings.CutPrefix(l.Value, "file "); ok {
			path = strings.TrimSpace(rest)
		}
	}
	return path
}

// tailLines returns the last n complete lines of the last max bytes of r.
func tailLines(r io.ReadSeeker, size int64, max int64, n int) ([]string, error) {
	start := size - max
	if start < 0 {
		start = 0
	}
	if _, err := r.Seek(start, io.SeekStart); err != nil {
		return nil, err
	}
	b, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(string(b), "\n")
	// a read that starts in the middle of a line drops its first, partial, line
	if start > 0 && len(lines) > 0 {
		lines = lines[1:]
	}
	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines, nil
}

// mqttLogTail: the log lines of the broker listening on port ([] when it has no log file).
func mqttLogTail(ctx context.Context, port int) (map[string][]string, error) {
	var pid int
	for _, c := range collectRoleCandidates(ctx) {
		if c.Type == "mqtt-broker" && c.Port == port && strings.HasPrefix(c.Process, "mosquitto") {
			pid = c.pid
		}
	}
	if pid <= 0 {
		return nil, fmt.Errorf("aucun broker Mosquitto sur le port %d de cet hôte", port)
	}
	conf, err := readMosquittoConf(os.DirFS("/"), configFileOf(pid), 0)
	if err != nil {
		return nil, err
	}
	path := logFileOf(conf)
	if path == "" {
		return map[string][]string{"lines": {}}, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	lines, err := tailLines(f, st.Size(), logTailBytes, logTailLines)
	if err != nil {
		return nil, err
	}
	return map[string][]string{"lines": lines}, nil
}
