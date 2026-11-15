import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { ObjectId } from 'mongodb';
import { applyMessage, parseInfo, parseTopic, wantedTopics } from '../src/esphome.js';
import { MqttPool } from '../src/mqttPool.js';
import { authorize, sensitiveAction } from '../src/profiles.js';
import { roleView } from '../src/roleView.js';
import { ROLE_DEFS, roleConflict } from '../src/roles.js';
import { brokersError, registerEsphomeRoutes, toEsphomeConfig } from '../src/routes/esphome.js';
import type { EsphomeDeviceDoc, EsphomeRole, RoleDoc } from '../src/types.js';

const role = (brokers: EsphomeRole['config']['brokers'] = []): EsphomeRole => ({ _id: 'esphome', type: 'esphome', name: 'ESPHome', carrier: { kind: 'hub' }, config: { brokers }, createdAt: new Date() });

test('esphome: the topics of a device, nothing else', () => {
  assert.deepEqual(parseTopic('esphome/command_portail/LWT'), { uniqueId: 'command_portail', kind: 'LWT' });
  assert.deepEqual(parseTopic('esphome/four/info'), { uniqueId: 'four', kind: 'info' });
  assert.deepEqual(parseTopic('esphome/four/log_level'), { uniqueId: 'four', kind: 'log_level' });
  assert.equal(parseTopic('esphome/four/log_level/set'), null);
  assert.deepEqual(parseTopic('esphome/four/logs'), { uniqueId: 'four', kind: 'logs' });
  assert.equal(parseTopic('esphome/four/sensor/x/state'), null);
  assert.equal(parseTopic('zigbee2mqtt/four/LWT'), null);
  assert.deepEqual(wantedTopics(['vouille']), new Map([['vouille', new Set(['esphome/+/LWT', 'esphome/+/info', 'esphome/+/log_level'])]]));
});

test('esphome: info keeps the known fields of the expected types, its sub-devices once each', () => {
  const r = parseInfo(JSON.stringify({ name: 'command-portail', ip: '192.168.90.20', mac: 'AA:BB', version: '2026.10.1', extra: 1, devices: [{ id: 'cmd_portail', name: 'Command Portail', tags: ['bme280', 'bme280', 3] }, { id: 'cmd_portail' }, { name: 'sans id' }] }));
  assert.deepEqual(r, { info: { name: 'command-portail', ip: '192.168.90.20', mac: 'AA:BB', version: '2026.10.1', devices: [{ id: 'cmd_portail', name: 'Command Portail', tags: ['bme280'] }] } });
  assert.deepEqual(parseInfo('{"name": 3}'), { info: {} });
  assert.deepEqual(parseInfo('online'), { error: 'info : JSON invalide' });
  assert.deepEqual(parseInfo('[1]'), { error: 'info : objet JSON attendu' });
  assert.deepEqual(parseInfo('{"devices": {}}'), { error: 'info : devices doit être une liste' });
});

test('esphome: a message changes the device only when what it says changes', () => {
  const t0 = new Date('2026-11-15T10:00:00Z');
  const t1 = new Date('2026-11-15T11:00:00Z');
  const d = applyMessage(undefined, 'vouille', 'four', 'LWT', 'online', t0)!;
  assert.deepEqual(d, { _id: 'vouille/four', brokerId: 'vouille', uniqueId: 'four', lwt: 'online', lwtAt: t0, firstSeenAt: t0, lastSeenAt: t0 });
  assert.equal(applyMessage(d, 'vouille', 'four', 'LWT', 'online', t1), null);
  const off = applyMessage(d, 'vouille', 'four', 'LWT', 'offline', t1)!;
  assert.equal(off.lwt, 'offline');
  assert.equal(off.firstSeenAt, t0);
  // the retained LWT cleared: no longer announced
  assert.equal(applyMessage(off, 'vouille', 'four', 'LWT', '', t1)!.lwt, null);
  // an empty LWT of a device never seen is not one
  assert.equal(applyMessage(undefined, 'vouille', 'x', 'LWT', '', t1), null);
  const bad = applyMessage(d, 'vouille', 'four', 'info', 'nope', t1)!;
  assert.equal(bad.infoError, 'info : JSON invalide');
  const good = applyMessage(bad, 'vouille', 'four', 'info', '{"name":"four"}', t1)!;
  assert.deepEqual(good.info, { name: 'four' });
  assert.equal('infoError' in good, false);
  assert.equal(applyMessage(good, 'vouille', 'four', 'info', '{"name":"four"}', t1), null);
  const lvl = applyMessage(good, 'vouille', 'four', 'log_level', 'debug', t1) as EsphomeDeviceDoc;
  assert.equal(lvl.level, 'DEBUG');
  assert.equal(applyMessage(lvl, 'vouille', 'four', 'log_level', 'DEBUG', t1), null);
});

test('esphome: a single role, carried by the hub, never a conflict of carrier', () => {
  assert.equal(ROLE_DEFS.esphome.single, true);
  assert.deepEqual(ROLE_DEFS.esphome.carriers, ['hub']);
  assert.equal(roleConflict([], 'esphome', 'ESPHome', null, { brokers: [] }), null);
  assert.equal(roleConflict([role()], 'esphome', 'ESPHome', null, { brokers: [] }), 'un rôle ESPHome est déjà déclaré');
  // a broker on a host next to the role of the hub: the carrier of the hub is never compared
  const host = new ObjectId();
  const broker: RoleDoc = { _id: 'v', type: 'mqtt-broker', name: 'V', carrier: { kind: 'host', id: host }, config: { scheme: 'mqtt', port: 1883, username: '', password: '' }, createdAt: new Date() };
  assert.equal(roleConflict([role(), broker], 'mqtt-broker', 'W', host, { scheme: 'mqtt', port: 8883, username: '', password: '' }), null);
});

test('esphome: the role as the UI shows it, the hub as its carrier', () => {
  const v = roleView(role([{ brokerId: 'vouille' }, { brokerId: 'jar', siteId: 'jarsay' }]), null);
  assert.deepEqual(v.carrier, { kind: 'hub', id: '', name: 'Hub' });
  assert.equal(v.url, '');
  assert.equal(v.status, null);
  assert.equal(v.summary, '2 brokers écoutés, 0 appareil découvert');
});

test('esphome: the brokers listened to are known roles, once each, on known sites', () => {
  const brokers = new Set(['vouille', 'jar']);
  const sites = new Set(['vouille', 'jarsay']);
  assert.equal(brokersError([{ brokerId: 'vouille' }, { brokerId: 'jar', siteId: 'jarsay' }], brokers, sites), null);
  assert.equal(brokersError([{ brokerId: 'x' }], brokers, sites), 'broker inconnu : x');
  assert.equal(brokersError([{ brokerId: 'jar' }, { brokerId: 'jar' }], brokers, sites), 'broker en double : jar');
  assert.equal(brokersError([{ brokerId: 'jar', siteId: 'mars' }], brokers, sites), 'site inconnu : mars');
  // "" is the site of the host of the broker
  assert.deepEqual(toEsphomeConfig([{ brokerId: 'jar', siteId: '' }, { brokerId: 'vouille', siteId: 'vouille' }]), { brokers: [{ brokerId: 'jar' }, { brokerId: 'vouille', siteId: 'vouille' }] });
});

test('esphome: bad bodies are refused, a role not declared is unknown', async () => {
  const a = Fastify();
  registerEsphomeRoutes(a);
  const put = (payload: unknown) => a.inject({ method: 'PUT', url: '/api/settings/esphome', payload });
  assert.equal((await put({})).statusCode, 400);
  assert.equal((await put({ brokers: [{ siteId: 'x' }] })).statusCode, 400);
  assert.equal((await put({ brokers: [{ brokerId: 'x'.repeat(33) }] })).statusCode, 400);
  // past the schema: no role in the cache (no database)
  assert.equal((await put({ brokers: [] })).statusCode, 404);
  assert.equal((await a.inject({ method: 'DELETE', url: '/api/settings/esphome' })).statusCode, 404);
  // no broker role: nothing to listen to
  assert.equal((await a.inject({ method: 'POST', url: '/api/settings/esphome' })).statusCode, 409);
});

test('esphome: settings of the admins, sensitive when written', () => {
  for (const [m, r] of [['GET', '/api/settings/esphome'], ['POST', '/api/settings/esphome'], ['PUT', '/api/settings/esphome'], ['DELETE', '/api/settings/esphome']]) {
    assert.ok(authorize('admin', m, r), `admin ${m} ${r}`);
    assert.ok(!authorize('operator', m, r), `operator ${m} ${r}`);
    assert.ok(!authorize('viewer', m, r), `viewer ${m} ${r}`);
    if (m !== 'GET') assert.ok(sensitiveAction(m, r), `${m} ${r}`);
  }
});

test('mqttPool: the probes keep their consumer name, publish needs a connection', async () => {
  const pool = new MqttPool();
  assert.throws(() => pool.want('probes', new Map()));
  pool.want('esphome', wantedTopics(['vouille']));
  assert.equal(pool.status('vouille'), null);
  assert.equal(await pool.publish('vouille', 'esphome/four/log_level/set', 'DEBUG'), false);
  pool.closeAll();
});

// --- equipments (lot 3) ---------------------------------------------------------------------------------------------

test('esphome equipments: the ESP gets its LWT and a ping, a sub-device its LWT only, never twice', async () => {
  const { esphomeProbes } = await import('../src/esphomeEquipments.js');
  const id = new ObjectId();
  const d = { brokerId: 'vouille', uniqueId: 'command_portail', info: { ip: '192.168.90.20' } };
  const esp = esphomeProbes(id, d, true, []);
  assert.deepEqual(esp.map((p) => [p.name, p.target]), [
    ['LWT', { type: 'mqtt', brokerId: 'vouille', topic: 'esphome/command_portail/LWT', contains: 'online' }],
    ['Ping', { type: 'ping', host: '192.168.90.20' }],
  ]);
  assert.ok(esp.every((p) => p.subject.kind === 'equipment' && p.subject.id.equals(id) && p.runFrom === 'hub'));
  assert.deepEqual(esphomeProbes(id, d, false, []).map((p) => p.name), ['LWT']);
  // a manual equipment linked keeps its own ping, and an LWT probe of another broker is not this one
  assert.deepEqual(esphomeProbes(id, d, true, [{ target: { type: 'ping', host: '10.0.0.1' } }, { target: { type: 'mqtt', brokerId: 'jar', topic: 'esphome/command_portail/LWT' } }]).map((p) => p.name), ['LWT']);
  assert.deepEqual(esphomeProbes(id, d, true, [{ target: { type: 'mqtt', brokerId: 'vouille', topic: 'esphome/command_portail/LWT' } }]).map((p) => p.name), ['Ping']);
  // no info yet: no address to ping
  assert.deepEqual(esphomeProbes(id, { brokerId: 'vouille', uniqueId: 'four' }, true, []).map((p) => p.name), ['LWT']);
});

test('esphome equipments: the manual ones it could be, by address then by name on its site; no two names on a site', async () => {
  const { candidatesFor, nameClash, providedOf } = await import('../src/esphomeEquipments.js');
  const e = (name: string, ip?: string, siteId?: string, source: 'manual' | 'omada' = 'manual') => ({ _id: new ObjectId(), name, ...(ip ? { ip } : {}), ...(siteId ? { siteId } : {}), source });
  const list = [e('Portail', '192.168.90.20', 'v'), e('command-portail', undefined, 'v'), e('four', undefined, 'v'), e('AP', '192.168.90.20', 'v', 'omada')];
  assert.deepEqual(candidatesFor({ uniqueId: 'command_portail', info: { name: 'command-portail', ip: '192.168.90.20' } }, list, 'v').map((x) => x.name), ['Portail']);
  assert.deepEqual(candidatesFor({ uniqueId: 'command_portail', info: { name: 'command-portail' } }, list, 'v').map((x) => x.name), ['command-portail']);
  assert.deepEqual(candidatesFor({ uniqueId: 'four' }, list, 'v').map((x) => x.name), ['four']);
  assert.deepEqual(candidatesFor({ uniqueId: 'four' }, list, 'j'), []);
  assert.equal(nameClash(['ESP', 'Temp'], [{ name: 'Autre' }]), null);
  assert.equal(nameClash(['ESP', 'temp', 'Temp'], []), 'Temp');
  assert.equal(nameClash(['ESP'], [{ name: 'esp' }]), 'ESP');
  assert.deepEqual(providedOf({ info: { ip: '1.2.3.4' } }, 'v'), { type: 'iot', siteId: 'v', ip: '1.2.3.4' });
  assert.deepEqual(providedOf({}, null), { type: 'iot' });
});

test('esphome equipments: what the screen shows of the equipments of a device', async () => {
  const { equipmentsOf } = await import('../src/routes/esphome.js');
  const t = new Date();
  const d: EsphomeDeviceDoc = { _id: 'v/cave', brokerId: 'v', uniqueId: 'cave', lwt: 'online', info: { name: 'command-cave-tech', ip: '10.0.0.5', devices: [{ id: 'vmc' }, { id: 'pompe' }] }, firstSeenAt: t, lastSeenAt: t };
  const esp = { _id: new ObjectId(), name: 'Cave', source: 'esphome' as const, externalId: 'v/cave' };
  const vmc = { _id: new ObjectId(), name: 'VMC', source: 'esphome' as const, externalId: 'v/cave/vmc' };
  // a device whose key starts the same is another one
  const other = { _id: new ObjectId(), name: 'Cave 2', source: 'esphome' as const, externalId: 'v/cave2' };
  const manual = { _id: new ObjectId(), name: 'Box', ip: '10.0.0.5', source: 'manual' as const };
  assert.deepEqual(equipmentsOf(d, [esp, vmc, other, manual], 'v'), { equipment: { id: esp._id.toHexString(), name: 'Cave' }, subEquipments: { vmc: { id: vmc._id.toHexString(), name: 'VMC' } }, candidates: [] });
  assert.deepEqual(equipmentsOf(d, [other, manual], 'v'), { equipment: null, subEquipments: {}, candidates: [{ id: manual._id.toHexString(), name: 'Box', ip: '10.0.0.5' }] });
});

test('esphome equipments: no connection domain until the source writes native checks', async () => {
  const { nativeStatus } = await import('../src/monitoring.js');
  assert.equal(nativeStatus({ source: 'esphome' }, Date.now()), null);
  assert.notEqual(nativeStatus({ source: 'omada' }, Date.now()), null);
});

// --- logs (lot 4) ---------------------------------------------------------------------------------------------------

test('esphome logs: the lines as the Geiger sends them, colours removed', async () => {
  const { parseLine } = await import('../src/esphomeLogs.js');
  assert.deepEqual(parseLine('\x1b[0;33m[W][component:313]: mqtt cleared Warning flag\x1b[0m'), { severity: 4, tag: 'component', line: '313', message: 'mqtt cleared Warning flag' });
  assert.deepEqual(parseLine('\x1b[0;32m[I][mqtt:353]: Connected\x1b[0m'), { severity: 5, tag: 'mqtt', line: '353', message: 'Connected' });
  assert.deepEqual(parseLine("[D][pulse_counter:200]: 'Geiger Radiation Power CPM': Retrieved counter: 17.00 pulses/min"), { severity: 7, tag: 'pulse_counter', line: '200', message: "'Geiger Radiation Power CPM': Retrieved counter: 17.00 pulses/min" });
  assert.equal(parseLine('[E][bench:1]: x').severity, 3);
  assert.equal(parseLine('[C][wifi:1]: x').severity, 6);
  assert.equal(parseLine('[VV][scheduler:1]: x').severity, 7);
  // a tag of a lambda without line, a tag with a dot
  assert.deepEqual(parseLine('[W][cmd_portail.safety]: endstops'), { severity: 4, tag: 'cmd_portail.safety', message: 'endstops' });
  assert.deepEqual(parseLine('not a line'), { severity: 6, tag: '', message: 'not a line' });
});

test('esphome logs: a line goes to the sub-device its tag names, else to the one driver that declares it, else stays on the ESP', async () => {
  const { attach } = await import('../src/esphomeLogs.js');
  const devices = [
    { id: 'geiger', tags: ['pulse_counter'] },
    { id: 'rfid_device', tags: ['pn532'] },
    { id: 'thermistor', tags: ['htu21d', 'aht10', 'ads1115'] },
    { id: 'thermistor2', tags: ['ads1115'] },
  ];
  assert.equal(attach('geiger', devices), 'geiger');
  assert.equal(attach('geiger.alarm', devices), 'geiger');
  assert.equal(attach('pulse_counter', devices), 'geiger');
  assert.equal(attach('pn532.i2c', devices), 'rfid_device');
  assert.equal(attach('htu21d', devices), 'thermistor');
  // two sub-devices declare it: the ESP
  assert.equal(attach('ads1115', devices), null);
  assert.equal(attach('mqtt', devices), null);
  assert.equal(attach('geigerx', devices), null);
  assert.equal(attach('', devices), null);
  assert.equal(attach('geiger'), null);
});

test('esphome logs: the record written, named as the syslog lines were', async () => {
  const { parseLine, recordOf } = await import('../src/esphomeLogs.js');
  const at = new Date('2026-11-15T17:30:00.123Z');
  const d = { brokerId: 'vouille', uniqueId: 'compteur_geiger_tech', info: { name: 'compteur-geiger-tech', ip: '192.168.90.30', devices: [{ id: 'thermistor', tags: ['htu21d'] }] } };
  assert.deepEqual(recordOf(d, parseLine('[D][htu21d:055]: Got Temperature=23.1°C'), 'vouille', at), {
    _time: '2026-11-15T17:30:00.123Z',
    _msg: 'Got Temperature=23.1°C',
    hostname: 'compteur-geiger-tech',
    app_name: 'htu21d',
    severity: '7',
    level: 'debug',
    facility: '16',
    facility_keyword: 'local0',
    source: 'esphome',
    unique_id: 'compteur_geiger_tech',
    broker: 'vouille',
    device: 'thermistor',
    site: 'vouille',
    esp_line: '055',
    ip: '192.168.90.30',
  });
  // no info: the unique_id names it, no device
  const r = recordOf({ brokerId: 'v', uniqueId: 'four' }, parseLine('[I][wifi:1]: up'), null, at);
  assert.equal(r.hostname, 'four');
  assert.equal('device' in r || 'site' in r || 'ip' in r, false);
});

test('esphome logs: the lines topic only on the brokers with a device whose logs are on; the device filter', async () => {
  const { filterQuery } = await import('../src/logs.js');
  assert.deepEqual(wantedTopics(['a', 'b'], new Set(['b'])), new Map([['a', new Set(['esphome/+/LWT', 'esphome/+/info', 'esphome/+/log_level'])], ['b', new Set(['esphome/+/LWT', 'esphome/+/info', 'esphome/+/log_level', 'esphome/+/logs'])]]));
  assert.deepEqual(parseTopic('esphome/four/logs'), { uniqueId: 'four', kind: 'logs' });
  assert.equal(filterQuery({ hostnames: ['geiger'], devices: ['thermistor'] }), 'hostname:="geiger" device:="thermistor"');
  assert.equal(filterQuery({ hostnames: ['geiger'], devices: ['thermistor'], deviceSystem: true }), 'hostname:="geiger" (device:="thermistor" or (device:"" severity:<=4))');
});

test('esphome logs: lines sent by batch, kept while the server fails, the oldest dropped beyond the limit', async () => {
  const { LogShipper, MAX_PENDING } = await import('../src/esphomeLogs.js');
  const { logRole } = await import('../src/logs.js');
  // no log server: what waits is dropped
  assert.equal(logRole(), undefined);
  const none = new LogShipper(() => undefined);
  none.push({ _msg: 'a' });
  await none.flush();
  assert.equal(none.dropped, 1);
  none.stop();
  // with a server (sender stubbed), a failure keeps the lines
  const roles = await import('../src/roles.js');
  const cache = roles.allRoles() as RoleDoc[];
  cache.push({ _id: 'vl', type: 'log-server', name: 'VL', carrier: { kind: 'host', id: new ObjectId() }, config: { url: 'http://vl:9428', port: 514, protocol: 'tcp', username: '', password: '', silentHours: 6 }, createdAt: new Date() });
  try {
    const sent: number[] = [];
    let fail = true;
    const s = new LogShipper(() => 'vl', undefined, async (_c, lines) => {
      if (fail) throw new Error('down');
      sent.push(lines.length);
    });
    for (let i = 0; i < 3; i++) s.push({ _msg: String(i) });
    await s.flush();
    assert.equal(s.waiting, 3);
    assert.equal(s.lastError, 'down');
    fail = false;
    await s.flush();
    assert.deepEqual(sent, [3]);
    assert.equal(s.waiting, 0);
    s.stop();
    const big = new LogShipper(() => 'vl', undefined, async () => {
      throw new Error('down');
    });
    for (let i = 0; i < MAX_PENDING + 5; i++) big.push({ _msg: String(i) });
    assert.equal(big.dropped, 5);
    big.stop();
  } finally {
    cache.pop();
  }
});

test('esphome logs: the switch of a device is the admins’, sensitive', () => {
  assert.ok(authorize('admin', 'PUT', '/api/settings/esphome/logs'));
  assert.ok(!authorize('operator', 'PUT', '/api/settings/esphome/logs'));
  assert.ok(sensitiveAction('PUT', '/api/settings/esphome/logs'));
});

// --- level and mute (lot 5) -----------------------------------------------------------------------------------------

test('esphome mute: an ESP online, logs on, silent for too long; nothing said offline, logs off or unwatched', async () => {
  const { muteNative } = await import('../src/esphome.js');
  const now = Date.parse('2026-11-15T20:00:00Z');
  const h = 3600_000;
  const on = { logs: true, lwt: 'online' as const };
  assert.deepEqual(muteNative(on, now - 30 * 60_000, now - 10 * h, 2, now)?.checks, [{ key: 'logs', label: 'Logs reçus', level: 'ok' }]);
  assert.deepEqual(muteNative(on, now - 3 * h, now - 10 * h, 2, now)?.checks, [{ key: 'logs', label: 'Logs reçus', level: 'warn', reason: 'Muet : aucune ligne de log depuis 3 h' }]);
  // no line yet: the grace after the logs were turned on, then mute
  assert.equal(muteNative(on, null, now - h, 2, now)?.checks[0].level, 'ok');
  assert.deepEqual(muteNative(on, null, now - 5 * h, 2, now)?.checks[0], { key: 'logs', label: 'Logs reçus', level: 'warn', reason: 'Muet : aucune ligne de log reçue' });
  assert.equal(muteNative({ logs: true, lwt: 'offline' }, null, 0, 2, now), null);
  assert.equal(muteNative({ logs: false, lwt: 'online' }, null, 0, 2, now), null);
  assert.equal(muteNative(on, null, 0, 0, now), null);
  assert.equal(muteNative(on, now, now, 2, now)?.syncedAt.getTime(), now);
});

test('esphome level: a known level, for a device the hub knows', async () => {
  const a = Fastify();
  registerEsphomeRoutes(a);
  const put = (payload: unknown) => a.inject({ method: 'PUT', url: '/api/settings/esphome/level', payload });
  assert.equal((await put({ key: 'v/four', level: 'LOUD' })).statusCode, 400);
  assert.equal((await put({ key: 'v/four' })).statusCode, 400);
  assert.equal((await put({ key: 'v/four', level: 'DEBUG' })).statusCode, 404);
  assert.equal((await a.inject({ method: 'PUT', url: '/api/settings/esphome', payload: { brokers: [], silentHours: 99 } })).statusCode, 400);
  assert.ok(!authorize('operator', 'PUT', '/api/settings/esphome/level'));
});
