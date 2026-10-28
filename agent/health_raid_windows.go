//go:build windows

package main

import (
	"context"
	"time"
)

func collectHealthRaid(context.Context) *HealthRaid {
	return &HealthRaid{CheckedAt: time.Now().UnixMilli(), Arrays: []HealthRaidArray{}}
}
