package main

import (
	"strings"
	"time"
)

// UPS seen by Windows as a battery (Win32_Battery), read only: the USB HID driver of Windows exposes
// state, charge and estimated runtime, nothing else (no load, input voltage, test, beeper, commands).
// The mapping is kept free of any Windows call so that it is tested everywhere.

type wmiBattery struct {
	Name                     string
	DeviceID                 string
	BatteryStatus            uint16
	EstimatedChargeRemaining uint16
	EstimatedRunTime         uint32 // minutes
	DesignVoltage            uint32 // mV
}

// Win32_SystemEnclosure.ChassisTypes of laptops, notebooks, tablets and the like: their Win32_Battery
// is the internal battery, not a UPS.
var portableChassis = map[uint16]bool{8: true, 9: true, 10: true, 11: true, 14: true, 30: true, 31: true, 32: true}

// wmiUnknownRunTime is what Win32_Battery returns when the runtime is not known.
const wmiUnknownRunTime = 71582788

func isWmiUps(b wmiBattery, chassis []uint16) bool {
	if strings.Contains(strings.ToUpper(b.Name), "UPS") {
		return true
	}
	for _, c := range chassis {
		if portableChassis[c] {
			return false
		}
	}
	return true
}

// upsFromWmi maps a Win32_Battery to the NUT-like report of the hub.
func upsFromWmi(b wmiBattery) *UpsReport {
	var status string
	switch b.BatteryStatus {
	case 1, 3, 11: // discharging, fully charged on battery, partially charged
		status = "OB"
	case 4, 5: // low, critical
		status = "OB LB"
	case 2, 6, 7, 8, 9: // AC, charging (low, high, critical)
		status = "OL"
	default:
		return nil
	}
	if b.BatteryStatus == 6 || b.BatteryStatus == 7 || b.BatteryStatus == 8 {
		status += " CHRG"
	}
	name := b.DeviceID
	if name == "" {
		name = b.Name
	}
	r := &UpsReport{
		CheckedAt: time.Now().UnixMilli(),
		Name:      name,
		Model:     b.Name,
		Driver:    "wmi",
		Status:    status,
	}
	if b.EstimatedChargeRemaining <= 100 {
		c := float64(b.EstimatedChargeRemaining)
		r.Charge = &c
	}
	if b.EstimatedRunTime != wmiUnknownRunTime {
		s := float64(b.EstimatedRunTime) * 60
		r.Runtime = &s
	}
	if b.DesignVoltage > 0 {
		v := float64(b.DesignVoltage) / 1000
		r.BatteryNom = &v
	}
	return r
}
