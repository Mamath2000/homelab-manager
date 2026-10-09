package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
)

// "6.12.48+deb13-amd64", "6.8.0-45-generic", "6.18.34+rpt-rpi-2712", "6.8.12-4-pve"
// -> numeric version + flavour suffix ("+deb13-amd64", "-generic", "+rpt-rpi-2712", "-pve")
var kernelRe = regexp.MustCompile(`^(\d+(?:\.\d+)+)(?:-(\d+))?(.*)$`)

func splitKernel(release string) ([]int, string, bool) {
	m := kernelRe.FindStringSubmatch(release)
	if m == nil {
		return nil, "", false
	}
	var nums []int
	parts := strings.Split(m[1], ".")
	if m[2] != "" {
		parts = append(parts, m[2])
	}
	for _, p := range parts {
		n, _ := strconv.Atoi(p)
		nums = append(nums, n)
	}
	return nums, m[3], true
}

func compareNums(a, b []int) int {
	for i := 0; i < len(a) || i < len(b); i++ {
		var x, y int
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		if x != y {
			if x > y {
				return 1
			}
			return -1
		}
	}
	return 0
}

// newerKernel returns the most recent installed kernel of the same flavour as the running one
// when it is newer than the running one, i.e. a reboot is needed to use it. Other flavours
// (a Raspberry Pi installs both -rpi-2712 and -rpi-v8) are ignored.
func newerKernel(running string, installed []string) string {
	rn, rs, ok := splitKernel(running)
	if !ok {
		return ""
	}
	best, bestN := "", rn
	for _, k := range installed {
		n, s, ok := splitKernel(k)
		if ok && s == rs && compareNums(n, bestN) > 0 {
			best, bestN = k, n
		}
	}
	return best
}

func runningKernel() string {
	var u syscall.Utsname
	if syscall.Uname(&u) != nil {
		return ""
	}
	b := make([]byte, 0, len(u.Release))
	for _, c := range u.Release {
		if c == 0 {
			break
		}
		b = append(b, byte(c))
	}
	return string(b)
}

// Kernels with modules installed. Containers (LXC) have none: their kernel is the host's.
func installedKernels() []string {
	entries, _ := os.ReadDir("/lib/modules")
	var out []string
	for _, e := range entries {
		// leftovers of removed kernels have no modules.dep
		if _, err := os.Stat(filepath.Join("/lib/modules", e.Name(), "modules.dep")); err == nil {
			out = append(out, e.Name())
		}
	}
	return out
}
