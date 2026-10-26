//go:build windows

package main

import (
	"context"

	"github.com/yusufpapurcu/wmi"
)

// UPS monitoring through Windows (Win32_Battery), see ups_wmi.go: one UPS per host, read only.

type wmiEnclosure struct {
	ChassisTypes []uint16
}

// collectUps returns nil when the host has no battery, or only the internal one of a laptop.
func collectUps(ctx context.Context) *UpsReport {
	var bats []wmiBattery
	if err := wmi.Query("SELECT Name, DeviceID, BatteryStatus, EstimatedChargeRemaining, EstimatedRunTime, DesignVoltage FROM Win32_Battery", &bats); err != nil || len(bats) == 0 {
		return nil
	}
	var enc []wmiEnclosure
	_ = wmi.Query("SELECT ChassisTypes FROM Win32_SystemEnclosure", &enc)
	var chassis []uint16
	for _, e := range enc {
		chassis = append(chassis, e.ChassisTypes...)
	}
	for _, b := range bats {
		if isWmiUps(b, chassis) {
			return upsFromWmi(b)
		}
	}
	return nil
}

func hasUps(ctx context.Context) bool { return collectUps(ctx) != nil }
