//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// a sysfs tree: sda with partition sda1, md0 over sdb1 + sdc1, dm-0 (LVM) over nvme0n1p3
func fakeBlockSys(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	devices := filepath.Join(root, "devices")
	class := filepath.Join(root, "class")
	mk := func(path string) {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	link := func(target, name string) {
		if err := os.Symlink(target, filepath.Join(class, name)); err != nil {
			t.Fatal(err)
		}
	}
	mk(class)
	for _, disk := range []struct{ disk, part string }{{"sda", "sda1"}, {"sdb", "sdb1"}, {"sdc", "sdc1"}, {"nvme0n1", "nvme0n1p3"}} {
		mk(filepath.Join(devices, disk.disk, disk.part))
		if err := os.WriteFile(filepath.Join(devices, disk.disk, disk.part, "partition"), []byte("1"), 0o644); err != nil {
			t.Fatal(err)
		}
		link(filepath.Join(devices, disk.disk), disk.disk)
		link(filepath.Join(devices, disk.disk, disk.part), disk.part)
	}
	for _, v := range []struct {
		name   string
		slaves []string
	}{{"md0", []string{"sdb1", "sdc1"}}, {"dm-0", []string{"nvme0n1p3"}}} {
		mk(filepath.Join(devices, v.name, "slaves"))
		for _, s := range v.slaves {
			mk(filepath.Join(devices, v.name, "slaves", s))
		}
		link(filepath.Join(devices, v.name), v.name)
	}
	return class
}

func TestVolumeDisks(t *testing.T) {
	prev := healthBlockSysRoot
	healthBlockSysRoot = fakeBlockSys(t)
	defer func() { healthBlockSysRoot = prev }()
	for device, want := range map[string][]string{
		"/dev/sda1":      {"/dev/sda"},
		"/dev/sda":       {"/dev/sda"},
		"/dev/md0":       {"/dev/sdb", "/dev/sdc"},
		"/dev/dm-0":      {"/dev/nvme0n1"},
		"/dev/zz9":       nil,
		"rpool/ROOT/pve": nil,
	} {
		if got := volumeDisks(device); !reflect.DeepEqual(got, want) {
			t.Errorf("volumeDisks(%s) = %v, want %v", device, got, want)
		}
	}
}
