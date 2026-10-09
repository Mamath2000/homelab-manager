package main

import "testing"

func TestParseUpgradable(t *testing.T) {
	out := `Listing...
libc6/stable-security,stable 2.36-9+deb12u8 amd64 [upgradable from: 2.36-9+deb12u7]
curl/stable-updates 7.88.1-10+deb12u6 amd64 [upgradable from: 7.88.1-10+deb12u5]
`
	p := parseUpgradable(out)
	if len(p) != 2 {
		t.Fatalf("want 2, got %d", len(p))
	}
	if !p[0].Security || p[0].Name != "libc6" || p[0].Current != "2.36-9+deb12u7" || p[0].Candidate != "2.36-9+deb12u8" {
		t.Fatalf("bad first: %+v", p[0])
	}
	if p[1].Security {
		t.Fatalf("curl must not be security")
	}
}

func TestValidPackages(t *testing.T) {
	if !validPackages([]string{"libc6", "g++-12", "libstdc++6:amd64"}) {
		t.Fatal("valid rejected")
	}
	if validPackages([]string{"foo; rm -rf /"}) || validPackages([]string{"--purge"}) {
		t.Fatal("invalid accepted")
	}
}
