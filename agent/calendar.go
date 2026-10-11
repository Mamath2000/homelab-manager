package main

import (
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"
	// time zones of the schedules even where the system has no tzdata (Unraid, minimal images)
	_ "time/tzdata"
)

// Calendar events of the backup schedules, the subset of the Proxmox / systemd syntax the hub
// understands: [WEEKDAYS] [[HOURS:]MINUTES], or minutely, hourly, daily, weekly, monthly.
// Same grammar as hub/src/calendar.ts; shared cases in testdata/calendar.json.
type calendarSpec struct {
	weekdays  map[time.Weekday]bool // nil: every day
	monthDays map[int]bool          // nil: every day
	hours     []int
	minutes   []int
}

var weekdayNames = []string{"sun", "mon", "tue", "wed", "thu", "fri", "sat"}

var calendarKeywords = map[string]string{
	"minutely": "*:*",
	"hourly":   "*:0",
	"daily":    "0:0",
	"weekly":   "mon 0:0",
}

var errCalendar = errors.New("unsupported calendar event")

func parseComponent(s string, max int) ([]int, error) {
	set := map[int]bool{}
	for _, part := range strings.Split(s, ",") {
		base, stepS, hasStep := strings.Cut(part, "/")
		step := 1
		if hasStep {
			v, err := strconv.Atoi(stepS)
			if err != nil || v < 1 || len(stepS) > 2 {
				return nil, errCalendar
			}
			step = v
		}
		fromS, toS, isRange := strings.Cut(base, "..")
		var from, to int
		if fromS == "*" {
			if isRange {
				return nil, errCalendar
			}
			from, to = 0, max
		} else {
			v, err := strconv.Atoi(fromS)
			if err != nil || len(fromS) > 2 {
				return nil, errCalendar
			}
			from, to = v, v
			if hasStep {
				to = max
			}
			if isRange {
				t, err := strconv.Atoi(toS)
				if err != nil || len(toS) > 2 {
					return nil, errCalendar
				}
				to = t
			}
		}
		if from > max || to > max || from > to {
			return nil, errCalendar
		}
		for v := from; v <= to; v += step {
			set[v] = true
		}
	}
	out := make([]int, 0, len(set))
	for v := range set {
		out = append(out, v)
	}
	sort.Ints(out)
	return out, nil
}

func indexOf(list []string, s string) int {
	for i, v := range list {
		if v == s {
			return i
		}
	}
	return -1
}

func parseWeekdays(s string) (map[time.Weekday]bool, error) {
	out := map[time.Weekday]bool{}
	for _, part := range strings.Split(s, ",") {
		a, b, isRange := strings.Cut(part, "..")
		from := indexOf(weekdayNames, a)
		to := from
		if isRange {
			to = indexOf(weekdayNames, b)
		}
		if from < 0 || to < 0 {
			return nil, errCalendar
		}
		// mon..sun wraps: walk forward
		for d := from; ; d = (d + 1) % 7 {
			out[time.Weekday(d)] = true
			if d == to {
				break
			}
		}
	}
	return out, nil
}

func parseCalendar(expr string) (*calendarSpec, error) {
	s := strings.Join(strings.Fields(strings.ToLower(expr)), " ")
	if s == "monthly" {
		return &calendarSpec{monthDays: map[int]bool{1: true}, hours: []int{0}, minutes: []int{0}}, nil
	}
	if k, ok := calendarKeywords[s]; ok {
		s = k
	}
	if s == "" {
		return nil, errCalendar
	}
	words := strings.Split(s, " ")
	if len(words) > 2 {
		return nil, errCalendar
	}
	spec := &calendarSpec{}
	timeS := ""
	if words[0][0] >= 'a' && words[0][0] <= 'z' {
		wd, err := parseWeekdays(words[0])
		if err != nil {
			return nil, err
		}
		spec.weekdays = wd
		if len(words) == 2 {
			timeS = words[1]
		}
	} else {
		if len(words) > 1 {
			return nil, errCalendar
		}
		timeS = words[0]
	}
	if timeS == "" {
		spec.hours, spec.minutes = []int{0}, []int{0}
		return spec, nil
	}
	parts := strings.Split(timeS, ":")
	if len(parts) > 2 {
		return nil, errCalendar
	}
	var err error
	if len(parts) == 2 {
		if spec.hours, err = parseComponent(parts[0], 23); err != nil {
			return nil, err
		}
	} else {
		for h := 0; h < 24; h++ {
			spec.hours = append(spec.hours, h)
		}
	}
	if spec.minutes, err = parseComponent(parts[len(parts)-1], 59); err != nil {
		return nil, err
	}
	return spec, nil
}

func (c *calendarSpec) dayMatches(d time.Time) bool {
	if c.weekdays != nil && !c.weekdays[d.Weekday()] {
		return false
	}
	if c.monthDays != nil && !c.monthDays[d.Day()] {
		return false
	}
	return true
}

const calendarMaxDays = 400

// previous returns the last run at or before t, in the location loc; zero if none within a year.
func (c *calendarSpec) previous(t time.Time, loc *time.Location) time.Time {
	w := t.In(loc)
	for i := 0; i <= calendarMaxDays; i++ {
		day := time.Date(w.Year(), w.Month(), w.Day()-i, 0, 0, 0, 0, loc)
		if !c.dayMatches(day) {
			continue
		}
		for hi := len(c.hours) - 1; hi >= 0; hi-- {
			for mi := len(c.minutes) - 1; mi >= 0; mi-- {
				r := time.Date(day.Year(), day.Month(), day.Day(), c.hours[hi], c.minutes[mi], 0, 0, loc)
				if !r.After(t) {
					return r
				}
			}
		}
	}
	return time.Time{}
}

// next returns the first run strictly after t.
func (c *calendarSpec) next(t time.Time, loc *time.Location) time.Time {
	w := t.In(loc)
	for i := 0; i <= calendarMaxDays; i++ {
		day := time.Date(w.Year(), w.Month(), w.Day()+i, 0, 0, 0, 0, loc)
		if !c.dayMatches(day) {
			continue
		}
		for _, h := range c.hours {
			for _, m := range c.minutes {
				r := time.Date(day.Year(), day.Month(), day.Day(), h, m, 0, 0, loc)
				if r.After(t) {
					return r
				}
			}
		}
	}
	return time.Time{}
}
