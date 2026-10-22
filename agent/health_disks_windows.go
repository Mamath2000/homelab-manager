//go:build windows

package main

func isHealthStoragePartition(_, _ string) bool {
	return true
}

func collectHAOSHealthDisks() (*HealthDisks, error) {
	return &HealthDisks{Volumes: []HealthVolume{}}, nil
}
