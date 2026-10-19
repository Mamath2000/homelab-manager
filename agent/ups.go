//go:build !windows

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// UPS monitoring through NUT: the first UPS listed by "upsc -l" on the host (one UPS per host).
// Read only, local (upsd on localhost), nothing is opened on the host.

type UpsReport struct {
	CheckedAt int64  `json:"checkedAt"` // unix ms
	Name      string `json:"name"`      // NUT name (upsc <name>)
	Model     string `json:"model"`
	Driver    string `json:"driver"`
	// ups.status as NUT gives it: OL, OB, LB, RB, CHRG, DISCHRG, ALARM... space separated
	Status string `json:"status"`
	// nil = not reported by the UPS
	Charge        *float64 `json:"charge,omitempty"`        // battery.charge, %
	ChargeWarning *float64 `json:"chargeWarning,omitempty"` // battery.charge.warning, %
	ChargeLow     *float64 `json:"chargeLow,omitempty"`     // battery.charge.low, %
	Runtime       *float64 `json:"runtime,omitempty"`       // battery.runtime, seconds
	RuntimeLow    *float64 `json:"runtimeLow,omitempty"`    // battery.runtime.low, seconds
	Load          *float64 `json:"load,omitempty"`          // ups.load, %
	InputVoltage  *float64 `json:"inputVoltage,omitempty"`  // input.voltage, V
	InputNominal  *float64 `json:"inputNominal,omitempty"`  // input.voltage.nominal, V
	BatteryVolt   *float64 `json:"batteryVoltage,omitempty"`
	BatteryNom    *float64 `json:"batteryNominal,omitempty"`
	TestResult    string   `json:"testResult,omitempty"` // ups.test.result
	BeeperStatus  string   `json:"beeper,omitempty"`     // ups.beeper.status
	// manufacturing date of the battery pack (battery.mfr.date), "" = unknown; battery.date is
	// not used: most units keep the factory value
	MfrDate string `json:"mfrDate,omitempty"`
}

// parseUpsc reads the "key: value" lines of "upsc <name>".
func parseUpsc(name, out string) *UpsReport {
	kv := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), ":")
		if ok {
			kv[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	if kv["ups.status"] == "" {
		return nil
	}
	num := func(k string) *float64 {
		f, err := strconv.ParseFloat(kv[k], 64)
		if err != nil {
			return nil
		}
		return &f
	}
	return &UpsReport{
		Name:          name,
		Model:         kv["ups.model"],
		Driver:        kv["driver.name"],
		Status:        kv["ups.status"],
		Charge:        num("battery.charge"),
		ChargeWarning: num("battery.charge.warning"),
		ChargeLow:     num("battery.charge.low"),
		Runtime:       num("battery.runtime"),
		RuntimeLow:    num("battery.runtime.low"),
		Load:          num("ups.load"),
		InputVoltage:  num("input.voltage"),
		InputNominal:  num("input.voltage.nominal"),
		BatteryVolt:   num("battery.voltage"),
		BatteryNom:    num("battery.voltage.nominal"),
		TestResult:    kv["ups.test.result"],
		BeeperStatus:  kv["ups.beeper.status"],
		MfrDate:       kv["battery.mfr.date"],
	}
}

// collectUps returns nil when the host has no NUT or no UPS.
func collectUps(ctx context.Context) *UpsReport {
	bin, err := exec.LookPath("upsc")
	if err != nil {
		return nil
	}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	list, err := exec.CommandContext(cctx, bin, "-l").Output() // stderr (SSL notice) left out
	if err != nil {
		return nil
	}
	name := strings.TrimSpace(strings.SplitN(string(list), "\n", 2)[0])
	if name == "" {
		return nil
	}
	out, err := exec.CommandContext(cctx, bin, name).Output()
	if err != nil {
		return nil
	}
	r := parseUpsc(name, string(out))
	if r != nil {
		r.CheckedAt = time.Now().UnixMilli()
	}
	return r
}

func hasUps(ctx context.Context) bool { return collectUps(ctx) != nil }

// Actions on the UPS: a fixed list of NUT instant commands, run as the NUT user "hm-agent" whose
// password is read from <agent dir>/ups.pass (one line, root only). The hub never sends the
// password nor a free command line. Without that file the UPS stays read only.
const (
	upsUser     = "hm-agent"
	upsPassFile = "ups.pass"
)

var upsCommands = map[string]bool{
	"beeper.enable":            true,
	"beeper.disable":           true,
	"beeper.mute":              true,
	"test.battery.start.quick": true,
}

// upsPassPath is set from the agent directory at start.
var upsPassPath = filepath.Join(defaultDir, upsPassFile)

func readUpsPass() (string, error) {
	b, err := os.ReadFile(upsPassPath)
	if err != nil {
		return "", err
	}
	pw := strings.TrimSpace(string(b))
	if pw == "" {
		return "", fmt.Errorf("%s is empty", upsPassPath)
	}
	return pw, nil
}

func canControlUps(ctx context.Context) bool {
	if _, err := readUpsPass(); err != nil {
		return false
	}
	return hasUps(ctx)
}

// runUpsCommand runs one instant command on the UPS of the host. The password goes through stdin,
// not on the command line (visible in ps).
func runUpsCommand(ctx context.Context, cmd string) error {
	if !upsCommands[cmd] {
		return fmt.Errorf("unsupported UPS command %q", cmd)
	}
	pw, err := readUpsPass()
	if err != nil {
		return fmt.Errorf("UPS control not set up on this host (%s): %w", upsPassPath, err)
	}
	bin, err := exec.LookPath("upscmd")
	if err != nil {
		return fmt.Errorf("upscmd not found")
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	list, err := exec.CommandContext(cctx, "upsc", "-l").Output()
	name := strings.TrimSpace(strings.SplitN(string(list), "\n", 2)[0])
	if err != nil || name == "" {
		return fmt.Errorf("no UPS found")
	}
	c := exec.CommandContext(cctx, bin, "-u", upsUser, name, cmd)
	c.Stdin = strings.NewReader(pw + "\n")
	out, err := c.CombinedOutput()
	if err != nil || !strings.Contains(string(out), "OK") {
		return fmt.Errorf("upscmd %s: %s", cmd, upsError(string(out)))
	}
	return nil
}

// upsError keeps the useful line of upscmd (ERR ..., Error: ...), without the prompt or SSL notice.
func upsError(out string) string {
	for _, l := range strings.Split(out, "\n") {
		l = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(l), "Password:"))
		if l != "" && !strings.HasPrefix(l, "Init SSL") {
			return l
		}
	}
	return "failed"
}

// sendUps reports the UPS right now, after a command (the NUT driver takes a moment to reflect it).
func (s *session) sendUps(ctx context.Context) {
	select {
	case <-ctx.Done():
		return
	case <-time.After(3 * time.Second):
	}
	if r := collectUps(ctx); r != nil {
		_ = s.send(ctx, Outbound{Type: "ups_report", Ups: r})
	}
}

// upsLoop polls every minute; a report goes to the hub when something changed, and at least every
// 5 minutes.
func (s *session) upsLoop(ctx context.Context) {
	var lastKey string
	var lastSent time.Time
	poll := func() {
		r := collectUps(ctx)
		if r == nil {
			return
		}
		at := r.CheckedAt
		r.CheckedAt = 0
		b, _ := json.Marshal(r)
		r.CheckedAt = at
		if string(b) == lastKey && time.Since(lastSent) < 5*time.Minute {
			return
		}
		if s.send(ctx, Outbound{Type: "ups_report", Ups: r}) == nil {
			lastKey, lastSent = string(b), time.Now()
		}
	}
	poll()
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			poll()
		}
	}
}
