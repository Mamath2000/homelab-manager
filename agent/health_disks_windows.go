//go:build windows

package main

func collectHAOSHealthDisks() (*HealthDisks, error) {
	return &HealthDisks{Volumes: []HealthVolume{}}, nil
}
