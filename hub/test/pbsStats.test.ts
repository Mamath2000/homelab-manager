import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dailySeries, parseBackupLine, parseBackupLog } from '../src/pbsStats.js';

const L = (s: string) => `2026-05-28T07:00:01+02:00: ${s}`;

test('the group comes from the start line, with its namespaces', () => {
  assert.deepEqual(parseBackupLine(L(`starting new backup on datastore 'ds3' from ::ffff:192.168.10.242: "ns/Jarsay/vm/100/2026-05-28T05:00:00Z"`)), { groupId: 'ds3/Jarsay/vm/100' });
  assert.deepEqual(parseBackupLine(L(`starting new backup on datastore 'ds0' from ::ffff:1.2.3.4: "ns/a/ns/b/host/unraid-boot/2026-02-27T02:47:49Z"`)), { groupId: 'ds0/a/b/host/unraid-boot' });
  assert.deepEqual(parseBackupLine(L(`starting new backup on datastore 'backup' from ::ffff:1.2.3.4: "ct/180/2026-02-26T05:00:02Z"`)), { groupId: 'backup//ct/180' });
  assert.equal(parseBackupLine(L('Size: 4701814784')), null);
});

test('a backup uploads the sum of its archives', () => {
  const r = parseBackupLog([
    L(`starting new backup on datastore 'ds3' from ::ffff:1.2.3.4: "ns/Jarsay/vm/100/2026-05-28T05:00:00Z"`),
    L('Upload size: 4139778048 (88%)'),
    L('Upload size: 11564 (100%)'),
  ]);
  assert.deepEqual(r, { groupId: 'ds3/Jarsay/vm/100', uploaded: 4139789612 });
  assert.equal(parseBackupLog([L('Upload size: 5 (1%)')]), null);
});

test('daily series: one cell per day, durations added up, failures counted', () => {
  const now = new Date(2026, 9, 20, 15).getTime();
  const at = (d: number, h: number) => new Date(2026, 9, d, h).getTime();
  const cells = dailySeries(
    [
      { start: at(20, 3), end: at(20, 3) + 60_000, uploaded: 100, ok: true },
      { start: at(20, 5), end: at(20, 5) + 30_000, uploaded: 0, ok: false },
      { start: at(18, 3), end: at(18, 3) + 10_000, uploaded: 7, ok: true },
      { start: at(1, 3), end: at(1, 3) + 10_000, uploaded: 9, ok: true }, // out of the window
    ],
    3,
    now,
  );
  assert.equal(cells.length, 3);
  assert.deepEqual(cells.map((c) => [c.uploaded, c.duration, c.count, c.failed]), [[7, 10_000, 1, 0], [0, 0, 0, 0], [100, 90_000, 2, 1]]);
});
