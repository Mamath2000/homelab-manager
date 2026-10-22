package main

import (
	"reflect"
	"runtime"
	"testing"
)

func TestHealthConfigDefaultsAndNormalization(t *testing.T) {
	defaults := defaultHealthConfig()
	if defaults.SystemIntervalSeconds != 30 || defaults.DiskIntervalSeconds != 300 || defaults.SmartIntervalSeconds != 86400 {
		t.Fatalf("unexpected defaults: %+v", defaults)
	}
	devices := []string{"/dev/sda"}
	got := (HealthConfig{SystemIntervalSeconds: 60, SmartDevices: devices}).normalized()
	if got.SystemIntervalSeconds != 60 || got.DiskIntervalSeconds != 300 || got.SmartIntervalSeconds != 86400 || !reflect.DeepEqual(got.SmartDevices, devices) {
		t.Fatalf("unexpected normalized config: %+v", got)
	}
	got.SmartDevices[0] = "/dev/nvme0"
	if devices[0] != "/dev/sda" {
		t.Fatal("normalization retained the caller's mutable device slice")
	}
}

func TestHealthSystemCollection(t *testing.T) {
	report, err := collectHealthSystem()
	if err != nil {
		t.Fatal(err)
	}
	if report.CheckedAt <= 0 || report.CPUPercent < 0 || report.CPUPercent > 100 || report.MemPercent < 0 || report.MemPercent > 100 || report.MemTotal == 0 || report.MemUsed > report.MemTotal {
		t.Fatalf("invalid system report: %+v", report)
	}
	if runtime.GOOS != "windows" && (report.Load1 == nil || report.Load5 == nil || report.Load15 == nil) {
		t.Fatalf("Unix load averages missing: %+v", report)
	}
}

func TestHealthDiskCollection(t *testing.T) {
	report, err := collectHealthDisks()
	if err != nil {
		t.Fatal(err)
	}
	if report.CheckedAt <= 0 || report.Volumes == nil {
		t.Fatalf("invalid disk report: %+v", report)
	}
	for _, volume := range report.Volumes {
		if volume.Total == 0 || volume.Used > volume.Total || volume.Percent < 0 || volume.Percent > 100 {
			t.Fatalf("invalid volume: %+v", volume)
		}
	}
}
