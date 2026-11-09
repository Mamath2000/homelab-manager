//go:build !windows

package main

import (
	"encoding/pem"
	"strings"
	"testing"
)

func TestReadInstallInput(t *testing.T) {
	ca := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: newTestCA(t).cert.Raw}))
	admin := newTestSigner(t, "admin").pub
	anchor := `{"signers":["` + admin + `"],"tofuUntil":9999999999}`
	code, got, a, err := readInstallInput(strings.NewReader(testCode + "\n" + ca + "\n" + anchor + "\n"))
	if err != nil || code != testCode || string(got) != ca {
		t.Fatalf("code %q, ca %q, err %v", code, got, err)
	}
	// the handed anchor never opens a window
	if len(a.Signers) != 1 || a.Signers[0] != admin || a.TofuUntil != 0 {
		t.Fatalf("anchor %+v", a)
	}
	for name, in := range map[string]string{
		"empty":          "",
		"no CA":          testCode + "\n",
		"bad code":       "abc'; rm -rf /\n" + ca + anchor,
		"bad CA":         testCode + "\n" + installCA + anchor,
		"no anchor":      testCode + "\n" + ca,
		"no signers":     testCode + "\n" + ca + `{"signers":[],"tofuUntil":9999999999}`,
		"bad signer":     testCode + "\n" + ca + `{"signers":["ssh-ed25519 !!!"]}`,
		"garbage anchor": testCode + "\n" + ca + "{",
	} {
		if _, _, _, err := readInstallInput(strings.NewReader(in)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
