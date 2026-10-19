//go:build windows

package main

import (
	"sort"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procWTSQuerySessionInformation = windows.NewLazySystemDLL("wtsapi32.dll").NewProc("WTSQuerySessionInformationW")

const (
	wtsSessionInfoEx = 25 // WTS_INFO_CLASS

	// WTS_CONNECTSTATE_CLASS
	wtsActive       = 0
	wtsConnected    = 1
	wtsDisconnected = 4

	// WTSINFOEX_LEVEL1.SessionFlags
	wtsSessionLock   = 0
	wtsSessionUnlock = 1

	// WTSINFOEX_LEVEL1.LogonTime: FILETIME (100 ns since 1601) of the unix epoch
	filetimeUnixEpoch = 116444736000000000

	// no input for that long: the session is no longer interactive (homelab#207)
	idleThreshold = 5 * time.Minute
)

// WTSINFOEXW with its WTSINFOEX_LEVEL1_W, up to LogonTime (the buffer is the system's, longer).
// Its LastInputTime is not maintained for the console session: see idle_windows.go.
type wtsInfoEx struct {
	Level          uint32
	_              uint32 // the union is 8-byte aligned
	SessionID      uint32
	SessionState   int32
	SessionFlags   int32
	WinStationName [33]uint16
	UserName       [21]uint16
	DomainName     [18]uint16
	LogonTime      int64
}

// compile-time check of the layout against the C structure (offsets 8 and 168 on amd64)
var _ = [1]struct{}{}[unsafe.Offsetof(wtsInfoEx{}.SessionID)-8+unsafe.Offsetof(wtsInfoEx{}.LogonTime)-168]

// Lock state from the session change notifications of the service: used when the session
// flags do not tell (WTS_SESSIONSTATE_UNKNOWN).
var lockEvents = struct {
	sync.Mutex
	locked map[uint32]bool
}{locked: map[uint32]bool{}}

func noteLock(session uint32, locked bool) {
	lockEvents.Lock()
	lockEvents.locked[session] = locked
	lockEvents.Unlock()
}

// collectSessions lists the sessions with a user: session 0 (services) and the listeners have none.
func collectSessions() (*SessionReport, error) {
	var list *windows.WTS_SESSION_INFO
	var n uint32
	if err := windows.WTSEnumerateSessions(0, 0, 1, &list, &n); err != nil {
		return nil, err
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(list)))
	out := []Session{}
	ids := []uint32{}
	for _, si := range unsafe.Slice(list, n) {
		s, ok := querySession(si.SessionID)
		if ok {
			out = append(out, s)
			ids = append(ids, s.ID)
		}
	}
	probes.ensure(ids)
	for i := range out {
		if d, ok := probes.idle(out[i].ID); ok {
			sec := int64(d / time.Second)
			out[i].IdleSec = &sec
			out[i].Interactive = out[i].State == "active" && d < idleThreshold
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return &SessionReport{CheckedAt: time.Now().UnixMilli(), Sessions: out}, nil
}

func querySession(id uint32) (Session, bool) {
	var buf *wtsInfoEx
	var size uint32
	r, _, _ := procWTSQuerySessionInformation.Call(0, uintptr(id), wtsSessionInfoEx,
		uintptr(unsafe.Pointer(&buf)), uintptr(unsafe.Pointer(&size)))
	if r == 0 || buf == nil {
		return Session{}, false
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(buf)))
	if buf.Level != 1 || uintptr(size) < unsafe.Sizeof(*buf) {
		return Session{}, false
	}
	user := windows.UTF16ToString(buf.UserName[:])
	if user == "" {
		return Session{}, false
	}
	s := Session{
		ID:      id,
		User:    user,
		Domain:  windows.UTF16ToString(buf.DomainName[:]),
		Station: windows.UTF16ToString(buf.WinStationName[:]),
	}
	if buf.LogonTime > filetimeUnixEpoch {
		s.LogonAt = (buf.LogonTime - filetimeUnixEpoch) / 10000
	}
	switch buf.SessionState {
	case wtsActive, wtsConnected:
		s.State = "active"
		switch buf.SessionFlags {
		case wtsSessionLock:
			s.State = "locked"
		case wtsSessionUnlock:
		default:
			lockEvents.Lock()
			if lockEvents.locked[id] {
				s.State = "locked"
			}
			lockEvents.Unlock()
		}
	case wtsDisconnected:
		// still logged on (fast user switching, remote desktop closed without logging off)
		s.State = "disconnected"
	default:
		return Session{}, false
	}
	return s, true
}

// sessionNotification: the WTSSESSION_NOTIFICATION of a SERVICE_CONTROL_SESSIONCHANGE.
func sessionNotification(eventData uintptr) *windows.WTSSESSION_NOTIFICATION {
	if eventData == 0 {
		return nil
	}
	// a pointer of the service control manager, handed over as an integer by svc
	return (*windows.WTSSESSION_NOTIFICATION)(*(*unsafe.Pointer)(unsafe.Pointer(&eventData)))
}
