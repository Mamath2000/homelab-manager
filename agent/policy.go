package main

// Local policy of the host (/etc/homelab-agent/policy.json): what this agent accepts from its hub, beyond the
// checks of form. It is written by root on the host (the installer puts strict defaults on a new install) and the
// hub has no way to change it, so a compromised hub or admin account cannot use the legitimate features
// (backups, agent installs from a PVE node) to take the host over.
//
// No file: the behaviour of the agents installed before the policy existed (everything the hub asks is accepted),
// except for the client image of the backups, always checked (backupImageAllowed).

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

const policyFile = "policy.json"

var policyFingerprintRe = regexp.MustCompile(`^[0-9A-F]{2}(:[0-9A-F]{2}){31}$`)

type BackupPolicy struct {
	// directories never backed up: an archive inside one is refused, an archive above one leaves it out
	Deny []string `json:"deny"`
	// PBS the backups may go to, by certificate fingerprint; empty with PinPBS: the first one used is kept
	PBSFingerprints []string `json:"pbsFingerprints"`
	PinPBS          bool     `json:"pinPbs"`
	// client images allowed besides the ones built into this agent (repository@sha256:… preferably)
	Images []string `json:"images"`
}

type Policy struct {
	// agent installs in the CTs or on the other nodes of this PVE node
	AgentInstall *bool        `json:"agentInstall"`
	Backup       BackupPolicy `json:"backup"`

	source  string // the file, "" for the defaults of an agent without policy
	invalid bool   // unreadable or invalid file: closedPolicy
}

// Strict policy written by the installer on a new install.
func strictPolicy() Policy {
	yes := true
	return Policy{
		AgentInstall: &yes,
		Backup: BackupPolicy{
			Deny:            []string{"/etc/shadow", "/etc/gshadow", "/etc/ssh", "/root/.ssh", "/etc/homelab-agent", "/var/run/docker.sock", "/run/docker.sock"},
			PBSFingerprints: []string{},
			PinPBS:          true,
			Images:          []string{},
		},
	}
}

// What an agent without policy file accepts: everything, as before the policy existed.
func legacyPolicy() Policy {
	yes := true
	return Policy{AgentInstall: &yes}
}

// A policy that cannot be read refuses what it would have to allow.
func closedPolicy(source string) Policy {
	no := false
	return Policy{AgentInstall: &no, Backup: BackupPolicy{PinPBS: true, Deny: strictPolicy().Backup.Deny}, source: source, invalid: true}
}

// agentDir is the directory of the agent identity (set by main), where the policy lives.
var agentDir = defaultDir

func policyPath() string { return filepath.Join(agentDir, policyFile) }

// currentPolicy reads the policy at each use: an edit on the host applies without restarting the agent.
func currentPolicy() Policy { return loadPolicy(policyPath()) }

func loadPolicy(file string) Policy {
	raw, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return legacyPolicy()
	}
	if err != nil {
		log.Printf("policy %s unreadable (%v): everything it governs is refused", file, err)
		return closedPolicy(file)
	}
	p, err := parsePolicy(raw)
	if err != nil {
		log.Printf("policy %s invalid (%v): everything it governs is refused", file, err)
		return closedPolicy(file)
	}
	p.source = file
	return p
}

func parsePolicy(raw []byte) (Policy, error) {
	var p Policy
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		return p, err
	}
	if p.AgentInstall == nil {
		no := false
		p.AgentInstall = &no
	}
	for _, d := range p.Backup.Deny {
		if !path.IsAbs(d) || path.Clean(d) != d {
			return p, fmt.Errorf("backup.deny: %q is not an absolute clean path", d)
		}
	}
	for i, f := range p.Backup.PBSFingerprints {
		f = strings.ToUpper(strings.TrimSpace(f))
		if !policyFingerprintRe.MatchString(f) {
			return p, fmt.Errorf("backup.pbsFingerprints: %q", f)
		}
		p.Backup.PBSFingerprints[i] = f
	}
	for _, img := range p.Backup.Images {
		if !imageRe.MatchString(img) {
			return p, fmt.Errorf("backup.images: %q", img)
		}
	}
	return p, nil
}

// label for the logs and the errors: where the rule comes from
func (p Policy) where() string {
	if p.source == "" {
		return "politique par défaut de l'agent"
	}
	return "politique locale " + p.source
}

// writePolicyIfAbsent puts the strict policy on a new install; an existing file is kept as it is.
func writePolicyIfAbsent(dir string) (bool, error) {
	file := filepath.Join(dir, policyFile)
	if _, err := os.Stat(file); err == nil {
		return false, nil
	}
	raw, _ := json.MarshalIndent(strictPolicy(), "", "  ")
	return true, writeFileAtomic(file, append(raw, '\n'), 0o644)
}

// PolicyReport: the policy as the hub shows it (hello), with the PBS pinned on this host. Read only: the hub
// cannot change any of it, unpinning is done on the host (pinFile).
type PolicyReport struct {
	File            string   `json:"file"` // "": no local policy, everything is accepted
	Invalid         bool     `json:"invalid,omitempty"`
	AgentInstall    bool     `json:"agentInstall"`
	Deny            []string `json:"deny"`
	PBSFingerprints []string `json:"pbsFingerprints"`
	PinPBS          bool     `json:"pinPbs"`
	PinnedPBS       string   `json:"pinnedPbs,omitempty"`
	PinFile         string   `json:"pinFile"`
}

func (p Policy) report(pinFile string) *PolicyReport {
	r := &PolicyReport{File: p.source, Invalid: p.invalid, AgentInstall: p.agentInstallAllowed(), Deny: p.Backup.Deny,
		PBSFingerprints: p.Backup.PBSFingerprints, PinPBS: p.Backup.PinPBS, PinFile: pinFile}
	if r.Deny == nil {
		r.Deny = []string{}
	}
	if r.PBSFingerprints == nil {
		r.PBSFingerprints = []string{}
	}
	if raw, err := os.ReadFile(pinFile); err == nil {
		r.PinnedPBS = strings.TrimSpace(string(raw))
	}
	return r
}

// --- agent installs ----------------------------------------------------------------------------

func (p Policy) agentInstallAllowed() bool { return p.AgentInstall != nil && *p.AgentInstall }

// --- backups -----------------------------------------------------------------------------------

// within: p is dir or below it
func within(p, dir string) bool {
	return p == dir || dir == "/" || strings.HasPrefix(p, dir+"/")
}

// backupExclusions checks the archives of a job against backup.deny: an archive inside a denied directory is
// refused, a denied directory inside an archive is left out (exclusion relative to the archive root, the form of
// proxmox-backup-client).
func (p Policy) backupExclusions(archives []BackupArchive) ([]string, error) {
	var out []string
	for _, a := range archives {
		for _, d := range p.Backup.Deny {
			if within(a.Path, d) {
				return nil, fmt.Errorf("%s : %s ne peut pas être sauvegardé (%s)", a.Name, a.Path, p.where())
			}
			if within(d, a.Path) {
				rel := strings.TrimPrefix(d, strings.TrimSuffix(a.Path, "/"))
				out = append(out, rel)
			}
		}
	}
	return out, nil
}

// pbsAllowed checks the fingerprint of the PBS a backup goes to; with pinPbs and no list, the first PBS used is
// recorded in pinFile and only that one is accepted afterwards.
func (p Policy) pbsAllowed(fingerprint, server, pinFile string) error {
	fp := strings.ToUpper(strings.TrimSpace(fingerprint))
	if fp == "" {
		// certificate of a public CA: the PBS is known by its address
		fp = "server " + server
	}
	if len(p.Backup.PBSFingerprints) > 0 {
		if slices.Contains(p.Backup.PBSFingerprints, fp) {
			return nil
		}
		return fmt.Errorf("PBS %s absent de backup.pbsFingerprints (%s)", fp, p.where())
	}
	if !p.Backup.PinPBS {
		return nil
	}
	raw, err := os.ReadFile(pinFile)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(filepath.Dir(pinFile), 0o700); err != nil {
			return err
		}
		if err := writeFileAtomic(pinFile, []byte(fp+"\n"), 0o600); err != nil {
			return err
		}
		log.Printf("backups: PBS %s pinned (%s)", fp, pinFile)
		return nil
	}
	if err != nil {
		return err
	}
	if pinned := strings.TrimSpace(string(raw)); pinned != fp {
		return fmt.Errorf("PBS %s différent du PBS épinglé %s : pour changer de PBS, supprimer %s sur l'hôte ou lister le nouveau dans backup.pbsFingerprints (%s)", fp, pinned, pinFile, p.where())
	}
	return nil
}

// trustedClientImages: client images built into a release agent (-X main.trustedClientImages=a,b), by digest.
// Empty in development builds: any image is then accepted, as before.
var trustedClientImages string

// backupImageAllowed: the client image of the backups is one built into this agent or allowed by the policy.
func (p Policy) backupImageAllowed(image string) error {
	if trustedClientImages == "" {
		return nil
	}
	for _, t := range strings.Split(trustedClientImages, ",") {
		if strings.TrimSpace(t) == image {
			return nil
		}
	}
	if slices.Contains(p.Backup.Images, image) {
		return nil
	}
	return fmt.Errorf("image du client %s non autorisée sur cet hôte : l'ajouter à backup.images de %s", image, policyPath())
}

// defaultTrustedImage: the client image used when the hub names none.
func defaultTrustedImage(fallback string) string {
	if first, _, _ := strings.Cut(trustedClientImages, ","); strings.TrimSpace(first) != "" {
		return strings.TrimSpace(first)
	}
	return fallback
}
