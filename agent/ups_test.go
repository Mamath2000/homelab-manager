package main

import (
	"context"
	"strings"
	"testing"
)

const upscSample = `battery.charge: 100
battery.charge.low: 10
battery.charge.warning: 50
battery.mfr.date: 2020/02/01
battery.runtime: 528
battery.runtime.low: 120
battery.voltage: 27.1
battery.voltage.nominal: 24.0
driver.name: usbhid-ups
input.voltage: 228.0
input.voltage.nominal: 230
ups.beeper.status: disabled
ups.load: 20
ups.model: Back-UPS XS 1400U 
ups.status: ALARM OL RB
ups.test.result: No test initiated
`

func TestParseUpsc(t *testing.T) {
	r := parseUpsc("ups", upscSample)
	if r == nil {
		t.Fatal("nil report")
	}
	if r.Status != "ALARM OL RB" || r.Model != "Back-UPS XS 1400U" || r.Driver != "usbhid-ups" {
		t.Errorf("text fields: %+v", r)
	}
	if r.Charge == nil || *r.Charge != 100 || r.Runtime == nil || *r.Runtime != 528 || r.BatteryVolt == nil || *r.BatteryVolt != 27.1 {
		t.Errorf("numbers: %+v", r)
	}
	if r.MfrDate != "2020/02/01" || r.TestResult != "No test initiated" {
		t.Errorf("dates: %+v", r)
	}
}

func TestParseUpscMissing(t *testing.T) {
	if parseUpsc("ups", "") != nil || parseUpsc("ups", "Error: Data stale\n") != nil {
		t.Error("expected nil without ups.status")
	}
	r := parseUpsc("ups", "ups.status: OL\n")
	if r == nil || r.Charge != nil || r.Runtime != nil {
		t.Errorf("absent values must stay nil: %+v", r)
	}
}

func TestUpsCommandWhitelist(t *testing.T) {
	for _, c := range []string{"beeper.mute", "beeper.enable", "beeper.disable", "test.battery.start.quick"} {
		if !upsCommands[c] {
			t.Errorf("%s must be allowed", c)
		}
	}
	for _, c := range []string{"load.off", "shutdown.reboot", "driver.killpower", "test.battery.start.deep", "beeper.mute; id", ""} {
		if err := runUpsCommand(context.Background(), c); err == nil || !strings.Contains(err.Error(), "unsupported") {
			t.Errorf("%q must be refused, got %v", c, err)
		}
	}
}

func TestUpsError(t *testing.T) {
	if got := upsError("Init SSL without certificate database\nPassword: ERR ACCESS-DENIED\n"); got != "ERR ACCESS-DENIED" {
		t.Errorf("got %q", got)
	}
}
