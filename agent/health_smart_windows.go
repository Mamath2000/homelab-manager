//go:build windows

package main

import (
	"context"
	"time"
)

func collectHealthSmart(_ context.Context, _ []string) *HealthSmart {
	return &HealthSmart{CheckedAt: time.Now().UnixMilli(), Disks: []HealthSmartDisk{}}
}
