package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// findSmartctl: smartmontools may be installed without being on the PATH of the service (Windows).
func findSmartctl() (string, error) {
	if p, err := exec.LookPath("smartctl"); err == nil {
		return p, nil
	}
	if runtime.GOOS == "windows" {
		for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)"} {
			if dir := os.Getenv(env); dir != "" {
				p := filepath.Join(dir, "smartmontools", "bin", "smartctl.exe")
				if _, err := os.Stat(p); err == nil {
					return p, nil
				}
			}
		}
	}
	return "", errors.New("smartctl introuvable (smartmontools non installé)")
}

type smartctlReport struct {
	PowerMode *struct {
		Name string `json:"name"`
	} `json:"power_mode"`
	Device struct {
		Model    string `json:"model_name"`
		Serial   string `json:"serial_number"`
		Protocol string `json:"protocol"`
	} `json:"device"`
	UserCapacity struct {
		Bytes uint64 `json:"bytes"`
	} `json:"user_capacity"`
	NvmeCapacity *uint64 `json:"nvme_total_capacity"`
	RotationRate *int    `json:"rotation_rate"`
	PowerOnTime  struct {
		Hours *uint64 `json:"hours"`
	} `json:"power_on_time"`
	Model       string `json:"model_name"`
	Serial      string `json:"serial_number"`
	SmartStatus *struct {
		Passed bool `json:"passed"`
	} `json:"smart_status"`
	Temperature struct {
		Current *float64 `json:"current"`
	} `json:"temperature"`
	Nvme struct {
		Temperature    *float64 `json:"temperature"`
		PercentageUsed *float64 `json:"percentage_used"`
	} `json:"nvme_smart_health_information_log"`
	Ata struct {
		Table []struct {
			ID   int    `json:"id"`
			Name string `json:"name"`
			Raw  struct {
				Value *uint64 `json:"value"`
			} `json:"raw"`
		} `json:"table"`
	} `json:"ata_smart_attributes"`
}

func collectHealthSmart(ctx context.Context, devices []string) *HealthSmart {
	r := &HealthSmart{CheckedAt: time.Now().UnixMilli(), Disks: make([]HealthSmartDisk, 0, len(devices))}
	smartctl, lookErr := findSmartctl()
	for _, device := range devices {
		d := HealthSmartDisk{Device: device}
		if lookErr != nil {
			d.Error = lookErr.Error()
			r.Disks = append(r.Disks, d)
			continue
		}
		cmdCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		out, err := exec.CommandContext(cmdCtx, smartctl, "--json", "--all", "-n", "standby", "--", device).Output()
		cancel()
		var report smartctlReport
		if jsonErr := json.Unmarshal(out, &report); jsonErr != nil {
			if err != nil {
				d.Error = fmt.Sprintf("smartctl: %v", err)
			} else {
				d.Error = fmt.Sprintf("invalid smartctl response: %v", jsonErr)
			}
			r.Disks = append(r.Disks, d)
			continue
		}
		// -n standby: a sleeping disk is not woken (smartctl answers with its power mode only); the hub keeps its last values
		if report.PowerMode != nil && strings.EqualFold(report.PowerMode.Name, "standby") {
			d.Standby = true
			r.Disks = append(r.Disks, d)
			continue
		}
		applySmartReport(&d, &report)
		if err != nil && d.Healthy == nil {
			d.Error = fmt.Sprintf("smartctl: %v", err)
		}
		r.Disks = append(r.Disks, d)
	}
	return r
}

// applySmartReport: what the hub keeps of the smartctl output of an awake disk.
func applySmartReport(d *HealthSmartDisk, report *smartctlReport) {
	d.Model = report.Model
	if d.Model == "" {
		d.Model = report.Device.Model
	}
	d.Serial = report.Serial
	if d.Serial == "" {
		d.Serial = report.Device.Serial
	}
	if report.SmartStatus != nil {
		d.Healthy = &report.SmartStatus.Passed
	}
	d.TemperatureC = report.Temperature.Current
	if d.TemperatureC == nil {
		d.TemperatureC = report.Nvme.Temperature
	}
	d.NvmeWearPercent = report.Nvme.PercentageUsed
	for _, attr := range report.Ata.Table {
		if attr.ID == 5 && attr.Raw.Value != nil {
			d.Reallocated = attr.Raw.Value
			break
		}
	}
	d.SizeBytes = report.UserCapacity.Bytes
	if d.SizeBytes == 0 && report.NvmeCapacity != nil {
		d.SizeBytes = *report.NvmeCapacity
	}
	d.Protocol = report.Device.Protocol
	d.RotationRate = report.RotationRate
	d.PowerOnHours = report.PowerOnTime.Hours
}

// SmartCandidate: a physical disk smartctl can read, offered in the host options.
type SmartCandidate struct {
	Device    string `json:"device"`
	Model     string `json:"model,omitempty"`
	Protocol  string `json:"protocol,omitempty"` // NVMe, ATA, SCSI...
	SizeBytes uint64 `json:"sizeBytes,omitempty"`
}

type smartctlScan struct {
	Devices []struct {
		Name string `json:"name"`
	} `json:"devices"`
}

type smartctlInfo struct {
	Device struct {
		Protocol string `json:"protocol"`
	} `json:"device"`
	Model        string `json:"model_name"`
	UserCapacity struct {
		Bytes uint64 `json:"bytes"`
	} `json:"user_capacity"`
}

// listSmartCandidates: `smartctl --scan` already leaves out loop, md and zram devices; model and size come from `-i`.
func listSmartCandidates(ctx context.Context) ([]SmartCandidate, error) {
	smartctl, err := findSmartctl()
	if err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, smartctl, "--scan", "--json").Output()
	var scan smartctlScan
	if jsonErr := json.Unmarshal(out, &scan); jsonErr != nil {
		if err != nil {
			return nil, fmt.Errorf("smartctl --scan: %w", err)
		}
		return nil, fmt.Errorf("réponse smartctl --scan invalide: %w", jsonErr)
	}
	list := make([]SmartCandidate, 0, len(scan.Devices))
	for _, dev := range scan.Devices {
		c := SmartCandidate{Device: dev.Name}
		// -n standby: listing must not wake a sleeping disk (its model is then simply unknown)
		out, _ := exec.CommandContext(cctx, smartctl, "--json", "-i", "-n", "standby", "--", dev.Name).Output()
		var info smartctlInfo
		if json.Unmarshal(out, &info) == nil {
			c.Model, c.Protocol, c.SizeBytes = info.Model, info.Device.Protocol, info.UserCapacity.Bytes
		}
		list = append(list, c)
	}
	return list, nil
}

// smartctlWindowsDiskName: the name smartctl gives on Windows to \\.\PhysicalDriveN: /dev/sda for 0, /dev/sdz for 25, then
// /dev/sdaa, /dev/sdab...
func smartctlWindowsDiskName(n int) string {
	if n < 26 {
		return "/dev/sd" + string(rune('a'+n))
	}
	return "/dev/sd" + string(rune('a'+n/26-1)) + string(rune('a'+n%26))
}

// diskExtentNames: the smartctl names of the disks of a Windows VOLUME_DISK_EXTENTS buffer (DWORD count + 4 bytes of
// padding, then 24-byte DISK_EXTENT entries starting with their DWORD DiskNumber), each disk once.
func diskExtentNames(buf []byte) []string {
	if len(buf) < 8 {
		return nil
	}
	count := int(binary.LittleEndian.Uint32(buf))
	seen := map[uint32]bool{}
	var out []string
	for i := 0; i < count && 8+24*(i+1) <= len(buf); i++ {
		disk := binary.LittleEndian.Uint32(buf[8+24*i:])
		if !seen[disk] {
			seen[disk] = true
			out = append(out, smartctlWindowsDiskName(int(disk)))
		}
	}
	return out
}
