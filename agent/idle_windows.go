//go:build windows

package main

// Keyboard/mouse activity of the user sessions (homelab#207). WTS does not maintain LastInputTime for the
// console session, and GetLastInputInfo only sees the session of its caller: the service starts a resident
// helper (agent idle-probe) in each user session. The helper writes the seconds since the last input on its
// stdout, a pipe of the service, every idleProbeEvery, and ends when the service stops reading.

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"strconv"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	procGetLastInputInfo = windows.NewLazySystemDLL("user32.dll").NewProc("GetLastInputInfo")
	procGetTickCount     = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetTickCount")
)

const (
	idleProbeEvery = 5 * time.Second
	// a helper that cannot start (no user token yet at logon...) is tried again after that
	idleProbeRetry = time.Minute
)

// lastInputIdle: time since the last input in the session of the calling process.
func lastInputIdle() (time.Duration, error) {
	info := struct{ size, time uint32 }{size: 8} // LASTINPUTINFO
	if r, _, err := procGetLastInputInfo.Call(uintptr(unsafe.Pointer(&info))); r == 0 {
		return 0, err
	}
	now, _, _ := procGetTickCount.Call()
	// both are GetTickCount values: the uint32 subtraction survives the wrap (49.7 days)
	return time.Duration(uint32(now)-info.time) * time.Millisecond, nil
}

// runIdleProbe is the helper, in the user session.
func runIdleProbe() {
	for {
		idle, err := lastInputIdle()
		if err != nil {
			os.Exit(1)
		}
		// broken pipe: the service is gone
		if _, err := fmt.Printf("%d\n", int64(idle/time.Second)); err != nil {
			return
		}
		time.Sleep(idleProbeEvery)
	}
}

type idleProbe struct {
	proc windows.Handle
	idle time.Duration // last value read
	seen time.Time     // when; zero until the first line
}

type idleProbes struct {
	mu      sync.Mutex
	helpers bool // service: helpers in the sessions; console run: this process reads its own session
	stopped bool
	running map[uint32]*idleProbe
	failed  map[uint32]time.Time
}

var probes = &idleProbes{running: map[uint32]*idleProbe{}, failed: map[uint32]time.Time{}}

// idle: time since the last input in a session, when known.
func (p *idleProbes) idle(id uint32) (time.Duration, bool) {
	if !p.helpers {
		var own uint32
		if windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &own) != nil || own != id {
			return 0, false
		}
		d, err := lastInputIdle()
		return d, err == nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	h := p.running[id]
	if h == nil || h.seen.IsZero() {
		return 0, false
	}
	return h.idle + time.Since(h.seen), true
}

// ensure starts a helper in each of these sessions that has none.
func (p *idleProbes) ensure(ids []uint32) {
	if !p.helpers {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stopped {
		return
	}
	for _, id := range ids {
		if p.running[id] != nil || time.Since(p.failed[id]) < idleProbeRetry {
			continue
		}
		h, out, err := startIdleProbe(id)
		if err != nil {
			log.Printf("idle probe, session %d: %v", id, err)
			p.failed[id] = time.Now()
			continue
		}
		delete(p.failed, id)
		p.running[id] = h
		go p.read(id, h, out)
	}
}

func (p *idleProbes) read(id uint32, h *idleProbe, out *os.File) {
	defer out.Close()
	sc := bufio.NewScanner(out)
	for sc.Scan() {
		sec, err := strconv.ParseInt(sc.Text(), 10, 64)
		if err != nil {
			continue
		}
		idle := time.Duration(sec) * time.Second
		p.mu.Lock()
		// back at the keyboard (or first value): report now rather than at the next poll
		woke := idle < idleThreshold && (h.seen.IsZero() || h.idle+time.Since(h.seen) >= idleThreshold)
		h.idle, h.seen = idle, time.Now()
		p.mu.Unlock()
		if woke {
			kickSessions()
		}
	}
	// the helper ended (logoff, killed...): started again by the next ensure if the session is still there
	p.mu.Lock()
	if p.running[id] == h {
		delete(p.running, id)
	}
	p.mu.Unlock()
	_, _ = windows.WaitForSingleObject(h.proc, windows.INFINITE)
	_ = windows.CloseHandle(h.proc)
}

// stop ends the helpers: they hold the binary, which an uninstallation removes.
func (p *idleProbes) stop() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.stopped = true
	for _, h := range p.running {
		_ = windows.TerminateProcess(h.proc, 0)
	}
}

// startIdleProbe starts the helper in a session, as its user (the service runs as LocalSystem).
func startIdleProbe(id uint32) (*idleProbe, *os.File, error) {
	var token windows.Token
	if err := windows.WTSQueryUserToken(id, &token); err != nil {
		return nil, nil, fmt.Errorf("user token: %w", err)
	}
	defer token.Close()
	exe, err := os.Executable()
	if err != nil {
		return nil, nil, err
	}
	var r, w windows.Handle
	if err := windows.CreatePipe(&r, &w, nil, 0); err != nil {
		return nil, nil, err
	}
	defer windows.CloseHandle(w) // the helper has its own copy
	// only the write end goes to the helper
	if err := windows.SetHandleInformation(w, windows.HANDLE_FLAG_INHERIT, windows.HANDLE_FLAG_INHERIT); err != nil {
		_ = windows.CloseHandle(r)
		return nil, nil, err
	}
	cmd, _ := windows.UTF16PtrFromString(windows.EscapeArg(exe) + " idle-probe")
	desktop, _ := windows.UTF16PtrFromString(`winsta0\default`)
	si := windows.StartupInfo{Desktop: desktop, Flags: windows.STARTF_USESTDHANDLES, StdOutput: w}
	si.Cb = uint32(unsafe.Sizeof(si))
	var pi windows.ProcessInformation
	// os/exec makes handles inheritable under this lock: none of them must leak into the helper
	syscall.ForkLock.Lock()
	err = windows.CreateProcessAsUser(token, nil, cmd, nil, nil, true, windows.CREATE_NO_WINDOW, nil, nil, &si, &pi)
	syscall.ForkLock.Unlock()
	if err != nil {
		_ = windows.CloseHandle(r)
		return nil, nil, fmt.Errorf("start: %w", err)
	}
	_ = windows.CloseHandle(pi.Thread)
	return &idleProbe{proc: pi.Process}, os.NewFile(uintptr(r), "idle-probe"), nil
}
