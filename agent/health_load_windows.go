//go:build windows

package main

var onHAOS = false

type HealthLoad struct {
	Load1  *float64
	Load5  *float64
	Load15 *float64
}

func collectHealthLoad() (*HealthLoad, error) { return nil, nil }
