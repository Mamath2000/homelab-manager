import assert from 'node:assert/strict';
import { createServer as createHttp } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';
import { MqttPool } from '../src/mqttPool.js';
import { checkHttp, checkPing, checkTcp, type Exec } from '../src/probeRunners.js';
import { nextState, targetError } from '../src/probes.js';
import type { MqttBroker } from '../src/types.js';

const close = (s: { close: (cb: () => void) => unknown }) => new Promise<void>((r) => s.close(() => r()));

test('target validation', () => {
  assert.equal(targetError({ type: 'ping', host: '192.168.1.1' }), null);
  assert.ok(targetError({ type: 'ping', host: '-c 10 1.1.1.1' }));
  assert.equal(targetError({ type: 'tcp', host: 'adguard.lan', port: 53 }), null);
  assert.ok(targetError({ type: 'tcp', host: 'adguard.lan', port: 70000 }));
  assert.equal(targetError({ type: 'http', url: 'https://nextcloud.example/status.php', keyword: 'installed' }), null);
  assert.ok(targetError({ type: 'http', url: 'ftp://host/' }));
  assert.ok(targetError({ type: 'http', url: 'pas une url' }));
  assert.equal(targetError({ type: 'mqtt', brokerId: 'vouille', topic: 'zigbee2mqtt/bridge/state', contains: 'online' }), null);
  assert.equal(targetError({ type: 'mqtt', brokerId: 'jarsay', topic: '$SYS/broker/heap/current' }), null);
  assert.ok(targetError({ type: 'mqtt', brokerId: 'vouille', topic: 'zigbee2mqtt/#' }));
  assert.ok(targetError({ type: 'mqtt', brokerId: 'Vou ille', topic: 't' }));
});

test('retries: a failed measure only turns the probe down after the allowed failures', () => {
  const fail = { state: 'down' as const, message: 'timeout' };
  let r = nextState({ failures: 0 }, { state: 'up' }, 2);
  assert.deepEqual(r, { state: 'up', message: null, failures: 0 });
  r = nextState(r, fail, 2);
  assert.equal(r.state, 'up');
  r = nextState(r, fail, 2);
  assert.equal(r.state, 'up');
  r = nextState(r, fail, 2);
  assert.deepEqual(r, { state: 'down', message: 'timeout', failures: 3 });
  // back up at once
  assert.deepEqual(nextState(r, { state: 'up' }, 2), { state: 'up', message: null, failures: 0 });
  // no retries: down at the first failure; a probe with no state yet stays unknown while it retries
  assert.equal(nextState({ failures: 0, state: 'up' }, fail, 0).state, 'down');
  assert.equal(nextState({ failures: 0 }, fail, 1).state, 'unknown');
});

test('unknown applies at once and is not a failure', () => {
  const r = nextState({ failures: 2, state: 'up' }, { state: 'unknown', message: 'broker injoignable' }, 3);
  assert.deepEqual(r, { state: 'unknown', message: 'broker injoignable', failures: 0 });
});

test('tcp: open port is up, closed port is down', async () => {
  const server = createServer((s) => s.end());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const up = await checkTcp('127.0.0.1', port, 2000);
  assert.equal(up.state, 'up');
  assert.ok(up.latencyMs! >= 1);
  await close(server);
  const gone = await checkTcp('127.0.0.1', port, 2000);
  assert.equal(gone.state, 'down');
  assert.equal(gone.message, 'connexion refusée');
});

test('http: status, redirect and keyword', async () => {
  const server = createHttp((req, res) => {
    if (req.url === '/ok') return void res.end('Status: Healthy');
    if (req.url === '/redirect') return void res.writeHead(302, { location: '/ok' }).end();
    if (req.url === '/teapot') return void res.writeHead(418).end();
    res.writeHead(500).end('boom');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await checkHttp(`${base}/ok`, {}, 2000)).state, 'up');
    assert.equal((await checkHttp(`${base}/redirect`, {}, 2000)).state, 'up');
    assert.equal((await checkHttp(`${base}/ok`, { keyword: 'Healthy' }, 2000)).state, 'up');
    const nokw = await checkHttp(`${base}/ok`, { keyword: 'Unhealthy' }, 2000);
    assert.equal(nokw.state, 'down');
    assert.match(nokw.message!, /mot-clé/);
    const err = await checkHttp(`${base}/boom`, {}, 2000);
    assert.deepEqual([err.state, err.message], ['down', 'code 500']);
    assert.equal((await checkHttp(`${base}/teapot`, { status: 418 }, 2000)).state, 'up');
    assert.equal((await checkHttp('http://127.0.0.1:1/', {}, 2000)).state, 'down');
  } finally {
    await close(server);
  }
});

test('ping: result of the command, and what makes the measure impossible', async () => {
  const ran: string[][] = [];
  const answer = (r: Awaited<ReturnType<Exec>>): Exec => async (_f, args) => {
    ran.push(args);
    return r;
  };
  const ok = await checkPing('192.168.1.1', 2000, answer({ code: 0, stdout: '64 bytes from 192.168.1.1: seq=0 ttl=64 time=0.412 ms', stderr: '' }));
  assert.deepEqual(ok, { state: 'up', latencyMs: 1 });
  assert.deepEqual(ran[0], ['-c', '1', '-W', '2', '192.168.1.1']);
  const lost = await checkPing('192.168.1.1', 2000, answer({ code: 1, stdout: '', stderr: '' }));
  assert.equal(lost.state, 'down');
  assert.equal((await checkPing('nope.lan', 2000, answer({ code: 1, stdout: '', stderr: 'ping: bad address nope.lan' }))).message, 'nom introuvable');
  assert.equal((await checkPing('192.168.1.1', 2000, answer({ code: 'ENOENT', stdout: '', stderr: '' }))).state, 'unknown');
  assert.equal((await checkPing('192.168.1.1', 2000, answer({ code: 1, stdout: '', stderr: 'ping: permission denied (are you root?)' }))).state, 'unknown');
  // an option is not a host: the command is not even run
  ran.length = 0;
  assert.equal((await checkPing('-f', 2000, answer({ code: 0, stdout: '', stderr: '' }))).state, 'down');
  assert.equal(ran.length, 0);
});

test('mqtt: payload must contain the value, a message must arrive in time, unreachable broker is unknown', async () => {
  const broker = await Aedes.createBroker();
  const server = createServer(broker.handle);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const b: MqttBroker = { id: 'vouille', name: 'vouille', url: `mqtt://127.0.0.1:${port}`, username: '', password: '' };
  const publisher = mqtt.connect(b.url);
  await new Promise<void>((r) => publisher.once('connect', () => r()));
  const publish = (topic: string, payload: string, retain = true) => new Promise<void>((r) => publisher.publish(topic, payload, { retain, qos: 1 }, () => r()));
  await publish('zigbee2mqtt/bridge/state', 'online');
  await publish('esphome/pv/LWT', 'offline');

  const pool = new MqttPool();
  const topics = new Set(['zigbee2mqtt/bridge/state', 'esphome/pv/LWT', 'sys/heap', 'absent/topic']);
  pool.sync([b], new Map([['vouille', topics]]));
  try {
    const up = await pool.check('vouille', 'zigbee2mqtt/bridge/state', 'online', 3000);
    assert.equal(up.state, 'up');
    const off = await pool.check('vouille', 'esphome/pv/LWT', 'online', 3000);
    assert.equal(off.state, 'down');
    assert.match(off.message!, /offline/);
    // the payload changes: the next check follows it
    await publish('zigbee2mqtt/bridge/state', 'offline');
    await new Promise((r) => setTimeout(r, 150)); // delivery to the subscriber
    assert.equal((await pool.check('vouille', 'zigbee2mqtt/bridge/state', 'online', 3000)).state, 'down');
    // nothing expected in the payload: any message within the delay
    await publish('sys/heap', '123456', false);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await pool.check('vouille', 'sys/heap', undefined, 3000)).state, 'up');
    const silent = await pool.check('vouille', 'absent/topic', undefined, 600);
    assert.deepEqual([silent.state, silent.message], ['down', 'aucun message en 1 s']);
    // not a configured topic
    assert.equal((await pool.check('vouille', 'other', 'x', 500)).state, 'unknown');
    assert.equal((await pool.check('missing', 'other', 'x', 500)).state, 'unknown');
  } finally {
    pool.closeAll();
    await new Promise<void>((r) => publisher.end(true, {}, () => r()));
    await close(server);
    await new Promise<void>((r) => broker.close(() => r()));
  }

  // broker down: the measure is impossible, the service is not judged
  const lost = new MqttPool();
  lost.sync([{ ...b, url: 'mqtt://127.0.0.1:1' }], new Map([['vouille', new Set(['t'])]]));
  try {
    const m = await lost.check('vouille', 't', 'online', 800);
    assert.equal(m.state, 'unknown');
    assert.match(m.message!, /broker injoignable/);
  } finally {
    lost.closeAll();
  }
});
