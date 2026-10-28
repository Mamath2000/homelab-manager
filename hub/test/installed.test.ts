import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INSTALLED_TTL_MS, recentlyInstalled } from '../src/installed.js';
import type { AptReport } from '../src/types.js';

const report = (names: string[]): AptReport => ({
  checkedAt: 0,
  listsUpdatedAt: 0,
  upgradable: names.map((name) => ({ name, current: '1', candidate: '2', repo: 'r', security: false })),
  held: [],
  rebootRequired: false,
  rebootPkgs: [],
});

test('packages leaving the upgradable list are recorded as installed', () => {
  const now = 1_000_000_000;
  const r = recentlyInstalled(report(['curl', 'linux-image-amd64']), report(['curl']), [], now);
  assert.deepEqual(r, [{ name: 'linux-image-amd64', from: '1', to: '2', at: now }]);
});

test('installed packages expire after a day or when they become upgradable again', () => {
  const now = 1_000_000_000;
  const prev = [
    { name: 'old', from: '1', to: '2', at: now - INSTALLED_TTL_MS - 1 },
    { name: 'again', from: '1', to: '2', at: now - 1000 },
    { name: 'kept', from: '1', to: '2', at: now - 1000 },
  ];
  const r = recentlyInstalled(report(['again']), report(['again']), prev, now);
  assert.deepEqual(r.map((p) => p.name), ['kept']);
});
