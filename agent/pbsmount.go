//go:build !windows

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Read-only mount of a snapshot of a PBS (rpc pbs_mount / pbs_umount / pbs_mount_status / pbs_mount_check,
// #209): proxmox-backup-client mount (FUSE) in a transient systemd unit, under the configured mount root. The client
// always runs on this host, never in the container of a PBS. The token is a volatile one the hub creates
// for the mount and revokes after: its secret only goes through an environment file readable by root,
// removed as soon as the unit has started (never on a command line, never logged).

const (
	defaultPbsMountRoot = "/srv/pbs-restore"
	pbsMountUnit        = "hlm-pbs-mount"
	pbsMountEnv         = "/run/homelab-agent/pbs-mount.env"
)

// PbsMountSpec is what the hub asks to mount: where the PBS is, the snapshot and the archive, the token.
type PbsMountSpec struct {
	Server      string `json:"server"` // host name, IPv4 or [IPv6], as reachable from this host
	Port        int    `json:"port"`
	Fingerprint string `json:"fingerprint"`
	Store       string `json:"store"`
	NS          string `json:"ns,omitempty"`
	Type        string `json:"type"` // host | ct
	ID          string `json:"id"`
	Time        int64  `json:"time"`    // unix s
	Archive     string `json:"archive"` // name on the PBS: root.pxar.didx
	MountRoot   string `json:"mountRoot,omitempty"`
	TokenID     string `json:"tokenId,omitempty"`
	Secret      string `json:"secret,omitempty"`
}

// PbsMountState: the unit runs (Active) and the mount points under the configured root.
type PbsMountState struct {
	Active bool     `json:"active"`
	Paths  []string `json:"paths"`
}

var (
	pbsServerRe      = regexp.MustCompile(`^([A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}))*|\[[0-9A-Fa-f:.]{2,45}\])$`)
	pbsSafeIDRe      = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$`)
	pbsArchiveRe     = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,120}\.pxar\.didx$`)
	pbsMountTokenRe  = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}@pbs![A-Za-z][A-Za-z0-9._-]{0,31}$`)
	pbsMountSecretRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	pbsPinRe         = regexp.MustCompile(`^[0-9A-F]{2}(:[0-9A-F]{2}){31}$`)
)

// validPbsNS: a namespace of the PBS, up to 7 levels ("" is the root).
func validPbsNS(ns string) bool {
	if ns == "" {
		return true
	}
	parts := strings.Split(ns, "/")
	if len(parts) > 7 {
		return false
	}
	for _, p := range parts {
		if !pbsSafeIDRe.MatchString(p) {
			return false
		}
	}
	return true
}

// validatePbsTarget checks the address of the PBS (pbs_mount_check needs nothing else).
func validatePbsTarget(s *PbsMountSpec) error {
	if s == nil {
		return errors.New("missing mount spec")
	}
	if !pbsServerRe.MatchString(s.Server) {
		return fmt.Errorf("invalid server %q", s.Server)
	}
	if s.Port < 1 || s.Port > 65535 {
		return fmt.Errorf("invalid port %d", s.Port)
	}
	if !pbsPinRe.MatchString(s.Fingerprint) {
		return errors.New("invalid fingerprint")
	}
	return nil
}

// validatePbsMount checks everything that reaches the command line or the environment file.
func validatePbsMount(s *PbsMountSpec) error {
	if err := validatePbsTarget(s); err != nil {
		return err
	}
	if !pbsSafeIDRe.MatchString(s.Store) {
		return fmt.Errorf("invalid datastore %q", s.Store)
	}
	if !validPbsNS(s.NS) {
		return fmt.Errorf("invalid namespace %q", s.NS)
	}
	if s.Type != "host" && s.Type != "ct" {
		return fmt.Errorf("backup type %q not mountable (host or ct)", s.Type)
	}
	if !pbsSafeIDRe.MatchString(s.ID) {
		return fmt.Errorf("invalid backup id %q", s.ID)
	}
	// from 2000 to 2100: a timestamp, not anything else
	if s.Time < 946684800 || s.Time > 4102444800 {
		return fmt.Errorf("invalid snapshot time %d", s.Time)
	}
	if !pbsArchiveRe.MatchString(s.Archive) {
		return fmt.Errorf("invalid archive %q (a .pxar.didx archive)", s.Archive)
	}
	root := pbsMountRootFor(s)
	if !validPbsMountRoot(root) {
		return fmt.Errorf("invalid mount root %q (an absolute, normalized path other than /)", root)
	}
	if !pbsMountTokenRe.MatchString(s.TokenID) {
		return errors.New("invalid token id")
	}
	if !pbsMountSecretRe.MatchString(s.Secret) {
		return errors.New("invalid token secret")
	}
	return nil
}

func pbsMountRootFor(s *PbsMountSpec) string {
	if s == nil || s.MountRoot == "" {
		return defaultPbsMountRoot
	}
	return s.MountRoot
}

func validPbsMountRoot(root string) bool {
	return filepath.IsAbs(root) &&
		root != string(filepath.Separator) &&
		filepath.Clean(root) == root &&
		strings.IndexFunc(root, func(r rune) bool { return r < 0x20 || r == 0x7f }) == -1
}

// pbsSnapshotRef: type/id/time as the client names a snapshot (RFC 3339, UTC).
func pbsSnapshotRef(s *PbsMountSpec) string {
	return s.Type + "/" + s.ID + "/" + time.Unix(s.Time, 0).UTC().Format("2006-01-02T15:04:05Z")
}

// pbsMountPath: one directory per snapshot and archive, ct-101_2026-10-19_02-30-00_root.
func pbsMountPath(s *PbsMountSpec) string {
	base := strings.TrimSuffix(s.Archive, ".pxar.didx")
	return filepath.Join(pbsMountRootFor(s), s.Type+"-"+s.ID+"_"+time.Unix(s.Time, 0).UTC().Format("2006-01-02_15-04-05")+"_"+base)
}

// pbsMountEnvFile: the repository and the secret, read by systemd when the unit starts.
func pbsMountEnvFile(s *PbsMountSpec) string {
	return "LC_ALL=C\n" +
		"PBS_REPOSITORY=" + s.TokenID + "@" + s.Server + ":" + strconv.Itoa(s.Port) + ":" + s.Store + "\n" +
		"PBS_PASSWORD=" + s.Secret + "\n" +
		"PBS_FINGERPRINT=" + s.Fingerprint + "\n"
}

// pbsMountArgs: systemd-run of the client. Without --verbose the client forks once the mount is ready
// (Type=forking): systemd-run returns then, or fails with the client.
func pbsMountArgs(s *PbsMountSpec, path string) []string {
	args := []string{
		"--unit=" + pbsMountUnit,
		"--description=homelab-manager: PBS mount " + pbsSnapshotRef(s) + " " + s.Archive,
		"--collect",
		"-p", "Type=forking",
		"-p", "TimeoutStartSec=120",
		"-p", "EnvironmentFile=" + pbsMountEnv,
		"--",
		"proxmox-backup-client", "mount",
	}
	if s.NS != "" {
		args = append(args, "--ns", s.NS)
	}
	// the client takes the name without .didx
	return append(args, pbsSnapshotRef(s), strings.TrimSuffix(s.Archive, ".didx"), path)
}

// pbsMountCapable: the native client (the client image cannot mount for the host), FUSE and systemd-run.
func pbsMountCapable() bool {
	if onWSL || onHAOS {
		return false
	}
	for _, bin := range []string{"proxmox-backup-client", "systemd-run", "systemctl"} {
		if _, err := exec.LookPath(bin); err != nil {
			return false
		}
	}
	_, err := os.Stat("/dev/fuse")
	return err == nil
}

// parseRestoreMounts: mount points under the default root in /proc/self/mountinfo (field 5, octal escapes).
func parseRestoreMounts(mountinfo string) []string {
	return parseRestoreMountsAt(mountinfo, defaultPbsMountRoot)
}

func parseRestoreMountsAt(mountinfo, root string) []string {
	var out []string
	for _, line := range strings.Split(mountinfo, "\n") {
		f := strings.Fields(line)
		if len(f) < 5 {
			continue
		}
		p := unescapeMountinfo(f[4])
		if strings.HasPrefix(p, root+"/") {
			out = append(out, p)
		}
	}
	return out
}

func unescapeMountinfo(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func restoreMounts(root string) []string {
	raw, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return nil
	}
	return parseRestoreMountsAt(string(raw), root)
}

func pbsMountUnitActive(ctx context.Context) bool {
	out, _ := exec.CommandContext(ctx, "systemctl", "is-active", pbsMountUnit+".service").Output()
	s := strings.TrimSpace(string(out))
	return s == "active" || s == "activating" || s == "reloading"
}

func pbsMountStatus(ctx context.Context, root string) PbsMountState {
	paths := restoreMounts(root)
	if paths == nil {
		paths = []string{}
	}
	return PbsMountState{Active: pbsMountUnitActive(ctx), Paths: paths}
}

// mountPbsSnapshot starts the unit. One mount at a time on this host (the hub allows one in all).
func mountPbsSnapshot(ctx context.Context, s *PbsMountSpec) (*PbsMountState, error) {
	if err := validatePbsMount(s); err != nil {
		return nil, err
	}
	if !pbsMountCapable() {
		return nil, errors.New("cannot mount here: native proxmox-backup-client, /dev/fuse and systemd needed")
	}
	root := pbsMountRootFor(s)
	if st := pbsMountStatus(ctx, root); st.Active || len(st.Paths) > 0 {
		return nil, errors.New("a backup is already mounted on this host: unmount it first")
	}
	path := pbsMountPath(s)
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	if err := os.Mkdir(path, 0o700); err != nil && !os.IsExist(err) {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(pbsMountEnv), 0o700); err != nil {
		return nil, err
	}
	if err := os.WriteFile(pbsMountEnv, []byte(pbsMountEnvFile(s)), 0o600); err != nil {
		return nil, err
	}
	// systemd has read it when systemd-run returns, whatever the outcome
	defer os.Remove(pbsMountEnv)
	// a failed unit of a previous attempt keeps the name
	_ = exec.CommandContext(ctx, "systemctl", "reset-failed", pbsMountUnit+".service").Run()
	var errb bytes.Buffer
	cmd := exec.CommandContext(ctx, "systemd-run", pbsMountArgs(s, path)...)
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		_ = os.Remove(path)
		return nil, fmt.Errorf("mount failed: %s", pbsMountFailure(ctx, err, errb.String()))
	}
	st := pbsMountStatus(ctx, root)
	for _, p := range st.Paths {
		if p == path {
			return &st, nil
		}
	}
	// started but nothing mounted: stopped, so that the hub can revoke the token
	_, _ = unmountPbs(ctx, root)
	_ = os.Remove(path)
	return nil, fmt.Errorf("the client started but %s is not mounted", path)
}

// pbsMountFailure: what the client said (journal of the unit), else systemd-run.
func pbsMountFailure(ctx context.Context, err error, stderr string) string {
	out, _ := exec.CommandContext(ctx, "journalctl", "-u", pbsMountUnit+".service", "-n", "8", "--no-pager", "-o", "cat", "--since", "-3min").Output()
	if msg := strings.TrimSpace(string(out)); msg != "" {
		return msg
	}
	if msg := strings.TrimSpace(stderr); msg != "" {
		return msg
	}
	return err.Error()
}

// unmountPbs stops the unit, unmounts what is left under the configured root (lazily as a last resort) and
// removes the empty directories. Nothing mounted is not an error.
func unmountPbs(ctx context.Context, root string) ([]string, error) {
	if root == "" {
		root = defaultPbsMountRoot
	}
	if !validPbsMountRoot(root) {
		return nil, fmt.Errorf("invalid mount root %q", root)
	}
	beforeStop := restoreMounts(root)
	_ = exec.CommandContext(ctx, "systemctl", "stop", pbsMountUnit+".service").Run()
	_ = exec.CommandContext(ctx, "systemctl", "reset-failed", pbsMountUnit+".service").Run()
	stillMounted := restoreMounts(root)
	var done []string
	var errs []string
	for _, p := range stillMounted {
		if exec.CommandContext(ctx, "umount", p).Run() != nil {
			if out, err := exec.CommandContext(ctx, "umount", "-l", p).CombinedOutput(); err != nil {
				errs = append(errs, fmt.Sprintf("%s: %s", p, strings.TrimSpace(string(out))))
				continue
			}
		}
		done = append(done, p)
	}
	for _, p := range beforeStop {
		if !slices.Contains(stillMounted, p) {
			done = append(done, p)
		}
	}
	// Remove only mount-point directories, never unrelated children of the configured root.
	for _, p := range done {
		_ = os.Remove(p)
	}
	if len(errs) > 0 {
		return done, fmt.Errorf("unmount failed: %s", strings.Join(errs, "; "))
	}
	if done == nil {
		done = []string{}
	}
	return done, nil
}

// PbsReach is the answer of pbs_mount_check: the PBS answers from this host with the expected certificate.
type PbsReach struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// checkPbsReach: TCP connection then TLS handshake, the certificate compared to the pinned fingerprint.
func checkPbsReach(ctx context.Context, s *PbsMountSpec) PbsReach {
	if err := validatePbsTarget(s); err != nil {
		return PbsReach{Error: err.Error()}
	}
	host := strings.Trim(s.Server, "[]")
	addr := net.JoinHostPort(host, strconv.Itoa(s.Port))
	d := &net.Dialer{Timeout: 5 * time.Second}
	cctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	raw, err := d.DialContext(cctx, "tcp", addr)
	if err != nil {
		return PbsReach{Error: fmt.Sprintf("%s unreachable: %v", addr, err)}
	}
	defer raw.Close()
	// the pin is the check: the certificate of a PBS is self-signed
	conn := tls.Client(raw, &tls.Config{InsecureSkipVerify: true, ServerName: host})
	if err := conn.HandshakeContext(cctx); err != nil {
		return PbsReach{Error: fmt.Sprintf("%s: TLS: %v", addr, err)}
	}
	certs := conn.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return PbsReach{Error: addr + ": no certificate"}
	}
	if got := certFingerprint(certs[0].Raw); got != s.Fingerprint {
		return PbsReach{Error: fmt.Sprintf("%s answers with another certificate (%s)", addr, got)}
	}
	return PbsReach{OK: true}
}

func certFingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	parts := make([]string, len(sum))
	for i, b := range sum {
		parts[i] = fmt.Sprintf("%02X", b)
	}
	return strings.Join(parts, ":")
}
