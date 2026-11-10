//go:build !windows

package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path"
	"strconv"
	"strings"
	"time"
)

// Enabling dynamic-security on a Mosquitto broker of this host, and the way back. The agent only ever adds files
// (a configuration, a directory of certificates, the state of the plugin): nothing the administrator wrote is
// modified, so a failure is undone by removing what was added. The certificates come from the hub (its CA signs them;
// the agent never holds the key of the CA nor the key of the account of the hub).

const (
	dynsecConfName = "zz-hlm-dynsec.conf" // last in the directory: the options after `listener` stay with it
	dynsecTLSDir   = "/etc/mosquitto/hlm-tls"
	dynsecInitPw   = "/etc/mosquitto/hlm-dynsec-init"
	dynsecState    = "/var/lib/mosquitto/dynamic-security.json"
	dynsecTLSPort  = 8883
)

// DynsecEnable: what the hub sends. ServerKeyPem is a secret: never logged.
type DynsecEnable struct {
	Port          int    `json:"port"`  // plain port of the broker, used locally to set the plugin up
	Admin         string `json:"admin"` // account of the hub, its certificate CN
	CaPem         string `json:"caPem"`
	ServerCertPem string `json:"serverCertPem"`
	ServerKeyPem  string `json:"serverKeyPem"`
}

type DynsecEnableResult struct {
	Port  int      `json:"port"`
	Steps []string `json:"steps"`
}

// dynsecHost: what the enabling does on the host, apart so that it can be tested (and its rollback).
type dynsecHost struct {
	Write   func(path string, data []byte, mode os.FileMode, group string) error // atomic, owner root
	Remove  func(path string) error                                              // missing is not an error
	Rename  func(from, to string) error
	Exists  func(path string) bool
	MkDir   func(path string, mode os.FileMode, group string) error
	Run     func(ctx context.Context, name string, args ...string) (string, error)
	Restart func(ctx context.Context, unit string) error
	Hosts   func() []string // addresses to reach the broker locally
	Now     func() time.Time
}

func realDynsecHost() dynsecHost {
	return dynsecHost{
		Write: func(p string, data []byte, mode os.FileMode, group string) error {
			tmp := p + ".tmp"
			if err := os.WriteFile(tmp, data, mode); err != nil {
				return err
			}
			if err := os.Chmod(tmp, mode); err != nil {
				return err
			}
			if err := chownGroup(tmp, group); err != nil {
				os.Remove(tmp)
				return err
			}
			return os.Rename(tmp, p)
		},
		Remove: func(p string) error {
			if err := os.RemoveAll(p); err != nil && !os.IsNotExist(err) {
				return err
			}
			return nil
		},
		Rename: os.Rename,
		Exists: func(p string) bool { _, err := os.Stat(p); return err == nil },
		MkDir: func(p string, mode os.FileMode, group string) error {
			if err := os.MkdirAll(p, mode); err != nil {
				return err
			}
			if err := os.Chmod(p, mode); err != nil {
				return err
			}
			return chownGroup(p, group)
		},
		Run: func(ctx context.Context, name string, args ...string) (string, error) {
			out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
			return string(out), err
		},
		Restart: func(ctx context.Context, unit string) error {
			return exec.CommandContext(ctx, "systemctl", "restart", unit).Run()
		},
		Hosts: func() []string {
			hosts := []string{"127.0.0.1"}
			if ips, err := localIPs(); err == nil {
				for _, ip := range ips {
					if ip.To4() != nil {
						hosts = append(hosts, ip.String())
					}
				}
			}
			return hosts
		},
		Now: time.Now,
	}
}

// chownGroup gives the file to root and the group of the broker ("" leaves the group as it is).
func chownGroup(p, group string) error {
	if group == "" {
		return nil
	}
	g, err := user.LookupGroup(group)
	if err != nil {
		return err
	}
	gid, _ := strconv.Atoi(g.Gid)
	return os.Chown(p, 0, gid)
}

// validateDynsecEnable: PEM that parse, a key that belongs to the certificate, a certificate not expired.
func validateDynsecEnable(r DynsecEnable) error {
	if r.Port < 1 || r.Port > 65535 {
		return fmt.Errorf("port invalide")
	}
	if r.Admin == "" || strings.ContainsAny(r.Admin, " \t\r\n\"'\\") {
		return fmt.Errorf("nom de compte invalide")
	}
	block, _ := pem.Decode([]byte(r.CaPem))
	if block == nil || block.Type != "CERTIFICATE" {
		return fmt.Errorf("CA illisible")
	}
	pair, err := tls.X509KeyPair([]byte(r.ServerCertPem), []byte(r.ServerKeyPem))
	if err != nil {
		return fmt.Errorf("certificat serveur ou clé illisible : %v", err)
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return fmt.Errorf("certificat serveur illisible")
	}
	if time.Now().After(leaf.NotAfter) {
		return fmt.Errorf("certificat serveur expiré")
	}
	return nil
}

// dynsecConf: the file added to the configuration of the broker. No comment after a value: Mosquitto would read it
// as a part of the value.
func dynsecConf(lib string, withInit bool) string {
	var b strings.Builder
	b.WriteString("# Added by the homelab-manager agent: dynamic-security and the TLS listener of the hub\n")
	b.WriteString("global_plugin " + lib + "\n")
	b.WriteString("plugin_opt_config_file " + dynsecState + "\n")
	if withInit {
		b.WriteString("plugin_opt_password_init_file " + dynsecInitPw + "\n")
	}
	b.WriteString("log_dest topic\n")
	b.WriteString(fmt.Sprintf("listener %d 0.0.0.0\n", dynsecTLSPort))
	b.WriteString("cafile " + dynsecTLSDir + "/ca.crt\n")
	b.WriteString("certfile " + dynsecTLSDir + "/server.crt\n")
	b.WriteString("keyfile " + dynsecTLSDir + "/server.key\n")
	b.WriteString("require_certificate true\n")
	b.WriteString("use_identity_as_username true\n")
	b.WriteString("tls_version tlsv1.2\n")
	return b.String()
}

func randomSecret() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// enableDynsec runs the steps; on a failure what was added is removed and the broker restarted, the error says
// which step failed and whether the way back succeeded.
func enableDynsec(ctx context.Context, h dynsecHost, rep DynsecReport, req DynsecEnable) (*DynsecEnableResult, error) {
	if err := validateDynsecEnable(req); err != nil {
		return nil, err
	}
	if !rep.Eligible || rep.Active || rep.IncludeDir == "" || rep.Lib == "" || rep.Unit == "" {
		return nil, fmt.Errorf("contrôles préalables non satisfaits")
	}
	confPath := path.Join(rep.IncludeDir, dynsecConfName)
	if h.Exists(confPath) || h.Exists(dynsecTLSDir) {
		return nil, fmt.Errorf("des fichiers d'une activation précédente existent : désactiver d'abord")
	}
	res := &DynsecEnableResult{Port: dynsecTLSPort}
	var undo []func()
	step := func(name string) { res.Steps = append(res.Steps, name) }
	fail := func(what string, err error) (*DynsecEnableResult, error) {
		for i := len(undo) - 1; i >= 0; i-- {
			undo[i]()
		}
		rb := "configuration restaurée"
		rctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if rerr := h.Restart(rctx, rep.Unit); rerr != nil {
			rb = fmt.Sprintf("configuration restaurée, mais le redémarrage du broker a échoué : %v", rerr)
		}
		return res, fmt.Errorf("%s : %v (%s)", what, err, rb)
	}
	remove := func(p string) { _ = h.Remove(p) }

	// a state file left by an old attempt is put aside, and put back by the way back
	savedState := ""
	if h.Exists(dynsecState) {
		savedState = dynsecState + ".before-hlm-" + strconv.FormatInt(h.Now().Unix(), 10)
		if err := h.Rename(dynsecState, savedState); err != nil {
			return nil, fmt.Errorf("état dynamic-security existant : %v", err)
		}
	}
	undo = append(undo, func() {
		remove(dynsecState)
		if savedState != "" {
			_ = h.Rename(savedState, dynsecState)
		}
	})

	if err := h.MkDir(dynsecTLSDir, 0o750, "mosquitto"); err != nil {
		return fail("répertoire des certificats", err)
	}
	undo = append(undo, func() { remove(dynsecTLSDir) })
	for _, f := range []struct {
		name string
		data string
		mode os.FileMode
	}{{"ca.crt", req.CaPem, 0o644}, {"server.crt", req.ServerCertPem, 0o644}, {"server.key", req.ServerKeyPem, 0o640}} {
		if err := h.Write(path.Join(dynsecTLSDir, f.name), []byte(f.data), f.mode, "mosquitto"); err != nil {
			return fail("écriture de "+f.name, err)
		}
	}
	step("certificats déposés")

	initPw, err := randomSecret()
	if err != nil {
		return fail("mot de passe d'initialisation", err)
	}
	if err := h.Write(dynsecInitPw, []byte(initPw), 0o600, "mosquitto"); err != nil {
		return fail("mot de passe d'initialisation", err)
	}
	undo = append(undo, func() { remove(dynsecInitPw) })
	if err := h.Write(confPath, []byte(dynsecConf(rep.Lib, true)), 0o644, ""); err != nil {
		return fail("écriture de la configuration", err)
	}
	undo = append(undo, func() { remove(confPath) })
	step("configuration ajoutée")

	if err := h.Restart(ctx, rep.Unit); err != nil {
		return fail("redémarrage du broker", err)
	}
	step("broker redémarré")

	ctrl := func(args ...string) (string, error) {
		var out string
		var last error
		for _, host := range h.Hosts() {
			cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			// the password of the installation is on the command line for the duration of the call, root only
			a := append([]string{"-h", host, "-p", strconv.Itoa(req.Port), "-u", "admin", "-P", initPw, "dynsec"}, args...)
			o, err := h.Run(cctx, "mosquitto_ctrl", a...)
			cancel()
			if msg := ctrlError(o); err == nil && msg == "" {
				return o, nil
			} else if msg != "" {
				err = fmt.Errorf("%s", msg)
			}
			out, last = o, err
		}
		return out, last
	}
	// the broker needs a moment to be up
	var ready error
	for i := 0; i < 15; i++ {
		if _, ready = ctrl("listClients"); ready == nil {
			break
		}
		select {
		case <-ctx.Done():
			return fail("attente du broker", ctx.Err())
		case <-time.After(time.Second):
		}
	}
	if ready != nil {
		return fail("le plugin ne répond pas", ready)
	}
	// anonymous clients keep what they had: a role with every topic on the anonymous group
	setup := [][]string{{"createRole", "legacy"}}
	for _, t := range []string{"publishClientSend", "publishClientReceive", "subscribePattern", "unsubscribePattern"} {
		setup = append(setup, []string{"addRoleACL", "legacy", t, "#", "allow", "5"})
	}
	setup = append(setup,
		[]string{"createGroup", "anonymous"},
		[]string{"addGroupRole", "anonymous", "legacy", "5"},
		[]string{"setAnonymousGroup", "anonymous"},
		// the account of the hub: its certificate, no password
		[]string{"createClient", req.Admin},
		[]string{"addClientRole", req.Admin, "super-admin", "5"},
	)
	for _, a := range setup {
		if out, err := ctrl(a...); err != nil {
			return fail("dynamic-security ("+a[0]+")", fmt.Errorf("%v %s", err, strings.TrimSpace(out)))
		}
	}
	step("rôle legacy, groupe anonyme et compte " + req.Admin + " créés")

	// the account of the installation goes away; from here the hub is the only administrator (the way back is a
	// fresh start of the state, see disableDynsec)
	if _, err := ctrl("deleteClient", "admin"); err != nil {
		return fail("suppression du compte d'initialisation", err)
	}
	remove(dynsecInitPw)
	// the state exists: the file of the password is not read again
	if err := h.Write(confPath, []byte(dynsecConf(rep.Lib, false)), 0o644, ""); err != nil {
		step("avertissement : configuration non allégée du fichier d'initialisation (" + err.Error() + ")")
	}
	step("compte d'initialisation supprimé")
	return res, nil
}

// ctrlError: the error line of mosquitto_ctrl ("Connection error: Not authorized", "Error: ..."), "" when none; its
// warning about the lack of encryption is not one.
func ctrlError(out string) string {
	for _, l := range strings.Split(out, "\n") {
		l = strings.TrimSpace(l)
		if strings.HasPrefix(l, "Error") || strings.HasPrefix(l, "Connection error") {
			return l
		}
	}
	return ""
}

// disableDynsec: removes what the enabling added and restarts the broker. The state of the plugin is kept aside
// (accounts, roles), not deleted; the broker is as it was configured before.
func disableDynsec(ctx context.Context, h dynsecHost, includeDir, unit string) ([]string, error) {
	var steps []string
	if includeDir == "" || unit == "" {
		return nil, fmt.Errorf("répertoire d'inclusion ou unité inconnus")
	}
	if err := h.Remove(path.Join(includeDir, dynsecConfName)); err != nil {
		return nil, err
	}
	steps = append(steps, "configuration retirée")
	_ = h.Remove(dynsecTLSDir)
	_ = h.Remove(dynsecInitPw)
	if h.Exists(dynsecState) {
		if err := h.Rename(dynsecState, dynsecState+".disabled-"+strconv.FormatInt(h.Now().Unix(), 10)); err != nil {
			return steps, err
		}
		steps = append(steps, "état dynamic-security mis de côté")
	}
	if err := h.Restart(ctx, unit); err != nil {
		return steps, fmt.Errorf("redémarrage du broker : %v", err)
	}
	return append(steps, "broker redémarré"), nil
}
