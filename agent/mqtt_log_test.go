//go:build !windows

package main

import (
	"strings"
	"testing"
)

func TestLogFileOf(t *testing.T) {
	conf := []confLine{{"m", "log_dest", "stdout"}, {"m", "log_dest", "file /var/log/mosquitto/mosquitto.log"}, {"m", "log_dest", "topic"}}
	if got := logFileOf(conf); got != "/var/log/mosquitto/mosquitto.log" {
		t.Fatal(got)
	}
	if got := logFileOf([]confLine{{"m", "log_dest", "topic"}}); got != "" {
		t.Fatal(got)
	}
}

func TestTailLines(t *testing.T) {
	data := "one\ntwo\nthree\nfour\n"
	got, err := tailLines(strings.NewReader(data), int64(len(data)), 1000, 2)
	if err != nil || strings.Join(got, ",") != "three,four" {
		t.Fatalf("%v %v", got, err)
	}
	// a window that starts in the middle of a line drops the partial first line
	got, _ = tailLines(strings.NewReader(data), int64(len(data)), 10, 10)
	if strings.Join(got, ",") != "four" {
		t.Fatalf("partial: %v", got)
	}
}
