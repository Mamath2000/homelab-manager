package main

// UPS report shared by the agents: NUT on Unix (ups.go), WMI on Windows (ups_windows.go).

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
