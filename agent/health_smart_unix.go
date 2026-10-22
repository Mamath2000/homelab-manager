//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"time"
)

type smartctlReport struct {
	Device struct {
		Model  string `json:"model_name"`
		Serial string `json:"serial_number"`
	} `json:"device"`
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
	for _, device := range devices {
		d := HealthSmartDisk{Device: device}
		cmdCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		out, err := exec.CommandContext(cmdCtx, "smartctl", "--json", "--all", "--", device).Output()
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
		if err != nil && d.Healthy == nil {
			d.Error = fmt.Sprintf("smartctl: %v", err)
		}
		r.Disks = append(r.Disks, d)
	}
	return r
}
