//go:build !windows

package main

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
)

// fakePbs answers like proxmox-backup-manager; calls records the commands.
type fakePbs struct {
	users, tokens []string
	stores        []string
	acls          [][3]string // path, role, auth id
	failOn        string      // commands with this prefix fail
	calls         []string
}

func newFakePbs() *fakePbs { return &fakePbs{stores: []string{"ds0", "ds1"}} }

func (f *fakePbs) run(_ context.Context, args ...string) (string, error) {
	cmd := strings.Join(args, " ")
	f.calls = append(f.calls, cmd)
	if f.failOn != "" && strings.HasPrefix(cmd, f.failOn) {
		return "", fmt.Errorf("%s: failed", cmd)
	}
	switch {
	case strings.HasPrefix(cmd, "acl list"):
		var b []string
		for _, a := range f.acls {
			b = append(b, fmt.Sprintf(`{"path":%q,"roleid":%q,"ugid":%q,"ugid_type":"user","propagate":true}`, a[0], a[1], a[2]))
		}
		return "[" + strings.Join(b, ",") + "]", nil
	case strings.HasPrefix(cmd, "user list-tokens"):
		var b []string
		for _, t := range f.tokens {
			if strings.HasPrefix(t, args[2]+"!") {
				b = append(b, fmt.Sprintf(`{"tokenid":%q}`, t))
			}
		}
		return "[" + strings.Join(b, ",") + "]", nil
	case strings.HasPrefix(cmd, "user delete-token"):
		f.tokens = slices.DeleteFunc(f.tokens, func(t string) bool { return t == args[2]+"!"+args[3] })
	case strings.HasPrefix(cmd, "user remove"):
		f.users = slices.DeleteFunc(f.users, func(u string) bool { return u == args[2] })
	case strings.HasPrefix(cmd, "user list"):
		var b []string
		for _, u := range f.users {
			b = append(b, fmt.Sprintf(`{"userid":%q}`, u))
		}
		return "[" + strings.Join(b, ",") + "]", nil
	case strings.HasPrefix(cmd, "datastore list"):
		var b []string
		for _, st := range f.stores {
			b = append(b, fmt.Sprintf(`{"name":%q}`, st))
		}
		return "[" + strings.Join(b, ",") + "]", nil
	case strings.HasPrefix(cmd, "user generate-token"):
		// the user id looks like a UUID too: only "value" holds the secret
		return `Result: {"tokenid":"0b1c2d3e-aaaa-2222-3333-444455556666@pbs!x","value":"0b1c2d3e-1111-2222-3333-444455556666"}`, nil
	}
	return "", nil
}

func TestEnsurePbsTokenCreates(t *testing.T) {
	f := newFakePbs()
	r, err := ensurePbsToken(context.Background(), f.run, &PbsTokenSpec{
		User: "host-x4@pbs", Token: "backup",
		ACLs: []PbsACL{{Path: "/datastore/{store}/Hosts", Role: "DatastoreBackup"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !r.Created || r.Secret != "0b1c2d3e-1111-2222-3333-444455556666" || r.TokenID != "host-x4@pbs!backup" {
		t.Fatalf("result %+v", r)
	}
	// user AND token, on every datastore
	want := []string{
		"acl update /datastore/ds0/Hosts DatastoreBackup --auth-id host-x4@pbs",
		"acl update /datastore/ds0/Hosts DatastoreBackup --auth-id host-x4@pbs!backup",
		"acl update /datastore/ds1/Hosts DatastoreBackup --auth-id host-x4@pbs",
		"acl update /datastore/ds1/Hosts DatastoreBackup --auth-id host-x4@pbs!backup",
	}
	got := strings.Join(f.calls, "\n")
	for _, w := range want {
		if !strings.Contains(got, w) {
			t.Errorf("missing call %q in\n%s", w, got)
		}
	}
}

func TestEnsurePbsTokenExisting(t *testing.T) {
	f := newFakePbs()
	f.users, f.tokens = []string{"homelab@pbs"}, []string{"homelab@pbs!monitor"}
	r, err := ensurePbsToken(context.Background(), f.run, &PbsTokenSpec{
		User: "homelab@pbs", Token: "monitor", ACLs: []PbsACL{{Path: "/datastore", Role: "DatastoreAudit"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if r.Created || r.Secret != "" {
		t.Fatalf("existing token must not return a secret: %+v", r)
	}
	for _, c := range f.calls {
		if strings.HasPrefix(c, "user create") || strings.HasPrefix(c, "user generate-token") {
			t.Errorf("unexpected call %q", c)
		}
	}
}

func TestEnsurePbsTokenRotates(t *testing.T) {
	f := newFakePbs()
	f.users, f.tokens = []string{"homelab@pbs"}, []string{"homelab@pbs!monitor"}
	r, err := ensurePbsToken(context.Background(), f.run, &PbsTokenSpec{
		User: "homelab@pbs", Token: "monitor", Rotate: true, ACLs: []PbsACL{{Path: "/datastore", Role: "DatastoreAudit"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !r.Created || !r.Rotated || r.Secret == "" {
		t.Fatalf("rotated token must return a new secret: %+v", r)
	}
	got := strings.Join(f.calls, "\n")
	if !strings.Contains(got, "user delete-token homelab@pbs monitor\nuser generate-token homelab@pbs monitor") {
		t.Fatalf("token not created again:\n%s", got)
	}
}

func TestEnsurePbsTokenPrunesTokenACLs(t *testing.T) {
	f := newFakePbs()
	f.users, f.tokens = []string{"homelab@pbs"}, []string{"homelab@pbs!monitor"}
	f.acls = [][3]string{
		{"/", "DatastoreAudit", "homelab@pbs!monitor"},          // former right: removed
		{"/datastore", "DatastoreAudit", "homelab@pbs!monitor"}, // still asked for: kept
		{"/", "DatastoreAudit", "homelab@pbs"},                  // user's: left alone
		{"/", "DatastoreAudit", "homelab@pbs!other"},            // another token: left alone
	}
	r, err := ensurePbsToken(context.Background(), f.run, &PbsTokenSpec{
		User: "homelab@pbs", Token: "monitor", ACLs: []PbsACL{{Path: "/datastore", Role: "DatastoreAudit"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var deletes []string
	for _, c := range f.calls {
		if strings.HasSuffix(c, "--delete true") {
			deletes = append(deletes, c)
		}
	}
	if len(deletes) != 1 || deletes[0] != "acl update / DatastoreAudit --auth-id homelab@pbs!monitor --delete true" {
		t.Fatalf("deletes %q", deletes)
	}
	if len(r.Removed) != 1 {
		t.Fatalf("removed %q", r.Removed)
	}
}

func TestDeletePbsTokenKeepsUserWithOtherToken(t *testing.T) {
	f := newFakePbs()
	f.users, f.tokens = []string{"homelab@pbs"}, []string{"homelab@pbs!monitor", "homelab@pbs!reader"}
	f.acls = [][3]string{
		{"/datastore", "DatastoreAudit", "homelab@pbs!monitor"}, // the token's: removed
		{"/datastore", "DatastoreAudit", "homelab@pbs"},         // user's: kept (other token)
		{"/datastore", "DatastoreReader", "homelab@pbs!reader"}, // other token: kept
	}
	r, err := deletePbsToken(context.Background(), f.run, &PbsTokenSpec{User: "homelab@pbs", Token: "monitor"})
	if err != nil {
		t.Fatal(err)
	}
	if !r.Deleted || r.UserDeleted || len(r.Removed) != 1 {
		t.Fatalf("result %+v", r)
	}
	got := strings.Join(f.calls, "\n")
	if !strings.Contains(got, "acl update /datastore DatastoreAudit --auth-id homelab@pbs!monitor --delete true") || !strings.Contains(got, "user delete-token homelab@pbs monitor") {
		t.Fatalf("calls:\n%s", got)
	}
	if strings.Contains(got, "user remove") || strings.Contains(got, "--auth-id homelab@pbs --delete") {
		t.Fatalf("user touched:\n%s", got)
	}
}

func TestDeletePbsTokenRemovesLastUser(t *testing.T) {
	f := newFakePbs()
	f.users, f.tokens = []string{"host-x4@pbs"}, []string{"host-x4@pbs!backup"}
	f.acls = [][3]string{
		{"/datastore/ds0/Hosts", "DatastoreBackup", "host-x4@pbs!backup"},
		{"/datastore/ds0/Hosts", "DatastoreBackup", "host-x4@pbs"},
	}
	r, err := deletePbsToken(context.Background(), f.run, &PbsTokenSpec{User: "host-x4@pbs", Token: "backup"})
	if err != nil {
		t.Fatal(err)
	}
	if !r.Deleted || !r.UserDeleted || len(r.Removed) != 2 {
		t.Fatalf("result %+v", r)
	}
	if last := f.calls[len(f.calls)-1]; last != "user remove host-x4@pbs" {
		t.Fatalf("last call %q", last)
	}
}

func TestDeletePbsTokenAlreadyGone(t *testing.T) {
	f := newFakePbs()
	r, err := deletePbsToken(context.Background(), f.run, &PbsTokenSpec{User: "homelab@pbs", Token: "monitor"})
	if err != nil || r.Deleted || r.UserDeleted {
		t.Fatalf("result %+v, %v", r, err)
	}
	if len(f.calls) != 1 {
		t.Fatalf("calls %q", f.calls)
	}
	if _, err := deletePbsToken(context.Background(), f.run, &PbsTokenSpec{User: "root@pam", Token: "x"}); err == nil {
		t.Fatal("root@pam accepted")
	}
}

func TestEnsurePbsTokenRollsBackOnFailure(t *testing.T) {
	f := newFakePbs()
	f.failOn = "acl update"
	r, err := ensurePbsToken(context.Background(), f.run, &PbsTokenSpec{
		User: "host-x4@pbs", Token: "backup", ACLs: []PbsACL{{Path: "/datastore/{store}/Hosts", Role: "DatastoreBackup"}},
	})
	if err == nil || r != nil {
		t.Fatalf("expected an error and no result: %+v %v", r, err)
	}
	if last := f.calls[len(f.calls)-1]; last != "user delete-token host-x4@pbs backup" {
		t.Fatalf("token not deleted, last call %q", last)
	}
}

func TestEnsurePbsTokenNoDatastore(t *testing.T) {
	f := newFakePbs()
	f.stores = nil
	if _, err := ensurePbsToken(context.Background(), f.run, &PbsTokenSpec{
		User: "host-x4@pbs", Token: "backup", ACLs: []PbsACL{{Path: "/datastore/{store}/Hosts", Role: "DatastoreBackup"}},
	}); err == nil {
		t.Fatal("token created without any right")
	}
	for _, c := range f.calls {
		if strings.HasPrefix(c, "user generate-token") || strings.HasPrefix(c, "user create") {
			t.Errorf("unexpected call %q", c)
		}
	}
}

func TestValidatePbsToken(t *testing.T) {
	ok := func() *PbsTokenSpec {
		return &PbsTokenSpec{User: "a@pbs", Token: "t1", ACLs: []PbsACL{{Path: "/datastore/ds9", Role: "DatastoreBackup"}, {Path: "/remote", Role: "RemoteAdmin"}}}
	}
	if err := validatePbsToken(ok()); err != nil {
		t.Fatal(err)
	}
	bad := map[string]func(s *PbsTokenSpec){
		"user realm":     func(s *PbsTokenSpec) { s.User = "a@pam" },
		"user injection": func(s *PbsTokenSpec) { s.User = "a b@pbs" },
		"token":          func(s *PbsTokenSpec) { s.Token = "1x" },
		"role":           func(s *PbsTokenSpec) { s.ACLs[0].Role = "Admin" },
		"system path":    func(s *PbsTokenSpec) { s.ACLs[0].Path = "/system" },
		"root path":      func(s *PbsTokenSpec) { s.ACLs[0].Path = "/" },
		"role on path":   func(s *PbsTokenSpec) { s.ACLs[1].Path = "/datastore" },
		"path traversal": func(s *PbsTokenSpec) { s.ACLs[0].Path = "/datastore/../x" },
		"container":      func(s *PbsTokenSpec) { s.Container = "a;b" },
		"empty":          func(s *PbsTokenSpec) { s.ACLs = nil },
	}
	for name, mut := range bad {
		s := ok()
		mut(s)
		if validatePbsToken(s) == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestParsePbsPort(t *testing.T) {
	out := `LISTEN 0 4096 127.0.0.1:82 0.0.0.0:* users:(("proxmox-backup-",pid=900,fd=14))
LISTEN 0 4096 *:8007 *:* users:(("proxmox-backup-",pid=901,fd=17))
LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))`
	if p := parsePbsPort(out); p != 8007 {
		t.Fatalf("port = %d, want 8007", p)
	}
	if p := parsePbsPort(`LISTEN 0 4096 [::]:8443 [::]:* users:(("proxmox-backup-",pid=901,fd=17))`); p != 8443 {
		t.Fatalf("port = %d, want 8443", p)
	}
	if p := parsePbsPort(`LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))`); p != 0 {
		t.Fatalf("port = %d, want 0", p)
	}
}
