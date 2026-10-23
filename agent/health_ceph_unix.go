//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"
)

// Ceph cluster of a Proxmox VE node (or any host with a configured ceph CLI), read with the admin keyring of root.
// Every node reports the state of the whole cluster (fsid) and the OSDs it hosts.
var cephConfigPaths = []string{"/etc/pve/ceph.conf", "/etc/ceph/ceph.conf"}

// a cluster without quorum makes ceph wait forever: the whole collection is bounded
const cephTimeout = 20 * time.Second

func hasCephHealth() bool {
	if _, err := exec.LookPath("ceph"); err != nil {
		return false
	}
	for _, p := range cephConfigPaths {
		if _, err := os.Stat(p); err == nil {
			return true
		}
	}
	return false
}

// localNodeName: the CRUSH host bucket of the OSDs of this node, its short host name.
func localNodeName() string {
	h, _ := os.Hostname()
	name, _, _ := strings.Cut(h, ".")
	return name
}

type cephStatus struct {
	Fsid   string `json:"fsid"`
	Health struct {
		Status string `json:"status"`
	} `json:"health"`
	Osdmap struct {
		NumOsds   int `json:"num_osds"`
		NumUpOsds int `json:"num_up_osds"`
		NumInOsds int `json:"num_in_osds"`
	} `json:"osdmap"`
	Pgmap struct {
		NumPgs     int `json:"num_pgs"`
		PgsByState []struct {
			StateName string `json:"state_name"`
			Count     int    `json:"count"`
		} `json:"pgs_by_state"`
		BytesUsed  uint64 `json:"bytes_used"`
		BytesTotal uint64 `json:"bytes_total"`
	} `json:"pgmap"`
}

type cephHealthDetail struct {
	Status string `json:"status"`
	Checks map[string]struct {
		Severity string `json:"severity"`
		Summary  struct {
			Message string `json:"message"`
		} `json:"summary"`
		Detail []struct {
			Message string `json:"message"`
		} `json:"detail"`
		Muted bool `json:"muted"`
	} `json:"checks"`
}

type cephOsdTree struct {
	Nodes []struct {
		ID       int     `json:"id"`
		Name     string  `json:"name"`
		Type     string  `json:"type"`
		Status   string  `json:"status"`
		Reweight float64 `json:"reweight"`
		Children []int   `json:"children"`
	} `json:"nodes"`
}

// cephText: messages are bounded, the hub refuses longer ones.
func cephText(s string) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > 300 {
		return string(r[:299]) + "…"
	}
	return s
}

func cephJSON(ctx context.Context, run pveRun, v any, args ...string) error {
	out, err := run(ctx, "ceph", append(args, "--format", "json")...)
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(out), v)
}

func collectHealthCeph(ctx context.Context, run pveRun, node string) *HealthCeph {
	ctx, cancel := context.WithTimeout(ctx, cephTimeout)
	defer cancel()
	c := &HealthCeph{Checks: []HealthCephCheck{}, Osds: []HealthCephOsd{}}
	var status cephStatus
	var detail cephHealthDetail
	var tree cephOsdTree
	err := cephJSON(ctx, run, &status, "status")
	if err == nil {
		err = cephJSON(ctx, run, &detail, "health", "detail")
	}
	if err != nil {
		c.Error = cephText(err.Error())
		return c
	}
	c.Fsid, c.Status = status.Fsid, detail.Status
	c.OsdsTotal, c.OsdsUp, c.OsdsIn = status.Osdmap.NumOsds, status.Osdmap.NumUpOsds, status.Osdmap.NumInOsds
	c.Pgs, c.UsedBytes, c.TotalBytes = status.Pgmap.NumPgs, status.Pgmap.BytesUsed, status.Pgmap.BytesTotal
	for _, s := range status.Pgmap.PgsByState {
		if s.StateName == "active+clean" {
			c.PgsClean = s.Count
		}
	}
	for code, ch := range detail.Checks {
		check := HealthCephCheck{Code: code, Severity: ch.Severity, Message: cephText(ch.Summary.Message), Detail: []string{}, Muted: ch.Muted}
		for _, d := range ch.Detail {
			if len(check.Detail) == 10 {
				break
			}
			check.Detail = append(check.Detail, cephText(d.Message))
		}
		c.Checks = append(c.Checks, check)
	}
	sort.Slice(c.Checks, func(i, j int) bool { return c.Checks[i].Code < c.Checks[j].Code })
	// the OSDs of this node: children of its host bucket
	if cephJSON(ctx, run, &tree, "osd", "tree") == nil {
		local := map[int]bool{}
		for _, n := range tree.Nodes {
			if n.Type == "host" && n.Name == node {
				for _, id := range n.Children {
					local[id] = true
				}
			}
		}
		for _, n := range tree.Nodes {
			if n.Type == "osd" && local[n.ID] {
				c.Osds = append(c.Osds, HealthCephOsd{ID: n.ID, Name: n.Name, Up: n.Status == "up", In: n.Reweight > 0})
			}
		}
	}
	return c
}
