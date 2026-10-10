package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func compose(project, service, state, status string) apiContainer {
	return apiContainer{
		ID: strings.Repeat(project[:1], 64), Names: []string{"/" + project + "-" + service + "-1"},
		Image: "nginx:latest", ImageID: "sha256:img", State: state, Status: status,
		Labels: map[string]string{
			labelProject: project, labelService: service,
			labelWorkingDir: "/srv/" + project, labelConfig: "/srv/" + project + "/compose.yml",
		},
	}
}

func TestBuildStacks(t *testing.T) {
	oneoff := compose("web", "migrate", "exited", "Exited (0)")
	oneoff.Labels[labelOneOff] = "True"
	stacks := buildStacks([]apiContainer{
		compose("web", "app", "running", "Up 2 hours (healthy)"),
		compose("web", "db", "exited", "Exited (1) 3 minutes ago"),
		oneoff,
		compose("media", "plex", "running", "Up 1 day"),
		{ID: "x", Image: "redis", State: "running"}, // not a compose container
	}, map[string]string{})
	if len(stacks) != 2 || stacks[0].Name != "media" || stacks[1].Name != "web" {
		t.Fatalf("got %+v", stacks)
	}
	web := stacks[1]
	if web.Status != "partial" || len(web.Services) != 2 || web.WorkingDir != "/srv/web" || web.ConfigFiles[0] != "/srv/web/compose.yml" {
		t.Fatalf("web: %+v", web)
	}
	if web.Services[0].Name != "app" || web.Services[0].Containers[0].Health != "healthy" || len(web.Services[0].Containers[0].ID) != 12 {
		t.Fatalf("app: %+v", web.Services[0])
	}
	if stacks[0].Status != "running" {
		t.Fatalf("media: %s", stacks[0].Status)
	}
	if stackStatus(0, 2) != "stopped" || stackStatus(0, 0) != "down" {
		t.Fatal("stackStatus")
	}
}

// Nextcloud AIO: the compose file starts one container, which creates the others with the
// project label alone (no service, directory nor files), listed first here.
func TestBuildStacksExternalContainers(t *testing.T) {
	child := apiContainer{ID: strings.Repeat("c", 64), Names: []string{"/aio-apache"}, Image: "apache", State: "running",
		Labels: map[string]string{labelProject: "aio"}}
	master := compose("aio", "master", "running", "Up 1 hour")
	stacks := buildStacks([]apiContainer{child, master}, map[string]string{})
	if len(stacks) != 1 {
		t.Fatalf("got %+v", stacks)
	}
	st := stacks[0]
	if st.WorkingDir != "/srv/aio" || len(st.ConfigFiles) != 1 || len(st.Services) != 2 {
		t.Fatalf("aio: %+v", st)
	}
	if st.Services[0].Name != "aio-apache" || !st.Services[0].External || st.Services[1].Name != "master" || st.Services[1].External {
		t.Fatalf("services: %+v", st.Services)
	}

	dir := t.TempDir()
	cfg := filepath.Join(dir, "compose.yml")
	os.WriteFile(cfg, []byte("services: {}\n"), 0o644)
	st.WorkingDir, st.ConfigFiles = dir, []string{cfg}
	s := newStackStore(dir)
	s.merge([]DockerStack{st})
	k, ok := s.get("aio")
	if !ok || strings.Join(k.Services, ",") != "aio-apache,master" || strings.Join(k.External, ",") != "aio-apache" {
		t.Fatalf("known: %+v", k)
	}
	// an external container removed by its creator is not kept
	st.Services = st.Services[1:]
	s.merge([]DockerStack{st})
	if k, _ = s.get("aio"); strings.Join(k.Services, ",") != "master" || len(k.External) != 0 {
		t.Fatalf("after removal: %+v", k)
	}
}

func TestPrefixLines(t *testing.T) {
	got := sortLogs("app-1  | 2026-10-09T22:00:02Z b\n" + prefixLines("aio-apache", "2026-10-09T22:00:01Z a\n"))
	if got != "aio-apache  | 2026-10-09T22:00:01Z a\napp-1  | 2026-10-09T22:00:02Z b\n" {
		t.Fatalf("got %q", got)
	}
	if prefixLines("x", "") != "" {
		t.Fatal("empty")
	}
}

func TestStackStore(t *testing.T) {
	dir := t.TempDir()
	cfg := filepath.Join(dir, "compose.yml")
	os.WriteFile(cfg, []byte("services: {}\n"), 0o644)
	live := []DockerStack{{Name: "web", WorkingDir: dir, ConfigFiles: []string{cfg}, Status: "running",
		Services: []DockerService{{Name: "app"}}}}

	s := newStackStore(dir)
	s.merge(live)
	// containers removed (docker compose down): still listed, as down
	s = newStackStore(dir)
	out := s.merge(nil)
	if len(out) != 1 || out[0].Status != "down" || out[0].Services[0].Name != "app" {
		t.Fatalf("got %+v", out)
	}
	// compose file deleted: forgotten
	os.Remove(cfg)
	if out := s.merge(nil); len(out) != 0 {
		t.Fatalf("got %+v", out)
	}
	if _, ok := s.get("web"); ok {
		t.Fatal("stack without compose file kept")
	}
}

func TestTargetValidation(t *testing.T) {
	d := &dockerModule{client: newDockerClient(filepath.Join(t.TempDir(), "none.sock")), store: newStackStore(t.TempDir())}
	d.store.stacks["web"] = knownStack{Name: "web", WorkingDir: "/srv/web", ConfigFiles: []string{"/srv/web/compose.yml"}, Services: []string{"app"}}
	for _, c := range []struct{ stack, service string }{
		{"../etc", ""}, {"-p", ""}, {"web", "--rm"}, {"web", "db"}, {"other", ""},
	} {
		if _, err := d.target(t.Context(), c.stack, c.service); err == nil {
			t.Errorf("%q/%q accepted", c.stack, c.service)
		}
	}
	if k, err := d.target(t.Context(), "web", "app"); err != nil || k.WorkingDir != "/srv/web" {
		t.Fatalf("got %+v %v", k, err)
	}
}

func TestComposeArgs(t *testing.T) {
	k := knownStack{Name: "web", WorkingDir: "/srv/web", ConfigFiles: []string{"/srv/web/a.yml", "/srv/web/b.yml"}, EnvFiles: []string{"/nonexistent/.env"}}
	got := strings.Join(composeArgs(k, withService([]string{"up", "-d"}, "app")...), " ")
	want := "compose --ansi never -p web --project-directory /srv/web -f /srv/web/a.yml -f /srv/web/b.yml up -d app"
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestMaskEnv(t *testing.T) {
	got := maskEnv("# db\nPOSTGRES_PASSWORD=secret\n\nexport TOKEN=abc\nweird line\n")
	if strings.Contains(got, "secret") || strings.Contains(got, "abc") || strings.Contains(got, "weird") {
		t.Fatalf("value leaked: %q", got)
	}
	if !strings.Contains(got, "# db\n") || !strings.Contains(got, "POSTGRES_PASSWORD=") || !strings.Contains(got, "export TOKEN=") {
		t.Fatalf("names lost: %q", got)
	}
}

func TestSortLogs(t *testing.T) {
	in := "db-1   | 2026-10-09T22:00:02Z ready\n" +
		"db-1   | 2026-10-09T22:00:04.5Z query\n" +
		"  continuation of query\n" +
		"app-1  | 2026-10-09T22:00:01.123456789Z starting\n" +
		"app-1  | 2026-10-09T22:00:03Z serving\n"
	want := "app-1  | 2026-10-09T22:00:01.123456789Z starting\n" +
		"db-1   | 2026-10-09T22:00:02Z ready\n" +
		"app-1  | 2026-10-09T22:00:03Z serving\n" +
		"db-1   | 2026-10-09T22:00:04.5Z query\n" +
		"  continuation of query\n"
	if got := sortLogs(in); got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}
