//go:build windows

package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidDirectoryWindows(t *testing.T) {
	for p, want := range map[string]bool{
		`C:\Users\math\Documents`: true,
		`D:\`:                     true,
		`C:\Users\..\Windows`:     false, // not clean
		`C:\Users\`:               false,
		`Users\math`:              false, // relative
		`\\nas\share\docs`:        false, // UNC: no VSS
		"/home/math":              false,
	} {
		if got := validDirectory(p); got != want {
			t.Errorf("validDirectory(%q) = %v, want %v", p, got, want)
		}
	}
}

func windowsSpec(j BackupJob) *BackupSpec {
	return &BackupSpec{Server: "pbs.lan:8007", Fingerprint: "aa:bb", TokenID: "agent@pbs!host", TokenSecret: "s", ClientPath: `C:\pbs\proxmoxbackup-directory.exe`, Jobs: []BackupJob{j}}
}

func TestValidateBackupSpecWindows(t *testing.T) {
	ok := BackupJob{ID: "0123456789abcdef01234567", BackupID: "pc", Store: "main", NS: "Hosts", Schedule: "daily", TZ: "Europe/Paris", Enabled: true,
		Archives: []BackupArchive{{Name: "docs", Path: `C:\Users\math\Documents`}}}
	if err := validateBackupSpec(windowsSpec(ok)); err != nil {
		t.Fatalf("valid job refused: %v", err)
	}
	two := ok
	two.Archives = append([]BackupArchive{{Name: "a", Path: `D:\a`}}, ok.Archives...)
	excl := ok
	excl.Excludes = []string{"*.tmp"}
	db := ok
	db.Kind, db.Archives, db.Database = "postgres", nil, &DatabaseDump{WorkDir: `C:\dumps`}
	for name, j := range map[string]BackupJob{"two directories": two, "exclusion": excl, "database": db} {
		if err := validateBackupSpec(windowsSpec(j)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	bad := windowsSpec(ok)
	bad.ClientPath = `proxmoxbackup-directory.exe`
	if err := validateBackupSpec(bad); err == nil {
		t.Error("relative client path accepted")
	}
}

// A fake client (a batch file) gets the settings through -config; its exit code makes the result.
func TestRunBackupWindows(t *testing.T) {
	dir := t.TempDir()
	backups = newBackupModule(dir)
	seen := filepath.Join(dir, "seen.json")
	client := filepath.Join(dir, "client.cmd")
	script := "@echo off\r\ncopy /y \"%2\" \"" + seen + "\" >nul\r\nexit /b %EXIT%\r\n"
	if err := os.WriteFile(client, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	j := BackupJob{Store: "main", NS: "Hosts", BackupID: "pc", Archives: []BackupArchive{{Name: "docs", Path: `C:\Users`}}}
	spec := windowsSpec(j)
	spec.ClientPath = client
	for exit, want := range map[string]string{"0": "", "2": "autre sauvegarde", "3": "incomplète", "1": "code 1"} {
		t.Setenv("EXIT", exit)
		_, err := runBackup(context.Background(), spec, j, func(string) {})
		if (err == nil) != (want == "") || (err != nil && !strings.Contains(err.Error(), want)) {
			t.Errorf("exit %s: %v, want %q", exit, err, want)
		}
	}
	raw, err := os.ReadFile(seen)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{`"secret":"s"`, `"backupdir":"C:\\Users"`, `"namespace":"Hosts"`, `"usevss":true`, `"certfingerprint":"aa:bb"`} {
		if !strings.Contains(string(raw), s) {
			t.Errorf("config without %s: %s", s, raw)
		}
	}
	// the secret does not stay on disk
	if _, err := os.Stat(filepath.Join(dir, "backup-run.json")); !os.IsNotExist(err) {
		t.Error("config left on disk")
	}
	spec.Fingerprint = ""
	if _, err := runBackup(context.Background(), spec, j, func(string) {}); err == nil {
		t.Error("run without fingerprint")
	}
}
