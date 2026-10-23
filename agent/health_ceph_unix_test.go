//go:build !windows

package main

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// answers of ceph on pve1 of vouille (2026-10-23), trimmed
var cephAnswers = map[string]string{
	"status": `{"fsid":"8b1c0e2a-0000-4000-8000-000000000001","health":{"status":"HEALTH_WARN"},
		"osdmap":{"epoch":31557,"num_osds":3,"num_up_osds":3,"num_in_osds":3},
		"pgmap":{"num_pgs":33,"pgs_by_state":[{"state_name":"active+clean","count":33}],"bytes_used":1284699860992,"bytes_total":3000558944256}}`,
	"health detail": `{"status":"HEALTH_WARN","checks":{"BLUESTORE_SLOW_OP_ALERT":{"severity":"HEALTH_WARN",
		"summary":{"message":"2 OSD(s) experiencing slow operations in BlueStore","count":2},
		"detail":[{"message":" osd.2 observed slow operation indications in BlueStore"},{"message":" osd.3 observed slow operation indications in BlueStore"}],"muted":false}},"mutes":[]}`,
	"osd tree": `{"nodes":[{"id":-1,"name":"default","type":"root","children":[-2,-5,-7]},
		{"id":-2,"name":"pve1","type":"host","children":[2]},{"id":2,"name":"osd.2","type":"osd","status":"up","reweight":1},
		{"id":-5,"name":"pve2","type":"host","children":[1]},{"id":1,"name":"osd.1","type":"osd","status":"up","reweight":1},
		{"id":-7,"name":"pve4","type":"host","children":[3]},{"id":3,"name":"osd.3","type":"osd","status":"down","reweight":0}]}`,
}

func cephRun(_ context.Context, bin string, args ...string) (string, error) {
	cmd := strings.TrimSuffix(strings.Join(args, " "), " --format json")
	if out, ok := cephAnswers[cmd]; ok && bin == "ceph" {
		return out, nil
	}
	return "", errors.New("unexpected " + bin + " " + cmd)
}

func TestCollectHealthCeph(t *testing.T) {
	c := collectHealthCeph(context.Background(), cephRun, "pve4")
	if c.Error != "" || c.Fsid == "" || c.Status != "HEALTH_WARN" || c.OsdsTotal != 3 || c.Pgs != 33 || c.PgsClean != 33 || c.TotalBytes == 0 {
		t.Fatalf("ceph = %+v", c)
	}
	if len(c.Checks) != 1 || c.Checks[0].Code != "BLUESTORE_SLOW_OP_ALERT" || len(c.Checks[0].Detail) != 2 || c.Checks[0].Detail[0] != "osd.2 observed slow operation indications in BlueStore" {
		t.Fatalf("checks = %+v", c.Checks)
	}
	// only the OSDs of this node
	if len(c.Osds) != 1 || c.Osds[0].ID != 3 || c.Osds[0].Up || c.Osds[0].In {
		t.Fatalf("osds = %+v", c.Osds)
	}
	if c := collectHealthCeph(context.Background(), cephRun, "pve3"); len(c.Osds) != 0 {
		t.Fatalf("pve3 osds = %+v", c.Osds)
	}
}

func TestCollectHealthCephUnreachable(t *testing.T) {
	run := func(context.Context, string, ...string) (string, error) {
		return "", errors.New("ceph status: signal: killed: ")
	}
	c := collectHealthCeph(context.Background(), run, "pve1")
	if c.Error == "" || c.Status != "" || c.Checks == nil || c.Osds == nil {
		t.Fatalf("ceph = %+v", c)
	}
}
