//go:build windows

package main

// Power actions of the hub (homelab#206): reboot, shutdown and the lock of a user session.

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procLockWorkStation = windows.NewLazySystemDLL("user32.dll").NewProc("LockWorkStation")

// powerDelay: let job_done reach the hub before the host goes down.
const powerDelay = 3

func (s *session) power(ctx context.Context, in Inbound, emit func(string)) {
	flag, msg := "/r", "rebooting"
	if in.Action == "shutdown" {
		flag, msg = "/s", "powering off"
	}
	emit(fmt.Sprintf("%s in %d seconds...\n", msg, powerDelay))
	_ = s.send(ctx, Outbound{Type: "job_done", JobID: in.JobID})
	// /f: applications that refuse to close do not hold the host back
	out, err := exec.Command("shutdown.exe", flag, "/f", "/t", fmt.Sprint(powerDelay), "/c", "homelab-manager").CombinedOutput()
	if err != nil {
		log.Printf("%s failed: %v: %s", in.Action, err, out)
	}
}

func (s *session) lock(ctx context.Context, in Inbound, emit func(string)) {
	done := func(err error) {
		o := Outbound{Type: "job_done", JobID: in.JobID}
		if err != nil {
			o.ExitCode, o.Error = -1, err.Error()
		}
		_ = s.send(ctx, o)
	}
	if in.SessionID == nil {
		done(fmt.Errorf("missing session"))
		return
	}
	emit(fmt.Sprintf("locking session %d...\n", *in.SessionID))
	done(lockSession(*in.SessionID))
}

// lockWorkStation: the helper, in the user session (the service runs in session 0 and cannot lock another one).
func lockWorkStation() error {
	if r, _, err := procLockWorkStation.Call(); r == 0 {
		return err
	}
	return nil
}

// lockSession starts the helper in the session, as its user, and waits for it.
func lockSession(id uint32) error {
	var token windows.Token
	if err := windows.WTSQueryUserToken(id, &token); err != nil {
		return fmt.Errorf("session %d: %w", id, err)
	}
	defer token.Close()
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd, _ := windows.UTF16PtrFromString(windows.EscapeArg(exe) + " lock-session")
	desktop, _ := windows.UTF16PtrFromString(`winsta0\default`)
	si := windows.StartupInfo{Desktop: desktop}
	si.Cb = uint32(unsafe.Sizeof(si))
	var pi windows.ProcessInformation
	syscall.ForkLock.Lock()
	err = windows.CreateProcessAsUser(token, nil, cmd, nil, nil, false, windows.CREATE_NO_WINDOW, nil, nil, &si, &pi)
	syscall.ForkLock.Unlock()
	if err != nil {
		return fmt.Errorf("start: %w", err)
	}
	defer windows.CloseHandle(pi.Thread)
	defer windows.CloseHandle(pi.Process)
	if ev, _ := windows.WaitForSingleObject(pi.Process, 10_000); ev != windows.WAIT_OBJECT_0 {
		return fmt.Errorf("timeout")
	}
	var code uint32
	if err := windows.GetExitCodeProcess(pi.Process, &code); err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("lock refused (exit %d)", code)
	}
	// the session report follows by itself (service notification), but not before the lock is effective
	time.AfterFunc(time.Second, kickSessions)
	return nil
}
