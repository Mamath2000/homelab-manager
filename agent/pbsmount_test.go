//go:build !windows

package main

import (
	"slices"
	"strings"
	"testing"
)

func mountSpec() *PbsMountSpec {
	return &PbsMountSpec{
		Server:      "192.168.100.20",
		Port:        8007,
		Fingerprint: strings.TrimSuffix(strings.Repeat("AB:", 32), ":"),
		Store:       "ds0",
		NS:          "Vouille",
		Type:        "ct",
		ID:          "101",
		Time:        1760841000, // 2025-10-19T02:30:00Z
		Archive:     "root.pxar.didx",
		TokenID:     "homelab-mount@pbs!m1a2b3",
		Secret:      "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b",
	}
}

func TestValidatePbsMount(t *testing.T) {
	if err := validatePbsMount(mountSpec()); err != nil {
		t.Fatalf("valid spec refused: %v", err)
	}
	bad := map[string]func(s *PbsMountSpec){
		"server with a space": func(s *PbsMountSpec) { s.Server = "pbs host" },
		"server with option":  func(s *PbsMountSpec) { s.Server = "-oProxy" },
		"port":                func(s *PbsMountSpec) { s.Port = 70000 },
		"fingerprint":         func(s *PbsMountSpec) { s.Fingerprint = "AB:CD" },
		"store":               func(s *PbsMountSpec) { s.Store = "../ds0" },
		"namespace":           func(s *PbsMountSpec) { s.NS = "Vouille/../x" },
		"namespace too deep":  func(s *PbsMountSpec) { s.NS = "a/b/c/d/e/f/g/h" },
		"vm":                  func(s *PbsMountSpec) { s.Type = "vm" },
		"id":                  func(s *PbsMountSpec) { s.ID = "101;rm" },
		"time":                func(s *PbsMountSpec) { s.Time = 12 },
		"img archive":         func(s *PbsMountSpec) { s.Archive = "drive-scsi0.img.fidx" },
		"archive path":        func(s *PbsMountSpec) { s.Archive = "../root.pxar.didx" },
		"relative mount root": func(s *PbsMountSpec) { s.MountRoot = "mnt/restore" },
		"unclean mount root":  func(s *PbsMountSpec) { s.MountRoot = "/mnt/../etc" },
		"filesystem root":     func(s *PbsMountSpec) { s.MountRoot = "/" },
		"token":               func(s *PbsMountSpec) { s.TokenID = "root@pam!x" },
		"secret":              func(s *PbsMountSpec) { s.Secret = "secret\nPBS_REPOSITORY=x" },
	}
	for name, mutate := range bad {
		s := mountSpec()
		mutate(s)
		if validatePbsMount(s) == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	for _, ok := range []string{"pbs.lan", "[fd00::20]", "100.71.188.9"} {
		s := mountSpec()
		s.Server = ok
		if err := validatePbsMount(s); err != nil {
			t.Errorf("server %s refused: %v", ok, err)
		}
	}
	s := mountSpec()
	s.NS = ""
	if err := validatePbsMount(s); err != nil {
		t.Errorf("root namespace refused: %v", err)
	}
}

func TestPbsMountCommand(t *testing.T) {
	s := mountSpec()
	path := pbsMountPath(s)
	if path != "/srv/pbs-restore/ct-101_2025-10-19_02-30-00_root" {
		t.Fatalf("path = %s", path)
	}
	s.MountRoot = "/mnt/restore"
	if custom := pbsMountPath(s); custom != "/mnt/restore/ct-101_2025-10-19_02-30-00_root" {
		t.Fatalf("custom path = %s", custom)
	}
	s.MountRoot = ""
	args := pbsMountArgs(s, path)
	tail := args[slices.Index(args, "--")+1:]
	want := []string{"proxmox-backup-client", "mount", "--ns", "Vouille", "ct/101/2025-10-19T02:30:00Z", "root.pxar", path}
	if !slices.Equal(tail, want) {
		t.Fatalf("command = %v, want %v", tail, want)
	}
	// the secret never reaches the command line, only the environment file
	if strings.Contains(strings.Join(args, " "), s.Secret) {
		t.Fatal("secret on the command line")
	}
	env := pbsMountEnvFile(s)
	for _, l := range []string{"PBS_REPOSITORY=homelab-mount@pbs!m1a2b3@192.168.100.20:8007:ds0", "PBS_PASSWORD=" + s.Secret, "PBS_FINGERPRINT=" + s.Fingerprint} {
		if !strings.Contains(env, l+"\n") {
			t.Errorf("env file without %q", l)
		}
	}
	s.NS = ""
	if slices.Contains(pbsMountArgs(s, path), "--ns") {
		t.Error("--ns for the root namespace")
	}
}

func TestParseRestoreMounts(t *testing.T) {
	info := `22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw
310 22 0:52 / /srv/pbs-restore/ct-101_2025-10-19_02-30-00_root rw,nosuid,nodev,relatime shared:170 - fuse proxmox-backup-client rw
311 22 0:53 / /srv/pbs-restore/host-a\040b_x rw - fuse proxmox-backup-client rw
312 22 0:54 / /srv/pbs-restore rw - tmpfs tmpfs rw
313 22 0:55 / /srv/pbs-restoreX/y rw - tmpfs tmpfs rw`
	got := parseRestoreMounts(info)
	want := []string{"/srv/pbs-restore/ct-101_2025-10-19_02-30-00_root", "/srv/pbs-restore/host-a b_x"}
	if !slices.Equal(got, want) {
		t.Fatalf("mounts = %q, want %q", got, want)
	}
}

func TestParseRestoreMountsAtCustomRoot(t *testing.T) {
	info := `310 22 0:52 / /mnt/restore/ct-101_x rw - fuse proxmox-backup-client rw
311 22 0:53 / /mnt/restoreX/ct-102_x rw - fuse proxmox-backup-client rw`
	got := parseRestoreMountsAt(info, "/mnt/restore")
	want := []string{"/mnt/restore/ct-101_x"}
	if !slices.Equal(got, want) {
		t.Fatalf("mounts = %q, want %q", got, want)
	}
}

func TestCertFingerprint(t *testing.T) {
	fp := certFingerprint([]byte("x"))
	if !pbsPinRe.MatchString(fp) {
		t.Fatalf("fingerprint %s", fp)
	}
	if r := checkPbsReach(t.Context(), &PbsMountSpec{Server: "bad host", Port: 8007, Fingerprint: fp}); r.OK || r.Error == "" {
		t.Fatalf("bad server accepted: %+v", r)
	}
}
