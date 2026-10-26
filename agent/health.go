package main

import (
	"context"
	"log"
	"math"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/mem"
)

const (
	defaultHealthSystemInterval = 30 * time.Second
	defaultHealthDiskInterval   = 5 * time.Minute
	defaultHealthSmartInterval  = 24 * time.Hour
)

type HealthSystem struct {
	CheckedAt  int64    `json:"checkedAt"`
	CPUPercent float64  `json:"cpuPercent"`
	MemPercent float64  `json:"memPercent"`
	MemUsed    uint64   `json:"memUsed"`
	MemTotal   uint64   `json:"memTotal"`
	Load1      *float64 `json:"load1,omitempty"`
	Load5      *float64 `json:"load5,omitempty"`
	Load15     *float64 `json:"load15,omitempty"`
	// CPUCount: usable CPUs (cgroup quota applied, may be fractional); absent from older agents
	CPUCount float64 `json:"cpuCount,omitempty"`
}

type HealthVolume struct {
	Device     string  `json:"device"`
	Mountpoint string  `json:"mountpoint"`
	Fstype     string  `json:"fstype"`
	Used       uint64  `json:"used"`
	Total      uint64  `json:"total"`
	Percent    float64 `json:"percent"`
}

type HealthDisks struct {
	CheckedAt int64          `json:"checkedAt"`
	Volumes   []HealthVolume `json:"volumes"`
}

type HealthSmartDisk struct {
	Device          string   `json:"device"`
	Model           string   `json:"model,omitempty"`
	Serial          string   `json:"serial,omitempty"`
	Healthy         *bool    `json:"healthy,omitempty"`
	TemperatureC    *float64 `json:"temperatureC,omitempty"`
	Reallocated     *uint64  `json:"reallocated,omitempty"`
	NvmeWearPercent *float64 `json:"nvmeWearPercent,omitempty"`
	Standby         bool     `json:"standby,omitempty"` // asleep: not read, so not woken
	Error           string   `json:"error,omitempty"`
}

type HealthSmart struct {
	CheckedAt int64             `json:"checkedAt"`
	Disks     []HealthSmartDisk `json:"disks"`
}

type HealthRaidMember struct {
	Device string `json:"device"`
	State  string `json:"state"`          // in_sync, faulty, spare... (comma-separated flags)
	Slot   *int   `json:"slot,omitempty"` // none for a spare or a failed member
	Errors uint64 `json:"errors"`         // read errors md corrected, never reset
}

type HealthRaidArray struct {
	Name          string             `json:"name"`
	Level         string             `json:"level"`
	State         string             `json:"state"` // array_state: clean, active, inactive, read-auto...
	RaidDisks     int                `json:"raidDisks"`
	Degraded      int                `json:"degraded"`
	SyncAction    string             `json:"syncAction"` // idle, check, repair, resync, recover, reshape, frozen
	SyncPercent   *float64           `json:"syncPercent,omitempty"`
	MismatchCount uint64             `json:"mismatchCount"`
	Members       []HealthRaidMember `json:"members"`
}

// HealthUnraidDisk: a slot of the Unraid array or a device of a pool; empty slots are left out.
type HealthUnraidDisk struct {
	Name     string  `json:"name"` // parity, disk1, speed2...
	Type     string  `json:"type"` // Parity, Data, Cache
	Device   string  `json:"device,omitempty"`
	Status   string  `json:"status"`             // DISK_OK, DISK_DSBL, DISK_INVALID...
	Errors   uint64  `json:"errors"`             // read/write errors of the md driver since the array started
	FsErrors *uint64 `json:"fsErrors,omitempty"` // btrfs device stats of a pool device, never reset
}

type HealthUnraidPool struct {
	Name            string             `json:"name"`
	FsType          string             `json:"fsType"`
	Profile         string             `json:"profile,omitempty"` // raid1, single...
	Devices         int                `json:"devices"`
	DevicesExpected int                `json:"devicesExpected"`
	Health          string             `json:"health,omitempty"` // zpool health (ONLINE, DEGRADED...)
	Disks           []HealthUnraidDisk `json:"disks"`
}

// HealthUnraidCheck: the last parity check (or sync), times in milliseconds.
type HealthUnraidCheck struct {
	StartedAt  int64  `json:"startedAt"`
	FinishedAt int64  `json:"finishedAt,omitempty"`
	Errors     uint64 `json:"errors"`
	Exit       int    `json:"exit"` // 0: completed, otherwise aborted (-4: cancelled)
}

type HealthUnraid struct {
	State       string             `json:"state"`                // mdState: STARTED, STOPPED...
	SyncAction  string             `json:"syncAction,omitempty"` // while a sync runs: "check P", "recon D5", "clear"...
	SyncPercent *float64           `json:"syncPercent,omitempty"`
	LastCheck   *HealthUnraidCheck `json:"lastCheck,omitempty"`
	Disks       []HealthUnraidDisk `json:"disks"`
	Pools       []HealthUnraidPool `json:"pools"`
}

type HealthCephCheck struct {
	Code     string   `json:"code"`
	Severity string   `json:"severity"` // HEALTH_WARN, HEALTH_ERR
	Message  string   `json:"message"`
	Detail   []string `json:"detail"`
	Muted    bool     `json:"muted"`
}

// HealthCephOsd: an OSD of this node.
type HealthCephOsd struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
	Up   bool   `json:"up"`
	In   bool   `json:"in"`
}

// HealthCeph: state of the whole Ceph cluster as one of its nodes sees it, plus the OSDs it hosts.
type HealthCeph struct {
	Fsid       string            `json:"fsid,omitempty"`
	Status     string            `json:"status,omitempty"` // HEALTH_OK, HEALTH_WARN, HEALTH_ERR
	Error      string            `json:"error,omitempty"`  // ceph did not answer (no quorum, timeout...)
	Checks     []HealthCephCheck `json:"checks"`
	OsdsTotal  int               `json:"osdsTotal"`
	OsdsUp     int               `json:"osdsUp"`
	OsdsIn     int               `json:"osdsIn"`
	Pgs        int               `json:"pgs"`
	PgsClean   int               `json:"pgsClean"`
	UsedBytes  uint64            `json:"usedBytes"`
	TotalBytes uint64            `json:"totalBytes"`
	Osds       []HealthCephOsd   `json:"osds"`
}

type HealthRaid struct {
	CheckedAt int64             `json:"checkedAt"`
	Arrays    []HealthRaidArray `json:"arrays"`
	Unraid    *HealthUnraid     `json:"unraid,omitempty"`
	Ceph      *HealthCeph       `json:"ceph,omitempty"`
}

func (r *HealthRaid) empty() bool {
	return len(r.Arrays) == 0 && r.Unraid == nil && r.Ceph == nil
}

type HealthConfig struct {
	SystemIntervalSeconds int      `json:"systemIntervalSeconds"`
	DiskIntervalSeconds   int      `json:"diskIntervalSeconds"`
	SmartIntervalSeconds  int      `json:"smartIntervalSeconds"`
	SmartDevices          []string `json:"smartDevices"`
}

func defaultHealthConfig() HealthConfig {
	return HealthConfig{
		SystemIntervalSeconds: int(defaultHealthSystemInterval / time.Second),
		DiskIntervalSeconds:   int(defaultHealthDiskInterval / time.Second),
		SmartIntervalSeconds:  int(defaultHealthSmartInterval / time.Second),
	}
}

func (c HealthConfig) normalized() HealthConfig {
	d := defaultHealthConfig()
	if c.SystemIntervalSeconds > 0 {
		d.SystemIntervalSeconds = c.SystemIntervalSeconds
	}
	if c.DiskIntervalSeconds > 0 {
		d.DiskIntervalSeconds = c.DiskIntervalSeconds
	}
	if c.SmartIntervalSeconds > 0 {
		d.SmartIntervalSeconds = c.SmartIntervalSeconds
	}
	d.SmartDevices = append([]string(nil), c.SmartDevices...)
	return d
}

func (s *session) healthConfigChanged() <-chan struct{} {
	s.healthMu.RLock()
	defer s.healthMu.RUnlock()
	return s.healthChanged
}

func collectHealthSystem() (*HealthSystem, error) {
	cpuPercents, err := cpu.Percent(0, false)
	if err != nil {
		return nil, err
	}
	if len(cpuPercents) == 0 || math.IsNaN(cpuPercents[0]) || math.IsInf(cpuPercents[0], 0) {
		return nil, errHealthUnavailable("cpu")
	}
	memory, err := mem.VirtualMemory()
	if err != nil {
		return nil, err
	}
	r := &HealthSystem{
		CheckedAt:  time.Now().UnixMilli(),
		CPUPercent: cpuPercents[0],
		MemPercent: memory.UsedPercent,
		MemUsed:    memory.Used,
		MemTotal:   memory.Total,
		CPUCount:   collectCPUCount(),
	}
	load, err := collectHealthLoad()
	if err != nil {
		log.Printf("health load average collection failed: %v", err)
	} else if load != nil {
		r.Load1, r.Load5, r.Load15 = load.Load1, load.Load5, load.Load15
	}
	return r, nil
}

func collectHealthDisks() (*HealthDisks, error) {
	if onHAOS {
		return collectHAOSHealthDisks()
	}
	partitions, err := disk.Partitions(false)
	if err != nil {
		return nil, err
	}
	r := &HealthDisks{CheckedAt: time.Now().UnixMilli(), Volumes: []HealthVolume{}}
	for _, p := range partitions {
		if isHealthExcludedMountpoint(p.Mountpoint) || !isHealthStoragePartition(p.Device, p.Fstype) {
			continue
		}
		usage, err := disk.Usage(p.Mountpoint)
		if err != nil {
			log.Printf("health disk usage for %s failed: %v", p.Mountpoint, err)
			continue
		}
		if usage.Total == 0 || math.IsNaN(usage.UsedPercent) || math.IsInf(usage.UsedPercent, 0) {
			continue
		}
		r.Volumes = append(r.Volumes, HealthVolume{
			Device: p.Device, Mountpoint: p.Mountpoint, Fstype: p.Fstype,
			Used: usage.Used, Total: usage.Total, Percent: usage.UsedPercent,
		})
	}
	return r, nil
}

// Boot partition and container runtime storage (Docker, containerd): not a volume to watch.
func isHealthExcludedMountpoint(mountpoint string) bool {
	if mountpoint == "/boot/efi" {
		return true
	}
	for _, dir := range []string{"/var/lib/docker", "/var/lib/containerd"} {
		if mountpoint == dir || strings.HasPrefix(mountpoint, dir+"/") {
			return true
		}
	}
	return false
}

func (s *session) healthConfig() HealthConfig {
	s.healthMu.RLock()
	defer s.healthMu.RUnlock()
	return s.healthCfg.normalized()
}

func (s *session) setHealthConfig(c HealthConfig) {
	s.healthMu.Lock()
	s.healthCfg = c.normalized()
	select {
	case s.healthChanged <- struct{}{}:
	default:
	}
	s.healthMu.Unlock()
}

func (s *session) healthLoop(ctx context.Context) {
	cfg := s.healthConfig()
	systemTicker := time.NewTicker(time.Duration(cfg.SystemIntervalSeconds) * time.Second)
	diskTicker := time.NewTicker(time.Duration(cfg.DiskIntervalSeconds) * time.Second)
	smartTicker := time.NewTicker(time.Duration(cfg.SmartIntervalSeconds) * time.Second)
	defer systemTicker.Stop()
	defer diskTicker.Stop()
	defer smartTicker.Stop()

	s.healthSystem(ctx)
	s.healthDisks(ctx)
	go s.healthRaid(ctx)
	s.healthSmart(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		case <-systemTicker.C:
			s.healthSystem(ctx)
		case <-diskTicker.C:
			s.healthDisks(ctx)
			go s.healthRaid(ctx)
		case <-smartTicker.C:
			if len(s.healthConfig().SmartDevices) > 0 {
				go s.healthSmart(ctx)
			}
		case <-s.healthConfigChanged():
			next := s.healthConfig()
			systemTicker.Reset(time.Duration(next.SystemIntervalSeconds) * time.Second)
			diskTicker.Reset(time.Duration(next.DiskIntervalSeconds) * time.Second)
			smartTicker.Reset(time.Duration(next.SmartIntervalSeconds) * time.Second)
			go s.healthSmart(ctx)
		}
	}
}

func (s *session) healthSystem(ctx context.Context) {
	r, err := collectHealthSystem()
	if err != nil {
		log.Printf("health system collection failed: %v", err)
		return
	}
	_ = s.send(ctx, Outbound{Type: "health_system", HealthSystem: r})
}

func (s *session) healthDisks(ctx context.Context) {
	r, err := collectHealthDisks()
	if err != nil {
		log.Printf("health disk collection failed: %v", err)
		return
	}
	_ = s.send(ctx, Outbound{Type: "health_disks", HealthDisks: r})
}

// healthRaidReported: a host without md arrays, Unraid array or Ceph sends nothing; one whose arrays went away sends an
// empty report once, so the hub drops them.
var (
	healthRaidReported atomic.Bool
	healthRaidMu       sync.Mutex // ceph can hang (no quorum): one collection at a time, out of the health loop
)

func (s *session) healthRaid(ctx context.Context) {
	if !healthRaidMu.TryLock() {
		return
	}
	defer healthRaidMu.Unlock()
	r := collectHealthRaid(ctx)
	if r.empty() && !healthRaidReported.Load() {
		return
	}
	if s.send(ctx, Outbound{Type: "health_raid", HealthRaid: r}) == nil {
		healthRaidReported.Store(!r.empty())
	}
}

func (s *session) healthSmart(ctx context.Context) {
	if !s.healthSmartMu.TryLock() {
		return
	}
	defer s.healthSmartMu.Unlock()
	cfg := s.healthConfig()
	r := collectHealthSmart(ctx, cfg.SmartDevices)
	_ = s.send(ctx, Outbound{Type: "health_smart", HealthSmart: r})
}

type healthUnavailableError string

func (e healthUnavailableError) Error() string { return string(e) + " metric unavailable" }

func errHealthUnavailable(name string) error {
	return healthUnavailableError(name)
}
