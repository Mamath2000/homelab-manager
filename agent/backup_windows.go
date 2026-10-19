//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Windows side of the backups (backup.go, homelab#208): the directory CLI of proxmoxbackupclient_go
// (proxmoxbackup-directory.exe, GPL-3.0), installed by hand and run as an external program; its path
// comes with the definition (ClientPath). VSS is on by default (the service runs as SYSTEM). One
// directory per job (each extra directory would be a group of its own) and no exclusion (the CLI has
// none); no database jobs.

// set by runAgent, before the connection to the hub
var backups *backupModule

// Absolute path on a drive letter (VSS works on local volumes only), clean.
func validDirectory(p string) bool {
	return len(filepath.VolumeName(p)) == 2 && filepath.IsAbs(p) && filepath.Clean(p) == p && !strings.ContainsAny(p, "\n\x00")
}

func checkPlatformJob(j BackupJob) error {
	if len(j.Archives) != 1 {
		return errors.New("one directory per job on Windows")
	}
	if len(j.Excludes) != 0 {
		return errors.New("no exclusion on Windows")
	}
	return nil
}

// no database jobs on Windows: their kinds are unknown here, validateBackupSpec refuses them
func isDatabaseKind(string) bool                   { return false }
func jobArchives(j BackupJob) []BackupArchive      { return j.Archives }
func validateDatabase(string, *DatabaseDump) error { return errors.New("no database job on Windows") }
func dumpDatabases(context.Context, string, *DatabaseDump, func(string)) error {
	return errors.New("no database job on Windows")
}
func dumpSizes(context.Context, string, *DatabaseDump) []DumpInfo      { return nil }
func finishDumps(string, *DatabaseDump, bool, time.Time, func(string)) {}

// clientPresent: the CLI named by the current definition exists.
func (b *backupModule) clientPresent() bool {
	b.mu.Lock()
	path := ""
	if b.state.Spec != nil {
		path = b.state.Spec.ClientPath
	}
	b.mu.Unlock()
	if path == "" {
		return false
	}
	st, err := os.Stat(path)
	return err == nil && st.Mode().IsRegular()
}

// Settings of the CLI (-config): the secret goes through this file, never the command line.
type directoryConfig struct {
	BaseURL         string `json:"baseurl"`
	CertFingerprint string `json:"certfingerprint"`
	AuthID          string `json:"authid"`
	Secret          string `json:"secret"`
	Datastore       string `json:"datastore"`
	Namespace       string `json:"namespace,omitempty"`
	BackupID        string `json:"backup-id"`
	BackupDir       string `json:"backupdir"`
	UseVSS          bool   `json:"usevss"`
}

func runBackup(ctx context.Context, spec *BackupSpec, j BackupJob, emit func(string)) (int, error) {
	if spec.ClientPath == "" {
		return -1, errors.New("chemin du client de sauvegarde non renseigné sur l'hôte")
	}
	if st, err := os.Stat(spec.ClientPath); err != nil || !st.Mode().IsRegular() {
		return -1, fmt.Errorf("client de sauvegarde introuvable : %s", spec.ClientPath)
	}
	// without it the CLI asks on the console whether to trust the certificate
	if spec.Fingerprint == "" {
		return -1, errors.New("empreinte du certificat du PBS inconnue")
	}
	if len(j.Archives) != 1 {
		return -1, errors.New("un seul répertoire par sauvegarde sous Windows")
	}
	raw, _ := json.Marshal(directoryConfig{
		BaseURL:         "https://" + spec.Server,
		CertFingerprint: spec.Fingerprint,
		AuthID:          spec.TokenID,
		Secret:          spec.TokenSecret,
		Datastore:       j.Store,
		Namespace:       j.NS,
		BackupID:        j.BackupID,
		BackupDir:       j.Archives[0].Path,
		UseVSS:          true,
	})
	// in the directory of the agent: SYSTEM and Administrators only (install_windows.go)
	conf := filepath.Join(backups.dir, "backup-run.json")
	if err := writeFileAtomic(conf, raw, 0o600); err != nil {
		return -1, err
	}
	defer os.Remove(conf)
	emit(fmt.Sprintf("%s -config … (%s → %s/%s, ns %s)\n", filepath.Base(spec.ClientPath), j.Archives[0].Path, j.Store, j.BackupID, j.NS))
	code, err := runStreaming(ctx, os.Environ(), emit, spec.ClientPath, "-config", conf)
	if err != nil {
		return code, err
	}
	switch code {
	case 0:
		return 0, nil
	case 2:
		return code, errors.New("une autre sauvegarde du client tourne déjà sur ce poste")
	case 3:
		return code, errors.New("sauvegarde incomplète : des fichiers n'ont pas pu être lus (snapshot créé)")
	default:
		return code, fmt.Errorf("le client de sauvegarde a échoué (code %d)", code)
	}
}
