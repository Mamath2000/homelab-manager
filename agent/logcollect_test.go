//go:build !windows

package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func decode(t *testing.T, b []byte) map[string]any {
	t.Helper()
	m := map[string]any{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("invalid JSON %q: %v", b, err)
	}
	return m
}

func TestMergeDaemonConfigEnable(t *testing.T) {
	cases := []struct {
		name    string
		cur     string
		want    map[string]any
		dropped []string
	}{
		{"absent", "", map[string]any{
			"log-driver": "json-file",
			"log-opts":   map[string]any{"max-size": "10m", "max-file": "3", "labels": "com.docker.compose.project,com.docker.compose.service"},
		}, nil},
		{"journald with tag: driver switched, tag dropped, other keys kept", `{"log-driver":"journald","log-opts":{"tag":"{{.Name}}"},"data-root":"/srv/docker"}`, map[string]any{
			"data-root":  "/srv/docker",
			"log-driver": "json-file",
			"log-opts":   map[string]any{"max-size": "10m", "max-file": "3", "labels": "com.docker.compose.project,com.docker.compose.service"},
		}, []string{"tag"}},
		{"own rotation and labels kept", `{"log-driver":"json-file","log-opts":{"max-size":"50m","max-file":"5","labels":"team"}}`, map[string]any{
			"log-driver": "json-file",
			"log-opts":   map[string]any{"max-size": "50m", "max-file": "5", "labels": "team,com.docker.compose.project,com.docker.compose.service"},
		}, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, changed, dropped, err := mergeDaemonConfig([]byte(c.cur), true)
			if err != nil || !changed {
				t.Fatalf("changed=%v err=%v", changed, err)
			}
			if got := decode(t, out); !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %v, want %v", got, c.want)
			}
			if !reflect.DeepEqual(dropped, c.dropped) {
				t.Fatalf("dropped %v, want %v", dropped, c.dropped)
			}
		})
	}
}

func TestMergeDaemonConfigUnchanged(t *testing.T) {
	cur := `{
  "log-opts": {"labels": "com.docker.compose.service,com.docker.compose.project", "max-file": "3", "max-size": "10m"},
  "log-driver": "json-file"
}`
	out, changed, _, err := mergeDaemonConfig([]byte(cur), true)
	if err != nil || changed || string(out) != cur {
		t.Fatalf("an equivalent file must be left as it is: changed=%v err=%v", changed, err)
	}
	if why := daemonLogDrift([]byte(cur)); why != "" {
		t.Fatalf("drift %q", why)
	}
}

func TestMergeDaemonConfigDisable(t *testing.T) {
	cur := `{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3","labels":"team,com.docker.compose.project,com.docker.compose.service"}}`
	out, changed, _, err := mergeDaemonConfig([]byte(cur), false)
	if err != nil || !changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	want := map[string]any{"log-driver": "json-file", "log-opts": map[string]any{"max-size": "10m", "max-file": "3", "labels": "team"}}
	if got := decode(t, out); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	// nothing of the collector: nothing to change
	if _, changed, _, _ := mergeDaemonConfig([]byte(`{"log-driver":"local"}`), false); changed {
		t.Fatal("a file without the labels is not changed")
	}
}

func TestMergeDaemonConfigInvalid(t *testing.T) {
	for _, cur := range []string{`{"log-driver":`, `{"log-opts":"x"}`} {
		if _, _, _, err := mergeDaemonConfig([]byte(cur), true); err == nil {
			t.Fatalf("%s: an error is expected (the file is never overwritten)", cur)
		}
	}
	if daemonLogDrift([]byte(`{"log-driver":"journald"}`)) == "" {
		t.Fatal("journald is a drift")
	}
}

func TestLogFollowed(t *testing.T) {
	labels := map[string]string{"labels": "com.docker.compose.project,com.docker.compose.service", "max-size": "10m"}
	if !logFollowed("json-file", labels) {
		t.Fatal("json-file with both labels is followed")
	}
	if logFollowed("journald", labels) || logFollowed("json-file", map[string]string{"labels": "com.docker.compose.project"}) || logFollowed("json-file", nil) {
		t.Fatal("another driver, or a label missing, is not followed")
	}
}

func TestValidateLogCollect(t *testing.T) {
	ok := []*LogCollectSpec{{Address: ""}, {Address: "192.168.100.172", Port: 517, Protocol: "tcp"}, {Address: "logs.lan", Port: 517, Protocol: "tcp"}, {Address: "logs.lan", Port: 517, Protocol: "tcp", Recreate: []string{"web", "canicoif-app"}}}
	for _, l := range ok {
		if err := validateLogCollect(l); err != nil {
			t.Fatalf("%+v: %v", l, err)
		}
	}
	bad := []*LogCollectSpec{nil, {Address: "x\" y", Port: 517, Protocol: "tcp"}, {Address: "a", Port: 0, Protocol: "tcp"}, {Address: "a", Port: 517, Protocol: "udp"}, {Address: "a\nb", Port: 517, Protocol: "tcp"}, {Address: "a", Port: 517, Protocol: "tcp", Recreate: []string{"../x"}}, {Address: "", Recreate: []string{"web"}}}
	for _, l := range bad {
		if validateLogCollect(l) == nil {
			t.Fatalf("%+v must be refused", l)
		}
	}
}

func TestRenderCollectorConfig(t *testing.T) {
	cfg := renderCollectorConfig("home-page", &LogCollectSpec{Address: "192.168.100.172", Port: 517, Protocol: "tcp"})
	for _, want := range []string{
		"hostname home-page\n",
		"host: 192.168.100.172\n",
		"port: 517\n",
		"mode: tcp\n",
		"syslog_sd_key: " + logCollectSDID + "\n",
		"nest_under: " + logCollectSDID + "\n",
		"compose_project ^" + logCollectorProject + "$\n",
		"path: " + collectorContainersDir + "/*/*-json.log\n",
	} {
		if !strings.Contains(cfg, want) {
			t.Fatalf("config without %q", want)
		}
	}
	// the structured levels come before the words of the text: an info line with "error" in it stays info
	if strings.Index(cfg, `"level":\s*(10|20|30)`) > strings.Index(cfg, `\b(error|exception|failed|failure)\b`) {
		t.Fatal("structured info before the keywords")
	}
	if c := renderCollectorCompose("/srv/docker/containers"); !strings.Contains(c, "- /srv/docker/containers:"+collectorContainersDir+":ro\n") || !strings.Contains(c, "image: "+logCollectorImage+"\n") {
		t.Fatalf("compose: %s", c)
	}
}
