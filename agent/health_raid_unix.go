//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Linux software RAID (mdadm) as the kernel exposes it under /sys/block/mdX/md: read-only, no package nor privilege needed.
// Unraid's own md driver has no md/ directory there and is left out.
var healthRaidSysRoot = "/sys/block"

func readSysValue(dir, name string) string {
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func readSysInt(dir, name string) *int64 {
	n, err := strconv.ParseInt(readSysValue(dir, name), 10, 64)
	if err != nil {
		return nil
	}
	return &n
}

func collectHealthRaid() *HealthRaid {
	dirs, _ := filepath.Glob(filepath.Join(healthRaidSysRoot, "md*", "md"))
	sort.Strings(dirs)
	r := &HealthRaid{CheckedAt: time.Now().UnixMilli(), Arrays: []HealthRaidArray{}}
	for _, dir := range dirs {
		a := HealthRaidArray{
			Name:       filepath.Base(filepath.Dir(dir)),
			Level:      readSysValue(dir, "level"),
			State:      readSysValue(dir, "array_state"),
			SyncAction: readSysValue(dir, "sync_action"),
			Members:    []HealthRaidMember{},
		}
		if n := readSysInt(dir, "raid_disks"); n != nil {
			a.RaidDisks = int(*n)
		}
		if n := readSysInt(dir, "degraded"); n != nil {
			a.Degraded = int(*n)
		}
		if n := readSysInt(dir, "mismatch_cnt"); n != nil {
			a.MismatchCount = uint64(*n)
		}
		// sync_completed: "done / total" in sectors while a sync runs, "none" otherwise
		if done, total, ok := strings.Cut(readSysValue(dir, "sync_completed"), "/"); ok {
			d, err1 := strconv.ParseFloat(strings.TrimSpace(done), 64)
			t, err2 := strconv.ParseFloat(strings.TrimSpace(total), 64)
			if err1 == nil && err2 == nil && t > 0 {
				p := d / t * 100
				a.SyncPercent = &p
			}
		}
		members, _ := filepath.Glob(filepath.Join(dir, "dev-*"))
		sort.Strings(members)
		for _, m := range members {
			member := HealthRaidMember{
				Device: strings.TrimPrefix(filepath.Base(m), "dev-"),
				State:  readSysValue(m, "state"),
			}
			if n := readSysInt(m, "slot"); n != nil {
				slot := int(*n)
				member.Slot = &slot
			}
			if n := readSysInt(m, "errors"); n != nil {
				member.Errors = uint64(*n)
			}
			a.Members = append(a.Members, member)
		}
		r.Arrays = append(r.Arrays, a)
	}
	return r
}
