//go:build !windows

package main

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Read-only checks before the agent enables the dynamic-security plugin of a Mosquitto broker of this host: nothing
// is written, the report tells what would be refused and what the change would touch. The only prerequisite for the
// administrator is Mosquitto 2.1 or later; the rest is checked here.

// DynsecCheck: one verdict. Level error blocks the activation, warn is shown, info is a fact of the preview.
type DynsecCheck struct {
	ID     string `json:"id"`
	Level  string `json:"level"` // error | warn | info
	Detail string `json:"detail"`
}

type DynsecReport struct {
	Eligible bool   `json:"eligible"`
	Active   bool   `json:"active"` // the plugin is already loaded
	Version  string `json:"version,omitempty"`
	Unit     string `json:"unit,omitempty"`
	ConfFile string `json:"confFile,omitempty"`
	// where the enabling puts its file, and the plugin it loads (not shown by the hub)
	IncludeDir string `json:"includeDir,omitempty"`
	// the broker accepts a connection without account (allow_anonymous true, the last word of the configuration)
	AllowAnonymous bool `json:"allowAnonymous"`
	// the same without the file added by the enabling: what the broker accepts once reset
	OriginAnonymous bool          `json:"originAnonymous"`
	Lib             string        `json:"lib,omitempty"`
	Checks          []DynsecCheck `json:"checks"`
}

// confLine: one directive of a Mosquitto configuration. A comment only starts a line: Mosquitto keeps what follows
// a value on the same line as part of it, which is why the agent never writes one there.
type confLine struct {
	File  string
	Key   string
	Value string
}

// readMosquittoConf reads a configuration and what it includes (include_dir: the *.conf files of a directory, in
// the order of their names). root holds the paths without their leading slash (os.DirFS("/")).
func readMosquittoConf(root fs.FS, file string, depth int) ([]confLine, error) {
	b, err := fs.ReadFile(root, strings.TrimPrefix(file, "/"))
	if err != nil {
		return nil, err
	}
	var out []confLine
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value := line, ""
		if i := strings.IndexAny(line, " \t"); i > 0 {
			key, value = line[:i], strings.TrimSpace(line[i:])
		}
		if key == "include_dir" && depth < 4 {
			out = append(out, confLine{file, key, value})
			ents, err := fs.ReadDir(root, strings.TrimPrefix(value, "/"))
			if err != nil {
				continue
			}
			names := []string{}
			for _, e := range ents {
				if !e.IsDir() && strings.HasSuffix(e.Name(), ".conf") {
					names = append(names, e.Name())
				}
			}
			sort.Strings(names)
			for _, n := range names {
				sub, err := readMosquittoConf(root, path.Join(value, n), depth+1)
				if err == nil {
					out = append(out, sub...)
				}
			}
			continue
		}
		out = append(out, confLine{file, key, value})
	}
	return out, nil
}

// dynsecInputs: what the checks read besides the configuration, gathered apart so that they can be tested.
type dynsecInputs struct {
	Version   string
	Dynsec    bool   // plugin loaded in the process
	Unit      string // systemd unit of the process, "" when it has none
	ConfFile  string
	Conf      []confLine
	ConfErr   error
	Lib       string // path of mosquitto_dynamic_security.so, "" when absent
	HasCtrl   bool   // mosquitto_ctrl found
	Root      bool
	TLSInUse  bool // 8883 already listens
	PersistOK bool // directory of the dynsec state exists
}

// authDirectives: configuration that already decides who may connect; dynamic-security does not replace it silently.
var authDirectives = map[string]string{
	"password_file": "un fichier de mots de passe (password_file)",
	"acl_file":      "un fichier d'ACL (acl_file)",
	"psk_file":      "des clés PSK (psk_file)",
	"auth_plugin":   "un plugin d'authentification (auth_plugin)",
}

// anonymousAllowed: the last allow_anonymous of the configuration; absent, Mosquitto 2 refuses once a listener is declared.
func anonymousAllowed(conf []confLine) bool {
	allowed := false
	for _, l := range conf {
		if l.Key == "allow_anonymous" {
			allowed = strings.EqualFold(l.Value, "true")
		}
	}
	return allowed
}

func hasListener(conf []confLine) bool {
	for _, l := range conf {
		if l.Key == "listener" || l.Key == "port" {
			return true
		}
	}
	return false
}

func versionAtLeast(v string, major, minor int) bool {
	parts := strings.Split(v, ".")
	if len(parts) < 2 {
		return false
	}
	a, err1 := strconv.Atoi(parts[0])
	b, err2 := strconv.Atoi(parts[1])
	return err1 == nil && err2 == nil && (a > major || (a == major && b >= minor))
}

func analyzeDynsec(in dynsecInputs) DynsecReport {
	r := DynsecReport{Version: in.Version, Unit: in.Unit, ConfFile: in.ConfFile, Active: in.Dynsec, Lib: in.Lib}
	add := func(id, level, format string, a ...any) {
		r.Checks = append(r.Checks, DynsecCheck{ID: id, Level: level, Detail: fmt.Sprintf(format, a...)})
	}
	switch {
	case in.Version == "":
		add("version", "error", "version de Mosquitto illisible")
	case !versionAtLeast(in.Version, 2, 1):
		add("version", "error", "Mosquitto %s : la version 2.1 ou plus est requise", in.Version)
	default:
		add("version", "info", "Mosquitto %s", in.Version)
	}
	if in.Dynsec {
		add("active", "info", "le plugin dynamic-security est déjà chargé")
	}
	if in.Unit == "" {
		add("systemd", "error", "le broker ne tourne pas sous systemd : l'agent ne sait pas le redémarrer")
	} else {
		add("systemd", "info", "unité %s", in.Unit)
	}
	if !in.Root {
		add("root", "error", "l'agent ne tourne pas en root : il ne peut pas écrire la configuration")
	}
	if in.ConfErr != nil {
		add("conf", "error", "configuration illisible (%s) : %v", in.ConfFile, in.ConfErr)
	}
	includeDir, listeners := "", []string{}
	r.AllowAnonymous = anonymousAllowed(in.Conf)
	var origin []confLine
	for _, l := range in.Conf {
		if path.Base(l.File) != dynsecConfName {
			origin = append(origin, l)
		}
	}
	r.OriginAnonymous = anonymousAllowed(origin)
	for _, l := range in.Conf {
		switch l.Key {
		case "include_dir":
			if includeDir == "" {
				includeDir = l.Value
			}
		case "listener":
			listeners = append(listeners, strings.Fields(l.Value + " ")[0])
		case "per_listener_settings":
			if strings.EqualFold(l.Value, "true") {
				add("per_listener_settings", "error", "per_listener_settings true : non pris en charge")
			}
		case "plugin", "global_plugin":
			if !strings.Contains(l.Value, "mosquitto_dynamic_security") {
				add("plugin", "error", "un autre plugin est chargé (%s)", filepath.Base(l.Value))
			}
		default:
			if what := authDirectives[l.Key]; what != "" {
				add("auth", "error", "la configuration définit déjà %s (%s) : à retirer avant l'activation", what, filepath.Base(l.File))
			}
		}
	}
	if includeDir == "" && in.ConfErr == nil {
		add("include_dir", "error", "la configuration n'a pas de include_dir : l'agent n'ajoute pas de fichier à celui de l'administrateur")
	} else if includeDir != "" {
		r.IncludeDir = includeDir
		add("include_dir", "info", "fichier ajouté dans %s", includeDir)
	}
	// without a listener of its own Mosquitto offers a default one on 1883, that a new listener would remove
	if in.ConfErr == nil && !hasListener(in.Conf) {
		add("listener", "error", "aucun listener explicite dans la configuration : en ajouter un ferait disparaître celui par défaut")
	}
	if in.Lib == "" {
		add("plugin_lib", "error", "mosquitto_dynamic_security.so introuvable")
	}
	if !in.HasCtrl {
		add("ctrl", "error", "mosquitto_ctrl introuvable (paquet mosquitto-clients)")
	}
	if in.TLSInUse && !in.Dynsec {
		add("port_8883", "error", "le port 8883 est déjà utilisé")
	}
	if !in.PersistOK {
		add("state_dir", "warn", "le répertoire d'état de dynamic-security n'existe pas encore : l'agent le créera")
	}
	if len(listeners) > 0 {
		add("listeners", "info", "listeners déclarés : %s", strings.Join(listeners, ", "))
	}
	r.Eligible = true
	for _, c := range r.Checks {
		if c.Level == "error" {
			r.Eligible = false
		}
	}
	return r
}

// systemdUnitOf reads the control group of a process: the service that runs it ("mosquitto.service").
func systemdUnitOf(pid int) string {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/cgroup", pid))
	if err != nil {
		return ""
	}
	return unitFromCgroup(string(b))
}

func unitFromCgroup(cg string) string {
	for _, line := range strings.Split(cg, "\n") {
		for _, seg := range strings.Split(line, "/") {
			if strings.HasSuffix(seg, ".service") {
				return seg
			}
		}
	}
	return ""
}

// configFileOf: the -c argument of the process, else the default one of the package.
func configFileOf(pid int) string {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err == nil {
		args := strings.Split(strings.TrimRight(string(b), "\x00"), "\x00")
		for i, a := range args {
			if (a == "-c" || a == "--config-file") && i+1 < len(args) {
				return args[i+1]
			}
		}
	}
	return "/etc/mosquitto/mosquitto.conf"
}

// checkDynsec: the report for the Mosquitto broker listening on port.
func checkDynsec(ctx context.Context, port int) (*DynsecReport, error) {
	cands := collectRoleCandidates(ctx)
	var c *RoleCandidate
	tls := false
	for i := range cands {
		if cands[i].Type != "mqtt-broker" {
			continue
		}
		if cands[i].Port == port && strings.HasPrefix(cands[i].Process, "mosquitto") {
			c = &cands[i]
		}
		if cands[i].Port == 8883 {
			tls = true
		}
	}
	if c == nil || c.pid <= 0 {
		return nil, fmt.Errorf("aucun broker Mosquitto sur le port %d de cet hôte", port)
	}
	in := dynsecInputs{Version: c.Version, Dynsec: c.Dynsec, Unit: systemdUnitOf(c.pid), ConfFile: configFileOf(c.pid), Root: os.Geteuid() == 0, TLSInUse: tls}
	in.Conf, in.ConfErr = readMosquittoConf(os.DirFS("/"), in.ConfFile, 0)
	if libs, _ := filepath.Glob("/usr/lib/*/mosquitto_dynamic_security.so"); len(libs) > 0 {
		in.Lib = libs[0]
	} else if _, err := os.Stat("/usr/lib/mosquitto_dynamic_security.so"); err == nil {
		in.Lib = "/usr/lib/mosquitto_dynamic_security.so"
	}
	_, err := exec.LookPath("mosquitto_ctrl")
	in.HasCtrl = err == nil
	if st, err := os.Stat("/var/lib/mosquitto"); err == nil && st.IsDir() {
		in.PersistOK = true
	}
	r := analyzeDynsec(in)
	return &r, nil
}
