import type { FastifyInstance, FastifyReply } from 'fastify';
import { ObjectId } from 'mongodb';
import { dayKey, ALERT_DAYS } from '../alerts.js';
import { equipments, hosts, parseId, probeDays, probes } from '../db.js';
import { STACK_RE } from '../docker.js';
import { publish } from '../events.js';
import { hostDto } from '../hostDto.js';
import { testConnection } from '../homeassistant/bridge.js';
import { BROKER_ID_RE, INTERVAL_RANGE, MAX_RETRIES, TIMEOUT_RANGE, loadMqttBrokers, probeEngine, roleUrl, targetError, testTarget } from '../probes.js';
import { BROKER_SCHEMES, type BrokerScheme, type HostRole, type ProbeDoc, type ProbeSubject, type ProbeTarget } from '../types.js';

// Probes of the hosts and equipment, and the MQTT brokers they listen to. Writes are for admins only (roles.ts refuses what it
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
    hostId: p.subject.kind === 'host' ? p.subject.id.toHexString() : null,
    equipmentId: p.subject.kind === 'equipment' ? p.subject.id.toHexString() : null,
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
async function invalid(b: ProbeBody, subject: Pick<ProbeSubject, 'kind' | 'id'>, reply: FastifyReply) {
  const bad = (error: string) => reply.code(400).send({ error });
  const timeoutSec = b.timeoutSec ?? TIMEOUT_RANGE.default;
  const intervalSec = b.intervalSec ?? INTERVAL_RANGE.default;
  const why = targetError(b.target);
  if (why) return bad(why);
  if (timeoutSec > intervalSec) return bad("le délai maximal dépasse l'intervalle");
  const t = b.target;
  if (t.type === 'mqtt' && !(await loadMqttBrokers()).brokers.some((x) => x.id === t.brokerId)) return bad('broker inconnu');
  if (b.stack) {
    if (subject.kind !== 'host') return bad("pas de stack hors d'un hôte");
    const host = await hosts.findOne({ _id: subject.id }, { projection: { docker: 1 } });
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

const roleBody = {
  type: 'object',
  required: ['name', 'scheme', 'port', 'username'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 64 },
    scheme: { enum: BROKER_SCHEMES },
    port: { type: 'integer', minimum: 1, maximum: 65535 },
    // absent or "": the first private IP of the host
    address: { type: 'string', maxLength: 253, pattern: '^[A-Za-z0-9.:_-]*$' },
    username: { type: 'string', maxLength: 128 },
    password: { type: 'string', maxLength: 256 }, // absent: unchanged, "": cleared
  },
} as const;

interface RoleBody {
  name: string;
  scheme: BrokerScheme;
  port: number;
  address?: string;
  username: string;
  password?: string;
}

async function saveRoles(hostId: ObjectId, roles: HostRole[]) {
  await hosts.updateOne({ _id: hostId }, { $set: { roles } });
  publish('probe.config', {});
  const h = await hosts.findOne({ _id: hostId });
  if (h) publish('host', hostDto(h));
}

// What a probe can be attached to, with the path of its probes
const SUBJECTS = [
  { kind: 'host', path: '/api/hosts/:id/probes', exists: (_id: ObjectId) => hosts.countDocuments({ _id }, { limit: 1 }), missing: 'host not found' },
  { kind: 'equipment', path: '/api/equipments/:id/probes', exists: (_id: ObjectId) => equipments.countDocuments({ _id }, { limit: 1 }), missing: 'equipment not found' },
] as const;

const subjectOf = (kind: 'host' | 'equipment', id: ObjectId, stack?: string): ProbeSubject =>
  kind === 'host' ? { kind, id, ...(stack ? { stack } : {}) } : { kind, id };

export function registerProbeRoutes(app: FastifyInstance) {
  // measures by state and day of every probe over the last days (blocks of the Probes page)
  app.get('/api/probes/days', async () => {
    const from = new Date();
    from.setDate(from.getDate() - (ALERT_DAYS - 1));
    const list = await probeDays.find({ day: { $gte: dayKey(from) } }).sort({ day: 1 }).toArray();
    return { days: list.map((d) => ({ probeId: d.probeId.toHexString(), day: d.day, up: d.up ?? 0, down: d.down ?? 0, unknown: d.unknown ?? 0 })) };
  });

  // every probe, of hosts and equipments (Probes page)
  app.get('/api/probes', async () => ({ probes: (await probes.find({}).sort({ name: 1 }).toArray()).map(dto) }));

  for (const { kind, path, exists, missing } of SUBJECTS) {
    app.get<{ Params: { id: string } }>(path, async (req, reply) => {
      const _id = parseId(req.params.id);
      if (!_id || !(await exists(_id))) return reply.code(404).send({ error: missing });
      return { probes: (await probes.find({ 'subject.kind': kind, 'subject.id': _id }).sort({ name: 1 }).toArray()).map(dto) };
    });

    app.post<{ Params: { id: string }; Body: ProbeBody }>(path, { schema: { body: probeBody } }, async (req, reply) => {
      const _id = parseId(req.params.id);
      if (!_id || !(await exists(_id))) return reply.code(404).send({ error: missing });
      const b = req.body;
      if (await invalid(b, { kind, id: _id }, reply)) return;
      const doc: ProbeDoc = {
        _id: new ObjectId(),
        subject: subjectOf(kind, _id, b.stack),
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
  }

  app.put<{ Params: { id: string }; Body: ProbeBody }>('/api/probes/:id', { schema: { body: probeBody } }, async (req, reply) => {
    const _id = parseId(req.params.id);
    const current = _id && (await probes.findOne({ _id }));
    if (!current || current.subject.kind === 'site') return reply.code(404).send({ error: 'probe not found' });
    const b = req.body;
    if (await invalid(b, current.subject, reply)) return;
    const next = {
      subject: subjectOf(current.subject.kind, current.subject.id, b.stack),
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

  // --- MQTT brokers of the probes: roles of the hosts (the agent reports the candidates, see hostDto) --------

  // all the brokers, for the form of a probe
  app.get('/api/settings/mqtt-brokers', async () => {
    const [{ brokers }, used, list] = await Promise.all([loadMqttBrokers(), probes.find({ 'target.type': 'mqtt' }).toArray(), hosts.find({ 'roles.0': { $exists: true } }, { projection: { name: 1 } }).toArray()]);
    const names = new Map(list.map((h) => [h._id.toHexString(), h.name]));
    return {
      brokers: brokers.map((b) => ({
        id: b.id,
        name: b.name,
        url: b.url,
        username: b.username,
        hasPassword: !!b.password,
        hostId: b.hostId.toHexString(),
        hostName: names.get(b.hostId.toHexString()) ?? '',
        status: probeEngine()?.pool.status(b.id) ?? null,
        probes: used.filter((p) => p.target.type === 'mqtt' && p.target.brokerId === b.id).length,
      })),
    };
  });

  const hostOf = async (id: string) => {
    const _id = parseId(id);
    return _id ? hosts.findOne({ _id }, { projection: { roles: 1, info: 1, roleCandidates: 1 } }) : null;
  };

  app.post<{ Params: { id: string }; Body: RoleBody }>('/api/hosts/:id/roles', { schema: { body: roleBody } }, async (req, reply) => {
    const host = await hostOf(req.params.id);
    if (!host) return reply.code(404).send({ error: 'host not found' });
    // a broker is activated from what the agent detected, never declared by hand
    if (!host.roleCandidates?.some((c) => c.type === 'mqtt-broker' && c.port === req.body.port)) return reply.code(409).send({ error: "aucun broker détecté par l'agent sur ce port" });
    if (host.roles?.some((r) => r.port === req.body.port)) return reply.code(409).send({ error: 'ce broker est déjà activé' });
    const name = req.body.name.trim();
    const all = (await loadMqttBrokers()).brokers;
    if (all.some((b) => b.name.toLowerCase() === name.toLowerCase())) return reply.code(409).send({ error: 'un broker porte déjà ce nom' });
    const base = idOf(name) || 'broker';
    let id = base;
    for (let n = 2; all.some((b) => b.id === id); n++) id = `${base.slice(0, 29)}-${n}`;
    if (!BROKER_ID_RE.test(id)) return reply.code(400).send({ error: 'nom invalide' });
    const role: HostRole = {
      id,
      type: 'mqtt-broker',
      name,
      scheme: req.body.scheme,
      port: req.body.port,
      ...(req.body.address ? { address: req.body.address } : {}),
      username: req.body.username,
      password: req.body.password ?? '',
    };
    await saveRoles(host._id, [...(host.roles ?? []), role]);
    return reply.code(201).send({ id });
  });

  app.put<{ Params: { id: string; roleId: string }; Body: RoleBody }>('/api/hosts/:id/roles/:roleId', { schema: { body: roleBody } }, async (req, reply) => {
    const host = await hostOf(req.params.id);
    const current = host?.roles?.find((r) => r.id === req.params.roleId);
    if (!host || !current) return reply.code(404).send({ error: 'rôle inconnu' });
    if (req.body.port !== current.port) return reply.code(400).send({ error: 'le port est celui détecté par l’agent' });
    const name = req.body.name.trim();
    const all = (await loadMqttBrokers()).brokers;
    if (all.some((b) => b.id !== current.id && b.name.toLowerCase() === name.toLowerCase())) return reply.code(409).send({ error: 'un broker porte déjà ce nom' });
    const next: HostRole = {
      id: current.id,
      type: 'mqtt-broker',
      name,
      scheme: req.body.scheme,
      port: req.body.port,
      ...(req.body.address ? { address: req.body.address } : {}),
      username: req.body.username,
      password: req.body.password ?? current.password,
    };
    await saveRoles(host._id, (host.roles ?? []).map((r) => (r.id === current.id ? next : r)));
    return { id: current.id };
  });

  app.delete<{ Params: { id: string; roleId: string } }>('/api/hosts/:id/roles/:roleId', async (req, reply) => {
    const host = await hostOf(req.params.id);
    if (!host || !host.roles?.some((r) => r.id === req.params.roleId)) return reply.code(404).send({ error: 'rôle inconnu' });
    const used = await probes.find({ 'target.type': 'mqtt', 'target.brokerId': req.params.roleId }).toArray();
    if (used.length) return reply.code(409).send({ error: `utilisé par ${used.length} sonde(s) : ${used.slice(0, 5).map((p) => p.name).join(', ')}${used.length > 5 ? '…' : ''}` });
    await saveRoles(host._id, host.roles.filter((r) => r.id !== req.params.roleId));
    return reply.code(204).send();
  });

  // connection test of a broker being edited; `roleId`: the stored password is used when none is typed
  app.post<{ Params: { id: string }; Body: Omit<RoleBody, 'name'> & { roleId?: string } }>(
    '/api/hosts/:id/roles/test',
    { schema: { body: { ...roleBody, required: ['scheme', 'port', 'username'], properties: { ...roleBody.properties, name: { type: 'string', maxLength: 64 }, roleId: { type: 'string', maxLength: 32 } } } } },
    async (req, reply) => {
      const host = await hostOf(req.params.id);
      if (!host) return reply.code(404).send({ error: 'host not found' });
      const url = roleUrl(req.body, host.info?.ips);
      if (!url) return { ok: false, error: "adresse de l'hôte inconnue : la saisir" };
      const stored = req.body.roleId ? host.roles?.find((r) => r.id === req.body.roleId) : undefined;
      try {
        await testConnection(url, req.body.username, req.body.password ?? stored?.password ?? '');
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );
}
