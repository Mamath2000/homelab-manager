import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { cleanCandidates } from '../src/agents.js';
import { filterQuery, hostKey, LOG_URL_RE, logTarget, queryHits, queryLogs, LogServerError, toRow } from '../src/logs.js';
import { authorize } from '../src/profiles.js';
import { ROLE_DEFS, roleConflict } from '../src/roles.js';
import { roleView } from '../src/roleView.js';
import { filtersOf, rangeOf, stepOf } from '../src/routes/logs.js';
import { configError, toConfig } from '../src/routes/roles.js';
import { DEFAULT_SETUP, buildSpec, logForwardSkip, withLogForward } from '../src/setup.js';
import type { LogServerConfig, RoleDoc, SetupProfile, SetupState } from '../src/types.js';

const server = (url = 'http://192.168.100.21:9428'): LogServerConfig => ({ url, port: 29514, protocol: 'tcp', username: '', password: '', silentHours: 6 });

test('logs: the filters become a LogsQL query, every value quoted', () => {
  assert.equal(filterQuery({}), '*');
  assert.equal(filterQuery({ hostnames: ['pve1'] }), 'hostname:="pve1"');
  assert.equal(filterQuery({ hostnames: ['pve1', 'pve2'], maxSeverity: 4 }), 'hostname:in("pve1","pve2") severity:<=4');
  // debug and worse is every journal: no condition
  assert.equal(filterQuery({ maxSeverity: 7 }), '*');
  assert.equal(filterQuery({ apps: ['sshd'], facilities: ['auth', 'authpriv'] }), 'app_name:="sshd" facility_keyword:in("auth","authpriv")');
  assert.equal(filterQuery({ not: { apps: ['cron'], hostnames: [] } }), '!app_name:="cron"');
});

test('logs: nothing typed in a filter is read as LogsQL', () => {
  // a quote, a pipe, a parenthesis: inside the quoted value
  assert.equal(filterQuery({ hostnames: ['x" | delete'] }), 'hostname:="x\\" | delete"');
  assert.equal(filterQuery({ apps: ['a") or *'] }), 'app_name:="a\\") or *"');
  // the text is looked for as it is: its regular expression characters are escaped, then the whole is quoted
  assert.equal(filterQuery({ text: 'a.b' }), '_msg:~"(?i)a\\\\.b"');
  assert.equal(filterQuery({ text: '" | stats count()' }), '_msg:~"(?i)\\" \\\\| stats count\\\\(\\\\)"');
  assert.equal(filterQuery({ text: '   ' }), '*');
});

test('logs: a row of the server as the UI reads it', () => {
  const row = toRow({ _time: '2026-11-12T19:07:58.419838Z', _msg: ' erreur de test', _stream: '{}', hostname: 'pve1', severity: '3', level: 'error', facility: '3', facility_keyword: 'daemon', app_name: 'sshd', proc_id: '-', msg_id: '-', priority: '27', format: 'rfc5424', remote_ip: '10.0.0.5', 'origin.software': 'rsyslogd' });
  assert.deepEqual(row, { time: '2026-11-12T19:07:58.419838Z', hostname: 'pve1', severity: 3, level: 'error', facility: 'daemon', app: 'sshd', pid: '', message: 'erreur de test', remoteIp: '10.0.0.5', fields: { 'origin.software': 'rsyslogd' } });
  // a journal without a severity is an information
  assert.equal(toRow({ _time: 't', _msg: 'x' }).level, 'info');
});

test('logs: range of a request, step of the histogram', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  assert.deepEqual(rangeOf({}, now), { start: '2026-11-12T11:00:00.000Z', startMs: now - 3600_000, endMs: now });
  assert.equal(rangeOf({ from: '7d' }, now).start, '2026-11-05T12:00:00.000Z');
  const r = rangeOf({ from: '2026-11-12T10:00:00Z', to: '2026-11-12T11:00:00.123456789Z' }, now);
  assert.equal(r.end, '2026-11-12T11:00:00.123456789Z');
  for (const bad of [{ from: 'now' }, { from: '1h; drop' }, { to: 'yesterday' }, { from: '2026-11-12T11:00:00Z', to: '2026-11-12T10:00:00Z' }]) assert.throws(() => rangeOf(bad, now));
  assert.equal(stepOf(15 * 60_000), '15s');
  assert.equal(stepOf(3600_000), '1m');
  assert.equal(stepOf(86_400_000), '30m');
  assert.equal(stepOf(7 * 86_400_000), '3h');
  assert.equal(stepOf(365 * 86_400_000), '1d');
});

test('logs: hosts, sites and tags of the hub become the names the journals carry', () => {
  const known = [
    { id: 'a', name: 'PVE 1', hostname: 'pve1', siteId: 's1', tags: ['prod'] },
    { id: 'b', name: 'Docker', hostname: 'docker01', siteId: 's1' },
    { id: 'c', name: 'Never connected', hostname: '', siteId: 's2' },
  ];
  assert.deepEqual(filtersOf({ host: 'a' }, known), { hostnames: ['pve1'] });
  assert.deepEqual(filtersOf({ site: 's1', severity: 4 }, known), { hostnames: ['pve1', 'docker01'], maxSeverity: 4 });
  assert.deepEqual(filtersOf({ site: 's1', tag: 'prod' }, known), { hostnames: ['pve1'] });
  // an unknown sender is named as it is
  assert.deepEqual(filtersOf({ hostname: 'switch-salon', host: 'b' }, known), { hostnames: ['switch-salon', 'docker01'] });
  // a selection with no host that can send returns nothing, never every journal
  assert.equal(filtersOf({ site: 's2' }, known), null);
  assert.equal(filtersOf({ host: 'zzz' }, known), null);
  assert.deepEqual(filtersOf({}, known), {});
  assert.equal(hostKey('PVE1.lan'), hostKey('pve1'));
});

test('logs: read by admins and operators only', () => {
  for (const route of ['/api/logs', '/api/logs/hits', '/api/logs/tail', '/api/logs/context']) {
    assert.equal(authorize('admin', 'GET', route), true);
    assert.equal(authorize('operator', 'GET', route), true);
    assert.equal(authorize('viewer', 'GET', route), false);
    assert.equal(authorize('superadmin', 'GET', route), false);
  }
});

test('log-server role: config, target of the hosts, view without its password', () => {
  assert.equal(configError('log-server', { url: 'http://192.168.100.21:9428', port: 29514 }), null);
  assert.ok(configError('log-server', { url: 'ftp://x', port: 29514 }));
  assert.ok(configError('log-server', { url: 'http://x:9428/select?x=1', port: 29514 }));
  assert.ok(configError('log-server', { url: 'http://x:9428' }));
  assert.ok(configError('log-server', { url: 'http://x:9428', port: 514, clientId: 'x' }));
  assert.ok(configError('log-server', { url: 'http://x:9428', port: 514, password: 'p' }));
  assert.ok(LOG_URL_RE.test('https://logs.lan/'));
  const c = toConfig('log-server', { url: 'http://192.168.100.21:9428/', port: 29514, username: ' ', password: 'kept?' }, 'kept?');
  assert.deepEqual(c, { url: 'http://192.168.100.21:9428', port: 29514, protocol: 'tcp', username: '', password: '', silentHours: 6 });
  assert.deepEqual(logTarget(c, ['127.0.0.1/8', '192.168.100.21/24']), { address: '192.168.100.21', port: 29514, protocol: 'tcp' });
  assert.equal(logTarget({ ...c, address: 'logs.lan' }, ['192.168.100.21/24']).address, 'logs.lan');
  assert.equal(logTarget(c, []).address, '');

  const id = new ObjectId();
  const role: RoleDoc = { _id: 'logs', type: 'log-server', name: 'Logs', carrier: { kind: 'host', id }, config: { ...c, username: 'hlm', password: 'secret' }, createdAt: new Date() };
  const view = roleView(role, { name: 'docker01', info: { ips: ['192.168.100.21/24'] } as never });
  assert.ok(!JSON.stringify(view).includes('secret'));
  assert.equal(view.hasSecret, true);
  assert.equal((view as { target: string }).target, 'tcp://192.168.100.21:29514');
  // several servers may exist, not twice the same one on a host
  assert.equal(ROLE_DEFS['log-server'].single, false);
  assert.ok(roleConflict([role], 'log-server', 'Autre', id, server('http://192.168.100.21:9428/')));
  assert.equal(roleConflict([role], 'log-server', 'Autre', id, server('http://192.168.100.22:9428')), null);
});

test('log-server candidates reported by an agent are kept', () => {
  const got = cleanCandidates([
    { type: 'log-server', process: 'victoria-logs-p', port: 9428, scheme: 'http' },
    { type: 'log-server', process: 'victoria-logs-p', port: 29514, scheme: 'whatever' },
    { type: 'shell', process: 'sh', port: 1 },
  ]);
  assert.deepEqual(got.map((c) => [c.type, c.port, c.scheme]), [['log-server', 9428, 'http'], ['log-server', 29514, 'syslog']]);
});

const withLogs = (role: string): SetupProfile => ({ ...DEFAULT_SETUP, options: { ...structuredClone(DEFAULT_SETUP.options), log_forward: { enabled: true, value: { role } } } });
const targets = new Map([['logs', { address: '192.168.100.21', port: 29514, protocol: 'tcp' as const }]]);

test('standardisation: the agent gets the address of the log server, only when it can apply it', () => {
  const p = withLogs('logs');
  const spec = buildSpec(p, undefined, undefined, { capabilities: ['setup', 'log_forward'], targets });
  assert.ok(spec.modules.includes('log_forward'));
  assert.deepEqual(spec.logForward, { address: '192.168.100.21', port: 29514, protocol: 'tcp' });
  // an agent that does not know the option would refuse the whole spec: it is left out, and told « sans objet »
  const old = buildSpec(p, undefined, undefined, { capabilities: ['setup'], targets });
  assert.ok(!old.modules.includes('log_forward') && !('logForward' in old));
  assert.equal(logForwardSkip({ log_forward: { role: 'logs' } }, { capabilities: ['setup'], targets })?.state, 'na');
  // a server that is gone, or whose address is unknown: an error, nothing sent
  assert.equal(logForwardSkip({ log_forward: { role: 'gone' } }, { capabilities: ['log_forward'], targets })?.state, 'error');
  assert.ok(!buildSpec(withLogs('gone'), undefined, undefined, { capabilities: ['log_forward'], targets }).modules.includes('log_forward'));
  // own value of a host « aucun envoi »: the agent removes its file
  const none = buildSpec(p, { log_forward: { mode: 'custom', value: { role: '' } } }, undefined, { capabilities: ['log_forward'], targets });
  assert.deepEqual(none.logForward, { address: '' });
  // not managed on this host
  assert.ok(!buildSpec(p, { log_forward: { mode: 'off' } }, undefined, { capabilities: ['log_forward'], targets }).modules.includes('log_forward'));
  // off by default
  assert.ok(!buildSpec(DEFAULT_SETUP, undefined, undefined, { capabilities: ['log_forward'], targets }).modules.includes('log_forward'));
});

test('standardisation: the check of the journals option names its server, or says why it was not sent', () => {
  const host = { _id: new ObjectId(), info: { hostname: 'pve1' } as never };
  const state: SetupState = { checkedAt: Date.now(), user: '', modules: [{ module: 'packages', state: 'ok' }, { module: 'log_forward', state: 'ok' }] };
  const ok = withLogForward(host, state, { log_forward: { role: 'logs' } }, { capabilities: ['log_forward'], targets });
  assert.deepEqual(ok[1], { module: 'log_forward', state: 'ok', role: 'logs' });
  const skipped = withLogForward(host, { ...state, modules: [state.modules[0]] }, { log_forward: { role: 'logs' } }, { capabilities: [], targets });
  assert.deepEqual(skipped.map((m) => [m.module, m.state]), [['packages', 'ok'], ['log_forward', 'na']]);
});

test('logs: rows read from the server, newest first; its errors are told', async () => {
  const seen: { path: string; body: URLSearchParams; auth?: string }[] = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ path: req.url!, body: new URLSearchParams(body), auth: req.headers.authorization });
      if (req.url === '/select/logsql/hits') {
        res.end(JSON.stringify({ hits: [{ fields: { severity: '6' }, timestamps: ['t1', 't2'], values: [1, 2], total: 3 }, { fields: { severity: '3' }, timestamps: ['t2'], values: [5], total: 5 }] }));
      } else if (new URLSearchParams(body).get('query') === 'hostname:="bad"') {
        res.statusCode = 400;
        res.end('cannot parse');
      } else {
        res.end('{"_time":"2026-11-12T10:00:00Z","_msg":" a","hostname":"h","severity":"6"}\n{"_time":"2026-11-12T10:00:02Z","_msg":" b","hostname":"h","severity":"3"}\n');
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const c = { ...server(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`), username: 'hlm', password: 'pw' };
  try {
    const rows = await queryLogs(c, { hostnames: ['h'] }, { start: '2026-11-12T09:00:00Z' }, 5000);
    assert.deepEqual(rows.map((r) => r.message), ['b', 'a']);
    assert.equal(seen[0].path, '/select/logsql/query');
    assert.equal(seen[0].body.get('query'), 'hostname:="h"');
    // capped
    assert.equal(seen[0].body.get('limit'), '1000');
    assert.equal(seen[0].auth, `Basic ${Buffer.from('hlm:pw').toString('base64')}`);
    const hits = await queryHits(c, {}, { start: '1h' }, '1m');
    assert.deepEqual(hits.timestamps, ['t1', 't2']);
    assert.deepEqual(hits.series.map((s) => [s.level, s.values, s.total]), [['error', [0, 5], 5], ['info', [1, 2], 3]]);
    await assert.rejects(queryLogs(c, { hostnames: ['bad'] }, { start: '1h' }, 10), LogServerError);
  } finally {
    srv.close();
  }
  await assert.rejects(queryLogs({ ...c, url: 'http://127.0.0.1:1' }, {}, { start: '1h' }, 10), /injoignable/);
});
