package main

import "testing"

func TestNewerKernel(t *testing.T) {
	cases := []struct {
		running   string
		installed []string
		want      string
	}{
		{"6.12.43+deb13-amd64", []string{"6.12.43+deb13-amd64", "6.12.48+deb13-amd64"}, "6.12.48+deb13-amd64"},
		{"6.12.48+deb13-amd64", []string{"6.12.43+deb13-amd64", "6.12.48+deb13-amd64"}, ""},
		// Raspberry Pi: other flavours are installed too and must not trigger a reboot
		{"6.18.34+rpt-rpi-2712", []string{"6.18.33+rpt-rpi-2712", "6.18.34+rpt-rpi-2712", "6.18.35+rpt-rpi-v8"}, ""},
		{"6.18.34+rpt-rpi-2712", []string{"6.18.34+rpt-rpi-2712", "6.18.35+rpt-rpi-2712", "6.18.35+rpt-rpi-v8"}, "6.18.35+rpt-rpi-2712"},
		{"6.8.0-45-generic", []string{"6.8.0-45-generic", "6.8.0-48-generic"}, "6.8.0-48-generic"},
		{"6.8.12-4-pve", []string{"6.8.12-4-pve", "6.8.12-10-pve"}, "6.8.12-10-pve"},
		// LXC: no kernel installed in the container
		{"6.8.12-4-pve", nil, ""},
	}
	for _, c := range cases {
		if got := newerKernel(c.running, c.installed); got != c.want {
			t.Errorf("newerKernel(%q, %v) = %q, want %q", c.running, c.installed, got, c.want)
		}
	}
}

func TestIsWSL(t *testing.T) {
	for release, want := range map[string]bool{
		"6.6.87.2-microsoft-standard-WSL2": true,
		"4.4.0-19041-Microsoft":            true,
		"6.12.48+deb13-amd64":              false,
		"6.8.12-4-pve":                     false,
	} {
		if got := isWSL(release); got != want {
			t.Errorf("isWSL(%q) = %v, want %v", release, got, want)
		}
	}
}
