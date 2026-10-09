package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"
)

// Docker Engine API over its unix socket: structured reads, no CLI output to parse. Actions go
// through the `docker compose` CLI so that their output can be streamed to the hub.
type dockerClient struct {
	http *http.Client
}

func newDockerClient(socket string) *dockerClient {
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socket)
		},
	}
	return &dockerClient{http: &http.Client{Transport: tr}}
}

// dockerSocket honours DOCKER_HOST when it is a unix socket.
func dockerSocket() string {
	if h := os.Getenv("DOCKER_HOST"); strings.HasPrefix(h, "unix://") {
		return strings.TrimPrefix(h, "unix://")
	}
	return "/var/run/docker.sock"
}

func (c *dockerClient) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker"+path, nil)
	if err != nil {
		return err
	}
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return errNotFound
	}
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("docker %s: HTTP %d %s", path, res.StatusCode, strings.TrimSpace(string(b)))
	}
	return json.NewDecoder(res.Body).Decode(out)
}

var errNotFound = fmt.Errorf("not found")

// Subset of the Engine API answers.
type apiContainer struct {
	ID      string            `json:"Id"`
	Names   []string          `json:"Names"`
	Image   string            `json:"Image"`
	ImageID string            `json:"ImageID"`
	State   string            `json:"State"`
	Status  string            `json:"Status"`
	Labels  map[string]string `json:"Labels"`
}

type apiImage struct {
	ID          string   `json:"Id"`
	RepoDigests []string `json:"RepoDigests"`
}

const (
	labelProject    = "com.docker.compose.project"
	labelWorkingDir = "com.docker.compose.project.working_dir"
	labelConfig     = "com.docker.compose.project.config_files"
	labelEnvFile    = "com.docker.compose.project.environment_file"
	labelService    = "com.docker.compose.service"
	labelOneOff     = "com.docker.compose.oneoff"
)

func health(status string) string {
	switch {
	case strings.Contains(status, "(unhealthy)"):
		return "unhealthy"
	case strings.Contains(status, "(healthy)"):
		return "healthy"
	case strings.Contains(status, "(health: starting)"):
		return "starting"
	}
	return ""
}

func splitList(s string) []string {
	out := []string{}
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func stackStatus(running, total int) string {
	switch {
	case total == 0:
		return "down"
	case running == total:
		return "running"
	case running == 0:
		return "stopped"
	}
	return "partial"
}

// buildStacks groups compose containers by project. images maps a container id to the image
// reference it was created from, when the list only gives an image id.
func buildStacks(cs []apiContainer, images map[string]string) []DockerStack {
	byName := map[string]*DockerStack{}
	services := map[string]map[string]*DockerService{}
	for _, c := range cs {
		project := c.Labels[labelProject]
		if project == "" || strings.EqualFold(c.Labels[labelOneOff], "true") {
			continue
		}
		st := byName[project]
		if st == nil {
			st = &DockerStack{
				Name:        project,
				WorkingDir:  c.Labels[labelWorkingDir],
				ConfigFiles: splitList(c.Labels[labelConfig]),
				EnvFiles:    splitList(c.Labels[labelEnvFile]),
			}
			byName[project] = st
			services[project] = map[string]*DockerService{}
		}
		name := c.Labels[labelService]
		svc := services[project][name]
		if svc == nil {
			svc = &DockerService{Name: name, Containers: []DockerContainer{}}
			services[project][name] = svc
		}
		ref := c.Image
		if r, ok := images[c.ID]; ok {
			ref = r
		}
		if svc.Image == "" {
			svc.Image = ref
		}
		id := c.ID
		if len(id) > 12 {
			id = id[:12]
		}
		cname := ""
		if len(c.Names) > 0 {
			cname = strings.TrimPrefix(c.Names[0], "/")
		}
		svc.Containers = append(svc.Containers, DockerContainer{
			ID: id, Name: cname, State: c.State, Status: c.Status, Health: health(c.Status), ImageID: c.ImageID,
		})
	}
	stacks := []DockerStack{}
	for name, st := range byName {
		running, total := 0, 0
		st.Services = []DockerService{}
		for _, svc := range services[name] {
			sort.Slice(svc.Containers, func(i, j int) bool { return svc.Containers[i].Name < svc.Containers[j].Name })
			for _, c := range svc.Containers {
				total++
				if c.State == "running" {
					running++
				}
			}
			st.Services = append(st.Services, *svc)
		}
		sort.Slice(st.Services, func(i, j int) bool { return st.Services[i].Name < st.Services[j].Name })
		st.Status = stackStatus(running, total)
		stacks = append(stacks, *st)
	}
	sort.Slice(stacks, func(i, j int) bool { return stacks[i].Name < stacks[j].Name })
	return stacks
}

// Docker module of the agent: engine client, known stacks and registry checks.
type dockerModule struct {
	client *dockerClient
	store  *stackStore
}

func newDockerModule() *dockerModule {
	return &dockerModule{client: newDockerClient(dockerSocket()), store: newStackStore(stateDir())}
}

func dockerEnv() []string {
	return append(os.Environ(), "LC_ALL=C", "LANG=C", "NO_COLOR=1")
}

// versions returns the engine and compose versions, or ok=false when Docker or the compose
// plugin (v2) is not usable on this host.
func (d *dockerModule) versions(ctx context.Context) (engine, compose string, ok bool) {
	var v struct {
		Version string `json:"Version"`
	}
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if d.client.get(cctx, "/version", &v) != nil {
		return "", "", false
	}
	cmd := exec.CommandContext(cctx, "docker", "compose", "version", "--short")
	cmd.Env = dockerEnv()
	out, err := cmd.Output()
	if err != nil {
		return v.Version, "", false
	}
	return v.Version, strings.TrimPrefix(strings.TrimSpace(string(out)), "v"), true
}

func (d *dockerModule) available(ctx context.Context) bool {
	_, _, ok := d.versions(ctx)
	return ok
}

// collect builds the report: running stacks from the engine, stopped ones (no container left)
// from the stacks this agent has already seen.
func (d *dockerModule) collect(ctx context.Context) (*DockerReport, error) {
	engine, compose, ok := d.versions(ctx)
	if !ok {
		return nil, fmt.Errorf("docker or docker compose v2 unavailable")
	}
	var cs []apiContainer
	q := url.Values{"all": {"1"}, "filters": {`{"label":["` + labelProject + `"]}`}}
	if err := d.client.get(ctx, "/containers/json?"+q.Encode(), &cs); err != nil {
		return nil, err
	}
	// when the tag moved since the container was created, the list shows an image id instead
	// of the reference: read it from the container configuration
	refs := map[string]string{}
	for _, c := range cs {
		if strings.HasPrefix(c.Image, "sha256:") {
			var ins struct {
				Config struct {
					Image string `json:"Image"`
				} `json:"Config"`
			}
			if d.client.get(ctx, "/containers/"+c.ID+"/json", &ins) == nil && ins.Config.Image != "" {
				refs[c.ID] = ins.Config.Image
			}
		}
	}
	stacks := d.store.merge(buildStacks(cs, refs))

	images := []DockerImage{}
	seen := map[string]bool{}
	for _, st := range stacks {
		for _, svc := range st.Services {
			if svc.Image == "" || seen[svc.Image] || strings.HasPrefix(svc.Image, "sha256:") {
				continue
			}
			seen[svc.Image] = true
			img := DockerImage{Ref: svc.Image}
			var ai apiImage
			if err := d.client.get(ctx, "/images/"+svc.Image+"/json", &ai); err == nil {
				img.ID = ai.ID
				if ref, err := parseRef(svc.Image); err == nil {
					img.Digest = localDigest(ref, ai.RepoDigests)
				}
			}
			images = append(images, img)
		}
	}
	return &DockerReport{
		CheckedAt: time.Now().UnixMilli(),
		Engine:    engine,
		Compose:   compose,
		Stacks:    stacks,
		Images:    images,
	}, nil
}

// watchEvents calls changed after container events (start, stop, die, health...), until ctx
// ends. Reconnects when the engine restarts or is installed later.
func (d *dockerModule) watchEvents(ctx context.Context, changed func()) {
	q := url.Values{"filters": {`{"type":["container"],"label":["` + labelProject + `"]}`}}
	for ctx.Err() == nil {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/events?"+q.Encode(), nil)
		res, err := d.client.http.Do(req)
		if err == nil {
			if res.StatusCode == http.StatusOK {
				dec := json.NewDecoder(res.Body)
				for {
					var ev struct {
						Action string `json:"Action"`
					}
					if dec.Decode(&ev) != nil {
						break
					}
					// exec_* events (health checks) would trigger a report every few seconds
					if !strings.HasPrefix(ev.Action, "exec_") {
						changed()
					}
				}
			}
			res.Body.Close()
		}
		select {
		case <-ctx.Done():
		case <-time.After(30 * time.Second):
		}
	}
}

// insecureRegistries lists the registries the daemon reaches over plain http
// (insecure-registries in daemon.json).
func (d *dockerModule) insecureRegistries(ctx context.Context) map[string]bool {
	var info struct {
		RegistryConfig struct {
			IndexConfigs map[string]struct {
				Secure bool `json:"Secure"`
			} `json:"IndexConfigs"`
		} `json:"RegistryConfig"`
	}
	out := map[string]bool{}
	if d.client.get(ctx, "/info", &info) == nil {
		for name, c := range info.RegistryConfig.IndexConfigs {
			if !c.Secure {
				out[name] = true
			}
		}
	}
	return out
}
