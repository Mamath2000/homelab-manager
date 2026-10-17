package main

import (
	"slices"
	"testing"
)

func TestAvailableScopes(t *testing.T) {
	if got := availableScopes(true, true, false); !slices.Equal(got, []string{"info", "apt", "docker", "ups"}) {
		t.Errorf("debian with docker: %v", got)
	}
	if got := availableScopes(false, false, true); !slices.Equal(got, []string{"info", "ha_backups"}) {
		t.Errorf("haos: %v", got)
	}
}

func TestWantedScopes(t *testing.T) {
	avail := []string{"info", "apt", "docker", "ups"}
	if got := wantedScopes(nil, avail); !slices.Equal(got, avail) {
		t.Errorf("none asked: %v", got)
	}
	// unknown or unavailable scopes are ignored, refresh order kept
	if got := wantedScopes([]string{"ups", "ha_backups", "apt", "bogus"}, avail); !slices.Equal(got, []string{"apt", "ups"}) {
		t.Errorf("subset: %v", got)
	}
	if got := wantedScopes([]string{"ha_backups"}, avail); len(got) != 0 {
		t.Errorf("nothing available: %v", got)
	}
}
