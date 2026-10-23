//go:build !windows

package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// emhttp files of the Unraid of vouille (2026-10-23), trimmed: healthy array with an empty data slot (disk3) and an
// unassigned second parity, a btrfs mirror pool (speed + speed2) and a single-device pool (pbs).
const unraidVarIni = `mdState="STARTED"
mdNumDisabled="1"
mdNumInvalid="1"
mdResyncPos="0"
mdResyncSize="5860522532"
mdResyncAction="check P"
sbSynced="1792720727"
sbSynced2="1792761028"
sbSyncErrs="0"
sbSyncExit="0"
`

const unraidDisksIni = `["parity"]
name="parity"
device="sdg"
status="DISK_OK"
numErrors="0"
type="Parity"
["disk1"]
name="disk1"
device="sdc"
status="DISK_OK"
numErrors="0"
type="Data"
["disk2"]
name="disk2"
device="sdh"
status="DISK_OK"
numErrors="3"
type="Data"
["disk3"]
name="disk3"
device=""
status="DISK_NP"
numErrors="0"
type="Data"
["parity2"]
name="parity2"
device=""
status="DISK_NP_DSBL"
numErrors="0"
type="Parity"
["pbs"]
name="pbs"
device="sde"
status="DISK_OK"
numErrors="0"
type="Cache"
deviceSb="sde1"
fsType="btrfs"
fsMountpoint="/mnt/pbs"
fsProfile="single"
slots="1"
devices="1"
devicesSb="1"
["speed"]
name="speed"
device="nvme0n1"
status="DISK_OK"
numErrors="0"
type="Cache"
deviceSb="nvme0n1p1"
fsType="btrfs"
fsMountpoint="/mnt/speed"
fsProfile="raid1"
slots="2"
devices="2"
devicesSb="2"
["speed2"]
name="speed2"
device="nvme1n1"
status="DISK_OK"
numErrors="0"
type="Cache"
deviceSb="nvme1n1p1"
["flash"]
name="flash"
device="sda"
status="DISK_OK"
type="Flash"
`

func TestCollectHealthUnraid(t *testing.T) {
	root := t.TempDir()
	for name, content := range map[string]string{"var.ini": unraidVarIni, "disks.ini": unraidDisksIni} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	previous := healthUnraidRoot
	healthUnraidRoot = root
	defer func() { healthUnraidRoot = previous }()
	if !isUnraidHealth() {
		t.Fatal("not detected")
	}
	run := func(_ context.Context, bin string, args ...string) (string, error) {
		if bin+" "+strings.Join(args, " ") == "btrfs device stats /mnt/speed" {
			return "[/dev/nvme0n1p1].write_io_errs    0\n[/dev/nvme0n1p1].read_io_errs     0\n" +
				"[/dev/nvme1n1p1].write_io_errs    2\n[/dev/nvme1n1p1].corruption_errs  1\n", nil
		}
		return "[/dev/sde1].write_io_errs    0\n", nil
	}

	u := collectHealthUnraid(context.Background(), run)
	if u.State != "STARTED" || u.SyncAction != "" || u.SyncPercent != nil {
		t.Fatalf("unraid = %+v", u)
	}
	if u.LastCheck == nil || u.LastCheck.StartedAt != 1792720727000 || u.LastCheck.FinishedAt != 1792761028000 || u.LastCheck.Errors != 0 {
		t.Fatalf("last check = %+v", u.LastCheck)
	}
	// empty slots (disk3, unassigned parity2) and the flash drive are left out
	var names []string
	for _, d := range u.Disks {
		names = append(names, d.Name)
	}
	if strings.Join(names, ",") != "parity,disk1,disk2" || u.Disks[2].Errors != 3 {
		t.Fatalf("disks = %+v", u.Disks)
	}
	if len(u.Pools) != 2 || u.Pools[0].Name != "pbs" || u.Pools[1].Name != "speed" {
		t.Fatalf("pools = %+v", u.Pools)
	}
	speed := u.Pools[1]
	if speed.Profile != "raid1" || speed.Devices != 2 || speed.DevicesExpected != 2 || len(speed.Disks) != 2 {
		t.Fatalf("speed = %+v", speed)
	}
	if *speed.Disks[0].FsErrors != 0 || speed.Disks[1].Name != "speed2" || *speed.Disks[1].FsErrors != 3 {
		t.Fatalf("speed disks = %+v", speed.Disks)
	}
}

func TestCollectHealthUnraidSync(t *testing.T) {
	root := t.TempDir()
	vars := strings.Replace(unraidVarIni, `mdResyncPos="0"`, `mdResyncPos="1465130633"`, 1)
	vars = strings.Replace(vars, `mdResyncAction="check P"`, `mdResyncAction="recon D2"`, 1)
	_ = os.WriteFile(filepath.Join(root, "var.ini"), []byte(vars), 0o644)
	_ = os.WriteFile(filepath.Join(root, "disks.ini"), []byte(unraidDisksIni), 0o644)
	previous := healthUnraidRoot
	healthUnraidRoot = root
	defer func() { healthUnraidRoot = previous }()

	u := collectHealthUnraid(context.Background(), func(context.Context, string, ...string) (string, error) { return "", nil })
	if u.SyncAction != "recon D2" || u.SyncPercent == nil || *u.SyncPercent < 24.9 || *u.SyncPercent > 25.1 {
		t.Fatalf("sync = %q %v", u.SyncAction, u.SyncPercent)
	}
}
