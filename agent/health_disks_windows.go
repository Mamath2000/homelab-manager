//go:build windows

package main

import (
	"strings"

	"golang.org/x/sys/windows"
)

func isHealthStoragePartition(_, _ string) bool {
	return true
}

func collectHAOSHealthDisks() (*HealthDisks, error) {
	return &HealthDisks{Volumes: []HealthVolume{}}, nil
}

// volumeGroups: no LVM on Windows.
func volumeGroups() []HealthVolumeGroup { return nil }

const ioctlVolumeGetVolumeDiskExtents = 0x00560000

// volumeDisks: the physical disks a drive letter (C:) lives on, from its disk extents (several for a spanned or Storage
// Spaces volume), named as smartctl names them (/dev/sda for PhysicalDrive0). Nothing when the volume cannot be opened.
func volumeDisks(device string) []string {
	letter := strings.TrimSuffix(strings.TrimSuffix(device, `\`), ":")
	if len(letter) != 1 {
		return nil
	}
	path, err := windows.UTF16PtrFromString(`\\.\` + letter + ":")
	if err != nil {
		return nil
	}
	// no access right needed for this IOCTL (FILE_ANY_ACCESS): works without opening the volume for reading
	h, err := windows.CreateFile(path, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(h)
	// VOLUME_DISK_EXTENTS: DWORD count (+4 padding), then DISK_EXTENT { DWORD DiskNumber (+4), LARGE_INTEGER x2 } = 24 bytes
	buf := make([]byte, 8+24*32)
	var n uint32
	if err := windows.DeviceIoControl(h, ioctlVolumeGetVolumeDiskExtents, nil, 0, &buf[0], uint32(len(buf)), &n, nil); err != nil {
		return nil
	}
	return diskExtentNames(buf[:n])
}
