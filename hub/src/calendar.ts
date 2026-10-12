// Calendar events of Proxmox VE / PBS schedules ("06:00", "sun 01:00", "mon..fri 8..17:0/15", "*/5",
// "daily"...), a subset of the systemd syntax: [WEEKDAYS] [[HOURS:]MINUTES]. Dates (YYYY-MM-DD) and
// seconds are not supported: parse() returns null and the caller falls back to the learned rhythm.
// Times are wall-clock times of a time zone (the one of the PVE node, or of the host).
// Same grammar in agent/calendar.go; shared cases in testdata/calendar.json.

export interface CalendarSpec {
  weekdays: number[] | null; // 0 = sunday; null: every day
  monthDays: number[] | null; // 1..31; null: every day
  hours: number[]; // sorted
  minutes: number[]; // sorted
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const ALL_HOURS = [...Array(24).keys()];

const KEYWORDS: Record<string, string> = {
  minutely: '*:*',
  hourly: '*:0',
  daily: '0:0',
  weekly: 'mon 0:0',
};

function range(from: number, to: number, step = 1) {
  const out: number[] = [];
  for (let v = from; v <= to; v += step) out.push(v);
  return out;
}

// One component (hours or minutes): *, n, a..b, list, start/step, */step
function parseComponent(s: string, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of s.split(',')) {
    const m = /^(\*|\d{1,2})(?:\.\.(\d{1,2}))?(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) return null;
    const step = m[3] ? Number(m[3]) : 1;
    if (step < 1) return null;
    const from = m[1] === '*' ? 0 : Number(m[1]);
    // "a/step" repeats up to the end, like "*/step" from a
    const to = m[2] ? Number(m[2]) : m[1] === '*' || m[3] ? max : from;
    if (from > max || to > max || from > to) return null;
    range(from, to, step).forEach((v) => out.add(v));
  }
  return [...out].sort((a, b) => a - b);
}

function parseWeekdays(s: string): number[] | null {
  const out = new Set<number>();
  for (const part of s.split(',')) {
    const [a, b] = part.split('..');
    const from = WEEKDAYS.indexOf(a);
    const to = b === undefined ? from : WEEKDAYS.indexOf(b);
    if (from < 0 || to < 0) return null;
    // mon..sun wraps: walk forward from `from` to `to`
    for (let d = from; ; d = (d + 1) % 7) {
      out.add(d);
      if (d === to) break;
    }
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCalendar(expr: string): CalendarSpec | null {
  let s = expr.trim().toLowerCase().replace(/\s+/g, ' ');
  if (s === 'monthly') return { weekdays: null, monthDays: [1], hours: [0], minutes: [0] };
  s = KEYWORDS[s] ?? s;
  if (!s) return null;
  const words = s.split(' ');
  if (words.length > 2) return null;
  let weekdays: number[] | null = null;
  let time: string | undefined;
  if (/^[a-z]/.test(words[0])) {
    weekdays = parseWeekdays(words[0]);
    if (!weekdays) return null;
    time = words[1];
  } else {
    if (words.length > 1) return null;
    time = words[0];
  }
  // weekdays alone: at midnight
  if (time === undefined) return { weekdays, monthDays: null, hours: [0], minutes: [0] };
  const parts = time.split(':');
  if (parts.length > 2) return null; // seconds: not supported
  // a single component is the minutes, every hour ("*/5", "30/10")
  const hours = parts.length === 2 ? parseComponent(parts[0], 23) : ALL_HOURS;
  const minutes = parseComponent(parts[parts.length - 1], 59);
  if (!hours || !minutes) return null;
  return { weekdays, monthDays: null, hours, minutes };
}

// --- time zones -----------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function validTimeZone(tz: string) {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

// wall-clock fields of an instant in a time zone
export function wall(ts: number, tz: string) {
  const p: Record<string, number> = {};
  for (const { type, value } of formatter(tz).formatToParts(new Date(ts))) if (type !== 'literal') p[type] = Number(value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

function offset(ts: number, tz: string) {
  const w = wall(ts, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ts / 1000) * 1000;
}

// instant of a wall-clock time in a time zone (a time skipped by DST falls one hour later)
function zoned(y: number, mo: number, d: number, h: number, mi: number, tz: string) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offset(guess, tz);
  return guess - offset(first, tz);
}

// --- runs ------------------------------------------------------------------------------------

function dayMatches(spec: CalendarSpec, y: number, mo: number, d: number) {
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (spec.weekdays && !spec.weekdays.includes(date.getUTCDay())) return false;
  if (spec.monthDays && !spec.monthDays.includes(d)) return false;
  return true;
}

const MAX_DAYS = 400;

// Last run at or before `at` (unix ms), null if none within a year.
export function previousRun(spec: CalendarSpec, at: number, tz: string): number | null {
  const w = wall(at, tz);
  for (let i = 0; i <= MAX_DAYS; i++) {
    const day = new Date(Date.UTC(w.y, w.mo - 1, w.d - i));
    const [y, mo, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    if (!dayMatches(spec, y, mo, d)) continue;
    for (let hi = spec.hours.length - 1; hi >= 0; hi--) {
      for (let mi = spec.minutes.length - 1; mi >= 0; mi--) {
        const t = zoned(y, mo, d, spec.hours[hi], spec.minutes[mi], tz);
        if (t <= at) return t;
      }
    }
  }
  return null;
}

// First run strictly after `at`.
export function nextRun(spec: CalendarSpec, at: number, tz: string): number | null {
  const w = wall(at, tz);
  for (let i = 0; i <= MAX_DAYS; i++) {
    const day = new Date(Date.UTC(w.y, w.mo - 1, w.d + i));
    const [y, mo, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    if (!dayMatches(spec, y, mo, d)) continue;
    for (const h of spec.hours) {
      for (const m of spec.minutes) {
        const t = zoned(y, mo, d, h, m, tz);
        if (t > at) return t;
      }
    }
  }
  return null;
}

// Readable form for the UI, French: "tous les jours à 06:00", "dim. à 01:00"; the raw expression otherwise.
export function describeCalendar(expr: string) {
  const spec = parseCalendar(expr);
  if (!spec) return expr;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (spec.monthDays) return 'le 1er du mois à 00:00';
  if (spec.hours.length !== 1 || spec.minutes.length !== 1) return expr;
  const at = `${pad(spec.hours[0])}:${pad(spec.minutes[0])}`;
  if (!spec.weekdays || spec.weekdays.length === 7) return `tous les jours à ${at}`;
  const names = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
  return `${spec.weekdays.map((d) => names[d]).join(', ')} à ${at}`;
}
