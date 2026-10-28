import type { FastifyInstance, FastifyReply } from 'fastify';
import { ObjectId } from 'mongodb';
import { hosts, parseId, probes, settings } from '../db.js';
import { STACK_RE } from '../docker.js';
import { publish } from '../events.js';
import { testConnection } from '../homeassistant/bridge.js';
import { BROKER_ID_RE, INTERVAL_RANGE, MAX_RETRIES, TIMEOUT_RANGE, loadMqttBrokers, probeEngine, targetError, testTarget } from '../probes.js';
import type { MqttBroker, MqttBrokersSettings, ProbeDoc, ProbeTarget } from '../types.js';

// Probes of the hosts and the MQTT brokers they listen to. Writes are for admins only (roles.ts refuses what it
// does not list): the hub opens connections to what is typed here.

// One flat shape for all the types (an anyOf of closed objects would have the validator strip the fields of the
// types it tries first): what each type needs is checked by targetError.
const target = {
  type: 'object',
  required: ['type'],
  additionalProperties: false,
  properties: {
    type: { enum: ['mqtt', 'ping', 'tcp', 'http'] },
    brokerId: { type: 'string', maxLength: 32 },
    topic: { type: 'string', maxLength: 256 },
    contains: { type: 'string', maxLength: 256 },
    host: { type: 'string', maxLength: 253 },
    port: { type: 'integer', minimum: 1, maximum: 65535 },
    url: { type: 'string', maxLength: 2048 },
    status: { type: 'integer', minimum: 100, maximum: 599 },
    keyword: { type: 'string', maxLength: 256 },
    insecure: { type: 'boolean' },
  },
} as const;

const timing = {
  intervalSec: { type: 'integer', minimum: INTERVAL_RANGE.min, maximum: INTERVAL_RANGE.max },
  timeoutSec: { type: 'integer', minimum: TIMEOUT_RANGE.min, maximum: TIMEOUT_RANGE.max },
} as const;

const probeBody = {
  type: 'object',
  required: ['name', 'target'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 64 },
    stack: { type: 'string', maxLength: 64 },
    target,
    ...timing,
    retries: { type: 'integer', minimum: 0, maximum: MAX_RETRIES },
  },
} as const;

const testBody = { type: 'object', required: ['target'], additionalProperties: false, properties: { target, timeoutSec: timing.timeoutSec } } as const;

interface ProbeBody {
  name: string;
  stack?: string;
  target: ProbeTarget;
  intervalSec?: number;
  timeoutSec?: number;
  retries?: number;
}

// empty optional fields are left out
function clean(t: ProbeTarget): ProbeTarget {
  if (t.type === 'mqtt') return { type: 'mqtt', brokerId: t.brokerId, topic: t.topic, ...(t.contains ? { contains: t.contains } : {}) };
  if (t.type === 'http') return { type: 'http', url: t.url, ...(t.status ? { status: t.status } : {}), ...(t.keyword ? { keyword: t.keyword } : {}), ...(t.insecure ? { insecure: true } : {}) };
  return t;
}

function dto(p: ProbeDoc) {
  const live = probeEngine()?.liveOf(p._id.toHexString());
  return {
    id: p._id.toHexString(),
    hostId: p.subject.id.toHexString(),
    stack: p.subject.stack ?? null,
    name: p.name,
    target: p.target,
    runFrom: p.runFrom,
    intervalSec: p.intervalSec,
    timeoutSec: p.timeoutSec,
    retries: p.retries,
    state: p.state ?? 'unknown',
    since: p.since ?? null,
    message: p.message ?? null,
    checkedAt: live?.checkedAt ?? null,
    latencyMs: live?.latencyMs ?? null,
  };
}

// null: valid; else the answer to send
async function invalid(b: ProbeBody, hostId: ObjectId, reply: FastifyReply) {
  const bad = (error: string) => reply.code(400).send({ error });
  const timeoutSec = b.timeoutSec ?? TIMEOUT_RANGE.default;
  const intervalSec = b.intervalSec ?? INTERVAL_RANGE.default;
  const why = targetError(b.target);
  if (why) return bad(why);
  if (timeoutSec > intervalSec) return bad("le délai maximal dépasse l'intervalle");
  const t = b.target;
  if (t.type === 'mqtt' && !(await loadMqttBrokers()).brokers.some((x) => x.id === t.brokerId)) return bad('broker inconnu');
  if (b.stack) {
    const host = await hosts.findOne({ _id: hostId }, { projection: { docker: 1 } });
    if (!STACK_RE.test(b.stack) || !host?.docker?.stacks.some((s) => s.name === b.stack)) return bad("stack inconnue sur cet hôte");
  }
  return null;
}

const idOf = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

const brokerBody = {
  type: 'object',
  required: ['name', 'url', 'username'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 64 },
    url: { type: 'string', maxLength: 256, pattern: '^(mqtts?|wss?)://[^\\s]+$' },
    username: { type: 'string', maxLength: 128 },
    password: { type: 'string', maxLength: 256 }, // absent: unchanged, "": cleared
  },
} as const;

interface BrokerBody {
  name: string;
  url: string;
  username: string;
  password?: string;
}

async function saveBrokers(brokers: MqttBroker[]) {
  await settings.replaceOne({ _id: 'mqttBrokers' }, { _id: 'mqttBrokers', brokers } satisfies MqttBrokersSettings, { upsert: true });
  publish('probe.config', {});
}

export function registerProbeRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/hosts/:id/probes', async (req, reply) => {
    const _id = parseId(req.params.id);
    if (!_id || !(await hosts.countDocuments({ _id }, { limit: 1 }))) return reply.code(404).send({ error: 'host not found' });
    return { probes: (await probes.find({ 'subject.kind': 'host', 'subject.id': _id }).sort({ name: 1 }).toArray()).map(dto) };
  });

  app.post<{ Params: { id: string }; Body: ProbeBody }>('/api/hosts/:id/probes', { schema: { body: probeBody } }, async (req, reply) => {
    const _id = parseId(req.params.id);
    if (!_id || !(await hosts.countDocuments({ _id }, { limit: 1 }))) return reply.code(404).send({ error: 'host not found' });
    const b = req.body;
    if (await invalid(b, _id, reply)) return;
    const doc: ProbeDoc = {
      _id: new ObjectId(),
      subject: { kind: 'host', id: _id, ...(b.stack ? { stack: b.stack } : {}) },
      name: b.name.trim(),
      target: clean(b.target),
      runFrom: 'hub',
      intervalSec: b.intervalSec ?? INTERVAL_RANGE.default,
      timeoutSec: b.timeoutSec ?? TIMEOUT_RANGE.default,
      retries: b.retries ?? 0,
      createdAt: new Date(),
    };
    await probes.insertOne(doc);
    publish('probe.config', {});
    return reply.code(201).send(dto(doc));
  });

  app.put<{ Params: { id: string }; Body: ProbeBody }>('/api/probes/:id', { schema: { body: probeBody } }, async (req, reply) => {
    const _id = parseId(req.params.id);
    const current = _id && (await probes.findOne({ _id }));
    if (!current || current.subject.kind !== 'host') return reply.code(404).send({ error: 'probe not found' });
    const b = req.body;
    if (await invalid(b, current.subject.id, reply)) return;
    const next = {
      subject: { kind: 'host' as const, id: current.subject.id, ...(b.stack ? { stack: b.stack } : {}) },
      name: b.name.trim(),
      target: clean(b.target),
      intervalSec: b.intervalSec ?? INTERVAL_RANGE.default,
      timeoutSec: b.timeoutSec ?? TIMEOUT_RANGE.default,
      retries: b.retries ?? 0,
    };
    // what it measures changed: the old state says nothing about the new target
    const moved = JSON.stringify(next.target) !== JSON.stringify(current.target);
    await probes.updateOne({ _id }, { $set: next, ...(moved ? { $unset: { state: '', since: '', message: '' } } : {}) });
    publish('probe.config', {});
    return dto((await probes.findOne({ _id }))!);
  });

  app.delete<{ Params: { id: string } }>('/api/probes/:id', async (req, reply) => {
    const _id = parseId(req.params.id);
    const res = _id && (await probes.deleteOne({ _id }));
    if (!res || !res.deletedCount) return reply.code(404).send({ error: 'probe not found' });
    publish('probe.config', {});
    return reply.code(204).send();
  });

  // measures now, saves nothing
  app.post<{ Body: { target: ProbeTarget; timeoutSec?: number } }>('/api/probes/test', { schema: { body: testBody } }, async (req, reply) => {
    const why = targetError(req.body.target);
    if (why) return reply.code(400).send({ error: why });
    return testTarget(clean(req.body.target), req.body.timeoutSec ?? TIMEOUT_RANGE.default);
  });

  // --- MQTT brokers of the probes ---------------------------------------------------------------

  app.get('/api/settings/mqtt-brokers', async () => {
    const [{ brokers }, used] = await Promise.all([loadMqttBrokers(), probes.find({ 'target.type': 'mqtt' }).toArray()]);
    return {
      brokers: brokers.map((b) => ({
        id: b.id,
        name: b.name,
        url: b.url,
        username: b.username,
        hasPassword: !!b.password,
        status: probeEngine()?.pool.status(b.id) ?? null,
        probes: used.filter((p) => p.target.type === 'mqtt' && p.target.brokerId === b.id).length,
      })),
    };
  });

  app.post<{ Body: BrokerBody }>('/api/settings/mqtt-brokers', { schema: { body: brokerBody } }, async (req, reply) => {
    const { brokers } = await loadMqttBrokers();
    const name = req.body.name.trim();
    if (brokers.some((b) => b.name.toLowerCase() === name.toLowerCase())) return reply.code(409).send({ error: 'un broker porte déjà ce nom' });
    const base = idOf(name) || 'broker';
    let id = base;
    for (let n = 2; brokers.some((b) => b.id === id); n++) id = `${base.slice(0, 29)}-${n}`;
    if (!BROKER_ID_RE.test(id)) return reply.code(400).send({ error: 'nom invalide' });
    const broker: MqttBroker = { id, name, url: req.body.url, username: req.body.username, password: req.body.password ?? '' };
    await saveBrokers([...brokers, broker]);
    return reply.code(201).send({ id });
  });

  app.put<{ Params: { id: string }; Body: BrokerBody }>('/api/settings/mqtt-brokers/:id', { schema: { body: brokerBody } }, async (req, reply) => {
    const { brokers } = await loadMqttBrokers();
    const current = brokers.find((b) => b.id === req.params.id);
    if (!current) return reply.code(404).send({ error: 'broker inconnu' });
    const name = req.body.name.trim();
    if (brokers.some((b) => b.id !== current.id && b.name.toLowerCase() === name.toLowerCase())) return reply.code(409).send({ error: 'un broker porte déjà ce nom' });
    const next: MqttBroker = { id: current.id, name, url: req.body.url, username: req.body.username, password: req.body.password ?? current.password };
    await saveBrokers(brokers.map((b) => (b.id === current.id ? next : b)));
    return { id: current.id };
  });

  app.delete<{ Params: { id: string } }>('/api/settings/mqtt-brokers/:id', async (req, reply) => {
    const { brokers } = await loadMqttBrokers();
    if (!brokers.some((b) => b.id === req.params.id)) return reply.code(404).send({ error: 'broker inconnu' });
    const used = await probes.find({ 'target.type': 'mqtt', 'target.brokerId': req.params.id }).toArray();
    if (used.length) return reply.code(409).send({ error: `utilisé par ${used.length} sonde(s) : ${used.slice(0, 5).map((p) => p.name).join(', ')}${used.length > 5 ? '…' : ''}` });
    await saveBrokers(brokers.filter((b) => b.id !== req.params.id));
    return reply.code(204).send();
  });

  // connection test of a broker being edited; `id`: the stored password is used when none is typed
  app.post<{ Body: BrokerBody & { id?: string } }>(
    '/api/settings/mqtt-brokers/test',
    { schema: { body: { ...brokerBody, properties: { ...brokerBody.properties, id: { type: 'string', maxLength: 32 } }, required: ['url', 'username'] } } },
    async (req) => {
      const stored = req.body.id ? (await loadMqttBrokers()).brokers.find((b) => b.id === req.body.id) : undefined;
      try {
        await testConnection(req.body.url, req.body.username, req.body.password ?? stored?.password ?? '');
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );
}
