package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGg0bWM3Y2xhdWRlLXRlc3Qta2V5LTAwMDAwMDAwMDA mamath@pc"

func TestValidateSetup(t *testing.T) {
	ok := SetupSpec{
		Modules:   []string{"user", "packages", "root_keys", "user_motd"},
		Packages:  []string{"htop", "lib++-dev"},
		Root:      AccountSpec{SSHKeys: []string{testKey}, Prompt: "classic", Motd: "homelab"},
		User:      &UserSpec{Name: "mamath", AccountSpec: AccountSpec{Motd: "fastfetch"}},
		Fastfetch: `{"logo": {"source": "debian"}}`,
	}
	if err := validateSetup(&ok); err != nil {
		t.Fatal(err)
	}
	bad := []SetupSpec{
		{User: &UserSpec{Name: "Root;rm"}},
		{User: &UserSpec{Name: "-x"}},
		{User: &UserSpec{Name: "root"}},
		{Modules: []string{"exec"}},
		{Modules: []string{"user_keys"}}, // user option without user
		{Packages: []string{"htop; reboot"}},
		{Root: AccountSpec{SSHKeys: []string{"ssh-ed25519 AAAA\nssh-rsa BBBB"}}},
		{User: &UserSpec{Name: "ops", AccountSpec: AccountSpec{SSHKeys: []string{`command="rm -rf /" ssh-ed25519 AAAA`}}}},
		{Fastfetch: `{"logo": `},
		{Root: AccountSpec{Prompt: "zsh"}},
		{User: &UserSpec{Name: "ops", AccountSpec: AccountSpec{Motd: "cowsay"}}},
		{Root: AccountSpec{Aliases: "a\x00b"}},
		{Root: AccountSpec{Aliases: strings.Repeat("x", maxSetupText+1)}},
	}
	for i, b := range bad {
		if validateSetup(&b) == nil {
			t.Errorf("case %d accepted: %+v", i, b)
		}
	}
}

func TestBashrcBlock(t *testing.T) {
	prompt, motd := sourceLine(promptDir, "classic"), sourceLine(motdDir, "fastfetch")
	// Debian user .bashrc already loads .bash_aliases: the block does not add it again
	user := "# ~/.bashrc\nif [ -f ~/.bash_aliases ]; then\n    . ~/.bash_aliases\nfi\n"
	got := withBlock(user, prompt, motd)
	if !strings.HasPrefix(got, user) || strings.Count(got, ".bash_aliases") != 2 || !strings.Contains(got, "/etc/homelab/prompt/classic.sh") {
		t.Fatalf("unexpected block:\n%s", got)
	}
	// idempotent
	if withBlock(got, prompt, motd) != got {
		t.Fatal("withBlock is not idempotent")
	}
	// root's .bashrc (no newline at the end, no .bash_aliases): the block loads it
	root := "PS1='# '"
	got = withBlock(root, "", "")
	if !strings.HasPrefix(got, root+"\n"+blockStart) || !strings.Contains(got, "[ -f ~/.bash_aliases ] && . ~/.bash_aliases") {
		t.Fatalf("unexpected root block:\n%s", got)
	}
	// a block in the middle is moved to the end, the rest is kept
	mid := "a\n" + bashrcBlock("", "", "") + "b\n"
	if got := withBlock(mid, "", ""); !strings.HasPrefix(got, "a\nb\n"+blockStart) {
		t.Fatalf("block not moved:\n%s", got)
	}
}

func TestAccountBlock(t *testing.T) {
	cur := withBlock("", sourceLine(promptDir, "starship"), sourceLine(motdDir, "homelab"))
	// managed options: the styles of the section
	s := &SetupSpec{Modules: []string{"root_prompt", "root_motd"}, Root: AccountSpec{Prompt: "classic", Motd: "none"}}
	got := s.accountBlock(cur, "root")
	if !strings.Contains(got, "/prompt/classic.sh") || strings.Contains(got, "/motd/") {
		t.Fatalf("managed styles not applied:\n%s", got)
	}
	// unmanaged options: the lines already there are kept
	s = &SetupSpec{Modules: []string{"root_aliases"}}
	if got := s.accountBlock(cur, "root"); got != cur {
		t.Fatalf("unmanaged styles changed:\n%s", got)
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
	if renderStarship(&SetupSpec{}) != "" || renderStarship(&SetupSpec{Starship: "a = 1"}) != managedHead+"a = 1\n" {
		t.Fatal("starship configuration")
	}
	if renderFastfetch(&SetupSpec{}) != "" {
		t.Fatal("no fastfetch configuration expected")
	}
	if got := renderFastfetch(&SetupSpec{Fastfetch: "{}"}); got != "// "+strings.TrimPrefix(managedHead, "# ")+"{}\n" {
		t.Fatalf("%q", got)
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
	want := renderFastfetch(&SetupSpec{Fastfetch: "{}"})
	if st, _ := checkFile(fastfetchFile, want); st != "drift" {
		t.Fatal("absent file must drift")
	}
	if err := syncFile(fastfetchFile, want, 0o644, nil, emit); err != nil {
		t.Fatal(err)
	}
	if st, d := checkFile(fastfetchFile, want); st != "ok" {
		t.Fatal(d)
	}
	_ = os.WriteFile(filepath.Join(fsRoot, fastfetchFile), []byte("changed"), 0o644)
	if st, _ := checkFile(fastfetchFile, want); st != "drift" {
		t.Fatal("modified file must drift")
	}
	// empty content: the file is removed
	if err := syncFile(fastfetchFile, "", 0o644, nil, emit); err != nil {
		t.Fatal(err)
	}
	if st, _ := checkFile(fastfetchFile, ""); st != "ok" {
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

func TestSshdReloadAction(t *testing.T) {
	for _, c := range []struct {
		socket, service bool
		want            string
	}{
		{false, true, "reload"}, // sshd listening by itself
		{true, true, "restart"}, // socket activation: a reload kills sshd (port held by systemd)
		{true, false, ""},       // next connection starts it
		{false, false, ""},      // stopped: next start
	} {
		if got := sshdReloadAction(c.socket, c.service); got != c.want {
			t.Errorf("sshdReloadAction(%v, %v) = %q, want %q", c.socket, c.service, got, c.want)
		}
	}
}

func TestEnsureSshdRunDir(t *testing.T) {
	fsRoot = t.TempDir()
	defer func() { fsRoot = "" }()
	ensureSshdRunDir()
	st, err := os.Stat(filepath.Join(fsRoot, "/run/sshd"))
	if err != nil || !st.IsDir() || st.Mode().Perm() != 0o755 {
		t.Fatalf("/run/sshd: %v %v", st, err)
	}
}
