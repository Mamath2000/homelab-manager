//go:build !windows

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Linux side of the backups (backup.go): proxmox-backup-client, natively when installed, otherwise
// in a container (Unraid).

var backups = newBackupModule(stateDir())

// Absolute, clean path; ':' separates the archive spec and the docker volume: refused.
func validDirectory(p string) bool {
	return filepath.IsAbs(p) && filepath.Clean(p) == p && !strings.ContainsAny(p, ":\n")
}

// Every job the hub sends is runnable here.
func checkPlatformJob(BackupJob) error { return nil }

// Client image when the definition does not name one (the hub sends its setting with every definition).
const defaultClientImage = "mathmath350/pbs-client:latest"

func (b *backupModule) image() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.state.Spec != nil && b.state.Spec.Image != "" {
		return b.state.Spec.Image
	}
	return defaultClientImage
}

// The client image is published for amd64 only.
func dockerBackupPossible(ctx context.Context) bool {
	if onWSL || runtime.GOARCH != "amd64" || !dock.available(ctx) {
		return false
	}
	_, err := exec.LookPath("docker")
	return err == nil
}

func imagePresent(ctx context.Context, image string) bool {
	return exec.CommandContext(ctx, "docker", "image", "inspect", image).Run() == nil
}

// Debian release the client repository of Proxmox serves (amd64 only); "" when not available here.
func aptBackupCodename() string {
	if runtime.GOARCH != "amd64" || !hasApt() {
		return ""
	}
	rel := osRelease()
	if rel["ID"] != "debian" {
		return ""
	}
	switch c := rel["VERSION_CODENAME"]; c {
	case "bookworm", "trixie":
		return c
	}
	return ""
}

func osRelease() map[string]string {
	out := map[string]string{}
	raw, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return out
	}
	for _, l := range strings.Split(string(raw), "\n") {
		if k, v, ok := strings.Cut(l, "="); ok {
			out[k] = strings.Trim(v, `"`)
		}
	}
	return out
}

// backupMode: how this host runs proxmox-backup-client: "native" (installed), "docker" (client
// image present), "" (neither: to install).
func backupMode(ctx context.Context) string {
	if _, err := exec.LookPath("proxmox-backup-client"); err == nil {
		return "native"
	}
	if dockerBackupPossible(ctx) && imagePresent(ctx, backups.image()) {
		return "docker"
	}
	return ""
}

// backupInstallOptions: how the client can be installed here, given the current mode.
func backupInstallOptions(ctx context.Context, mode string) []string {
	var out []string
	if mode != "native" && aptBackupCodename() != "" {
		out = append(out, "apt")
	}
	if mode == "" && dockerBackupPossible(ctx) {
		out = append(out, "docker")
	}
	return out
}

// installBackupClient installs the client: the client-only repository of Proxmox and its package,
// or the client image.
func installBackupClient(ctx context.Context, method string, emit func(string)) (int, error) {
	switch method {
	case "apt":
		codename := aptBackupCodename()
		if codename == "" {
			return -1, errors.New("APT install: Debian bookworm or trixie on amd64 only")
		}
		keyring := "/usr/share/keyrings/proxmox-release-" + codename + ".gpg"
		keyURL := "https://enterprise.proxmox.com/debian/proxmox-release-" + codename + ".gpg"
		emit("downloading the Proxmox release key " + keyURL + "\n")
		key, err := httpGetBytes(ctx, keyURL, 64*1024)
		if err != nil {
			return -1, fmt.Errorf("release key: %w", err)
		}
		if err := os.WriteFile(keyring, key, 0o644); err != nil {
			return -1, err
		}
		list := "deb [signed-by=" + keyring + "] http://download.proxmox.com/debian/pbs-client " + codename + " main\n"
		if err := os.WriteFile("/etc/apt/sources.list.d/pbs-client.list", []byte(list), 0o644); err != nil {
			return -1, err
		}
		emit("/etc/apt/sources.list.d/pbs-client.list: " + list)
		if code, err := runStreaming(ctx, aptEnv(), emit, "apt-get", "update"); err != nil || code != 0 {
			return code, err
		}
		return runStreaming(ctx, aptEnv(), emit, "apt-get", "install", "-y", "proxmox-backup-client")
	case "docker":
		if !dockerBackupPossible(ctx) {
			return -1, errors.New("Docker install: Docker on amd64 only (the client image is published for amd64)")
		}
		return runStreaming(ctx, os.Environ(), emit, "docker", "pull", backups.image())
	default:
		return -1, fmt.Errorf("unknown install method %q", method)
	}
}

func httpGetBytes(ctx context.Context, url string, max int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := (&http.Client{Timeout: time.Minute}).Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return io.ReadAll(io.LimitReader(res.Body, max))
}
func backupArgs(j BackupJob) []string {
	args := []string{"backup"}
	for _, a := range jobArchives(j) {
		args = append(args, a.Name+".pxar:"+a.Path)
	}
	args = append(args, "--backup-type", "host", "--backup-id", j.BackupID)
	if j.NS != "" {
		args = append(args, "--ns", j.NS)
	}
	for _, e := range j.Excludes {
		args = append(args, "--exclude", e)
	}
	return args
}

// The secret goes through the environment only, never the command line (visible in ps).
func backupEnv(spec *BackupSpec, j BackupJob) []string {
	return append(os.Environ(),
		"LC_ALL=C",
		"PBS_REPOSITORY="+spec.TokenID+"@"+spec.Server+":"+j.Store,
		"PBS_PASSWORD="+spec.TokenSecret,
		"PBS_FINGERPRINT="+spec.Fingerprint,
	)
}

func runBackup(ctx context.Context, spec *BackupSpec, j BackupJob, emit func(string)) (int, error) {
	env := backupEnv(spec, j)
	switch waitBackupMode(ctx, emit) {
	case "native":
		emit(fmt.Sprintf("proxmox-backup-client %s\n", strings.Join(backupArgs(j), " ")))
		return runStreaming(ctx, env, emit, "proxmox-backup-client", backupArgs(j)...)
	case "docker":
		if spec.Image == "" {
			return -1, errors.New("no proxmox-backup-client and no client image")
		}
		if err := exec.CommandContext(ctx, "docker", "image", "inspect", spec.Image).Run(); err != nil {
			emit("pulling " + spec.Image + "\n")
			if code, err := runStreaming(ctx, os.Environ(), emit, "docker", "pull", spec.Image); err != nil || code != 0 {
				return code, fmt.Errorf("docker pull %s failed", spec.Image)
			}
		}
		args := []string{"run", "--rm", "--network", "host", "-e", "PBS_REPOSITORY", "-e", "PBS_PASSWORD", "-e", "PBS_FINGERPRINT", "-e", "LC_ALL"}
		for _, a := range jobArchives(j) {
			args = append(args, "-v", a.Path+":"+a.Path+":ro")
		}
		args = append(args, spec.Image)
		args = append(args, backupArgs(j)...)
		emit(fmt.Sprintf("docker run … %s %s\n", spec.Image, strings.Join(backupArgs(j), " ")))
		return runStreaming(ctx, env, emit, "docker", args...)
	default:
		if _, err := exec.LookPath("docker"); err == nil {
			return -1, errors.New("proxmox-backup-client not installed and Docker daemon unreachable or client image missing")
		}
		return -1, errors.New("proxmox-backup-client unavailable (neither installed nor Docker)")
	}
}

// Docker engine start-up grace: at boot the agent can run a catch-up job before the daemon is up
// (Unraid starts the agent from the go file, well before the array and Docker).
const (
	dockerWaitMax  = 3 * time.Minute
	dockerWaitStep = 10 * time.Second
)

// ensureClientImage runs once at start: on a host that has backup jobs but no native client, waits for
// the Docker daemon and pulls the client image when it is missing, so that the first run does not have to.
func (b *backupModule) ensureClientImage(ctx context.Context) {
	b.mu.Lock()
	hasJobs := b.state.Spec != nil && len(b.state.Spec.Jobs) > 0
	b.mu.Unlock()
	if !hasJobs {
		return
	}
	if _, err := exec.LookPath("proxmox-backup-client"); err == nil {
		return
	}
	deadline := time.Now().Add(dockerWaitMax)
	for !dockerBackupPossible(ctx) {
		if time.Now().After(deadline) {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(dockerWaitStep):
		}
	}
	img := b.image()
	if imagePresent(ctx, img) {
		return
	}
	log.Printf("backup: pulling client image %s", img)
	if code, err := runStreaming(ctx, os.Environ(), func(string) {}, "docker", "pull", img); err != nil || code != 0 {
		log.Printf("backup: pull %s failed (code %d): %v", img, code, err)
	}
}

// waitBackupMode is backupMode, retried for a while when only the Docker daemon is missing.
func waitBackupMode(ctx context.Context, emit func(string)) string {
	mode := backupMode(ctx)
	if mode != "" || onWSL || runtime.GOARCH != "amd64" {
		return mode
	}
	if _, err := exec.LookPath("docker"); err != nil {
		return mode
	}
	emit("waiting for the Docker daemon…\n")
	deadline := time.Now().Add(dockerWaitMax)
	for mode == "" && time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return ""
		case <-time.After(dockerWaitStep):
		}
		mode = backupMode(ctx)
	}
	return mode
}
