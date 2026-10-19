//go:build windows

package main

// Windows agent (homelab#183): presence, host info and sessions only. Every other file of the
// package is Linux code (//go:build !windows) except the shared core: config.go, connect.go,
// enroll.go, tls.go, info.go.

const defaultDir = `C:\ProgramData\homelab-agent`

func main() {}
