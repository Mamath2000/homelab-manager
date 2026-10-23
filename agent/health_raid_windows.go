//go:build windows

package main

import "time"

func collectHealthRaid() *HealthRaid {
	return &HealthRaid{CheckedAt: time.Now().UnixMilli(), Arrays: []HealthRaidArray{}}
}
