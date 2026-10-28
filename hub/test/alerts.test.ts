import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayKey, jobDomain, jobLabel, latestDay } from '../src/alerts.js';

test('the latest observation of the day replaces the previous state and reasons', () => {
  assert.deepEqual(latestDay({ level: 'ok', reasons: [] }), { level: 'ok', reasons: [] });
  assert.deepEqual(latestDay({ level: 'warn', reasons: ['a'] }), { level: 'warn', reasons: ['a'] });
  assert.deepEqual(latestDay({ level: 'alert', reasons: ['c'] }), { level: 'alert', reasons: ['c'] });
});

test('failed jobs: domain and label', () => {
  assert.equal(jobDomain('apt_upgrade'), 'apt');
  assert.equal(jobDomain('reboot'), 'apt');
  assert.equal(jobDomain('docker_update'), 'docker');
  assert.equal(jobDomain('backup_run'), 'backup');
  assert.equal(jobDomain('offsite_run'), 'offsite');
  assert.equal(jobDomain('agent_update'), null);
  assert.equal(jobLabel({ action: 'docker_restart', stack: 'frigate' }), 'redémarrage frigate');
  assert.equal(jobLabel({ action: 'backup_run', backupJobName: 'Nextcloud · base' }), 'sauvegarde Nextcloud · base');
});

test('day key in local time', () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});
