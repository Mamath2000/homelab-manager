package main

import (
	"strings"
	"testing"
)

func TestReadCode(t *testing.T) {
	for in, want := range map[string]string{
		"abc-_09\n":          "abc-_09",
		"abc-_09":            "abc-_09",
		"  abc\r\nignored\n": "abc",
		"":                   "",
	} {
		got, err := readCode(strings.NewReader(in))
		if err != nil || got != want {
			t.Errorf("readCode(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
}
