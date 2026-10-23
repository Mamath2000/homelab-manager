//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func writeSysTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, value := range files {
		p := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(value+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCollectHealthRaid(t *testing.T) {
	root := t.TempDir()
	writeSysTree(t, root, map[string]string{
		// canicoif: healthy RAID5 with corrected read errors on one member
		"md0/md/level": "raid5", "md0/md/array_state": "clean", "md0/md/raid_disks": "4", "md0/md/degraded": "0",
		"md0/md/sync_action": "idle", "md0/md/sync_completed": "none", "md0/md/mismatch_cnt": "0",
		"md0/md/dev-sdb1/state": "in_sync", "md0/md/dev-sdb1/slot": "0", "md0/md/dev-sdb1/errors": "0",
		"md0/md/dev-sdd1/state": "in_sync", "md0/md/dev-sdd1/slot": "2", "md0/md/dev-sdd1/errors": "8",
		// degraded RAID1 rebuilding on a spare
		"md1/md/level": "raid1", "md1/md/array_state": "active", "md1/md/raid_disks": "2", "md1/md/degraded": "1",
		"md1/md/sync_action": "recover", "md1/md/sync_completed": "250 / 1000", "md1/md/mismatch_cnt": "0",
		"md1/md/dev-sda2/state": "in_sync", "md1/md/dev-sda2/slot": "0", "md1/md/dev-sda2/errors": "0",
		"md1/md/dev-sdf2/state": "spare", "md1/md/dev-sdf2/slot": "none", "md1/md/dev-sdf2/errors": "0",
		"md1/md/dev-sdg2/state": "faulty", "md1/md/dev-sdg2/slot": "none", "md1/md/dev-sdg2/errors": "12",
	})
	// a non-md block device and an md device without md/ (Unraid's driver) are ignored
	writeSysTree(t, root, map[string]string{"sda/size": "100", "md2p1/size": "100"})
	previous := healthRaidSysRoot
	healthRaidSysRoot = root
	defer func() { healthRaidSysRoot = previous }()

	arrays := collectMdArrays()
	if len(arrays) != 2 {
		t.Fatalf("arrays = %+v", arrays)
	}
	md0, md1 := arrays[0], arrays[1]
	if md0.Name != "md0" || md0.Level != "raid5" || md0.State != "clean" || md0.RaidDisks != 4 || md0.Degraded != 0 || md0.SyncAction != "idle" || md0.SyncPercent != nil {
		t.Fatalf("md0 = %+v", md0)
	}
	if len(md0.Members) != 2 || md0.Members[1].Device != "sdd1" || md0.Members[1].Errors != 8 || *md0.Members[1].Slot != 2 {
		t.Fatalf("md0 members = %+v", md0.Members)
	}
	if md1.Degraded != 1 || md1.SyncAction != "recover" || md1.SyncPercent == nil || *md1.SyncPercent != 25 {
		t.Fatalf("md1 = %+v", md1)
	}
	if len(md1.Members) != 3 || md1.Members[1].Slot != nil || md1.Members[2].State != "faulty" {
		t.Fatalf("md1 members = %+v", md1.Members)
	}
}

func TestCollectHealthRaidWithoutArrays(t *testing.T) {
	previous := healthRaidSysRoot
	healthRaidSysRoot = t.TempDir()
	defer func() { healthRaidSysRoot = previous }()
	if arrays := collectMdArrays(); arrays == nil || len(arrays) != 0 {
		t.Fatalf("arrays = %+v", arrays)
	}
}
