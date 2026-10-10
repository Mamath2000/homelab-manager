package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Standardisation of a host (setup_apply / setup_check): a fixed list of options in three sections
// (system, root, an optional user), each with typed values checked here again. The hub never sends a
// command or a path: only values that end up in files this module writes (aliases, fastfetch) or in
// fixed commands (apt-get install, useradd).

// Options, in the order they are applied: the user first (the others write in its home), the SSH
// password last (it refuses to lock out a host where no key is installed).
var setupModules = []string{
	"user", "packages",
	"root_keys", "user_keys", "root_aliases", "user_aliases",
	"root_prompt", "user_prompt", "root_motd", "user_motd",
	"ssh_password",
}

// What is configured for one account: root or the user.
type AccountSpec struct {
	SSHKeys []string `json:"sshKeys,omitempty"`
	Aliases string   `json:"aliases,omitempty"`
	Prompt  string   `json:"prompt,omitempty"` // none | classic | starship
	Motd    string   `json:"motd,omitempty"`   // none | homelab | fastfetch
}

type UserSpec struct {
	Name           string `json:"name"`
	SudoNoPassword bool   `json:"sudoNoPassword,omitempty"`
	AccountSpec
}

type SetupSpec struct {
	Modules       []string    `json:"modules"` // managed options
	Packages      []string    `json:"packages,omitempty"`
	AllowPassword bool        `json:"allowPassword,omitempty"`
	Root          AccountSpec `json:"root"`
	User          *UserSpec   `json:"user,omitempty"`
	Fastfetch     string      `json:"fastfetch,omitempty"` // JSON configuration (welcome screen fastfetch)
	Starship      string      `json:"starship,omitempty"`  // TOML configuration (prompt starship)
}

// State of one module against the spec.
type SetupCheck struct {
	Module string `json:"module"`
	State  string `json:"state"` // ok | drift | na (does not apply to this host) | error
	Detail string `json:"detail,omitempty"`
}

type SetupReport struct {
	CheckedAt int64        `json:"checkedAt"`
	User      string       `json:"user"`
	Modules   []SetupCheck `json:"modules"`
}

var (
	userNameRe = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
	sshKeyRe   = regexp.MustCompile(`^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\r\n]*)?$`)
)

const maxSetupText = 64 << 10

// fsRoot prefixes every system path (tests write into a temporary directory).
var fsRoot = ""

func sysPath(p string) string { return fsRoot + p }

// Files and markers written by the module.
const (
	homelabDir    = "/etc/homelab"
	promptDir     = homelabDir + "/prompt"
	motdDir       = homelabDir + "/motd"
	motdEnvFile   = homelabDir + "/motd.env"
	fastfetchFile = homelabDir + "/fastfetch.jsonc"
	starshipFile  = homelabDir + "/starship.toml"
	sshdDropIn    = "/etc/ssh/sshd_config.d/00-homelab.conf"
	sudoersFile   = "/etc/sudoers.d/90-homelab"
	blockStart    = "# >>> homelab-manager >>>"
	blockEnd      = "# <<< homelab-manager <<<"
	managedHead   = "# Géré par Homelab Manager (Paramètres > Standardisation) : les modifications locales seront écrasées.\n"
)

func validateAccount(a *AccountSpec) error {
	for _, k := range a.SSHKeys {
		if !sshKeyRe.MatchString(k) {
			return fmt.Errorf("invalid ssh key")
		}
	}
	if !contains([]string{"", "none", "classic", "starship"}, a.Prompt) || !contains([]string{"", "none", "homelab", "fastfetch"}, a.Motd) {
		return fmt.Errorf("invalid prompt or motd style")
	}
	if len(a.Aliases) > maxSetupText || strings.ContainsRune(a.Aliases, 0) {
		return fmt.Errorf("text too long or binary")
	}
	return nil
}

func validateSetup(s *SetupSpec) error {
	if s.User != nil && (!userNameRe.MatchString(s.User.Name) || s.User.Name == "root") {
		return fmt.Errorf("invalid user name")
	}
	for _, m := range s.Modules {
		if !contains(setupModules, m) {
			return fmt.Errorf("unknown module %q", m)
		}
		if strings.HasPrefix(m, "user") && s.User == nil {
			return fmt.Errorf("%s without user", m)
		}
	}
	if !validPackages(s.Packages) {
		return fmt.Errorf("invalid package name")
	}
	if err := validateAccount(&s.Root); err != nil {
		return err
	}
	if s.User != nil {
		if err := validateAccount(&s.User.AccountSpec); err != nil {
			return err
		}
	}
	if len(s.Fastfetch) > maxSetupText || (s.Fastfetch != "" && !json.Valid([]byte(s.Fastfetch))) {
		return fmt.Errorf("invalid fastfetch configuration")
	}
	// TOML is checked by the hub; starship ignores an invalid file (warning, default prompt)
	if len(s.Starship) > maxSetupText || strings.ContainsRune(s.Starship, 0) {
		return fmt.Errorf("invalid starship configuration")
	}
	return nil
}

// account whose home is configured, besides root
type account struct {
	name     string
	home     string
	uid, gid int
}

func lookupAccount(name string) (*account, error) {
	u, err := user.Lookup(name)
	if err != nil {
		return nil, err
	}
	uid, _ := strconv.Atoi(u.Uid)
	gid, _ := strconv.Atoi(u.Gid)
	return &account{name: u.Username, home: u.HomeDir, uid: uid, gid: gid}, nil
}

func (s *SetupSpec) has(m string) bool { return contains(s.Modules, m) }

func (s *SetupSpec) userName() string {
	if s.User == nil {
		return ""
	}
	return s.User.Name
}

// section of the spec an option belongs to: "root" or "user", with its values
func (s *SetupSpec) section(prefix string) *AccountSpec {
	if prefix == "user" {
		if s.User == nil {
			return nil
		}
		return &s.User.AccountSpec
	}
	return &s.Root
}

// account of a section, nil when the user does not exist (yet)
func (s *SetupSpec) account(prefix string) *account {
	name := "root"
	if prefix == "user" {
		name = s.userName()
	}
	if name == "" {
		return nil
	}
	a, err := lookupAccount(name)
	if err != nil {
		return nil
	}
	return a
}

// --- rendering (pure, tested) ------------------------------------------------------

func renderSshd(allow bool) string {
	v := "no"
	if allow {
		v = "yes"
	}
	return managedHead + "PasswordAuthentication " + v + "\n"
}

func renderManaged(content string) string {
	content = strings.ReplaceAll(content, "\r\n", "\n")
	if content != "" && !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	return managedHead + content
}

// PS1 of homeSetup (root in red), with the git branch when there is one.
const promptClassic = `# shellcheck shell=bash
__hm_git() { local b; b=$(git symbolic-ref --short HEAD 2>/dev/null) || return; printf ' (%s)' "$b"; }
if [ "$(id -u)" -eq 0 ]; then __hm_c='\[\e[31m\]'; else __hm_c='\[\e[38;5;11m\]'; fi
PS1="${__hm_c}\u\[\e[0m\]@\H:\[\e[38;5;6m\][\w]\[\e[38;5;13m\]\$(__hm_git)\[\e[0m\] "
unset __hm_c
`

const promptStarship = `# shellcheck shell=bash
[ -r /etc/homelab/starship.toml ] && export STARSHIP_CONFIG=/etc/homelab/starship.toml
command -v starship >/dev/null 2>&1 && eval "$(starship init bash)"
`

// renderPrompt is the script of a prompt style, in promptDir/<style>.sh.
func renderPrompt(style string) string {
	switch style {
	case "classic":
		return managedHead + promptClassic
	case "starship":
		return managedHead + promptStarship
	}
	return ""
}

// Welcome screen, once per interactive login shell. Plain bash reading /proc: instantaneous. The
// counters known by the agent (updates, containers) come from motd.env, refreshed by the agent.
const motdHomelab = `# shellcheck shell=bash
if [ -n "$PS1" ] && [ -z "$HM_MOTD_SHOWN" ]; then
  export HM_MOTD_SHOWN=1
  __hm_motd() {
    local d=$'\e[2m' o=$'\e[0m' b=$'\e[1m' y=$'\e[33m' r=$'\e[31m' g=$'\e[32m'
    local os up load mem disk ip virt line
    os=$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")
    virt=$(systemd-detect-virt 2>/dev/null)
    read -r up _ </proc/uptime; up=${up%.*}
    read -r load _ </proc/loadavg
    mem=$(awk '/^MemTotal/{t=$2}/^MemAvailable/{a=$2}END{printf "%.1f/%.1f Go", (t-a)/1048576, t/1048576}' /proc/meminfo)
    disk=$(df -P / 2>/dev/null | awk 'NR==2{print $5}')
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    local HM_UPDATES= HM_SECURITY= HM_REBOOT= HM_CONTAINERS= HM_RUNNING=
    [ -r /etc/homelab/motd.env ] && . /etc/homelab/motd.env
    printf '\n  %s%s%s %s· %s%s%s\n' "$b" "$(hostname)" "$o" "$d" "${os:-Linux}" "${virt:+ · $virt}" "$o"
    printf '  %sup%s %dj %dh %02dm  %s·%s charge %s  %s·%s RAM %s  %s·%s / %s\n' "$d" "$o" $((up/86400)) $((up%86400/3600)) $((up%3600/60)) "$d" "$o" "$load" "$d" "$o" "$mem" "$d" "$o" "$disk"
    line="  ${ip:-}"
    [ -n "$HM_CONTAINERS" ] && line="$line  $d·$o docker $HM_RUNNING/$HM_CONTAINERS conteneurs"
    printf '%s\n' "$line"
    if [ "${HM_UPDATES:-0}" -gt 0 ]; then
      if [ "${HM_SECURITY:-0}" -gt 0 ]; then
        printf '  %s%s mise(s) à jour, dont %s de sécurité%s\n' "$r" "$HM_UPDATES" "$HM_SECURITY" "$o"
      else
        printf '  %s%s mise(s) à jour%s\n' "$y" "$HM_UPDATES" "$o"
      fi
    elif [ -n "$HM_UPDATES" ]; then
      printf '  %sà jour%s\n' "$g" "$o"
    fi
    [ "$HM_REBOOT" = 1 ] && printf '  %sredémarrage requis%s\n' "$y" "$o"
    printf '\n'
  }
  __hm_motd
  unset -f __hm_motd
fi
`

const motdFastfetch = `# shellcheck shell=bash
if [ -n "$PS1" ] && [ -z "$HM_MOTD_SHOWN" ]; then
  export HM_MOTD_SHOWN=1
  if command -v fastfetch >/dev/null 2>&1; then
    if [ -r /etc/homelab/fastfetch.jsonc ]; then fastfetch -c /etc/homelab/fastfetch.jsonc; else fastfetch; fi
  fi
fi
`

// renderMotd is the script of a welcome screen style, in motdDir/<style>.sh.
func renderMotd(style string) string {
	switch style {
	case "homelab":
		return managedHead + motdHomelab
	case "fastfetch":
		return managedHead + motdFastfetch
	}
	return ""
}

// renderFastfetch is the configuration read by the fastfetch welcome screen.
func renderFastfetch(s *SetupSpec) string {
	if strings.TrimSpace(s.Fastfetch) == "" {
		return ""
	}
	// same header as the other files, as a JSONC comment
	return "//" + strings.TrimPrefix(renderManaged(s.Fastfetch), "#")
}

// renderStarship is the configuration read by the Starship prompt (TOML: same header).
func renderStarship(s *SetupSpec) string {
	if strings.TrimSpace(s.Starship) == "" {
		return ""
	}
	return renderManaged(s.Starship)
}

func stylePath(dir, style string) string { return dir + "/" + style + ".sh" }

// sourceLine loads a style script from ~/.bashrc, nothing for "none".
func sourceLine(dir, style string) string {
	if style == "" || style == "none" {
		return ""
	}
	p := stylePath(dir, style)
	return "[ -r " + p + " ] && . " + p + "\n"
}

// blockLine returns the line of the current block that loads a script of dir ("" when none).
func blockLine(content, dir string) string {
	i := strings.Index(content, blockStart)
	if i < 0 {
		return ""
	}
	for _, l := range strings.Split(content[i:], "\n") {
		if strings.HasPrefix(l, blockEnd) {
			break
		}
		if strings.Contains(l, dir+"/") {
			return l + "\n"
		}
	}
	return ""
}

// bashrcBlock is the managed block at the end of ~/.bashrc: it loads ~/.bash_aliases when the rest
// of the file does not (root's .bashrc on Debian), then the prompt and welcome screen of the account.
func bashrcBlock(rest, prompt, motd string) string {
	var b strings.Builder
	b.WriteString(blockStart + "\n")
	if !strings.Contains(rest, ".bash_aliases") {
		b.WriteString("[ -f ~/.bash_aliases ] && . ~/.bash_aliases\n")
	}
	b.WriteString(prompt + motd)
	b.WriteString(blockEnd + "\n")
	return b.String()
}

// accountBlock returns the content of ~/.bashrc with the block of the section: a prompt or welcome
// screen that is not managed keeps the line already there.
func (s *SetupSpec) accountBlock(content, prefix string) string {
	acc := s.section(prefix)
	prompt, motd := blockLine(content, promptDir), blockLine(content, motdDir)
	if s.has(prefix + "_prompt") {
		prompt = sourceLine(promptDir, acc.Prompt)
	}
	if s.has(prefix + "_motd") {
		motd = sourceLine(motdDir, acc.Motd)
	}
	return withBlock(content, prompt, motd)
}

// withBlock returns content with the managed block (re)written at the end.
func withBlock(content, prompt, motd string) string {
	rest := stripBlock(content)
	if rest != "" && !strings.HasSuffix(rest, "\n") {
		rest += "\n"
	}
	return rest + bashrcBlock(rest, prompt, motd)
}

func stripBlock(content string) string {
	i := strings.Index(content, blockStart)
	if i < 0 {
		return content
	}
	j := strings.Index(content[i:], blockEnd)
	if j < 0 {
		return content[:i]
	}
	end := i + j + len(blockEnd)
	if end < len(content) && content[end] == '\n' {
		end++
	}
	return content[:i] + content[end:]
}

// keyID identifies a public key by its type and base64 blob, whatever its comment.
func keyID(line string) string {
	f := strings.Fields(line)
	if len(f) < 2 {
		return ""
	}
	// options before the key type (from="...", command="...") are not supported: compare as is
	return f[0] + " " + f[1]
}

// missingKeys returns the keys of want that are absent from an authorized_keys content.
func missingKeys(content string, want []string) []string {
	have := map[string]bool{}
	for _, l := range strings.Split(content, "\n") {
		if id := keyID(strings.TrimSpace(l)); id != "" {
			have[id] = true
		}
	}
	var out []string
	for _, k := range want {
		if !have[keyID(k)] {
			out = append(out, k)
		}
	}
	return out
}

func countKeys(content string) int {
	n := 0
	for _, l := range strings.Split(content, "\n") {
		l = strings.TrimSpace(l)
		if l != "" && !strings.HasPrefix(l, "#") {
			n++
		}
	}
	return n
}

// Counters shown by the welcome screen, written by the agent.
type motdCounters struct {
	updates, security   int
	reboot              bool
	containers, running int
	hasApt, hasDocker   bool
}

func renderMotdEnv(c motdCounters) string {
	var b strings.Builder
	if c.hasApt {
		fmt.Fprintf(&b, "HM_UPDATES=%d\nHM_SECURITY=%d\n", c.updates, c.security)
		if c.reboot {
			b.WriteString("HM_REBOOT=1\n")
		}
	}
	if c.hasDocker {
		fmt.Fprintf(&b, "HM_CONTAINERS=%d\nHM_RUNNING=%d\n", c.containers, c.running)
	}
	return b.String()
}

// --- files ---------------------------------------------------------------------------

func readFile(p string) (string, bool) {
	b, err := os.ReadFile(sysPath(p))
	return string(b), err == nil
}

// writeOwned writes a file (atomically) and gives it to an account.
func writeOwned(p, content string, mode os.FileMode, a *account) error {
	full := sysPath(p)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	if err := writeFileAtomic(full, []byte(content), mode); err != nil {
		return err
	}
	if a != nil {
		return os.Chown(full, a.uid, a.gid)
	}
	return nil
}

// sshDir creates ~/.ssh (700) for an account.
func sshDir(a *account) (string, error) {
	d := filepath.Join(a.home, ".ssh")
	if err := os.MkdirAll(sysPath(d), 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(sysPath(d), 0o700); err != nil {
		return "", err
	}
	return d, os.Chown(sysPath(d), a.uid, a.gid)
}

// syncFile writes p when its content differs; content "" removes it.
func syncFile(p, content string, mode os.FileMode, a *account, emit func(string)) error {
	cur, ok := readFile(p)
	if content == "" {
		if !ok {
			return nil
		}
		emit("removing " + p + "\n")
		return os.Remove(sysPath(p))
	}
	if ok && cur == content {
		emit(p + " already up to date\n")
		return nil
	}
	emit("writing " + p + "\n")
	return writeOwned(p, content, mode, a)
}

// --- apply ---------------------------------------------------------------------------

func installedPackages(ctx context.Context, names []string) map[string]bool {
	out := map[string]bool{}
	if len(names) == 0 {
		return out
	}
	args := append([]string{"-W", "-f", "${Package} ${db:Status-Status}\n"}, names...)
	raw, _ := exec.CommandContext(ctx, "dpkg-query", args...).Output() // exit 1 when one is unknown
	sc := bufio.NewScanner(strings.NewReader(string(raw)))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && f[1] == "installed" {
			out[strings.SplitN(f[0], ":", 2)[0]] = true
		}
	}
	return out
}

func missingPackages(ctx context.Context, names []string) []string {
	inst := installedPackages(ctx, names)
	var out []string
	for _, n := range names {
		if !inst[n] {
			out = append(out, n)
		}
	}
	return out
}

// aptInstall installs the missing packages, after an apt-get update.
func aptInstall(ctx context.Context, names []string, emit func(string)) error {
	missing := missingPackages(ctx, names)
	if len(missing) == 0 {
		emit("packages already installed\n")
		return nil
	}
	if code, err := runStreaming(ctx, aptEnv(), emit, "apt-get", "update", "-q"); err != nil || code != 0 {
		return fmt.Errorf("apt-get update failed (%d) %v", code, err)
	}
	args := append([]string{"install", "-y", "-q", "-o", "Dpkg::Options::=--force-confold", "-o", "Dpkg::Options::=--force-confdef"}, missing...)
	if code, err := runStreaming(ctx, aptEnv(), emit, "apt-get", args...); err != nil || code != 0 {
		return fmt.Errorf("apt-get install %s failed (%d) %v: is it available in the repositories of this distribution?", strings.Join(missing, " "), code, err)
	}
	return nil
}

func groupExists(name string) bool {
	_, err := user.LookupGroup(name)
	return err == nil
}

func userGroups(name string) map[string]bool {
	out := map[string]bool{}
	u, err := user.Lookup(name)
	if err != nil {
		return out
	}
	ids, _ := u.GroupIds()
	for _, id := range ids {
		if g, err := user.LookupGroupId(id); err == nil {
			out[g.Name] = true
		}
	}
	return out
}

// groups the user should belong to, among those that exist on the host
func wantedGroups() []string {
	var out []string
	for _, g := range []string{"sudo", "docker", "adm"} {
		if groupExists(g) {
			out = append(out, g)
		}
	}
	return out
}

func sudoersContent(name string) string {
	return managedHead + name + " ALL=(ALL:ALL) NOPASSWD: ALL\n"
}

func applyUser(ctx context.Context, s *SetupSpec, emit func(string)) error {
	name := s.userName()
	if _, err := exec.LookPath("sudo"); err != nil {
		if err := aptInstall(ctx, []string{"sudo"}, emit); err != nil {
			return err
		}
	}
	if _, err := user.Lookup(name); err != nil {
		emit("creating user " + name + "\n")
		args := []string{"-m", "-s", "/bin/bash"}
		if g := wantedGroups(); len(g) > 0 {
			args = append(args, "-G", strings.Join(g, ","))
		}
		if code, err := runStreaming(ctx, os.Environ(), emit, "useradd", append(args, name)...); err != nil || code != 0 {
			return fmt.Errorf("useradd failed (%d) %v", code, err)
		}
	} else {
		have := userGroups(name)
		var add []string
		for _, g := range wantedGroups() {
			if !have[g] {
				add = append(add, g)
			}
		}
		if len(add) > 0 {
			emit("adding " + name + " to " + strings.Join(add, ", ") + "\n")
			if code, err := runStreaming(ctx, os.Environ(), emit, "usermod", "-aG", strings.Join(add, ","), name); err != nil || code != 0 {
				return fmt.Errorf("usermod failed (%d) %v", code, err)
			}
		} else {
			emit("user " + name + " already set up\n")
		}
	}
	content := ""
	if s.User.SudoNoPassword {
		content = sudoersContent(name)
	}
	if content != "" {
		// a broken sudoers file locks sudo: check it before it takes effect
		tmp := sysPath(sudoersFile) + ".new"
		if err := os.WriteFile(tmp, []byte(content), 0o440); err != nil {
			return err
		}
		defer os.Remove(tmp)
		if out, err := exec.CommandContext(ctx, "visudo", "-cf", tmp).CombinedOutput(); err != nil {
			return fmt.Errorf("visudo: %s", strings.TrimSpace(string(out)))
		}
	}
	return syncFile(sudoersFile, content, 0o440, nil, emit)
}

// applySSHKeys adds the missing keys to ~/.ssh/authorized_keys of the account; the others are kept.
func applySSHKeys(a *account, keys []string, emit func(string)) error {
	if len(keys) == 0 {
		emit("no key configured\n")
		return nil
	}
	d, err := sshDir(a)
	if err != nil {
		return err
	}
	p := filepath.Join(d, "authorized_keys")
	cur, _ := readFile(p)
	add := missingKeys(cur, keys)
	if len(add) == 0 {
		emit(p + ": keys already present\n")
		return nil
	}
	if cur != "" && !strings.HasSuffix(cur, "\n") {
		cur += "\n"
	}
	emit(fmt.Sprintf("%s: adding %d key(s)\n", p, len(add)))
	return writeOwned(p, cur+strings.Join(add, "\n")+"\n", 0o600, a)
}

func aliasesContent(aliases string) string {
	if strings.TrimSpace(aliases) == "" {
		return ""
	}
	return renderManaged(aliases)
}

// applyBashrc writes the managed block of a section to ~/.bashrc of its account.
func applyBashrc(s *SetupSpec, prefix string, a *account, emit func(string)) error {
	p := filepath.Join(a.home, ".bashrc")
	cur, ok := readFile(p)
	if !ok {
		cur, _ = readFile("/etc/skel/.bashrc")
	}
	next := s.accountBlock(cur, prefix)
	if ok && next == cur {
		return nil
	}
	emit("updating " + p + "\n")
	return writeOwned(p, next, 0o644, a)
}

// applyStyle installs the package of a prompt or welcome screen style when it needs one, then writes its script.
func applyStyle(ctx context.Context, dir, style, content string, emit func(string)) error {
	if pkg := stylePackage(style); pkg != "" {
		if err := aptInstall(ctx, []string{pkg}, emit); err != nil {
			return err
		}
	}
	if content == "" {
		return nil
	}
	return syncFile(stylePath(dir, style), content, 0o644, nil, emit)
}

// package a style needs, installed by APT
func stylePackage(style string) string {
	if style == "starship" || style == "fastfetch" {
		return style
	}
	return ""
}

// applyAccountOption applies one option of the root or user section (keys, aliases, prompt, motd).
func applyAccountOption(ctx context.Context, s *SetupSpec, m string, emit func(string)) error {
	prefix, opt, _ := strings.Cut(m, "_")
	a := s.account(prefix)
	if a == nil {
		return fmt.Errorf("account %s absent", s.userName())
	}
	acc := s.section(prefix)
	switch opt {
	case "keys":
		return applySSHKeys(a, acc.SSHKeys, emit)
	case "aliases":
		if err := syncFile(filepath.Join(a.home, ".bash_aliases"), aliasesContent(acc.Aliases), 0o644, a, emit); err != nil {
			return err
		}
	case "prompt":
		if err := applyStyle(ctx, promptDir, acc.Prompt, renderPrompt(acc.Prompt), emit); err != nil {
			return err
		}
		if acc.Prompt == "starship" {
			if err := syncFile(starshipFile, renderStarship(s), 0o644, nil, emit); err != nil {
				return err
			}
		}
	case "motd":
		if err := applyStyle(ctx, motdDir, acc.Motd, renderMotd(acc.Motd), emit); err != nil {
			return err
		}
		if acc.Motd == "fastfetch" {
			if err := syncFile(fastfetchFile, renderFastfetch(s), 0o644, nil, emit); err != nil {
				return err
			}
		}
		if acc.Motd == "homelab" {
			writeMotdEnv()
		}
	}
	return applyBashrc(s, prefix, a, emit)
}

func sshdBinary() string {
	if p, err := exec.LookPath("sshd"); err == nil {
		return p
	}
	if _, err := os.Stat("/usr/sbin/sshd"); err == nil {
		return "/usr/sbin/sshd"
	}
	return ""
}

// sshd -t / -T need the privilege separation directory, which ssh.service creates (RuntimeDirectory)
// only while it runs: missing when sshd is stopped, e.g. socket-activated and not started yet.
func ensureSshdRunDir() { _ = os.MkdirAll(sysPath("/run/sshd"), 0o755) }

// How to make a running sshd take a new configuration. With socket activation (ssh.socket, the
// default in Proxmox LXC), systemd holds port 22: a reload makes sshd re-exec and bind the port
// itself, which fails and kills it. Restarting ssh.service hands it the socket again, and
// KillMode=process keeps the open sessions. Without ssh.service running, the next connection
// starts it with the new configuration.
func sshdReloadAction(socketActive, serviceActive bool) string {
	switch {
	case !serviceActive:
		return ""
	case socketActive:
		return "restart"
	default:
		return "reload"
	}
}

// sshd reads the files of sshd_config.d first (first value wins) when sshd_config includes them.
func sshdUsesDropIns() bool {
	cfg, _ := readFile("/etc/ssh/sshd_config")
	for _, l := range strings.Split(cfg, "\n") {
		l = strings.TrimSpace(l)
		if strings.HasPrefix(strings.ToLower(l), "include") && strings.Contains(l, "sshd_config.d") {
			return true
		}
	}
	return false
}

// installed keys of root and the user, so that disabling passwords cannot lock everyone out
func installedKeys(s *SetupSpec) int {
	n := 0
	for _, prefix := range []string{"root", "user"} {
		if a := s.account(prefix); a != nil {
			c, _ := readFile(filepath.Join(a.home, ".ssh", "authorized_keys"))
			n += countKeys(c)
		}
	}
	return n
}

func applySSHPassword(ctx context.Context, s *SetupSpec, emit func(string)) error {
	sshd := sshdBinary()
	if sshd == "" {
		emit("no SSH server on this host\n")
		return nil
	}
	if !s.AllowPassword && installedKeys(s) == 0 {
		return fmt.Errorf("refusing to disable password logins: no SSH key installed for root or the user (push SSH keys first)")
	}
	if !sshdUsesDropIns() {
		return fmt.Errorf("/etc/ssh/sshd_config does not include sshd_config.d: set PasswordAuthentication by hand")
	}
	prev, had := readFile(sshdDropIn)
	if err := syncFile(sshdDropIn, renderSshd(s.AllowPassword), 0o644, nil, emit); err != nil {
		return err
	}
	ensureSshdRunDir()
	if out, err := exec.CommandContext(ctx, sshd, "-t").CombinedOutput(); err != nil {
		// put the previous configuration back: never leave sshd unable to start
		if had {
			_ = writeOwned(sshdDropIn, prev, 0o644, nil)
		} else {
			_ = os.Remove(sysPath(sshdDropIn))
		}
		return fmt.Errorf("sshd -t: %s", strings.TrimSpace(string(out)))
	}
	active := func(unit string) bool {
		return exec.CommandContext(ctx, "systemctl", "is-active", "--quiet", unit).Run() == nil
	}
	socket := active("ssh.socket")
	for _, unit := range []string{"ssh", "sshd"} {
		action := sshdReloadAction(socket, active(unit+".service"))
		if action == "" {
			continue
		}
		emit(action + "ing " + unit + "\n")
		if out, err := exec.CommandContext(ctx, "systemctl", action, unit+".service").CombinedOutput(); err != nil {
			return fmt.Errorf("systemctl %s %s: %s", action, unit, strings.TrimSpace(string(out)))
		}
		return nil
	}
	if socket {
		emit("ssh service not running (socket activation): taken into account at the next connection\n")
	} else {
		emit("ssh service not running: taken into account at its next start\n")
	}
	return nil
}

// applySetup runs the managed options; a failed one does not stop the others, except the user,
// whose home the following options write in.
func applySetup(ctx context.Context, s *SetupSpec, emit func(string)) (int, error) {
	if err := validateSetup(s); err != nil {
		return -1, err
	}
	var failed []string
	for _, m := range setupModules {
		if !s.has(m) {
			continue
		}
		emit("\n== " + m + "\n")
		var err error
		switch m {
		case "user":
			err = applyUser(ctx, s, emit)
		case "packages":
			err = aptInstall(ctx, s.Packages, emit)
		case "ssh_password":
			err = applySSHPassword(ctx, s, emit)
		default:
			err = applyAccountOption(ctx, s, m, emit)
		}
		if err != nil {
			emit("error: " + err.Error() + "\n")
			failed = append(failed, m)
			if m == "user" {
				return 1, fmt.Errorf("user setup failed, nothing else applied: %w", err)
			}
		}
	}
	if len(failed) > 0 {
		return 1, fmt.Errorf("failed: %s", strings.Join(failed, ", "))
	}
	emit("\ndone\n")
	return 0, nil
}

// --- check ---------------------------------------------------------------------------

func checkFile(p, want string) (string, string) {
	cur, ok := readFile(p)
	switch {
	case want == "" && ok:
		return "drift", p + " present"
	case want == "":
		return "ok", ""
	case !ok:
		return "drift", p + " absent"
	case cur != want:
		return "drift", p + " modified"
	}
	return "ok", ""
}

func checkBashrc(s *SetupSpec, prefix string, a *account) (string, string) {
	p := filepath.Join(a.home, ".bashrc")
	cur, _ := readFile(p)
	if s.accountBlock(cur, prefix) != cur {
		return "drift", p + " does not load the Homelab Manager block"
	}
	return "ok", ""
}

// checkStyle checks the script of a style and its package.
func checkStyle(ctx context.Context, dir, style, content string) (string, string) {
	if pkg := stylePackage(style); pkg != "" && len(missingPackages(ctx, []string{pkg})) > 0 {
		return "drift", pkg + " not installed"
	}
	if content == "" {
		return "ok", ""
	}
	return checkFile(stylePath(dir, style), content)
}

func checkModule(ctx context.Context, s *SetupSpec, m string) SetupCheck {
	c := SetupCheck{Module: m, State: "ok"}
	set := func(state, detail string) {
		if c.State == "ok" {
			c.State, c.Detail = state, detail
		}
	}
	switch m {
	case "user":
		name := s.userName()
		if _, err := user.Lookup(name); err != nil {
			set("drift", "user "+name+" absent")
			break
		}
		have := userGroups(name)
		var miss []string
		for _, g := range wantedGroups() {
			if !have[g] {
				miss = append(miss, g)
			}
		}
		if len(miss) > 0 {
			set("drift", "not in group "+strings.Join(miss, ", "))
		}
		want := ""
		if s.User.SudoNoPassword {
			want = sudoersContent(name)
		}
		set(checkFile(sudoersFile, want))
	case "packages":
		if miss := missingPackages(ctx, s.Packages); len(miss) > 0 {
			sort.Strings(miss)
			set("drift", "missing: "+strings.Join(miss, " "))
		}
	case "ssh_password":
		sshd := sshdBinary()
		if sshd == "" {
			c.State, c.Detail = "na", "no SSH server"
			return c
		}
		ensureSshdRunDir()
		out, err := exec.CommandContext(ctx, sshd, "-T").Output()
		if err != nil {
			c.State, c.Detail = "error", "sshd -T failed"
			return c
		}
		want := "no"
		if s.AllowPassword {
			want = "yes"
		}
		got := ""
		for _, l := range strings.Split(string(out), "\n") {
			if v, ok := strings.CutPrefix(l, "passwordauthentication "); ok {
				got = strings.TrimSpace(v)
			}
		}
		if got != want {
			set("drift", "PasswordAuthentication "+got)
		}
	default:
		prefix, opt, _ := strings.Cut(m, "_")
		a := s.account(prefix)
		if a == nil {
			set("drift", "account "+s.userName()+" absent")
			break
		}
		acc := s.section(prefix)
		switch opt {
		case "keys":
			p := filepath.Join(a.home, ".ssh", "authorized_keys")
			cur, _ := readFile(p)
			if n := len(missingKeys(cur, acc.SSHKeys)); n > 0 {
				set("drift", fmt.Sprintf("%s: %d key(s) missing", p, n))
			}
			return c
		case "aliases":
			set(checkFile(filepath.Join(a.home, ".bash_aliases"), aliasesContent(acc.Aliases)))
		case "prompt":
			set(checkStyle(ctx, promptDir, acc.Prompt, renderPrompt(acc.Prompt)))
			if acc.Prompt == "starship" {
				set(checkFile(starshipFile, renderStarship(s)))
			}
		case "motd":
			set(checkStyle(ctx, motdDir, acc.Motd, renderMotd(acc.Motd)))
			if acc.Motd == "fastfetch" {
				set(checkFile(fastfetchFile, renderFastfetch(s)))
			}
		}
		set(checkBashrc(s, prefix, a))
	}
	return c
}

func checkSetup(ctx context.Context, s *SetupSpec) (*SetupReport, error) {
	if err := validateSetup(s); err != nil {
		return nil, err
	}
	r := &SetupReport{CheckedAt: time.Now().UnixMilli(), User: s.userName(), Modules: []SetupCheck{}}
	for _, m := range setupModules {
		if s.has(m) {
			r.Modules = append(r.Modules, checkModule(ctx, s, m))
		}
	}
	return r, nil
}

// --- welcome screen counters ------------------------------------------------------------

// writeMotdEnv refreshes the counters of the welcome screen, only where it is installed and only
// when they change. Readable by every user: counts only.
func writeMotdEnv() {
	if _, ok := readFile(stylePath(motdDir, "homelab")); !ok {
		return
	}
	c := motdState.snapshot()
	content := renderMotdEnv(c)
	if cur, ok := readFile(motdEnvFile); ok && cur == content {
		return
	}
	_ = writeOwned(motdEnvFile, content, 0o644, nil)
}

// last known counters, fed by the apt and docker reports
type motdStore struct {
	mu sync.Mutex
	c  motdCounters
}

var motdState = &motdStore{}

func (m *motdStore) setApt(r *AptReport) {
	m.mu.Lock()
	m.c.hasApt = true
	m.c.updates, m.c.security = len(r.Upgradable), 0
	for _, p := range r.Upgradable {
		if p.Security {
			m.c.security++
		}
	}
	m.c.reboot = r.RebootRequired
	m.mu.Unlock()
	writeMotdEnv()
}

func (m *motdStore) setDocker(r *DockerReport) {
	m.mu.Lock()
	m.c.hasDocker = true
	m.c.containers, m.c.running = 0, 0
	for _, st := range r.Stacks {
		for _, sv := range st.Services {
			for _, c := range sv.Containers {
				m.c.containers++
				if c.State == "running" {
					m.c.running++
				}
			}
		}
	}
	m.mu.Unlock()
	writeMotdEnv()
}

func (m *motdStore) snapshot() motdCounters {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.c
}
