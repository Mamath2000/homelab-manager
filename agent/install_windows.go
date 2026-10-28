//go:build windows

package main

// homelab-agent.exe install <token> | uninstall, from an administrator prompt. The token is the
// one of the Home Assistant OS add-on: base64url JSON {hub, pin, code}, made by the hub (hubUrl.ts).

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	serviceName    = "homelab-agent"
	serviceDisplay = "Homelab Manager agent"
)

// Identity directory: SYSTEM and Administrators only (ProgramData is readable by every user).
const identitySDDL = "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"

var (
	pinRe  = regexp.MustCompile(`^[A-Za-z0-9+/=]+$`)
	codeRe = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
)

type installToken struct {
	Hub  string `json:"hub"`
	Pin  string `json:"pin"`
	Code string `json:"code"`
}

func parseToken(s string) (installToken, error) {
	var t installToken
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(strings.TrimSpace(s), "="))
	if err != nil || json.Unmarshal(raw, &t) != nil {
		return t, errors.New("invalid token: copy it again from the hub")
	}
	if !strings.HasPrefix(t.Hub, "https://") || !pinRe.MatchString(t.Pin) || !codeRe.MatchString(t.Code) {
		return t, errors.New("invalid token: copy it again from the hub")
	}
	t.Hub = strings.TrimRight(t.Hub, "/")
	return t, nil
}

func installDir() string {
	return filepath.Join(env("ProgramFiles", `C:\Program Files`), "homelab-agent")
}

func runInstall(ctx context.Context, args []string) error {
	if len(args) != 1 {
		return errors.New("usage: homelab-agent.exe install <token>")
	}
	tok, err := parseToken(args[0])
	if err != nil {
		return err
	}
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("service manager: %w (run from an administrator prompt)", err)
	}
	defer m.Disconnect()

	dir := defaultDir
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := restrictDir(dir); err != nil {
		return fmt.Errorf("permissions of %s: %w", dir, err)
	}
	fmt.Println("hub CA...")
	if err := fetchCA(ctx, tok, dir); err != nil {
		return err
	}
	fmt.Println("enrollment...")
	id, err := enroll(ctx, tok.Hub, tok.Code, dir)
	if err != nil {
		return fmt.Errorf("enrollment failed: %w", err)
	}
	fmt.Printf("enrolled as host %s\n", id)

	// a previous installation: stopped so that its binary can be replaced
	s, err := m.OpenService(serviceName)
	if err == nil {
		stopService(s)
	}
	exe, err := copySelf()
	if err != nil {
		return err
	}
	svcArgs := []string{"-hub", tok.Hub, "-dir", dir}
	if s != nil {
		cfg, err := s.Config()
		if err == nil {
			cfg.BinaryPathName = windows.EscapeArg(exe) + " " + joinArgs(svcArgs)
			cfg.StartType = mgr.StartAutomatic
			err = s.UpdateConfig(cfg)
		}
		if err != nil {
			s.Close()
			return fmt.Errorf("service update: %w", err)
		}
	} else {
		s, err = m.CreateService(serviceName, exe, mgr.Config{
			DisplayName: serviceDisplay,
			Description: "Reports this computer and its sessions to Homelab Manager.",
			StartType:   mgr.StartAutomatic,
		}, svcArgs...)
		if err != nil {
			return fmt.Errorf("service creation: %w", err)
		}
	}
	defer s.Close()
	_ = s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 10 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
		{Type: mgr.ServiceRestart, Delay: time.Minute},
	}, 86400)
	_ = s.SetRecoveryActionsOnNonCrashFailures(true)
	if err := s.Start(); err != nil {
		return fmt.Errorf("service start: %w", err)
	}
	fmt.Printf("service %s started (%s)\n", serviceName, exe)
	return nil
}

func runUninstall() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("service manager: %w (run from an administrator prompt)", err)
	}
	defer m.Disconnect()
	if s, err := m.OpenService(serviceName); err == nil {
		stopService(s)
		err = s.Delete()
		s.Close()
		if err != nil {
			return fmt.Errorf("service deletion: %w", err)
		}
		fmt.Printf("service %s removed\n", serviceName)
	}
	if err := os.RemoveAll(defaultDir); err != nil {
		return err
	}
	// the running binary cannot delete itself, but it can be moved: out of the installation directory
	// (a reinstallation before the next reboot must not lose its binary), removed at the next reboot
	dir := installDir()
	if self, err := os.Executable(); err == nil && strings.EqualFold(filepath.Dir(filepath.Clean(self)), dir) {
		moved := filepath.Join(os.TempDir(), fmt.Sprintf("homelab-agent-uninstalled-%d.exe", os.Getpid()))
		if os.Rename(self, moved) == nil {
			if p, err := windows.UTF16PtrFromString(moved); err == nil {
				_ = windows.MoveFileEx(p, nil, windows.MOVEFILE_DELAY_UNTIL_REBOOT)
			}
		}
	}
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("%s: %w", dir, err)
	}
	fmt.Println("uninstalled; delete the host in the hub to revoke its certificate")
	return nil
}

func restrictDir(dir string) error {
	sd, err := windows.SecurityDescriptorFromString(identitySDDL)
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

// fetchCA downloads the hub CA, trusting the agent server on the pinned key of the token only
// (sha256 of its SubjectPublicKeyInfo, as curl --pinnedpubkey on Linux).
func fetchCA(ctx context.Context, tok installToken, dir string) error {
	client := &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true, // replaced by the pin below
			VerifyConnection: func(cs tls.ConnectionState) error {
				if len(cs.PeerCertificates) == 0 {
					return errors.New("no server certificate")
				}
				sum := sha256.Sum256(cs.PeerCertificates[0].RawSubjectPublicKeyInfo)
				if base64.StdEncoding.EncodeToString(sum[:]) != tok.Pin {
					return errors.New("the hub key does not match the token")
				}
				return nil
			},
		}},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, tok.Hub+"/agent/ca.pem", nil)
	if err != nil {
		return err
	}
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("hub CA: %w", err)
	}
	defer res.Body.Close()
	pem, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if res.StatusCode != http.StatusOK || !x509.NewCertPool().AppendCertsFromPEM(pem) {
		return fmt.Errorf("hub CA: unexpected answer (HTTP %d)", res.StatusCode)
	}
	return writeFileAtomic(filepath.Join(dir, caFile), pem, 0o644)
}

// copySelf puts this binary in Program Files, unless it already runs from there.
func copySelf() (string, error) {
	src, err := os.Executable()
	if err != nil {
		return "", err
	}
	dir := installDir()
	dst := filepath.Join(dir, "homelab-agent.exe")
	if strings.EqualFold(filepath.Clean(src), dst) {
		return dst, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	in, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer in.Close()
	b, err := io.ReadAll(in)
	if err != nil {
		return "", err
	}
	if err := writeFileAtomic(dst, b, 0o755); err != nil {
		return "", fmt.Errorf("copy to %s: %w", dst, err)
	}
	return dst, nil
}

func stopService(s *mgr.Service) {
	st, err := s.Query()
	if err != nil || st.State == svc.Stopped {
		return
	}
	_, _ = s.Control(svc.Stop)
	for range 40 {
		time.Sleep(500 * time.Millisecond)
		if st, err := s.Query(); err != nil || st.State == svc.Stopped {
			return
		}
	}
}

func joinArgs(args []string) string {
	q := make([]string, len(args))
	for i, a := range args {
		q[i] = windows.EscapeArg(a)
	}
	return strings.Join(q, " ")
}
