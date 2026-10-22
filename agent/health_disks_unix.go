//go:build !windows

package main

import (
	"context"
	"fmt"
	"path/filepath"
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
