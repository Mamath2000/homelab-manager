package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGg0bWM3Y2xhdWRlLXRlc3Qta2V5LTAwMDAwMDAwMDA mamath@pc"

func TestValidateSetup(t *testing.T) {
	ok := SetupSpec{User: "mamath", Modules: []string{"user", "packages"}, Packages: []string{"htop", "lib++-dev"}, SSHKeys: []string{testKey}, AptProxy: "http://192.168.100.8:3142", Prompt: "classic", Motd: "homelab"}
	if err := validateSetup(&ok); err != nil {
		t.Fatal(err)
	}
	bad := []SetupSpec{
		{User: "Root;rm"},
		{User: "-x"},
		{Modules: []string{"exec"}},
		{Packages: []string{"htop; reboot"}},
		{SSHKeys: []string{"ssh-ed25519 AAAA\nssh-rsa BBBB"}},
		{SSHKeys: []string{`command="rm -rf /" ssh-ed25519 AAAA`}},
		{AptProxy: "http://proxy:3142/\nAcquire::x"},
		{AptProxy: "ftp://proxy"},
		{Prompt: "zsh"},
		{Motd: "cowsay"},
		{Aliases: "a\x00b"},
		{SSHConfig: strings.Repeat("x", maxSetupText+1)},
	}
	for i, b := range bad {
		if validateSetup(&b) == nil {
			t.Errorf("case %d accepted: %+v", i, b)
		}
	}
}

func TestBashrcBlock(t *testing.T) {
	// Debian user .bashrc already loads .bash_aliases: the block does not add it again
	user := "# ~/.bashrc\nif [ -f ~/.bash_aliases ]; then\n    . ~/.bash_aliases\nfi\n"
	got := withBlock(user)
	if !strings.HasPrefix(got, user) || strings.Count(got, ".bash_aliases") != 2 {
		t.Fatalf("unexpected block:\n%s", got)
	}
	// idempotent
	if withBlock(got) != got {
		t.Fatal("withBlock is not idempotent")
	}
	// root's .bashrc (no newline at the end, no .bash_aliases): the block loads it
	root := "PS1='# '"
	got = withBlock(root)
	if !strings.HasPrefix(got, root+"\n"+blockStart) || !strings.Contains(got, "[ -f ~/.bash_aliases ] && . ~/.bash_aliases") {
		t.Fatalf("unexpected root block:\n%s", got)
	}
	// a block in the middle is moved to the end, the rest is kept
	mid := "a\n" + bashrcBlock("") + "b\n"
	if got := withBlock(mid); !strings.HasPrefix(got, "a\nb\n"+blockStart) {
		t.Fatalf("block not moved:\n%s", got)
	}
}

func TestMissingKeys(t *testing.T) {
	other := "ssh-rsa AAAAB3NzaC1yc2E other"
	content := "# comment\n" + strings.Replace(testKey, "mamath@pc", "renamed", 1) + "\n"
	if got := missingKeys(content, []string{testKey, other}); len(got) != 1 || got[0] != other {
		t.Fatalf("missingKeys = %v", got)
	}
	if countKeys(content) != 1 {
		t.Fatal("countKeys")
	}
}

func TestRender(t *testing.T) {
	if renderAptProxy("") != "" {
		t.Fatal("empty proxy must remove the file")
	}
	if p := renderAptProxy("http://10.0.0.8:3142"); !strings.Contains(p, `Acquire::HTTP::Proxy "http://10.0.0.8:3142";`) {
		t.Fatal(p)
	}
	if !strings.HasSuffix(renderSshd(false), "PasswordAuthentication no\n") || !strings.HasSuffix(renderSshd(true), "PasswordAuthentication yes\n") {
		t.Fatal("sshd drop-in")
	}
	if renderPrompt("none") != "" || renderMotd("none") != "" {
		t.Fatal("none must remove the file")
	}
	if got := renderManaged("alias ll='ls -l'\r\n"); got != managedHead+"alias ll='ls -l'\n" {
		t.Fatalf("%q", got)
	}
	env := renderMotdEnv(motdCounters{hasApt: true, updates: 3, security: 1, reboot: true, hasDocker: true, containers: 8, running: 7})
	if env != "HM_UPDATES=3\nHM_SECURITY=1\nHM_REBOOT=1\nHM_CONTAINERS=8\nHM_RUNNING=7\n" {
		t.Fatalf("%q", env)
	}
}

func TestSyncFileAndCheck(t *testing.T) {
	fsRoot = t.TempDir()
	defer func() { fsRoot = "" }()
	emit := func(string) {}
	want := renderAptProxy("http://10.0.0.8:3142")
	if st, _ := checkFile(aptProxyFile, want); st != "drift" {
		t.Fatal("absent file must drift")
	}
	if err := syncFile(aptProxyFile, want, 0o644, nil, emit); err != nil {
		t.Fatal(err)
	}
	if st, d := checkFile(aptProxyFile, want); st != "ok" {
		t.Fatal(d)
	}
	_ = os.WriteFile(filepath.Join(fsRoot, aptProxyFile), []byte("changed"), 0o644)
	if st, _ := checkFile(aptProxyFile, want); st != "drift" {
		t.Fatal("modified file must drift")
	}
	// no proxy: the file is removed
	if err := syncFile(aptProxyFile, "", 0o644, nil, emit); err != nil {
		t.Fatal(err)
	}
	if st, _ := checkFile(aptProxyFile, ""); st != "ok" {
		t.Fatal("removed file")
	}
}

func TestSSHDropInsDetection(t *testing.T) {
	fsRoot = t.TempDir()
	defer func() { fsRoot = "" }()
	p := filepath.Join(fsRoot, "/etc/ssh/sshd_config")
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	_ = os.WriteFile(p, []byte("Port 22\n"), 0o644)
	if sshdUsesDropIns() {
		t.Fatal("no include")
	}
	_ = os.WriteFile(p, []byte("Include /etc/ssh/sshd_config.d/*.conf\nPort 22\n"), 0o644)
	if !sshdUsesDropIns() {
		t.Fatal("include not seen")
	}
}
