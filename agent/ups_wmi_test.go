package main

import "testing"

func TestUpsFromWmi(t *testing.T) {
	r := upsFromWmi(wmiBattery{Name: "Back-UPS ES 850G2 FW:938.a2 .I US", DeviceID: "1234Back-UPS", BatteryStatus: 2, EstimatedChargeRemaining: 100, EstimatedRunTime: 19, DesignVoltage: 13590})
	if r == nil || r.Status != "OL" || *r.Charge != 100 || *r.Runtime != 19*60 || *r.BatteryNom != 13.59 || r.Driver != "wmi" || r.Load != nil {
		t.Fatalf("unexpected report: %+v", r)
	}
	if r := upsFromWmi(wmiBattery{BatteryStatus: 1, EstimatedChargeRemaining: 50, EstimatedRunTime: wmiUnknownRunTime}); r.Status != "OB" || r.Runtime != nil {
		t.Fatalf("on battery: %+v", r)
	}
	if r := upsFromWmi(wmiBattery{BatteryStatus: 5}); r.Status != "OB LB" {
		t.Fatalf("critical: %+v", r)
	}
	if r := upsFromWmi(wmiBattery{BatteryStatus: 6}); r.Status != "OL CHRG" {
		t.Fatalf("charging: %+v", r)
	}
	if upsFromWmi(wmiBattery{BatteryStatus: 0}) != nil {
		t.Fatal("unknown status must give no report")
	}
}

func TestIsWmiUps(t *testing.T) {
	apc := wmiBattery{Name: "Back-UPS ES 850G2"}
	laptop := wmiBattery{Name: "DELL 12345"}
	for _, c := range []struct {
		b       wmiBattery
		chassis []uint16
		want    bool
	}{
		{apc, []uint16{3}, true},
		{apc, []uint16{10}, true}, // name wins on a laptop with an UPS
		{laptop, []uint16{10}, false},
		{laptop, []uint16{3}, true},
		{laptop, nil, true},
	} {
		if got := isWmiUps(c.b, c.chassis); got != c.want {
			t.Errorf("%+v %v: got %v", c.b, c.chassis, got)
		}
	}
}
