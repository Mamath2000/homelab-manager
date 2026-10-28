import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { equipmentAlertDays } from '../alerts.js';
import { loadSites, sameName } from '../catalog.js';
import { equipments, parseId, probes } from '../db.js';
import { SOURCE_FIELDS, equipmentDto, ipError, removeEquipment, uplinkError } from '../equipments.js';
import { publish } from '../events.js';
import { INTERVAL_RANGE, TIMEOUT_RANGE } from '../probes.js';
import { EQUIPMENT_TYPES, type EquipmentDoc, type ProbeDoc } from '../types.js';

// Equipment (equipments.ts): read by every account, written by the admins (roles.ts). Only the manual ones are
// created here; an empty siteId, ip or uplinkId clears it.

const fields = {
  name: { type: 'string', minLength: 1, maxLength: 64 },
  type: { type: 'string', enum: EQUIPMENT_TYPES },
  siteId: { type: 'string', maxLength: 24 },
  ip: { type: 'string', maxLength: 45 },
  uplinkId: { type: 'string', maxLength: 24 },
} as const;

const createBody = {
  type: 'object',
  required: ['name', 'type'],
  additionalProperties: false,
  // ping: a ping probe on the IP is created with it
  properties: { ...fields, ping: { type: 'boolean' } },
} as const;

const patchBody = { type: 'object', minProperties: 1, additionalProperties: false, properties: fields } as const;

interface Body {
  name?: string;
  type?: EquipmentDoc['type'];
  siteId?: string;
  ip?: string;
  uplinkId?: string;
  ping?: boolean;
}

async function withProbes(list: EquipmentDoc[]) {
  const own = await probes.find({ 'subject.kind': 'equipment', 'subject.id': { $in: list.map((e) => e._id) } }).sort({ name: 1 }).toArray();
  return list.map((e) => equipmentDto(e, own.filter((p) => p.subject.id.equals(e._id))));
}

// null: valid, else why not. current: the equipment edited (null when created).
async function invalid(b: Body, current: EquipmentDoc | null): Promise<string | null> {
  if (b.name !== undefined && !b.name.trim()) return 'nom vide';
  if (b.siteId && !(await loadSites()).some((s) => s.id === b.siteId)) return 'site inconnu';
  if (b.ip && ipError(b.ip.trim())) return ipError(b.ip.trim());
  if (b.uplinkId) {
    if (!parseId(b.uplinkId)) return 'équipement amont introuvable';
    const all = await equipments.find({}, { projection: { uplinkId: 1 } }).toArray();
    const up = new Map(all.map((e) => [e._id.toHexString(), e.uplinkId?.toHexString()]));
    const why = uplinkError(current?._id.toHexString() ?? null, b.uplinkId, (id) => (up.has(id) ? up.get(id) : null));
    if (why) return why;
  }
  // a name once per site
  const name = (b.name ?? current?.name ?? '').trim();
  const siteId = b.siteId !== undefined ? b.siteId || undefined : current?.siteId;
  const same = await equipments.find({ siteId: siteId ?? { $exists: false } }, { projection: { name: 1 } }).toArray();
  if (same.some((e) => !e._id.equals(current?._id ?? new ObjectId()) && sameName(e.name, name))) return `un équipement s'appelle déjà « ${name} » sur ce site`;
  return null;
}

// what an automatic source provides cannot be changed by hand
function sourceField(b: Body, current: EquipmentDoc) {
  const now: Record<(typeof SOURCE_FIELDS)[number], string> = { type: current.type, siteId: current.siteId ?? '', ip: current.ip ?? '', uplinkId: current.uplinkId?.toHexString() ?? '' };
  return SOURCE_FIELDS.find((f) => b[f] !== undefined && b[f] !== now[f]) ?? null;
}

export function registerEquipmentRoutes(app: FastifyInstance) {
  app.get('/api/equipments', async () => ({ equipments: await withProbes(await equipments.find().sort({ name: 1 }).toArray()) }));

  app.get<{ Params: { id: string } }>('/api/equipments/:id', async (req, reply) => {
    const _id = parseId(req.params.id);
    const e = _id && (await equipments.findOne({ _id }));
    if (!e) return reply.code(404).send({ error: 'equipment not found' });
    return (await withProbes([e]))[0];
  });

  // alerts of the last days, for the timeline of its page
  app.get<{ Params: { id: string } }>('/api/equipments/:id/alerts', async (req, reply) => {
    const _id = parseId(req.params.id);
    if (!_id || !(await equipments.countDocuments({ _id }, { limit: 1 }))) return reply.code(404).send({ error: 'equipment not found' });
    return { days: await equipmentAlertDays(_id) };
  });

  app.post<{ Body: Body }>('/api/equipments', { schema: { body: createBody } }, async (req, reply) => {
    const b = req.body;
    const why = await invalid(b, null);
    if (why) return reply.code(400).send({ error: why });
    const ip = b.ip?.trim();
    const doc: EquipmentDoc = {
      _id: new ObjectId(),
      name: b.name!.trim(),
      type: b.type!,
      ...(b.siteId ? { siteId: b.siteId } : {}),
      ...(ip ? { ip } : {}),
      source: 'manual',
      ...(b.uplinkId ? { uplinkId: new ObjectId(b.uplinkId) } : {}),
      createdAt: new Date(),
    };
    await equipments.insertOne(doc);
    const own: ProbeDoc[] = [];
    if (b.ping && ip) {
      own.push({
        _id: new ObjectId(),
        subject: { kind: 'equipment', id: doc._id },
        name: 'Ping',
        target: { type: 'ping', host: ip },
        runFrom: 'hub',
        intervalSec: INTERVAL_RANGE.default,
        timeoutSec: TIMEOUT_RANGE.default,
        retries: 0,
        createdAt: new Date(),
      });
      await probes.insertMany(own);
      publish('probe.config', {});
    }
    publish('equipment', { id: doc._id.toHexString() });
    return reply.code(201).send(equipmentDto(doc, own));
  });

  app.patch<{ Params: { id: string }; Body: Body }>('/api/equipments/:id', { schema: { body: patchBody } }, async (req, reply) => {
    const _id = parseId(req.params.id);
    const current = _id && (await equipments.findOne({ _id }));
    if (!current) return reply.code(404).send({ error: 'equipment not found' });
    const b = req.body;
    const locked = current.source !== 'manual' && sourceField(b, current);
    if (locked) return reply.code(400).send({ error: `${locked} : fourni par la source ${current.source}` });
    const why = await invalid(b, current);
    if (why) return reply.code(400).send({ error: why });
    const set: Partial<EquipmentDoc> = {};
    const unset: Partial<Record<'siteId' | 'ip' | 'uplinkId', ''>> = {};
    if (b.name !== undefined) set.name = b.name.trim();
    if (b.type !== undefined) set.type = b.type;
    for (const f of ['siteId', 'ip'] as const) {
      if (b[f]) set[f] = b[f]!.trim();
      else if (b[f] === '') unset[f] = '';
    }
    if (b.uplinkId) set.uplinkId = new ObjectId(b.uplinkId);
    else if (b.uplinkId === '') unset.uplinkId = '';
    const update = Object.keys(unset).length ? { $set: set, $unset: unset } : { $set: set };
    const e = (await equipments.findOneAndUpdate({ _id }, update, { returnDocument: 'after' }))!;
    // the probes that measured the old address follow the new one, their state starts over
    if (current.ip && e.ip && e.ip !== current.ip) {
      const moved = await probes.updateMany(
        { 'subject.kind': 'equipment', 'subject.id': _id, 'target.type': { $in: ['ping', 'tcp'] }, 'target.host': current.ip },
        { $set: { 'target.host': e.ip }, $unset: { state: '', since: '', message: '' } },
      );
      if (moved.modifiedCount) publish('probe.config', {});
    }
    publish('equipment', { id: e._id.toHexString() });
    return (await withProbes([e]))[0];
  });

  app.delete<{ Params: { id: string } }>('/api/equipments/:id', async (req, reply) => {
    const _id = parseId(req.params.id);
    if (!_id || !(await equipments.countDocuments({ _id }, { limit: 1 }))) return reply.code(404).send({ error: 'equipment not found' });
    await removeEquipment(_id);
    return reply.code(204).send();
  });
}
