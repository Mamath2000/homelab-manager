//go:build !windows

package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path"
	"strings"
	"testing"
	"time"
)

// fakeHost: files in a map, the commands recorded; failOn: a mosquitto_ctrl command that fails.
type fakeHost struct {
	files    map[string]string
	modes    map[string]os.FileMode
	groups   map[string]string
	cmds     []string
	restarts int
	failOn   string
}

func (f *fakeHost) host() dynsecHost {
	return dynsecHost{
		Write: func(p string, d []byte, _ os.FileMode, _ string) error { f.files[p] = string(d); return nil },
		Remove: func(p string) error {
			for k := range f.files {
				if k == p || strings.HasPrefix(k, p+"/") {
					delete(f.files, k)
				}
			}
			return nil
		},
		Rename: func(a, b string) error { f.files[b] = f.files[a]; delete(f.files, a); return nil },
		Read: func(p string) ([]byte, error) {
			if v, ok := f.files[p]; ok {
				return []byte(v), nil
			}
			return nil, os.ErrNotExist
		},
		Exists: func(p string) bool {
			for k := range f.files {
				if k == p || strings.HasPrefix(k, p+"/") {
					return true
				}
			}
			return false
		},
		Glob: func(pattern string) []string {
			var out []string
			for k := range f.files {
				if ok, _ := path.Match(pattern, k); ok {
					out = append(out, k)
				}
			}
			return out
		},
		MkDir: func(p string, _ os.FileMode, _ string) error { return nil },
		Run: func(_ context.Context, name string, args ...string) (string, error) {
			cmd := strings.Join(args, " ")
			f.cmds = append(f.cmds, name+" "+cmd)
			if f.failOn != "" && strings.Contains(cmd, f.failOn) {
				return "Error: boom\n", fmt.Errorf("exit 1")
			}
			if strings.Contains(cmd, "createRole") {
				f.files[dynsecState] = "{}" // the plugin writes its state
			}
			return "Warning: You are running mosquitto_ctrl without encryption.\n", nil
		},
		Restart: func(context.Context, string) error { f.restarts++; return nil },
		Hosts:   func() []string { return []string{"127.0.0.1"} },
		Now:     func() time.Time { return time.Unix(1000, 0) },
	}
}

func testPKI(t *testing.T) DynsecEnable {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "t"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	kb, _ := x509.MarshalECPrivateKey(key)
	cert := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	return DynsecEnable{Port: 1883, Admin: "hlm", CaPem: cert, ServerCertPem: cert, ServerKeyPem: string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}))}
}

func okReport() DynsecReport {
	return DynsecReport{Eligible: true, Unit: "mosquitto.service", IncludeDir: "/etc/mosquitto/conf.d", Lib: "/usr/lib/x/mosquitto_dynamic_security.so"}
}

func TestEnableDynsec(t *testing.T) {
	f := &fakeHost{files: map[string]string{}}
	res, err := enableDynsec(context.Background(), f.host(), okReport(), testPKI(t))
	if err != nil {
		t.Fatal(err)
	}
	if res.Port != 8883 || f.restarts != 1 {
		t.Fatalf("res=%+v restarts=%d", res, f.restarts)
	}
	for _, p := range []string{dynsecTLSDir + "/ca.crt", dynsecTLSDir + "/server.crt", dynsecTLSDir + "/server.key", "/etc/mosquitto/conf.d/" + dynsecConfName} {
		if _, ok := f.files[p]; !ok {
			t.Errorf("missing %s", p)
		}
	}
	if _, ok := f.files[dynsecInitPw]; ok {
		t.Error("the init password file must be gone")
	}
	if c := f.files["/etc/mosquitto/conf.d/"+dynsecConfName]; strings.Contains(c, "password_init_file") {
		t.Error("the conf still points to the init file")
	}
	all := strings.Join(f.cmds, "\n")
	for _, want := range []string{"createRole legacy", "setAnonymousGroup anonymous", "createClient hlm", "addClientRole hlm super-admin 5", "addClientRole hlm sys-observe 5", "deleteClient admin"} {
		if !strings.Contains(all, want) {
			t.Errorf("missing command %q", want)
		}
	}
	if strings.Index(all, "createClient hlm") > strings.Index(all, "deleteClient admin") {
		t.Error("the init account is deleted before the account of the hub exists")
	}
}

func TestEnableDynsecRollback(t *testing.T) {
	for _, failOn := range []string{"createRole", "setAnonymousGroup", "createClient", "deleteClient"} {
		f := &fakeHost{files: map[string]string{"/etc/mosquitto/conf.d/local.conf": "listener 1883"}, failOn: failOn}
		_, err := enableDynsec(context.Background(), f.host(), okReport(), testPKI(t))
		if err == nil || !strings.Contains(err.Error(), "configuration restaurée") {
			t.Fatalf("%s: err = %v", failOn, err)
		}
		if len(f.files) != 1 || f.files["/etc/mosquitto/conf.d/local.conf"] == "" {
			t.Errorf("%s: files left: %v", failOn, f.files)
		}
		if f.restarts != 2 {
			t.Errorf("%s: restarts = %d, want 2", failOn, f.restarts)
		}
	}
}

func TestEnableDynsecKeepsAnExistingState(t *testing.T) {
	f := &fakeHost{files: map[string]string{dynsecState: "old"}, failOn: "createClient"}
	if _, err := enableDynsec(context.Background(), f.host(), okReport(), testPKI(t)); err == nil {
		t.Fatal("expected a failure")
	}
	if f.files[dynsecState] != "old" || len(f.files) != 1 {
		t.Fatalf("files: %v", f.files)
	}
}

func TestEnableDynsecRefuses(t *testing.T) {
	good := testPKI(t)
	bad := good
	bad.ServerKeyPem = "nope"
	notElig := okReport()
	notElig.Eligible = false
	for name, c := range map[string]struct {
		rep DynsecReport
		req DynsecEnable
	}{"key": {okReport(), bad}, "eligible": {notElig, good}} {
		f := &fakeHost{files: map[string]string{}}
		if _, err := enableDynsec(context.Background(), f.host(), c.rep, c.req); err == nil || len(f.files) != 0 || f.restarts != 0 {
			t.Errorf("%s: err=%v files=%v restarts=%d", name, err, f.files, f.restarts)
		}
	}
	f := &fakeHost{files: map[string]string{dynsecTLSDir + "/ca.crt": "x"}}
	if _, err := enableDynsec(context.Background(), f.host(), okReport(), good); err == nil {
		t.Error("a previous activation must be reset first")
	}
}

func TestDynsecConfHasNoTrailingComment(t *testing.T) {
	for _, l := range strings.Split(dynsecConf("/lib/x.so", true), "\n") {
		if l != "" && !strings.HasPrefix(l, "#") && strings.Contains(l, " #") {
			t.Errorf("trailing comment: %q", l)
		}
	}
}

func TestResetDynsec(t *testing.T) {
	f := &fakeHost{files: map[string]string{
		"/etc/mosquitto/conf.d/" + dynsecConfName: "x", dynsecTLSDir + "/ca.crt": "x", dynsecInitPw: "x", dynsecState: "{}",
		dynsecState + ".disabled-900": "{}", dynsecState + ".before-hlm-800": "{}", "/etc/mosquitto/conf.d/local.conf": "listener 1883",
	}}
	if _, err := resetDynsec(context.Background(), f.host(), "/etc/mosquitto/conf.d", "mosquitto.service"); err != nil {
		t.Fatal(err)
	}
	// what the administrator had before the enabling stays
	if f.files["/etc/mosquitto/conf.d/local.conf"] == "" || f.files[dynsecState+".before-hlm-800"] == "" || len(f.files) != 2 || f.restarts != 1 {
		t.Fatalf("files=%v restarts=%d", f.files, f.restarts)
	}
}

// The plugin and the TLS listener read their files after the broker dropped its privileges: a file of root:mosquitto
// must be readable by the group (this is what a 600 init password file broke on a real broker).
func TestEnableDynsecFilesAreReadableByTheBroker(t *testing.T) {
	f := &fakeHost{files: map[string]string{}}
	var written []string
	h := f.host()
	write := h.Write
	h.Write = func(p string, d []byte, mode os.FileMode, group string) error {
		written = append(written, p)
		if group == "mosquitto" && mode&0o040 == 0 || group == "" && mode&0o004 == 0 {
			t.Errorf("%s: mode %o group %q is not readable by the broker", p, mode, group)
		}
		return write(p, d, mode, group)
	}
	if _, err := enableDynsec(context.Background(), h, okReport(), testPKI(t)); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, p := range written {
		found = found || p == dynsecInitPw
	}
	if !found {
		t.Fatal("the init password file was not written")
	}
}

func TestWithAnonymous(t *testing.T) {
	base := dynsecConf("/lib/x.so", false)
	denied := withAnonymous(base, false)
	if !strings.Contains(denied, "log_dest topic\nallow_anonymous false\nlistener 8883") {
		t.Fatalf("not before the listener:\n%s", denied)
	}
	if withAnonymous(denied, false) != denied {
		t.Fatal("not idempotent")
	}
	if withAnonymous(denied, true) != base {
		t.Fatalf("allowing must give the file back:\n%s", withAnonymous(denied, true))
	}
}

func TestSetAnonymous(t *testing.T) {
	settleTime = time.Millisecond
	defer func() { settleTime = time.Second }()
	conf := "/etc/mosquitto/conf.d/" + dynsecConfName
	f := &fakeHost{files: map[string]string{conf: dynsecConf("/lib/x.so", false)}}
	h := f.host()
	active := true
	run := h.Run
	h.Run = func(ctx context.Context, name string, args ...string) (string, error) {
		if name == "systemctl" {
			if active {
				return "active\n", nil
			}
			return "failed\n", fmt.Errorf("exit 3")
		}
		return run(ctx, name, args...)
	}
	rep := okReport()
	if _, err := setAnonymous(context.Background(), h, rep, false); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(f.files[conf], "allow_anonymous false") || f.restarts != 1 {
		t.Fatalf("file=%s restarts=%d", f.files[conf], f.restarts)
	}
	// already so: nothing written, no restart
	if steps, err := setAnonymous(context.Background(), h, rep, false); err != nil || f.restarts != 1 || steps[0] != "déjà dans cet état" {
		t.Fatalf("steps=%v err=%v restarts=%d", steps, err, f.restarts)
	}
	// the broker does not come back: the file is put back
	before := f.files[conf]
	active = false
	if _, err := setAnonymous(context.Background(), h, rep, true); err == nil || !strings.Contains(err.Error(), "configuration restaurée") {
		t.Fatalf("err = %v", err)
	}
	if f.files[conf] != before {
		t.Fatalf("not restored:\n%s", f.files[conf])
	}
}
