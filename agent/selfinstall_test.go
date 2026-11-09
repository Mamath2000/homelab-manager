//go:build !windows

package main

import (
	"encoding/pem"
	"strings"
	"testing"
)

func TestReadInstallInput(t *testing.T) {
	ca := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: newTestCA(t).cert.Raw}))
	code, got, err := readInstallInput(strings.NewReader(testCode + "\n" + ca))
	if err != nil || code != testCode || string(got) != ca {
		t.Fatalf("code %q, ca %q, err %v", code, got, err)
	}
	for name, in := range map[string]string{
		"empty":    "",
		"no CA":    testCode + "\n",
		"bad code": "abc'; rm -rf /\n" + ca,
		"bad CA":   testCode + "\n" + installCA,
	} {
		if _, _, err := readInstallInput(strings.NewReader(in)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
