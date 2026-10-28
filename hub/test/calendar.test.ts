import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { describeCalendar, nextRun, parseCalendar, previousRun } from '../src/calendar.js';

// cases shared with agent/calendar_test.go
const cases = JSON.parse(readFileSync(new URL('../../testdata/calendar.json', import.meta.url), 'utf8')) as {
  runs: { expr: string; tz: string; at: string; prev: string; next: string }[];
  invalid: string[];
};

test('previous and next runs of the shared cases', () => {
  for (const c of cases.runs) {
    const spec = parseCalendar(c.expr);
    assert.ok(spec, c.expr);
    const at = Date.parse(c.at);
    assert.equal(new Date(previousRun(spec, at, c.tz)!).toISOString(), new Date(c.prev).toISOString(), `prev ${c.expr}`);
    assert.equal(new Date(nextRun(spec, at, c.tz)!).toISOString(), new Date(c.next).toISOString(), `next ${c.expr}`);
  }
});

test('unsupported expressions are refused', () => {
  for (const e of cases.invalid) assert.equal(parseCalendar(e), null, e);
});

test('readable form', () => {
  assert.equal(describeCalendar('6:00'), 'tous les jours à 06:00');
  assert.equal(describeCalendar('sun 01:00'), 'dim. à 01:00');
  assert.equal(describeCalendar('*/5'), '*/5');
});
