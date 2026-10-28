//go:build windows

package main

import (
	"context"
	"log"

	"github.com/yusufpapurcu/wmi"
)

// UPS monitoring through Windows (Win32_Battery), see ups_wmi.go: one UPS per host, read only.

// WMI returns the elements of a uint16 array as int32 and the wmi package panics on a []uint16 field.
type wmiEnclosure struct {
	ChassisTypes []int32
}

// collectUps returns nil when the host has no battery, or only the internal one of a laptop.
func collectUps(ctx context.Context) (report *UpsReport) {
	// a WMI failure must never take the agent down
	defer func() {
		if r := recover(); r != nil {
			log.Printf("ups: WMI query panicked: %v", r)
			report = nil
		}
	}()
	var bats []wmiBattery
	if err := wmi.Query("SELECT Name, DeviceID, BatteryStatus, EstimatedChargeRemaining, EstimatedRunTime, DesignVoltage FROM Win32_Battery", &bats); err != nil || len(bats) == 0 {
		return nil
	}
	var enc []wmiEnclosure
	_ = wmi.Query("SELECT ChassisTypes FROM Win32_SystemEnclosure", &enc)
	var chassis []uint16
	for _, e := range enc {
		for _, c := range e.ChassisTypes {
			chassis = append(chassis, uint16(c))
		}
	}
	for _, b := range bats {
		if isWmiUps(b, chassis) {
			return upsFromWmi(b)
		}
	}
	return nil
}

func hasUps(ctx context.Context) bool { return collectUps(ctx) != nil }
