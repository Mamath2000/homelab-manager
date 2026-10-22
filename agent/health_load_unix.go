//go:build !windows

package main

import "github.com/shirou/gopsutil/v4/load"

type HealthLoad struct {
	Load1  *float64
	Load5  *float64
	Load15 *float64
}

func collectHealthLoad() (*HealthLoad, error) {
	avg, err := load.Avg()
	if err != nil {
		return nil, err
	}
	return &HealthLoad{Load1: &avg.Load1, Load5: &avg.Load5, Load15: &avg.Load15}, nil
}
