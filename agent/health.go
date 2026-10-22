package main

import (
	"context"
	"log"
	"math"
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
	Error           string   `json:"error,omitempty"`
}

type HealthSmart struct {
	CheckedAt int64             `json:"checkedAt"`
	Disks     []HealthSmartDisk `json:"disks"`
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
		if onHAOS && (p.Fstype == "overlay" || p.Fstype == "tmpfs" || p.Fstype == "proc" || p.Fstype == "sysfs") {
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
	s.healthSmart(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		case <-systemTicker.C:
			s.healthSystem(ctx)
		case <-diskTicker.C:
			s.healthDisks(ctx)
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
