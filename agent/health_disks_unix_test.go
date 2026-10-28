//go:build !windows

package main

import "testing"

func TestIsHealthStoragePartition(t *testing.T) {
	tests := []struct {
		device     string
		filesystem string
		want       bool
	}{
		{"/dev/sda1", "vfat", true},
		{"/dev/md1p1", "xfs", true},
		{"/dev/nvme1n1p1", "btrfs", true},
		{"tank/data", "zfs", true},
		{"/dev/loop2", "btrfs", false},
		{"/dev/loop1", "squashfs", false},
		{"/dev/loop-control", "none", false},
		{"/dev/sda1", "overlay", false},
		{"server:/export", "nfs", false},
		{"tmpfs", "tmpfs", false},
	}

	for _, tt := range tests {
		t.Run(tt.device+"_"+tt.filesystem, func(t *testing.T) {
			if got := isHealthStoragePartition(tt.device, tt.filesystem); got != tt.want {
				t.Errorf("isHealthStoragePartition(%q, %q) = %t, want %t", tt.device, tt.filesystem, got, tt.want)
			}
		})
	}
}

func TestBootEFIMountpointIsExcluded(t *testing.T) {
	if !isHealthExcludedMountpoint("/boot/efi") {
		t.Fatal("/boot/efi should be excluded")
	}
	if isHealthExcludedMountpoint("/boot/efi-data") {
		t.Fatal("similarly named mountpoint should not be excluded")
	}
}

func TestContainerStorageMountpointsAreExcluded(t *testing.T) {
	for _, m := range []string{"/var/lib/docker", "/var/lib/containerd", "/var/lib/docker/overlay2"} {
		if !isHealthExcludedMountpoint(m) {
			t.Errorf("%s should be excluded", m)
		}
	}
	if isHealthExcludedMountpoint("/var/lib/dockerdata") {
		t.Fatal("similarly named mountpoint should not be excluded")
	}
}
