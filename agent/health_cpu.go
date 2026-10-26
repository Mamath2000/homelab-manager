package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// collectCPUCount returns the CPUs the agent can really use: the logical CPUs (cpuset/affinity aware),
// capped by the cgroup CPU quota when there is one (LXC/Docker limits can be fractional, e.g. 1.5).
func collectCPUCount() float64 {
	n := float64(runtime.NumCPU())
	if limit := cgroupCPULimit("/sys/fs/cgroup"); limit > 0 && limit < n {
		return limit
	}
	return n
}

// cgroupCPULimit reads the cgroup v2 `cpu.max` ("<quota> <period>" or "max <period>") under root,
// falling back to the v1 cpu.cfs_quota_us / cpu.cfs_period_us pair. 0 means no limit.
func cgroupCPULimit(root string) float64 {
	if data, err := os.ReadFile(filepath.Join(root, "cpu.max")); err == nil {
		return quotaRatio(strings.Fields(string(data)))
	}
	quota, err1 := os.ReadFile(filepath.Join(root, "cpu", "cpu.cfs_quota_us"))
	period, err2 := os.ReadFile(filepath.Join(root, "cpu", "cpu.cfs_period_us"))
	if err1 != nil || err2 != nil {
		return 0
	}
	return quotaRatio([]string{strings.TrimSpace(string(quota)), strings.TrimSpace(string(period))})
}

func quotaRatio(fields []string) float64 {
	if len(fields) != 2 || fields[0] == "max" {
		return 0
	}
	quota, err1 := strconv.ParseFloat(fields[0], 64)
	period, err2 := strconv.ParseFloat(fields[1], 64)
	if err1 != nil || err2 != nil || quota <= 0 || period <= 0 {
		return 0
	}
	return quota / period
}
