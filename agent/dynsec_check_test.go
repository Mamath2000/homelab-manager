//go:build !windows

package main

import (
	"testing"
	"testing/fstest"
)

func confFS(files map[string]string) fstest.MapFS {
	m := fstest.MapFS{}
	for k, v := range files {
		m[k] = &fstest.MapFile{Data: []byte(v)}
	}
	return m
}

func TestReadMosquittoConfIncludesDir(t *testing.T) {
	fsys := confFS(map[string]string{
		"etc/mosquitto/mosquitto.conf": "# c\npersistence true\ninclude_dir /etc/mosquitto/conf.d\n",
		"etc/mosquitto/conf.d/b.conf":  "listener 8883\n",
		"etc/mosquitto/conf.d/a.conf":  "listener 1883 0.0.0.0\nallow_anonymous true # tail\n",
		"etc/mosquitto/conf.d/README":  "listener 9999\n",
	})
	got, err := readMosquittoConf(fsys, "/etc/mosquitto/mosquitto.conf", 0)
	if err != nil {
		t.Fatal(err)
	}
	var keys []string
	for _, l := range got {
		keys = append(keys, l.Key+"="+l.Value)
	}
	want := []string{"persistence=true", "include_dir=/etc/mosquitto/conf.d", "listener=1883 0.0.0.0", "allow_anonymous=true # tail", "listener=8883"}
	if len(keys) != len(want) {
		t.Fatalf("lines = %v", keys)
	}
	for i := range want {
		if keys[i] != want[i] {
			t.Fatalf("line %d = %q, want %q", i, keys[i], want[i])
		}
	}
}

func okInputs() dynsecInputs {
	return dynsecInputs{
		Version: "2.1.2", Unit: "mosquitto.service", ConfFile: "/etc/mosquitto/mosquitto.conf", Lib: "/usr/lib/x/mosquitto_dynamic_security.so", HasCtrl: true, Root: true, PersistOK: true,
		Conf: []confLine{{"m", "include_dir", "/etc/mosquitto/conf.d"}, {"l", "listener", "1883 0.0.0.0"}, {"l", "allow_anonymous", "true"}},
	}
}

func levels(r DynsecReport, id string) []string {
	var out []string
	for _, c := range r.Checks {
		if c.ID == id {
			out = append(out, c.Level)
		}
	}
	return out
}

func TestAnalyzeDynsecEligible(t *testing.T) {
	if r := analyzeDynsec(okInputs()); !r.Eligible {
		t.Fatalf("not eligible: %+v", r.Checks)
	}
}

func TestAnalyzeDynsecRefuses(t *testing.T) {
	cases := map[string]func(*dynsecInputs){
		"version":     func(i *dynsecInputs) { i.Version = "2.0.21" },
		"systemd":     func(i *dynsecInputs) { i.Unit = "" },
		"root":        func(i *dynsecInputs) { i.Root = false },
		"include_dir": func(i *dynsecInputs) { i.Conf = i.Conf[1:] },
		"plugin_lib":  func(i *dynsecInputs) { i.Lib = "" },
		"ctrl":        func(i *dynsecInputs) { i.HasCtrl = false },
		"port_8883":   func(i *dynsecInputs) { i.TLSInUse = true },
		"listener":    func(i *dynsecInputs) { i.Conf = []confLine{{"m", "include_dir", "/etc/mosquitto/conf.d"}} },
		"auth":        func(i *dynsecInputs) { i.Conf = append(i.Conf, confLine{"l", "password_file", "/etc/mosquitto/pw"}) },
		"plugin":      func(i *dynsecInputs) { i.Conf = append(i.Conf, confLine{"l", "global_plugin", "/usr/lib/x/other.so"}) },
		"per_listener_settings": func(i *dynsecInputs) {
			i.Conf = append(i.Conf, confLine{"l", "per_listener_settings", "true"})
		},
	}
	for id, mod := range cases {
		in := okInputs()
		mod(&in)
		r := analyzeDynsec(in)
		if r.Eligible || len(levels(r, id)) == 0 || levels(r, id)[0] != "error" {
			t.Errorf("%s: eligible=%v checks=%+v", id, r.Eligible, r.Checks)
		}
	}
}

func TestAnalyzeDynsecAlreadyActive(t *testing.T) {
	in := okInputs()
	in.Dynsec = true
	in.Conf = append(in.Conf, confLine{"d", "global_plugin", "/usr/lib/x/mosquitto_dynamic_security.so"})
	r := analyzeDynsec(in)
	if !r.Active || !r.Eligible {
		t.Fatalf("%+v", r)
	}
}

func TestUnitFromCgroup(t *testing.T) {
	if got := unitFromCgroup("0::/system.slice/mosquitto.service\n"); got != "mosquitto.service" {
		t.Fatal(got)
	}
	if got := unitFromCgroup("0::/user.slice/session-3.scope\n"); got != "" {
		t.Fatal(got)
	}
}
