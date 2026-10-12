import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { haGroups, isHaBackupReport, type HaBackupReport } from '../src/haBackups.js';
import { backupState, effectiveThreshold, haCalendar } from '../src/pbs.js';
import type { BackupDoc, BackupHa } from '../src/types.js';

const H = 3600_000;
const D = 24 * H;
const hostId = new ObjectId();
// 2026-10-12 04:45 Paris (02:45 UTC)
const at0445 = Date.UTC(2026, 9, 12, 2, 45);

// report of the agent: daily backups at 04:45 to local and to an SFTP NAS
function report(over: Partial<HaBackupReport> = {}): HaBackupReport {
  return {
    checkedAt: at0445 + H,
    configured: true,
    recurrence: 'daily',
    days: [],
    time: '04:45',
    timeZone: 'Europe/Paris',
    autoAgentIds: ['hassio.local', 'sftp_storage.nas'],
    lastAttempted: at0445,
    lastCompleted: at0445 + 60_000,
    next: at0445 + D,
    state: 'idle',
    agents: [
      {
        agentId: 'hassio.local',
        name: 'Home Assistant',
        backups: [
          { id: 'b1', name: 'Automatic', date: at0445 - D, size: 100, automatic: true },
          { id: 'b2', name: 'Automatic', date: at0445 + 1000, size: 120, automatic: true },
        ],
      },
      { agentId: 'sftp_storage.nas', name: 'NAS', backups: [{ id: 'b2', name: 'Automatic', date: at0445 + 1000, size: 120, automatic: true }] },
      // unused backup agent, nothing on it: not followed
      { agentId: 'cloud.cloud', name: 'Home Assistant Cloud', backups: [] },
    ],
    ...over,
  };
}

// group of the report as stored by refreshHaBackups
function doc(r: HaBackupReport, agentId: string): BackupDoc {
  const g = haGroups(hostId, r).find((x) => x.set.ha?.agentId === agentId)!;
  return { _id: g._id, ...g.set, ...(g.history ?? { count: 0, size: null, lastBackup: 0, times: [] }), verify: null, hostId, source: 'haos', seenAt: new Date() } as BackupDoc;
}

test('one group per destination of the automatic backups or holding backups', () => {
  const g = haGroups(hostId, report());
  assert.deepEqual(
    g.map((x) => x._id),
    [`haos/${hostId.toHexString()}/hassio.local`, `haos/${hostId.toHexString()}/sftp_storage.nas`],
  );
  assert.deepEqual(
    { store: g[0].set.store, type: g[0].set.type, backupId: g[0].set.backupId },
    { store: 'Home Assistant', type: 'ha', backupId: 'Home Assistant' },
  );
  // history: last backup and its size, dates oldest first
  assert.deepEqual(g[0].history, {
    count: 2,
    size: 120,
    lastBackup: at0445 + 1000,
    times: [
      { t: at0445 - D, verify: null },
      { t: at0445 + 1000, verify: null },
    ],
  });
  assert.equal(g[1].set.ha?.automatic, true);
  assert.deepEqual(g[1].set.ha?.schedule, { recurrence: 'daily', days: [], time: '04:45' });
});

test('a destination that could not be listed keeps its last known history', () => {
  const r = report();
  r.agents[1] = { agentId: 'sftp_storage.nas', name: 'NAS', backups: [], error: 'Connection refused' };
  const nas = haGroups(hostId, r)[1];
  assert.equal(nas.history, null);
  assert.equal(nas.set.ha?.error, 'Connection refused');
});

test('report shape is checked', () => {
  assert.ok(isHaBackupReport(report()));
  assert.ok(!isHaBackupReport({ ...report(), agents: [{ agentId: 'x' }] }));
  assert.ok(!isHaBackupReport(null));
});

const ha = (over: Partial<BackupHa> = {}): BackupHa => ({
  agentId: 'hassio.local',
  automatic: true,
  schedule: { recurrence: 'daily', days: [], time: '04:45' },
  tz: 'Europe/Paris',
  next: null,
  lastAttempted: null,
  lastCompleted: null,
  failedAt: null,
  error: null,
  ...over,
});

test('schedule of Home Assistant as a calendar event', () => {
  assert.equal(haCalendar(ha()), '4:45');
  assert.equal(haCalendar(ha({ schedule: { recurrence: 'custom_days', days: ['mon', 'thu'], time: '23:05:00' } })), 'mon,thu 23:05');
  // time chosen by Home Assistant: the one of the next run, in its time zone
  assert.equal(haCalendar(ha({ schedule: { recurrence: 'daily', days: [], time: null }, next: Date.UTC(2026, 9, 13, 3, 12) })), '5:12');
  assert.equal(haCalendar(ha({ schedule: null })), null);
});

test('states of a Home Assistant destination', () => {
  const now = at0445 + 3 * H;
  const local = doc(report(), 'hassio.local');
  assert.equal(backupState(local, now), 'ok');
  assert.equal(effectiveThreshold(local, now).source, 'schedule');

  // the backup did not reach the NAS
  const failed = report({ agents: [{ ...report().agents[1], backups: [{ id: 'b1', name: 'A', date: at0445 - D, size: 1, automatic: true }], failedAt: at0445 + 1000 }] });
  assert.equal(backupState(doc(failed, 'sftp_storage.nas'), now), 'task_failed');

  // the whole backup failed: attempted after the last completed one, nothing written since
  const whole = report({ lastCompleted: at0445 - D + 60_000, agents: [{ ...report().agents[0], backups: [{ id: 'b1', name: 'A', date: at0445 - D, size: 1, automatic: true }] }] });
  assert.equal(backupState(doc(whole, 'hassio.local'), now), 'task_failed');
  // ...but a destination written by this attempt is fine, even if Home Assistant did not mark it completed
  assert.equal(backupState(doc(report({ lastCompleted: at0445 - D }), 'hassio.local'), now), 'ok');

  // no backup since the expected run (two days ago)
  assert.equal(backupState(local, now + 2 * D), 'stale');

  // automatic backups off, or not to this destination: disabled, unless a threshold of its own is set
  const off = doc(report({ configured: false }), 'hassio.local');
  assert.equal(backupState(off, now), 'disabled');
  assert.equal(backupState({ ...off, staleHours: 48 }, now), 'ok');
  assert.equal(backupState({ ...off, staleHours: 48 }, now + 3 * D), 'stale');
  const manualOnly = doc(report({ autoAgentIds: ['hassio.local'] }), 'sftp_storage.nas');
  assert.equal(manualOnly.ha?.automatic, false);
  assert.equal(backupState(manualOnly, now), 'disabled');
});
