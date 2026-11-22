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

func TestVolumeGroups(t *testing.T) {
	prev := healthBlockSysRoot
	healthBlockSysRoot = fakeBlockSys(t)
	defer func() { healthBlockSysRoot = prev }()
	devices := filepath.Join(filepath.Dir(healthBlockSysRoot), "devices")
	dm := func(name, dmName, uuid string, slaves ...string) {
		dir := filepath.Join(devices, name)
		for _, p := range append([]string{filepath.Join(dir, "dm")}, func() (out []string) {
			for _, s := range slaves {
				out = append(out, filepath.Join(dir, "slaves", s))
			}
			return
		}()...) {
			if err := os.MkdirAll(p, 0o755); err != nil {
				t.Fatal(err)
			}
		}
		_ = os.WriteFile(filepath.Join(dir, "dm", "name"), []byte(dmName+"\n"), 0o644)
		_ = os.WriteFile(filepath.Join(dir, "dm", "uuid"), []byte(uuid+"\n"), 0o644)
		if _, err := os.Lstat(filepath.Join(healthBlockSysRoot, name)); err != nil {
			if err := os.Symlink(dir, filepath.Join(healthBlockSysRoot, name)); err != nil {
				t.Fatal(err)
			}
		}
	}
	// pve: root (dm-0, over nvme0n1p3) and a thin pool (dm-3 over dm-4 over sda1); my-vg over sdb1; a dm-crypt mapping
	dm("dm-0", "pve-root", "LVM-aaaa", "nvme0n1p3")
	dm("dm-4", "pve-data_tdata", "LVM-bbbb-tdata", "sda1")
	dm("dm-3", "pve-data-tpool", "LVM-bbbb-tpool", "dm-4")
	dm("dm-5", "my--vg-home", "LVM-cccc", "sdb1")
	dm("dm-6", "luks-1234", "CRYPT-LUKS2-1234", "sdc1")
	want := []HealthVolumeGroup{{Name: "my-vg", Disks: []string{"/dev/sdb"}}, {Name: "pve", Disks: []string{"/dev/nvme0n1", "/dev/sda"}}}
	if got := volumeGroups(); !reflect.DeepEqual(got, want) {
		t.Errorf("volumeGroups() = %+v, want %+v", got, want)
	}
	for in, want := range map[string]string{"pve-root": "pve", "pve-data-tpool": "pve", "my--vg-home": "my-vg", "a--b--c-d--e": "a-b-c", "nodash": ""} {
		if got := lvmVolumeGroupName(in); got != want {
			t.Errorf("lvmVolumeGroupName(%s) = %s, want %s", in, got, want)
		}
	}
}
