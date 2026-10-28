package main

import (
	"os"
	"path/filepath"
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
	report, err := collectHealthSystem(0)
	if err != nil {
		t.Fatal(err)
	}
	if report.CheckedAt <= 0 || report.CPUPercent < 0 || report.CPUPercent > 100 || report.MemPercent < 0 || report.MemPercent > 100 || report.MemTotal == 0 || report.MemUsed > report.MemTotal {
		t.Fatalf("invalid system report: %+v", report)
	}
	if report.CPUCount <= 0 {
		t.Fatalf("CPU count missing: %+v", report)
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

func TestCgroupCPULimit(t *testing.T) {
	write := func(root, name, content string) {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	cases := []struct {
		name  string
		files map[string]string
		want  float64
	}{
		{"v2 unlimited", map[string]string{"cpu.max": "max 100000\n"}, 0},
		{"v2 two cpus", map[string]string{"cpu.max": "200000 100000\n"}, 2},
		{"v2 fractional", map[string]string{"cpu.max": "150000 100000\n"}, 1.5},
		{"v1 limited", map[string]string{"cpu/cpu.cfs_quota_us": "50000\n", "cpu/cpu.cfs_period_us": "100000\n"}, 0.5},
		{"v1 unlimited", map[string]string{"cpu/cpu.cfs_quota_us": "-1\n", "cpu/cpu.cfs_period_us": "100000\n"}, 0},
		{"absent", nil, 0},
	}
	for _, c := range cases {
		root := t.TempDir()
		for name, content := range c.files {
			write(root, name, content)
		}
		if got := cgroupCPULimit(root); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}
