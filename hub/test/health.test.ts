import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_HEALTH_SETTINGS, isHealthDisks, isHealthSmart, isHealthSystem } from '../src/health.js';

const now = Date.now();

test('health defaults use distinct system, volume, and SMART frequencies with short retention', () => {
  assert.deepEqual(
    [
      DEFAULT_HEALTH_SETTINGS.systemIntervalSeconds,
      DEFAULT_HEALTH_SETTINGS.diskIntervalSeconds,
      DEFAULT_HEALTH_SETTINGS.smartIntervalSeconds,
      DEFAULT_HEALTH_SETTINGS.retentionHours,
    ],
    [30, 300, 86400, 48],
  );
});

test('system measurements validate finite percentages, bytes, and optional Unix load', () => {
  const report = { checkedAt: now, cpuPercent: 34.5, memPercent: 61, memUsed: 610, memTotal: 1000, load1: 1, load5: 0.8, load15: 0.4 };
  assert.equal(isHealthSystem(report), true);
  assert.equal(isHealthSystem({ ...report, cpuPercent: 101 }), false);
  assert.equal(isHealthSystem({ ...report, load5: Number.NaN }), false);
  assert.equal(isHealthSystem({ ...report, checkedAt: now - 11 * 60_000 }), false);
});

test('volume reports reject invalid or virtual percentages outside the report shape', () => {
  assert.equal(isHealthDisks({ checkedAt: now, volumes: [{ device: '/dev/sda', mountpoint: '/', fstype: 'ext4', used: 80, total: 100, percent: 80 }] }), true);
  assert.equal(isHealthDisks({ checkedAt: now, volumes: [{ device: '/dev/sda', mountpoint: '/', fstype: 'ext4', used: 80, total: 100, percent: 101 }] }), false);
});

test('SMART reports validate optional measurements and bounded error text', () => {
  assert.equal(isHealthSmart({ checkedAt: now, disks: [{ device: '/dev/sda', healthy: true, temperatureC: 40, reallocated: 0 }] }), true);
  assert.equal(isHealthSmart({ checkedAt: now, disks: [{ device: '/dev/sda', temperatureC: 300 }] }), false);
});
