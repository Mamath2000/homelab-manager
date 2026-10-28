//go:build !windows

package main

import (
	"bufio"
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Unraid array and pools, as emhttp describes them in /var/local/emhttp (var.ini, disks.ini): read-only, the files are
// rewritten by emhttp on each change. Its md driver has no /sys/block/mdX/md, so collectMdArrays does not see it.
var healthUnraidRoot = "/var/local/emhttp"

func isUnraidHealth() bool {
	_, err1 := os.Stat(filepath.Join(healthUnraidRoot, "var.ini"))
	_, err2 := os.Stat(filepath.Join(healthUnraidRoot, "disks.ini"))
	return err1 == nil && err2 == nil
}

type iniSection struct {
	name   string
	values map[string]string
}

// readEmhttpIni reads an emhttp ini file: `["section"]` headers (none in var.ini) and `key="value"` lines.
func readEmhttpIni(name string) []iniSection {
	f, err := os.Open(filepath.Join(healthUnraidRoot, name))
	if err != nil {
		return nil
	}
	defer f.Close()
	sections := []iniSection{{values: map[string]string{}}}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			sections = append(sections, iniSection{name: strings.Trim(line, `[]"`), values: map[string]string{}})
			continue
		}
		if k, v, ok := strings.Cut(line, "="); ok {
			sections[len(sections)-1].values[k] = strings.Trim(v, `"`)
		}
	}
	return sections
}

func iniInt(values map[string]string, key string) int64 {
	n, _ := strconv.ParseInt(values[key], 10, 64)
	return n
}

// unraidEmptySlot: a slot with no disk assigned. An unassigned parity slot is also "disabled"; a data slot that is
// absent and disabled is a removed disk being emulated, not an empty slot.
func unraidEmptySlot(typ, status string) bool {
	return status == "DISK_NP" || (typ == "Parity" && status == "DISK_NP_DSBL")
}

func collectHealthUnraid(ctx context.Context, run pveRun) *HealthUnraid {
	vars := readEmhttpIni("var.ini")[0].values
	u := &HealthUnraid{State: vars["mdState"], Disks: []HealthUnraidDisk{}, Pools: []HealthUnraidPool{}}
	if pos, size := iniInt(vars, "mdResyncPos"), iniInt(vars, "mdResyncSize"); pos > 0 && size > 0 {
		p := float64(pos) / float64(size) * 100
		u.SyncAction, u.SyncPercent = vars["mdResyncAction"], &p
	}
	if started := iniInt(vars, "sbSynced"); started > 0 {
		c := &HealthUnraidCheck{StartedAt: started * 1000, Errors: uint64(max(iniInt(vars, "sbSyncErrs"), 0)), Exit: int(iniInt(vars, "sbSyncExit"))}
		if finished := iniInt(vars, "sbSynced2"); finished >= started {
			c.FinishedAt = finished * 1000
		}
		u.LastCheck = c
	}

	disks := readEmhttpIni("disks.ini")
	byName := map[string]map[string]string{}
	for _, s := range disks {
		byName[s.name] = s.values
	}
	disk := func(v map[string]string) HealthUnraidDisk {
		return HealthUnraidDisk{Name: v["name"], Type: v["type"], Device: v["device"], Status: v["status"], Errors: uint64(max(iniInt(v, "numErrors"), 0))}
	}
	for _, s := range disks {
		v := s.values
		switch {
		case v["type"] == "Parity" || v["type"] == "Data":
			if !unraidEmptySlot(v["type"], v["status"]) {
				u.Disks = append(u.Disks, disk(v))
			}
		// a pool is described by its first device (fsMountpoint, devices...); the others are <pool>2, <pool>3...
		case v["type"] == "Cache" && v["fsMountpoint"] != "":
			p := HealthUnraidPool{Name: s.name, FsType: v["fsType"], Profile: v["fsProfile"], Devices: int(iniInt(v, "devices")), DevicesExpected: int(iniInt(v, "devicesSb")), Disks: []HealthUnraidDisk{}}
			stats := map[string]uint64{}
			if p.FsType == "btrfs" {
				stats = btrfsDeviceErrors(ctx, run, v["fsMountpoint"])
			} else if p.FsType == "zfs" {
				p.Health = zpoolHealth(ctx, run, s.name)
			}
			for i := 1; i <= max(int(iniInt(v, "slots")), 1); i++ {
				name := s.name
				if i > 1 {
					name += strconv.Itoa(i)
				}
				dv, ok := byName[name]
				if !ok || dv["status"] == "DISK_NP" {
					continue
				}
				d := disk(dv)
				if n, ok := stats["/dev/"+dv["deviceSb"]]; ok {
					d.FsErrors = &n
				}
				p.Disks = append(p.Disks, d)
			}
			u.Pools = append(u.Pools, p)
		}
	}
	return u
}

var btrfsStatRe = regexp.MustCompile(`^\[(.+)\]\.\w+_errs\s+(\d+)$`)

// btrfsDeviceErrors: sum of the error counters of `btrfs device stats` per device.
func btrfsDeviceErrors(ctx context.Context, run pveRun, mountpoint string) map[string]uint64 {
	errs := map[string]uint64{}
	out, err := run(ctx, "btrfs", "device", "stats", mountpoint)
	if err != nil {
		return errs
	}
	for _, line := range strings.Split(out, "\n") {
		if m := btrfsStatRe.FindStringSubmatch(strings.TrimSpace(line)); m != nil {
			n, _ := strconv.ParseUint(m[2], 10, 64)
			errs[m[1]] += n
		}
	}
	return errs
}

func zpoolHealth(ctx context.Context, run pveRun, pool string) string {
	out, err := run(ctx, "zpool", "list", "-H", "-o", "health", pool)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}
