import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aptAlert, backupsAlert, dayKey, dockerAlert, jobDomain, jobLabel, latestDay } from '../src/alerts.js';
import type { AptReport, BackupDoc, DockerStack, Package } from '../src/types.js';
import { dockerHost } from './fixtures.js';

const H = 3600_000;
const now = Date.UTC(2026, 9, 15, 12);
const pkg = (name: string, security = false): Package => ({ name, current: '1', candidate: '2', repo: 'trixie', security });
const report = (o: Partial<AptReport> = {}): AptReport => ({ checkedAt: now, listsUpdatedAt: now - H, upgradable: [], held: [], rebootRequired: false, rebootPkgs: [], ...o });

test('APT: security first, then reboot, updates and stale lists; nothing without a report', () => {
  assert.equal(aptAlert({}, true, now), null);
  assert.deepEqual(aptAlert({ apt: report() }, true, now), { level: 'ok', reasons: [] });
  assert.deepEqual(aptAlert({ apt: report({ upgradable: [pkg('curl', true), pkg('vim')], rebootRequired: true }) }, true, now), {
    level: 'alert',
    reasons: ['Mises à jour de sécurité : curl'],
  });
  const warn = aptAlert({ apt: report({ upgradable: [pkg('vim')], rebootRequired: true, rebootPkgs: ['linux-image'], listsUpdatedAt: now - 3 * 24 * H }) }, true, now);
  assert.deepEqual(warn, { level: 'warn', reasons: ['Redémarrage requis (linux-image)', '1 paquet(s) à mettre à jour', 'Listes de paquets périmées'] });
  // roaming host away: its old lists are not its fault
  assert.deepEqual(aptAlert({ apt: report({ listsUpdatedAt: now - 3 * 24 * H }), roaming: true }, false, now), { level: 'ok', reasons: [] });
});

function stack(name: string, status: DockerStack['status'], states: string[], health?: string): DockerStack {
  return {
    name,
    workingDir: `/srv/${name}`,
    configFiles: [],
    envFiles: [],
    status,
    services: states.map((state, i) => ({ name: `s${i}`, image: `img${i}`, containers: [{ id: `${name}${i}`, name: `${name}-${i}`, state, status: '', imageId: 'img-current', health }] })),
  };
}

test('Docker: a problem is an alert, an image update a warning, otherwise it is OK', () => {
  assert.equal(dockerAlert({ ...dockerHost({}), capabilities: [] }), null);
  assert.deepEqual(dockerAlert(dockerHost({ stacks: [stack('web', 'running', ['running'])] })), { level: 'ok', reasons: [] });
  assert.deepEqual(dockerAlert(dockerHost({ stacks: [stack('web', 'stopped', ['exited'])] })), { level: 'ok', reasons: [] });
  const updates = { checkedAt: now, images: [{ ref: 'img0', digest: 'new' }] };
  const report = {
    stacks: [stack('aio', 'running', ['running']), stack('web', 'running', ['running'])],
    images: [{ ref: 'img0', id: 'img-current', digest: 'old' }],
  };
  assert.deepEqual(dockerAlert({ ...dockerHost(report, updates), unmanagedStacks: ['aio'] }), {
    level: 'warn',
    reasons: ['web : 1 image(s) à mettre à jour'],
  });
  assert.deepEqual(
    dockerAlert({ ...dockerHost({ ...report, stacks: [report.stacks[0]] }, updates), unmanagedStacks: ['aio'] }),
    { level: 'ok', reasons: [] },
  );
  const bad = dockerAlert(dockerHost({ stacks: [stack('web', 'partial', ['running', 'exited']), stack('db', 'running', ['running'], 'unhealthy')] }));
  assert.equal(bad?.level, 'alert');
  assert.deepEqual(bad?.reasons, ['web : 1/2 conteneurs en marche', 'db : s0 : en mauvaise santé']);
  // unmanaged: its state is not followed
  assert.deepEqual(dockerAlert({ ...dockerHost({ stacks: [stack('aio', 'partial', ['running', 'exited'])] }), unmanagedStacks: ['aio'] }), { level: 'ok', reasons: [] });
});

test('backups: failures are alerts, late or pending ones warnings', () => {
  const g = (o: Partial<BackupDoc>) => ({ backupId: 'home', lastBackup: now - H, verify: null, gone: false, staleHours: 26, ...o }) as BackupDoc;
  assert.equal(backupsAlert([], now), null);
  assert.deepEqual(backupsAlert([g({})], now), { level: 'ok', reasons: [] });
  assert.deepEqual(backupsAlert([g({ comment: 'config', lastBackup: now - 30 * H })], now), { level: 'warn', reasons: ['config : en retard'] });
  assert.deepEqual(backupsAlert([g({ lastBackup: now - 30 * H }), g({ backupId: 'db', verify: 'failed' })], now), { level: 'alert', reasons: ['db : vérification en échec'] });
});

test('the latest observation of the day replaces the previous state and reasons', () => {
  assert.deepEqual(latestDay({ level: 'ok', reasons: [] }), { level: 'ok', reasons: [] });
  assert.deepEqual(latestDay({ level: 'warn', reasons: ['a'] }), { level: 'warn', reasons: ['a'] });
  assert.deepEqual(latestDay({ level: 'alert', reasons: ['c'] }), { level: 'alert', reasons: ['c'] });
});

test('failed jobs: domain and label', () => {
  assert.equal(jobDomain('apt_upgrade'), 'apt');
  assert.equal(jobDomain('reboot'), 'apt');
  assert.equal(jobDomain('docker_update'), 'docker');
  assert.equal(jobDomain('backup_run'), 'backups');
  assert.equal(jobDomain('agent_update'), null);
  assert.equal(jobLabel({ action: 'docker_restart', stack: 'frigate' }), 'redémarrage frigate');
  assert.equal(jobLabel({ action: 'backup_run', backupJobName: 'Nextcloud · base' }), 'sauvegarde Nextcloud · base');
});

test('day key in local time', () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});
