import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { cleanCandidates } from '../src/agents.js';
import { filterQuery, hostKey, LOG_URL_RE, logTarget, NO_SOURCE, queryHits, queryLogs, queryMatrix, LogServerError, toRow } from '../src/logs.js';
import { authorize } from '../src/profiles.js';
import { ROLE_DEFS, roleConflict } from '../src/roles.js';
import { roleView } from '../src/roleView.js';
import { filtersOf, locateSenders, rangeOf, stepOf } from '../src/routes/logs.js';
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
  // the source of a journal; NO_SOURCE: the ones that have none (alone, or with named ones)
  assert.equal(filterQuery({ sources: ['esphome'] }), 'source:="esphome"');
  assert.equal(filterQuery({ sources: ['host', 'omada'] }), 'source:in("host","omada")');
  assert.equal(filterQuery({ sources: [NO_SOURCE] }), 'source:""');
  assert.equal(filterQuery({ sources: ['host', NO_SOURCE] }), '(source:="host" or source:"")');
  assert.equal(filterQuery({ sources: ['x" | delete'] }), 'source:="x\\" | delete"');
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
  // several sites: the hosts of any of them
  assert.deepEqual(filtersOf({ site: 's1,s2' }, known), { hostnames: ['pve1', 'docker01'] });
  assert.deepEqual(filtersOf({ site: 's3,s1' }, known), { hostnames: ['pve1', 'docker01'] });
  // an unknown sender is named as it is
  assert.deepEqual(filtersOf({ hostname: 'switch-salon', host: 'b' }, known), { hostnames: ['switch-salon', 'docker01'] });
  // a selection with no host that can send returns nothing, never every journal
  assert.equal(filtersOf({ site: 's2' }, known), null);
  assert.equal(filtersOf({ host: 'zzz' }, known), null);
  assert.deepEqual(filtersOf({}, known), {});
  assert.equal(hostKey('PVE1.lan'), hostKey('pve1'));
});

test('logs: a sender the hub does not know is located by an equipment, the address it sends from, else the main site', () => {
  const known = [
    { id: 'a', name: 'PVE 1', hostname: 'pve1', siteId: 's1', ips: ['192.168.100.241/24'] },
    { id: 'r', name: 'pje1', hostname: 'pje1', siteId: 's2', ips: ['192.168.10.241'] },
  ];
  const equip = [
    { name: 'ER707-M2', ip: '192.168.100.1', siteId: 's1' },
    { name: 'svlb-06', ip: '192.168.90.165', siteId: 's2' },
    { name: 'no site', ip: '192.168.90.9' },
  ];
  const located = locateSenders(
    [
      { hostname: 'pve1', ip: '192.168.10.241' }, // the host of the hub wins over the address
      { hostname: '192.168.100.1', ip: '192.168.100.1' }, // Omada names itself by its address
      { hostname: 'SVLB-06', ip: '192.168.90.165' },
      { hostname: 'general', ip: '192.168.10.241' }, // relayed by a host of the hub
      { hostname: 'air-sensor', ip: '192.168.90.25' }, // an ESPHome: the main site
    ],
    known,
    equip,
    's9',
  );
  assert.deepEqual(located, [
    { hostname: 'pve1', siteId: 's1' },
    { hostname: '192.168.100.1', siteId: 's1' },
    { hostname: 'SVLB-06', siteId: 's2' },
    { hostname: 'general', siteId: 's2' },
    { hostname: 'air-sensor', siteId: 's9' },
  ]);
  // a site holds its hosts and the senders located there; a host of the hub keeps its own site
  assert.deepEqual(filtersOf({ site: 's9' }, known, located), { hostnames: ['air-sensor'] });
  assert.deepEqual(filtersOf({ site: 's2' }, known, located), { hostnames: ['pje1', 'SVLB-06', 'general'] });
  // a site without any sender returns nothing
  assert.equal(filtersOf({ site: 's7' }, known, located), null);
  // a tag never takes a sender the hub does not know
  assert.equal(filtersOf({ site: 's9', tag: 'prod' }, known, located), null);
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
      if (new URLSearchParams(body).get('query')?.endsWith('| stats by (source, severity) count() n')) {
        res.end(['{"source":"zeta","severity":"6","n":"1"}', '{"source":"","severity":"6","n":"7"}', '{"source":"esphome","severity":"4","n":"14"}', '{"source":"host","severity":"3","n":"2"}', '{"source":"host","severity":"6","n":"30"}', '{"source":"host","severity":"9","n":"4"}', '{"source":"omada","severity":"6","n":"0"}'].join('\n'));
      } else if (req.url === '/select/logsql/hits') {
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
    // the matrix: the columns in the order of the categories, journals without a source last
    const matrix = await queryMatrix(c, { hostnames: ['h'] }, { start: '1h' });
    assert.equal(seen[seen.length - 1].body.get('query'), 'hostname:="h" | stats by (source, severity) count() n');
    assert.deepEqual(matrix.sources, ['host', 'esphome', 'zeta', NO_SOURCE]);
    assert.deepEqual(matrix.cells.find((x) => x.source === 'esphome'), { source: 'esphome', severity: 4, count: 14 });
    // a row without a count or with a severity out of range is dropped
    assert.equal(matrix.cells.length, 5);
  } finally {
    srv.close();
  }
  await assert.rejects(queryLogs({ ...c, url: 'http://127.0.0.1:1' }, {}, { start: '1h' }, 10), /injoignable/);
});

test('log routes: 404 without a log server, never with an API key, filters checked by the schema', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerLogRoutes } = await import('../src/routes/logs.js');
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    if (req.headers['x-key']) req.apiKey = { id: new ObjectId(), name: 'homepage' };
  });
  registerLogRoutes(app);
  await app.ready();
  for (const url of ['/api/logs', '/api/logs/hits', '/api/logs/matrix', '/api/logs/fields?field=app', '/api/logs/sources', '/api/logs/context?hostname=h&time=2026-11-12T10:00:00Z', '/api/logs/tail']) {
    assert.equal((await app.inject({ url })).statusCode, 404, url);
    assert.equal((await app.inject({ url, headers: { 'x-key': '1' } })).statusCode, 403, url);
  }
  assert.equal((await app.inject({ url: '/api/logs?severity=9' })).statusCode, 400);
  // a parameter the routes do not know (a LogsQL query) is dropped, never passed on
  assert.equal((await app.inject({ url: '/api/logs?query=*' })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/logs/fields?field=_msg' })).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/logs?limit=5000' })).statusCode, 400);
  await app.close();
});

test('Paramètres › Logs: how a host sends to a server, and the values that make it send or stop', async () => {
  const { overridesSending, sendMode } = await import('../src/routes/logs.js');
  const { config: hubConfig } = await import('../src/config.js');
  const was = hubConfig.featureStandardisation;
  hubConfig.featureStandardisation = true;
  try {
    const caps = ['setup', 'log_forward'];
    const std = withLogs('logs');
    // the standard value: no own value needed, and one to a server or to nothing is replaced
    assert.deepEqual(overridesSending(std, { packages: { mode: 'off' }, log_forward: { mode: 'custom', value: { role: '' } } }, 'logs'), { packages: { mode: 'off' } });
    assert.deepEqual(overridesSending(std, {}, 'other'), { log_forward: { mode: 'custom', value: { role: 'other' } } });
    // without the standard: an own value
    assert.deepEqual(overridesSending(DEFAULT_SETUP, {}, 'logs'), { log_forward: { mode: 'custom', value: { role: 'logs' } } });
    // stopping: « no forwarding », the agent removes its file
    assert.deepEqual(overridesSending(std, {}, ''), { log_forward: { mode: 'custom', value: { role: '' } } });
    assert.equal(sendMode(std, { capabilities: caps }, 'logs'), 'standard');
    assert.equal(sendMode(std, { capabilities: caps, setupOverrides: { log_forward: { mode: 'off' } } }, 'logs'), null);
    assert.equal(sendMode(DEFAULT_SETUP, { capabilities: caps, setupOverrides: { log_forward: { mode: 'custom', value: { role: 'logs' } } } }, 'logs'), 'custom');
    assert.equal(sendMode(std, { capabilities: caps, setupOverrides: { log_forward: { mode: 'custom', value: { role: '' } } } }, 'logs'), null);
    // a host without standardisation never sends through it
    assert.equal(sendMode(std, { capabilities: [] }, 'logs'), null);
  } finally {
    hubConfig.featureStandardisation = was;
  }
  assert.equal(authorize('operator', 'GET', '/api/settings/logs/:role/hosts'), false);
  assert.equal(authorize('admin', 'POST', '/api/settings/logs/:role/hosts'), true);
});

test('log server: the syslog ports read in its flags', async () => {
  const { parseSyslogFlags } = await import('../src/logs.js');
  assert.deepEqual(parseSyslogFlags('-httpListenAddr=":9428"\n-syslog.listenAddr.tcp=":514"\n-syslog.listenAddr.udp=":514"\n-syslog.timezone="Europe/Paris"'), { tcp: [514], udp: [514] });
  assert.deepEqual(parseSyslogFlags('-syslog.listenAddr.tcp="0.0.0.0:1514,:514,[::]:6514"'), { tcp: [514, 1514, 6514], udp: [] });
  assert.deepEqual(parseSyslogFlags('-retentionPeriod="30d"'), { tcp: [], udp: [] });
});

test('log server: the reception test sends a syslog line and finds it through the API', async () => {
  const { testReception } = await import('../src/logs.js');
  const net = await import('node:net');
  // a syslog input that hands what it receives to the API
  const received: string[] = [];
  const input = net.createServer((s) => s.on('data', (d) => received.push(String(d))));
  await new Promise<void>((r) => input.listen(0, '127.0.0.1', r));
  const api = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const q = new URLSearchParams(body).get('query') ?? '';
      const nonce = /test de réception ([0-9a-f]+)/.exec(q)?.[1];
      res.end(nonce && received.some((l) => l.includes(nonce)) ? '{"_msg":"ok"}\n' : '');
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const c = { ...server(`http://127.0.0.1:${(api.address() as AddressInfo).port}`) };
  try {
    assert.deepEqual(await testReception(c, '127.0.0.1', (input.address() as AddressInfo).port), { received: true });
    assert.match(received.join(''), /^<14>1 \S+ homelab-manager hlm-reception-test - - - test de réception [0-9a-f]+\n$/);
    // a port where nothing listens: refused, said as such
    await assert.rejects(testReception(c, '127.0.0.1', 1), /refuse la connexion/);
  } finally {
    input.close();
    api.close();
  }
});
