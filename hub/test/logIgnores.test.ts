import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { InvalidRule, normalizeRule, toIgnore } from '../src/logIgnores.js';
import { countIgnored, filterQuery, ignoreCondition, LogServerError, querySenders } from '../src/logs.js';
import { authorize } from '../src/profiles.js';
import type { LogServerConfig } from '../src/types.js';

const server = (url: string): LogServerConfig => ({ url, port: 29514, protocol: 'tcp', username: '', password: '', silentHours: 6 });

// the first rule of homelab#379: a kernel message of the PVE nodes at every vzdump snapshot of a CT on Ceph
const orphan = { pattern: 'EXT4-fs \\(rbd\\d+\\): write access unavailable, skipping orphan cleanup', regex: true, hostnames: ['pve1', 'pve2'], apps: ['kernel'] };

test('log ignores: a rule becomes one condition, its values quoted', () => {
  // a text as it is written (no (?i): the server would read every line), nothing of it a pattern
  assert.equal(ignoreCondition({ pattern: 'a.b (c)', regex: false }), '(_msg:~"a\\\\.b \\\\(c\\\\)")');
  // a regular expression as typed, narrowed to its hosts and applications
  assert.equal(ignoreCondition(orphan), '(_msg:~"EXT4-fs \\\\(rbd\\\\d+\\\\): write access unavailable, skipping orphan cleanup" hostname:in("pve1","pve2") app_name:="kernel")');
  // nothing of a value is read as syntax
  assert.equal(ignoreCondition({ pattern: 'x") | delete', regex: true, apps: ['a" or *'] }), '(_msg:~"x\\") | delete" app_name:="a\\" or *")');
});

test('log ignores: the queries leave the rules out, or read the lines of one rule', () => {
  const a = { pattern: 'noise', regex: false };
  assert.equal(filterQuery({ hostnames: ['pve1'], ignores: [] }), 'hostname:="pve1"');
  assert.equal(filterQuery({ hostnames: ['pve1'], maxSeverity: 4, ignores: [a, orphan] }), `hostname:="pve1" severity:<=4 !${ignoreCondition(a)} !${ignoreCondition(orphan)}`);
  assert.equal(filterQuery({ ignored: orphan }), ignoreCondition(orphan));
});

test('log ignores: a rule is checked and trimmed before it is stored', () => {
  const r = normalizeRule({ pattern: '  skipping orphan cleanup ', hostnames: [' pve1 ', 'pve1', ''], apps: ['kernel'], comment: ' vzdump snapshot ' });
  assert.deepEqual(r, { pattern: 'skipping orphan cleanup', regex: false, hostnames: ['pve1'], apps: ['kernel'], comment: 'vzdump snapshot', enabled: true });
  assert.deepEqual(toIgnore({ ...r, hostnames: [], apps: [] }), { pattern: 'skipping orphan cleanup', regex: false });
  assert.throws(() => normalizeRule({ pattern: ' ', comment: 'x' }), InvalidRule);
  // why it is benign is required
  assert.throws(() => normalizeRule({ pattern: 'x', comment: '  ' }), /commentaire/);
  assert.throws(() => normalizeRule({ pattern: 'a(b', regex: true, comment: 'x' }), /expression régulière invalide/);
  // the same text is no regular expression in words mode
  assert.equal(normalizeRule({ pattern: 'a(b', comment: 'x' }).pattern, 'a(b');
  assert.throws(() => normalizeRule({ pattern: 'x', hostnames: ['a b'], comment: 'x' }), /hôtes invalide/);
  assert.throws(() => normalizeRule({ pattern: 'x', apps: ['a,b'], comment: 'x' }), /applications invalide/);
});

test('log ignores: one query per rule counts its lines; the errors of the senders leave them out', async () => {
  const seen: string[] = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const query = new URLSearchParams(body).get('query') ?? '';
      seen.push(query);
      if (query.includes('(?<=')) {
        res.statusCode = 400;
        res.end('cannot parse regexp');
      } else if (query.endsWith('| stats count() n')) res.end(query.includes('noise') ? '{"n":"0"}\n' : '{"n":"21"}\n');
      else res.end('{"hostname":"pve2","last":"2026-11-28T10:00:00Z","n":"40","errors":"1"}\n');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const c = server(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
  try {
    const noise = { pattern: 'noise', regex: false };
    assert.deepEqual(await countIgnored(c, [orphan, noise], { start: '14d' }), [21, 0]);
    // its condition as the filter (the server skips the blocks that cannot hold it), never a counter over every line
    assert.deepEqual(seen.sort(), [`${ignoreCondition(noise)} | stats count() n`, `${ignoreCondition(orphan)} | stats count() n`].sort());
    // no rule: no query
    assert.deepEqual(await countIgnored(c, [], { start: '1h' }), []);
    assert.equal(seen.length, 2);
    // a pattern the server cannot read: its answer is kept (the routes refuse the rule)
    await assert.rejects(countIgnored(c, [{ pattern: '(?<=a)b', regex: true }], { start: '5m' }), (err: unknown) => err instanceof LogServerError && err.upstream === 400);
    const senders = await querySenders(c, '1d', {}, undefined, [orphan]);
    assert.equal(senders[0].errors, 1);
    // the last journal and the count stay the raw ones
    assert.match(seen.at(-1)!, new RegExp(`count\\(\\) n, count\\(\\) if \\(severity:<=3 !\\(_msg:~`));
  } finally {
    srv.close();
  }
});

test('log ignores: read by those who read the journals, written by admins only', () => {
  for (const route of ['/api/logs/ignore-rules']) {
    assert.equal(authorize('operator', 'GET', route), true);
    assert.equal(authorize('viewer', 'GET', route), false);
  }
  for (const [method, route] of [['POST', '/api/logs/ignore-rules'], ['POST', '/api/logs/ignore-rules/preview'], ['PUT', '/api/logs/ignore-rules/:id'], ['DELETE', '/api/logs/ignore-rules/:id']]) {
    assert.equal(authorize('admin', method, route), true);
    assert.equal(authorize('operator', method, route), false);
  }
});

test('log ignores: the pattern offered for a line makes what changes from one line to the next generic', async () => {
  // a helper of the page (web/src/lib/logPattern.ts), checked here: the web part has no tests of its own
  const { suggestPattern } = await import('../../web/src/lib/logPattern.js');
  const p = suggestPattern('EXT4-fs (rbd0): write access unavailable, skipping orphan cleanup');
  assert.equal(p, 'EXT\\d+-fs \\(rbd\\d+\\): write access unavailable, skipping orphan cleanup');
  assert.match('EXT4-fs (rbd12): write access unavailable, skipping orphan cleanup', new RegExp(p));
  // a date and an hour in the message: the next line still matches
  const dated = suggestPattern('[2026-11-28 10:03:01] job a1b2c3d4e5f6 done in 12.5s (id 3f2504e0-4f89-11d3-9a0c-0305e82c3301)');
  assert.equal(dated, '\\[\\d+-\\d+-\\d+ \\d+:\\d+:\\d+\\] job [0-9a-fA-F]+ done in \\d+\\.\\d+s \\(id [0-9a-fA-F-]{36}\\)');
  assert.match('[2026-12-01 23:59:59] job 00ff00ff00ff done in 3.1s (id 00000000-0000-0000-0000-000000000000)', new RegExp(dated));
  // a word is never taken for a hexadecimal value
  assert.equal(suggestPattern('deadbeefcafe accepted'), 'deadbeefcafe accepted');
  // a long message: its beginning only
  assert.equal(suggestPattern('x'.repeat(300)).length, 200);
});
