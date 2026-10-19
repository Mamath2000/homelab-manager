import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSessionReport, sessionSummary, type SessionReport } from '../src/sessions.js';

const report = (sessions: SessionReport['sessions']): SessionReport => ({ checkedAt: 1, sessions });

test('isSessionReport accepts a report of the agent and refuses an unknown state', () => {
  assert.ok(isSessionReport(report([{ id: 1, user: 'math', state: 'active', station: 'Console' }])));
  assert.ok(isSessionReport(report([])));
  assert.ok(!isSessionReport(report([{ id: 1, user: 'math', state: 'away' as 'active' }])));
  assert.ok(!isSessionReport({ checkedAt: 1 }));
});

test('sessionSummary: nobody, someone at the keyboard, all locked', () => {
  assert.equal(sessionSummary(undefined), null);
  assert.deepEqual(sessionSummary(report([])), { users: [], loggedIn: false, locked: false, interactive: false });
  assert.deepEqual(sessionSummary(report([{ id: 1, user: 'math', state: 'active' }])), { users: ['math'], loggedIn: true, locked: false, interactive: false });
  // fast user switching: the other user is disconnected, the console one is locked
  assert.deepEqual(
    sessionSummary(report([{ id: 1, user: 'math', state: 'locked' }, { id: 2, user: 'zoe', state: 'disconnected' }])),
    { users: ['math', 'zoe'], loggedIn: true, locked: true, interactive: false },
  );
});

test('sessionSummary: interactive as soon as one session has recent input', () => {
  const s = sessionSummary(report([
    { id: 1, user: 'math', state: 'active', interactive: false, idleSec: 900 },
    { id: 2, user: 'zoe', state: 'active', interactive: true, idleSec: 3 },
  ]));
  assert.equal(s?.interactive, true);
});
