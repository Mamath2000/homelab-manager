package main

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

// cases shared with hub/test/calendar.test.ts
type calendarCases struct {
	Runs []struct {
		Expr string `json:"expr"`
		TZ   string `json:"tz"`
		At   string `json:"at"`
		Prev string `json:"prev"`
		Next string `json:"next"`
	} `json:"runs"`
	Invalid []string `json:"invalid"`
}

func TestCalendarSharedCases(t *testing.T) {
	raw, err := os.ReadFile("../testdata/calendar.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases calendarCases
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases.Runs {
		spec, err := parseCalendar(c.Expr)
		if err != nil {
			t.Fatalf("%q: %v", c.Expr, err)
		}
		loc, err := time.LoadLocation(c.TZ)
		if err != nil {
			t.Fatal(err)
		}
		at, _ := time.Parse(time.RFC3339, c.At)
		prev, _ := time.Parse(time.RFC3339, c.Prev)
		next, _ := time.Parse(time.RFC3339, c.Next)
		if got := spec.previous(at, loc); !got.Equal(prev) {
			t.Errorf("%q previous(%s) = %s, want %s", c.Expr, c.At, got.UTC(), prev)
		}
		if got := spec.next(at, loc); !got.Equal(next) {
			t.Errorf("%q next(%s) = %s, want %s", c.Expr, c.At, got.UTC(), next)
		}
	}
	for _, e := range cases.Invalid {
		if _, err := parseCalendar(e); err == nil {
			t.Errorf("%q accepted", e)
		}
	}
}
