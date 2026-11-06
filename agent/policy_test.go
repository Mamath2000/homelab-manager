package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
)

func TestLoadPolicy(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, policyFile)
	// no file: what the agents accepted before the policy existed
	if p := loadPolicy(file); !p.agentInstallAllowed() || p.Backup.PinPBS || len(p.Backup.Deny) != 0 {
		t.Fatalf("legacy: %+v", p)
	}
	// unreadable or invalid: closed
	for name, raw := range map[string]string{
		"syntax":      "{",
		"unknown key": `{"agentInstall":true,"extra":1}`,
		"bad deny":    `{"backup":{"deny":["etc"]}}`,
		"bad fp":      `{"backup":{"pbsFingerprints":["AB:CD"]}}`,
		"bad image":   `{"backup":{"images":["Bad Image"]}}`,
	} {
		os.WriteFile(file, []byte(raw), 0o644)
		if p := loadPolicy(file); p.agentInstallAllowed() || !p.Backup.PinPBS {
			t.Errorf("%s: not closed: %+v", name, p)
		}
	}
	// omitted fields: the strict side
	os.WriteFile(file, []byte(`{}`), 0o644)
	if p := loadPolicy(file); p.agentInstallAllowed() {
		t.Errorf("empty: %+v", p)
	}
	// fingerprints are normalised
	os.WriteFile(file, []byte(`{"agentInstall":true,"backup":{"pbsFingerprints":[" `+strings.Repeat("ab:", 31)+`ab "]}}`), 0o644)
	if p := loadPolicy(file); !p.agentInstallAllowed() || p.Backup.PBSFingerprints[0] != strings.Repeat("AB:", 31)+"AB" {
		t.Errorf("full: %+v", p)
	}
}

func TestWritePolicyIfAbsent(t *testing.T) {
	dir := t.TempDir()
	if wrote, err := writePolicyIfAbsent(dir); !wrote || err != nil {
		t.Fatalf("wrote %v, err %v", wrote, err)
	}
	p := loadPolicy(filepath.Join(dir, policyFile))
	p.source = ""
	if !reflect.DeepEqual(p, strictPolicy()) {
		t.Fatalf("written %+v, want %+v", p, strictPolicy())
	}
	// an existing policy is kept
	os.WriteFile(filepath.Join(dir, policyFile), []byte(`{"agentInstall":false}`), 0o644)
	if wrote, _ := writePolicyIfAbsent(dir); wrote || loadPolicy(filepath.Join(dir, policyFile)).agentInstallAllowed() {
		t.Fatal("existing policy replaced")
	}
}

// install.sh writes the same strict policy as the Go installer
func TestInstallScriptPolicy(t *testing.T) {
	raw, err := os.ReadFile("../hub/assets/install.sh")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?s)<<'POLICY'\n(.*?)\nPOLICY`).FindSubmatch(raw)
	if m == nil {
		t.Fatal("no policy in install.sh")
	}
	p, err := parsePolicy(m[1])
	if err != nil {
		t.Fatal(err)
	}
	want := strictPolicy()
	if !reflect.DeepEqual(p, want) {
		a, _ := json.Marshal(p)
		b, _ := json.Marshal(want)
		t.Fatalf("install.sh %s\nstrictPolicy %s", a, b)
	}
}

func TestBackupExclusions(t *testing.T) {
	p := strictPolicy()
	ex, err := p.backupExclusions([]BackupArchive{{Name: "etc", Path: "/etc"}, {Name: "data", Path: "/srv/data"}})
	if err != nil || !slices.Equal(ex, []string{"/shadow", "/gshadow", "/ssh", "/homelab-agent"}) {
		t.Fatalf("etc: %v, %v", ex, err)
	}
	ex, err = p.backupExclusions([]BackupArchive{{Name: "root", Path: "/"}})
	if err != nil || len(ex) != len(p.Backup.Deny) || ex[0] != "/etc/shadow" {
		t.Fatalf("root: %v, %v", ex, err)
	}
	for _, path := range []string{"/root/.ssh", "/etc/ssh/keys", "/etc/shadow"} {
		if _, err := p.backupExclusions([]BackupArchive{{Name: "x", Path: path}}); err == nil {
			t.Errorf("%s accepted", path)
		}
	}
	// a name that only starts like a denied directory
	if ex, err := p.backupExclusions([]BackupArchive{{Name: "x", Path: "/etc/sshguard"}}); err != nil || len(ex) != 0 {
		t.Errorf("sshguard: %v, %v", ex, err)
	}
	if ex, err := legacyPolicy().backupExclusions([]BackupArchive{{Name: "x", Path: "/"}}); err != nil || len(ex) != 0 {
		t.Errorf("legacy: %v, %v", ex, err)
	}
}

func TestPbsAllowed(t *testing.T) {
	fp1, fp2 := strings.Repeat("AA:", 31)+"AA", strings.Repeat("BB:", 31)+"BB"
	pin := filepath.Join(t.TempDir(), "state", "pbs-pin")
	if err := legacyPolicy().pbsAllowed(fp1, "pbs:8007", pin); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(pin); err == nil {
		t.Fatal("legacy policy pinned")
	}
	p := strictPolicy()
	if err := p.pbsAllowed(strings.ToLower(fp1), "pbs:8007", pin); err != nil {
		t.Fatal(err)
	}
	if err := p.pbsAllowed(fp1, "pbs:8007", pin); err != nil {
		t.Fatalf("same PBS refused: %v", err)
	}
	if err := p.pbsAllowed(fp2, "evil:8007", pin); err == nil || !strings.Contains(err.Error(), pin) {
		t.Fatalf("other PBS: %v", err)
	}
	// an explicit list wins over the pin
	p.Backup.PBSFingerprints = []string{fp2}
	if err := p.pbsAllowed(fp2, "pbs2:8007", pin); err != nil {
		t.Fatal(err)
	}
	if err := p.pbsAllowed(fp1, "pbs:8007", pin); err == nil {
		t.Fatal("PBS outside the list accepted")
	}
}

func TestBackupImageAllowed(t *testing.T) {
	defer func(v string) { trustedClientImages = v }(trustedClientImages)
	trustedClientImages = ""
	if err := legacyPolicy().backupImageAllowed("evil/image:latest"); err != nil {
		t.Fatalf("development build: %v", err)
	}
	good := "mathmath350/pbs-client@sha256:" + strings.Repeat("a", 64)
	trustedClientImages = good + ",other/client@sha256:" + strings.Repeat("b", 64)
	if err := legacyPolicy().backupImageAllowed(good); err != nil {
		t.Fatal(err)
	}
	if err := legacyPolicy().backupImageAllowed("mathmath350/pbs-client:latest"); err == nil {
		t.Fatal("tag accepted")
	}
	p := legacyPolicy()
	p.Backup.Images = []string{"local/client:1"}
	if err := p.backupImageAllowed("local/client:1"); err != nil {
		t.Fatal(err)
	}
	if got := defaultTrustedImage("fallback"); got != good {
		t.Fatalf("default %s", got)
	}
}

func TestApplyBackupPolicy(t *testing.T) {
	pin := filepath.Join(t.TempDir(), "pbs-pin")
	spec := &BackupSpec{Server: "pbs:8007", Fingerprint: strings.Repeat("AA:", 31) + "AA"}
	j := BackupJob{Archives: []BackupArchive{{Name: "etc", Path: "/etc"}}, Excludes: []string{"*.log"}}
	if err := applyBackupPolicy(strictPolicy(), spec, &j, pin); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(j.Excludes, "*.log") || !slices.Contains(j.Excludes, "/shadow") {
		t.Fatalf("excludes %v", j.Excludes)
	}
	j = BackupJob{Archives: []BackupArchive{{Name: "keys", Path: "/root/.ssh"}}}
	if err := applyBackupPolicy(strictPolicy(), spec, &j, pin); err == nil {
		t.Fatal("/root/.ssh backed up")
	}
}
