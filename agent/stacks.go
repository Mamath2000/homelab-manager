package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

// Stacks the agent has seen running, kept so that a stack whose containers were removed
// (`docker compose down`) stays listed and can be started again. The agent only ever acts on
// stacks from this list: the hub names a stack, it never sends a path.
type knownStack struct {
	Name        string   `json:"name"`
	WorkingDir  string   `json:"workingDir"`
	ConfigFiles []string `json:"configFiles"`
	EnvFiles    []string `json:"envFiles"`
	Services    []string `json:"services"`
	LastSeen    int64    `json:"lastSeen"`
}

type stackStore struct {
	mu     sync.Mutex
	path   string
	stacks map[string]knownStack
}

func stateDir() string {
	return env("AGENT_STATE_DIR", "/var/lib/homelab-agent")
}

func newStackStore(dir string) *stackStore {
	s := &stackStore{path: filepath.Join(dir, "stacks.json"), stacks: map[string]knownStack{}}
	if raw, err := os.ReadFile(s.path); err == nil {
		var list []knownStack
		if json.Unmarshal(raw, &list) == nil {
			for _, k := range list {
				if stackNameRe.MatchString(k.Name) {
					s.stacks[k.Name] = k
				}
			}
		}
	}
	return s
}

func (s *stackStore) saveLocked() {
	list := make([]knownStack, 0, len(s.stacks))
	for _, k := range s.stacks {
		list = append(list, k)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
	raw, _ := json.MarshalIndent(list, "", "  ")
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err == nil {
		_ = writeFileAtomic(s.path, raw, 0o600)
	}
}

func filesExist(paths []string) bool {
	if len(paths) == 0 {
		return false
	}
	for _, p := range paths {
		if st, err := os.Stat(p); err != nil || !st.Mode().IsRegular() {
			return false
		}
	}
	return true
}

// merge records the running stacks and appends the known ones that have no container left
// (status down), as long as their compose files still exist.
func (s *stackStore) merge(live []DockerStack) []DockerStack {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UnixMilli()
	changed := false
	present := map[string]bool{}
	for _, st := range live {
		present[st.Name] = true
		if !stackNameRe.MatchString(st.Name) || st.WorkingDir == "" || len(st.ConfigFiles) == 0 {
			continue
		}
		svcs := []string{}
		for _, svc := range st.Services {
			svcs = append(svcs, svc.Name)
		}
		old, ok := s.stacks[st.Name]
		// LastSeen only changes with the rest: the file may sit on a flash drive (Unraid)
		k := knownStack{Name: st.Name, WorkingDir: st.WorkingDir, ConfigFiles: st.ConfigFiles, EnvFiles: st.EnvFiles, Services: svcs, LastSeen: now}
		// keep services seen earlier (a stopped service may have no container left)
		if ok {
			k.Services = union(old.Services, svcs)
		}
		if !ok || old.WorkingDir != k.WorkingDir || strings.Join(old.ConfigFiles, ",") != strings.Join(k.ConfigFiles, ",") ||
			strings.Join(old.Services, ",") != strings.Join(k.Services, ",") {
			changed = true
		}
		s.stacks[st.Name] = k
	}
	out := append([]DockerStack{}, live...)
	for name, k := range s.stacks {
		if present[name] {
			continue
		}
		if !filesExist(k.ConfigFiles) {
			delete(s.stacks, name)
			changed = true
			continue
		}
		svcs := []DockerService{}
		for _, n := range k.Services {
			svcs = append(svcs, DockerService{Name: n, Containers: []DockerContainer{}})
		}
		out = append(out, DockerStack{Name: name, WorkingDir: k.WorkingDir, ConfigFiles: k.ConfigFiles, EnvFiles: k.EnvFiles, Status: "down", Services: svcs})
	}
	if changed {
		s.saveLocked()
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func union(a, b []string) []string {
	set := map[string]bool{}
	for _, x := range append(append([]string{}, a...), b...) {
		set[x] = true
	}
	out := make([]string, 0, len(set))
	for x := range set {
		out = append(out, x)
	}
	sort.Strings(out)
	return out
}

func (s *stackStore) get(name string) (knownStack, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	k, ok := s.stacks[name]
	return k, ok
}

func (s *stackStore) forget(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.stacks, name)
	s.saveLocked()
}

// Compose project and service names: what compose itself accepts, nothing that could be read
// as an option or a path.
var (
	stackNameRe   = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	serviceNameRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$`)
)

// target resolves the stack (and service) of a request against what the agent knows.
func (d *dockerModule) target(ctx context.Context, stack, service string) (knownStack, error) {
	if !stackNameRe.MatchString(stack) {
		return knownStack{}, errors.New("invalid stack name")
	}
	if service != "" && !serviceNameRe.MatchString(service) {
		return knownStack{}, errors.New("invalid service name")
	}
	k, ok := d.store.get(stack)
	if !ok {
		// a stack started since the last report: refresh once
		if _, err := d.collect(ctx); err == nil {
			k, ok = d.store.get(stack)
		}
	}
	if !ok {
		return knownStack{}, fmt.Errorf("unknown stack %q", stack)
	}
	if service != "" && !contains(k.Services, service) {
		return knownStack{}, fmt.Errorf("unknown service %q in stack %q", service, stack)
	}
	return k, nil
}

func contains(list []string, x string) bool {
	for _, v := range list {
		if v == x {
			return true
		}
	}
	return false
}

// composeArgs builds `docker compose` arguments for a known stack: the project, its directory
// and files come from the labels compose set on the containers.
func composeArgs(k knownStack, args ...string) []string {
	a := []string{"compose", "--ansi", "never", "-p", k.Name, "--project-directory", k.WorkingDir}
	for _, f := range k.ConfigFiles {
		a = append(a, "-f", f)
	}
	for _, f := range k.EnvFiles {
		if filesExist([]string{f}) {
			a = append(a, "--env-file", f)
		}
	}
	return append(a, args...)
}

func withService(args []string, service string) []string {
	if service != "" {
		return append(args, service)
	}
	return args
}

// runAction runs a docker_* job on a stack (docker_check aside), streaming the compose output.
func (d *dockerModule) runAction(ctx context.Context, emit func(string), action, stack, service string) (int, error) {
	k, err := d.target(ctx, stack, service)
	if err != nil {
		return -1, err
	}
	run := func(args ...string) (int, error) {
		args = withService(args, service)
		emit("$ docker compose -p " + k.Name + " " + strings.Join(args, " ") + "\n")
		return runStreaming(ctx, dockerEnv(), emit, "docker", composeArgs(k, args...)...)
	}
	switch action {
	case "docker_up":
		return run("up", "-d")
	case "docker_stop":
		return run("stop")
	case "docker_restart":
		return run("restart")
	case "docker_update":
		if code, err := run("pull"); code != 0 || err != nil {
			return code, err
		}
		if code, err := run("up", "-d"); code != 0 || err != nil {
			return code, err
		}
		// dangling images only: the versions just replaced, never an image still tagged
		emit("$ docker image prune -f\n")
		return runStreaming(ctx, dockerEnv(), emit, "docker", "image", "prune", "-f")
	}
	return -1, fmt.Errorf("unknown action %q", action)
}

// check asks the registries for the digest of every image used by the stacks.
func (d *dockerModule) check(ctx context.Context, emit func(string)) (*DockerUpdates, error) {
	r, err := d.collect(ctx)
	if err != nil {
		return nil, err
	}
	reg := newRegistryClient(d.insecureRegistries(ctx))
	upd := &DockerUpdates{Images: []ImageCheck{}}
	failed := 0
	for _, img := range r.Images {
		c := ImageCheck{Ref: img.Ref}
		ref, err := parseRef(img.Ref)
		switch {
		case err != nil:
			c.Error = err.Error()
		case ref.Digest != "":
			c.Error = "pinned by digest"
		case img.ID == "":
			c.Error = "image not present locally"
		case img.Digest == "":
			c.Error = "local image (built on the host, no registry digest)"
		default:
			cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
			c.Digest, err = reg.remoteDigest(cctx, ref)
			cancel()
			if err != nil {
				c.Error = err.Error()
			}
		}
		switch {
		case c.Error != "":
			failed++
			emit(fmt.Sprintf("%s: %s\n", img.Ref, c.Error))
		case slices.Contains(img.Digests, c.Digest):
			emit(fmt.Sprintf("%s: up to date\n", img.Ref))
		default:
			emit(fmt.Sprintf("%s: update available (%s → %s)\n", img.Ref, short(img.Digest), short(c.Digest)))
		}
		upd.Images = append(upd.Images, c)
	}
	upd.CheckedAt = time.Now().UnixMilli()
	emit(fmt.Sprintf("%d image(s) checked, %d not checkable\n", len(r.Images), failed))
	return upd, nil
}

func short(digest string) string {
	d := strings.TrimPrefix(digest, "sha256:")
	if len(d) > 12 {
		d = d[:12]
	}
	return d
}

const maxRPCBytes = 512 * 1024

// logs returns the last lines of the stack (or service) logs.
func (d *dockerModule) logs(ctx context.Context, stack, service string, tail int) (string, error) {
	k, err := d.target(ctx, stack, service)
	if err != nil {
		return "", err
	}
	if tail <= 0 {
		tail = 200
	}
	tail = min(tail, 2000)
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "docker", composeArgs(k, withService([]string{"logs", "--no-color", "--timestamps", "--tail", fmt.Sprint(tail)}, service)...)...)
	cmd.Env = dockerEnv()
	out, err := cmd.CombinedOutput()
	if err != nil && len(out) == 0 {
		return "", err
	}
	logs := sortLogs(string(out))
	if len(logs) > maxRPCBytes {
		logs = logs[len(logs)-maxRPCBytes:]
	}
	return logs, nil
}

// sortLogs merges the containers of a stack by time: compose prints them one after the other.
// Lines are "web-1  | 2026-10-09T22:49:45.958655709Z message"; a line without a timestamp stays
// after the previous one.
func sortLogs(out string) string {
	type line struct {
		at   time.Time
		text string
	}
	lines := []line{}
	var last time.Time
	for _, l := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		if _, rest, ok := strings.Cut(l, "| "); ok {
			ts, _, _ := strings.Cut(rest, " ")
			if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
				last = t
			}
		}
		lines = append(lines, line{last, l})
	}
	sort.SliceStable(lines, func(i, j int) bool { return lines[i].at.Before(lines[j].at) })
	var b strings.Builder
	for _, l := range lines {
		b.WriteString(l.text + "\n")
	}
	return b.String()
}

type composeFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	// values of env files are replaced: only the variable names are shown
	Masked bool `json:"masked,omitempty"`
}

// maskEnv keeps comments and variable names of an env file and hides the values.
func maskEnv(content string) string {
	var b strings.Builder
	sc := bufio.NewScanner(strings.NewReader(content))
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			b.WriteString(line + "\n")
			continue
		}
		if key, _, ok := strings.Cut(line, "="); ok {
			b.WriteString(key + "=••••••\n")
		} else {
			b.WriteString("••••••\n")
		}
	}
	return b.String()
}

func readLimited(path string, limit int64) (string, error) {
	st, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !st.Mode().IsRegular() {
		return "", fmt.Errorf("%s: not a regular file", path)
	}
	if st.Size() > limit {
		return "", fmt.Errorf("%s: larger than %d KB", path, limit/1024)
	}
	raw, err := os.ReadFile(path)
	return string(raw), err
}

// composeFiles returns the compose files of a stack and its env files with masked values.
func (d *dockerModule) composeFiles(ctx context.Context, stack string) ([]composeFile, error) {
	k, err := d.target(ctx, stack, "")
	if err != nil {
		return nil, err
	}
	files := []composeFile{}
	total := 0
	add := func(path string, masked bool) {
		content, err := readLimited(path, 256*1024)
		if err != nil {
			content = "# " + err.Error() + "\n"
		}
		if masked {
			content = maskEnv(content)
		}
		if total+len(content) > maxRPCBytes {
			content = "# not shown: answer too large\n"
		}
		total += len(content)
		files = append(files, composeFile{Path: path, Content: content, Masked: masked})
	}
	for _, f := range k.ConfigFiles {
		add(f, false)
	}
	envs := append([]string{}, k.EnvFiles...)
	if def := filepath.Join(k.WorkingDir, ".env"); !contains(envs, def) && filesExist([]string{def}) {
		envs = append(envs, def)
	}
	for _, f := range envs {
		add(f, true)
	}
	return files, nil
}

// forget drops a stack that has no container left from the known stacks.
func (d *dockerModule) forget(ctx context.Context, stack string) error {
	if _, err := d.target(ctx, stack, ""); err != nil {
		return err
	}
	r, err := d.collect(ctx)
	if err != nil {
		return err
	}
	for _, st := range r.Stacks {
		if st.Name == stack && st.Status != "down" {
			return fmt.Errorf("stack %q still has containers: remove them first (docker compose down)", stack)
		}
	}
	d.store.forget(stack)
	return nil
}
