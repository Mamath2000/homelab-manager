//go:build !windows

package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

var healthPseudoFilesystems = map[string]struct{}{
	"autofs": {}, "cgroup": {}, "cgroup2": {}, "configfs": {}, "debugfs": {},
	"devpts": {}, "devtmpfs": {}, "efivarfs": {}, "fusectl": {}, "hugetlbfs": {},
	"mqueue": {}, "nfs": {}, "nfs4": {}, "overlay": {}, "proc": {}, "pstore": {},
	"ramfs": {}, "securityfs": {}, "squashfs": {}, "sysfs": {}, "tmpfs": {},
	"tracefs": {}, "cifs": {}, "smb3": {}, "9p": {}, "ceph": {}, "fuse.sshfs": {},
}

func isHealthStoragePartition(device, filesystem string) bool {
	if _, excluded := healthPseudoFilesystems[strings.ToLower(filesystem)]; excluded {
		return false
	}
	if strings.HasPrefix(device, "/dev/") {
		base := filepath.Base(device)
		if !strings.HasPrefix(base, "loop") {
			return true
		}
		if _, err := strconv.Atoi(strings.TrimPrefix(base, "loop")); err == nil || base == "loop-control" {
			return false
		}
	}
	return true
}

func collectHAOSHealthDisks() (*HealthDisks, error) {
	var host struct {
		DiskFree  *float64 `json:"disk_free"`
		DiskTotal *float64 `json:"disk_total"`
		DiskUsed  *float64 `json:"disk_used"`
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := supervisorGet(ctx, "/host/info", &host); err != nil {
		return nil, err
	}
	r := &HealthDisks{CheckedAt: time.Now().UnixMilli(), Volumes: []HealthVolume{}}
	if host.DiskTotal == nil || *host.DiskTotal <= 0 {
		return r, nil
	}
	used := host.DiskUsed
	if used == nil && host.DiskFree != nil {
		value := *host.DiskTotal - *host.DiskFree
		used = &value
	}
	if used == nil || *used < 0 || *used > *host.DiskTotal {
		return nil, fmt.Errorf("Supervisor /host/info returned invalid disk usage")
	}
	// The Supervisor reports these values in GiB.
	totalBytes := uint64(*host.DiskTotal * 1024 * 1024 * 1024)
	usedBytes := uint64(*used * 1024 * 1024 * 1024)
	r.Volumes = append(r.Volumes, HealthVolume{
		Device: "haos-host", Mountpoint: "/", Fstype: "haos",
		Used: usedBytes, Total: totalBytes, Percent: *used / *host.DiskTotal * 100,
	})
	return r, nil
}

// healthBlockSysRoot: the block devices as sysfs lists them (replaced in tests).
var healthBlockSysRoot = "/sys/class/block"

// volumeDisks: the whole disks a volume lives on. A partition gives its disk (sda1 → sda); a device-mapper (LVM,
// dm-crypt) or md device gives the disks of its slaves, followed down to the bottom. Device names of /dev/mapper are
// links to /dev/dm-N. Nothing for what is not a block device (ZFS dataset, network share...).
func volumeDisks(device string) []string {
	if !strings.HasPrefix(device, "/dev/") {
		return nil
	}
	name := filepath.Base(device)
	if real, err := filepath.EvalSymlinks(device); err == nil {
		name = filepath.Base(real)
	}
	seen := map[string]bool{}
	var out []string
	var walk func(name string, depth int)
	walk = func(name string, depth int) {
		dir := filepath.Join(healthBlockSysRoot, name)
		if depth > 8 {
			return
		}
		if _, err := os.Stat(filepath.Join(dir, "partition")); err == nil {
			// sysfs puts a partition under its disk: /sys/devices/.../sda/sda1
			if real, err := filepath.EvalSymlinks(dir); err == nil {
				walk(filepath.Base(filepath.Dir(real)), depth+1)
			}
			return
		}
		slaves, _ := os.ReadDir(filepath.Join(dir, "slaves"))
		if len(slaves) > 0 {
			for _, s := range slaves {
				walk(s.Name(), depth+1)
			}
			return
		}
		if _, err := os.Stat(dir); err == nil && !seen[name] {
			seen[name] = true
			out = append(out, "/dev/"+name)
		}
	}
	walk(name, 0)
	return out
}

// volumeGroups: the LVM volume groups and their disks, from the active logical volumes sysfs lists (dm/uuid starting
// with LVM-, dm/name "vg-lv"). A volume group without any active volume is not seen.
func volumeGroups() []HealthVolumeGroup {
	entries, err := os.ReadDir(healthBlockSysRoot)
	if err != nil {
		return nil
	}
	disks := map[string][]string{}
	var names []string
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), "dm-") {
			continue
		}
		uuid, _ := os.ReadFile(filepath.Join(healthBlockSysRoot, e.Name(), "dm", "uuid"))
		name, _ := os.ReadFile(filepath.Join(healthBlockSysRoot, e.Name(), "dm", "name"))
		if !strings.HasPrefix(string(uuid), "LVM-") {
			continue
		}
		vg := lvmVolumeGroupName(strings.TrimSpace(string(name)))
		if vg == "" {
			continue
		}
		if _, known := disks[vg]; !known {
			names = append(names, vg)
			disks[vg] = []string{}
		}
		for _, d := range volumeDisks("/dev/" + e.Name()) {
			if !slices.Contains(disks[vg], d) {
				disks[vg] = append(disks[vg], d)
			}
		}
	}
	slices.Sort(names)
	var out []HealthVolumeGroup
	for _, vg := range names {
		if len(disks[vg]) > 0 {
			out = append(out, HealthVolumeGroup{Name: vg, Disks: disks[vg]})
		}
	}
	return out
}

// lvmVolumeGroupName: the volume group of a device-mapper name, where LVM doubles the dashes of the names and joins
// volume group and logical volume with a single dash: "pve-data-tpool" → "pve", "my--vg-root" → "my-vg".
func lvmVolumeGroupName(dmName string) string {
	for i := 0; i < len(dmName); i++ {
		if dmName[i] != '-' {
			continue
		}
		if i+1 < len(dmName) && dmName[i+1] == '-' {
			i++
			continue
		}
		return strings.ReplaceAll(dmName[:i], "--", "-")
	}
	return ""
}
