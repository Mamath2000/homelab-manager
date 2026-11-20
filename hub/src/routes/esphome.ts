import type { FastifyInstance } from 'fastify';
import { settingsDiff } from '../audit.js';
import { loadSites } from '../catalog.js';
import { equipments, parseId, roles } from '../db.js';
import { DEFAULT_LEVEL, deviceMute, ESPHOME_SILENT_HOURS, esphomeDevices, esphomeShipper, forgetDevices, lastLineOf, LOG_LEVELS, setDeviceLevel, setDeviceLogs, type LogLevel } from '../esphome.js';
import { logRole } from '../logs.js';
import { candidatesFor, createEsphomeEquipments, EsphomeLinkError, subKey, syncAllEsphomeEquipments } from '../esphomeEquipments.js';
import { probeEngine } from '../probes.js';
import { rolesSaved } from '../roleEvents.js';
import { allRoles, esphomeRoles, newRoleId, roleConflict } from '../roles.js';
import type { EquipmentDoc, EsphomeConfig, EsphomeDeviceDoc, EsphomeRole, MqttBrokerRole } from '../types.js';

// Rôles › ESPHome (admin, homelab#352, #358): one esphome role per site, carried by the hub, declared and removed here.
// Each listens to one broker (mqtt-broker role) for the devices of its site. The devices found on each broker, as their
// messages left them (esphome.ts).

const brokerRoles = () => allRoles().filter((r): r is MqttBrokerRole => r.type === 'mqtt-broker');

const roleBody = {
  type: 'object',
  required: ['siteId', 'brokerId'],
  additionalProperties: false,
  properties: {
    siteId: { type: 'string', minLength: 1, maxLength: 24 },
    brokerId: { type: 'string', minLength: 1, maxLength: 32 },
    // absent: "ESPHome — <site>"
    name: { type: 'string', maxLength: 64 },
    // hours without a line before an ESP online is mute (0: not watched)
    silentHours: { type: 'integer', minimum: 0, maximum: 48 },
  },
} as const;

// null: the role may listen to this broker for this site, else why not (self: the role being edited)
export function esphomeError(c: { siteId: string; brokerId: string }, brokerIds: Set<string>, siteIds: Set<string>, others: EsphomeRole[]) {
  if (!siteIds.has(c.siteId)) return `site inconnu : ${c.siteId}`;
  if (!brokerIds.has(c.brokerId)) return `broker inconnu : ${c.brokerId}`;
  if (others.some((r) => r.config.siteId === c.siteId)) return 'un rôle ESPHome est déjà déclaré pour ce site';
  if (others.some((r) => r.config.brokerId === c.brokerId)) return 'ce broker est déjà écouté par un autre rôle ESPHome';
  return null;
}

export const toEsphomeConfig = (c: { siteId: string; brokerId: string }, silentHours?: number): EsphomeConfig => ({
  siteId: c.siteId,
  brokerId: c.brokerId,
  ...(silentHours !== undefined ? { silentHours } : {}),
});

type Box = Pick<EquipmentDoc, '_id' | 'name' | 'ip' | 'siteId' | 'source' | 'externalId'>;
const ref = (e: Box) => ({ id: e._id.toHexString(), name: e.name });

// The equipments of a device, as the screen shows them: the ESP's, the ones of its sub-devices (by id), and the manual
// equipments it could be linked to while it has none.
export function equipmentsOf(d: EsphomeDeviceDoc, list: Box[], siteId: string | null | undefined) {
  const byKey = new Map(list.filter((e) => e.source === 'esphome').map((e) => [e.externalId!, e]));
  const own = byKey.get(d._id);
  const subs = Object.fromEntries((d.info?.devices ?? []).flatMap((s) => (byKey.has(subKey(d._id, s.id)) ? [[s.id, ref(byKey.get(subKey(d._id, s.id))!)]] : [])));
  return { equipment: own ? ref(own) : null, subEquipments: subs, candidates: own ? [] : candidatesFor(d, list, siteId).map((e) => ({ ...ref(e), ip: e.ip ?? null })) };
}

// A device as the screen shows it (key: the one its actions name).
export const deviceView = (d: EsphomeDeviceDoc) => ({
  key: d._id,
  brokerId: d.brokerId,
  uniqueId: d.uniqueId,
  name: d.info?.name ?? null,
  ip: d.info?.ip ?? null,
  mac: d.info?.mac ?? null,
  version: d.info?.version ?? null,
  devices: d.info?.devices ?? [],
  // no info received: an ESP whose package does not publish it yet
  hasInfo: !!d.info,
  infoError: d.infoError ?? null,
  lwt: d.lwt,
  lwtAt: d.lwtAt ?? null,
  level: d.level ?? null,
  // its lines forwarded to the log server, and the last one received (ms, since the hub started)
  logs: !!d.logs,
  lastLineAt: lastLineOf(d._id),
  // why it is mute (null: it is not, or not watched)
  mute: deviceMute(d)?.checks.find((c) => c.level !== 'ok')?.reason ?? null,
  firstSeenAt: d.firstSeenAt,
  lastSeenAt: d.lastSeenAt,
});

export function registerEsphomeRoutes(app: FastifyInstance) {
  app.get('/api/settings/esphome', async () => {
    const engine = probeEngine();
    const boxes = await equipments.find({ source: { $in: ['esphome', 'manual'] } }, { projection: { name: 1, ip: 1, siteId: 1, source: 1, externalId: 1 } }).toArray();
    const brokers = brokerRoles().map((b) => ({ id: b._id, name: b.name }));
    const shipper = esphomeShipper();
    return {
      // where the lines go (null: no log server, the logs cannot be turned on), and how the writing goes
      logServer: logRole()?._id ?? null,
      shipping: shipper ? { sent: shipper.sent, dropped: shipper.dropped, waiting: shipper.waiting, error: shipper.lastError } : null,
      roles: esphomeRoles().map((r) => ({
        id: r._id,
        name: r.name,
        siteId: r.config.siteId,
        brokerId: r.config.brokerId,
        brokerName: brokers.find((x) => x.id === r.config.brokerId)?.name ?? r.config.brokerId,
        silentHours: r.config.silentHours ?? ESPHOME_SILENT_HOURS,
        status: engine?.pool.status(r.config.brokerId) ?? null,
        devices: esphomeDevices(r.config.brokerId).map((d) => ({ ...deviceView(d), ...equipmentsOf(d, boxes, r.config.siteId) })),
      })),
      // the brokers that may be listened to
      brokers,
      // the levels a device may be set to, and the one it boots at
      levels: LOG_LEVELS,
      defaultLevel: DEFAULT_LEVEL,
    };
  });

  app.post<{ Body: { siteId: string; brokerId: string; name?: string; silentHours?: number } }>('/api/settings/esphome', { schema: { body: roleBody } }, async (req, reply) => {
    const sites = await loadSites();
    const bad = esphomeError(req.body, new Set(brokerRoles().map((b) => b._id)), new Set(sites.map((s) => s.id)), esphomeRoles());
    if (bad) return reply.code(409).send({ error: bad });
    const name = req.body.name?.trim() || `ESPHome — ${sites.find((s) => s.id === req.body.siteId)?.name ?? req.body.siteId}`;
    const why = roleConflict(allRoles(), 'esphome', name, null, toEsphomeConfig(req.body));
    if (why) return reply.code(409).send({ error: why });
    const taken = new Set(allRoles().map((r) => r._id));
    const doc: EsphomeRole = { _id: newRoleId(name, (id) => taken.has(id)), type: 'esphome', name, carrier: { kind: 'hub' }, config: toEsphomeConfig(req.body, req.body.silentHours), createdAt: new Date() };
    await roles.insertOne(doc);
    req.auditNote = { target: { kind: 'role', id: doc._id, name: doc.name }, details: { type: doc.type, carrier: 'hub', siteId: doc.config.siteId, brokerId: doc.config.brokerId } };
    await rolesSaved([]);
    await syncAllEsphomeEquipments();
    return reply.code(201).send({ id: doc._id });
  });

  app.put<{ Params: { id: string }; Body: { siteId: string; brokerId: string; name?: string; silentHours?: number } }>('/api/settings/esphome/:id', { schema: { body: roleBody } }, async (req, reply) => {
    const current = esphomeRoles().find((r) => r._id === req.params.id);
    if (!current) return reply.code(404).send({ error: 'rôle ESPHome inconnu' });
    const sites = await loadSites();
    const bad = esphomeError(req.body, new Set(brokerRoles().map((b) => b._id)), new Set(sites.map((s) => s.id)), esphomeRoles().filter((r) => r._id !== current._id));
    if (bad) return reply.code(409).send({ error: bad });
    const name = req.body.name?.trim() || current.name;
    const why = roleConflict(allRoles(), 'esphome', name, null, toEsphomeConfig(req.body), current._id);
    if (why) return reply.code(409).send({ error: why });
    const config = toEsphomeConfig(req.body, req.body.silentHours ?? current.config.silentHours);
    await roles.replaceOne({ _id: current._id }, { ...current, name, config });
    req.auditNote = { target: { kind: 'role', id: current._id, name }, details: { type: current.type, ...settingsDiff(current.config, config) } };
    await rolesSaved([]);
    await forgetDevices(new Set(esphomeRoles().map((r) => r.config.brokerId)));
    // the site of a broker may have changed: its equipments follow
    await syncAllEsphomeEquipments();
    return { id: current._id };
  });

  // The lines of an ESP forwarded to the log server, or not. Only for an ESP that is an equipment.
  app.put<{ Body: { key: string; enabled: boolean } }>(
    '/api/settings/esphome/logs',
    { schema: { body: { type: 'object', required: ['key', 'enabled'], additionalProperties: false, properties: { key: { type: 'string', minLength: 3, maxLength: 128 }, enabled: { type: 'boolean' } } } } },
    async (req, reply) => {
      const d = esphomeDevices().find((x) => x._id === req.body.key);
      if (!d) return reply.code(404).send({ error: 'appareil inconnu' });
      if (req.body.enabled) {
        if (!logRole()) return reply.code(409).send({ error: 'aucun serveur de logs : déclarer un rôle Serveur de logs' });
        if (!(await equipments.countDocuments({ source: 'esphome', externalId: d._id }, { limit: 1 }))) return reply.code(409).send({ error: "créer d'abord l'équipement de l'appareil" });
      }
      await setDeviceLogs(d._id, req.body.enabled);
      req.auditNote = { target: { kind: 'equipment', id: d._id, name: d.info?.name ?? d.uniqueId }, details: { enabled: req.body.enabled } };
      return { key: d._id, logs: req.body.enabled };
    },
  );

  // Another level for the logger of an ESP online, until it reboots (the command is never retained).
  app.put<{ Body: { key: string; level: LogLevel } }>(
    '/api/settings/esphome/level',
    { schema: { body: { type: 'object', required: ['key', 'level'], additionalProperties: false, properties: { key: { type: 'string', minLength: 3, maxLength: 128 }, level: { enum: LOG_LEVELS } } } } },
    async (req, reply) => {
      const d = esphomeDevices().find((x) => x._id === req.body.key);
      if (!d) return reply.code(404).send({ error: 'appareil inconnu' });
      if (d.lwt !== 'online') return reply.code(409).send({ error: "l'appareil est hors ligne : la commande, non conservée, serait perdue" });
      if (!(await setDeviceLevel(d._id, req.body.level))) return reply.code(502).send({ error: 'broker non connecté' });
      return { key: d._id, level: req.body.level };
    },
  );

  // Makes the equipment of an ESP (or links it to a manual one, equipmentId) and the ones of the sub-devices chosen; on an
  // ESP already made, the sub-devices it lacks.
  app.post<{ Body: { key: string; name?: string; equipmentId?: string; devices: string[] } }>(
    '/api/settings/esphome/equipments',
    {
      schema: {
        body: {
          type: 'object',
          required: ['key', 'devices'],
          additionalProperties: false,
          properties: {
            key: { type: 'string', minLength: 3, maxLength: 128 },
            name: { type: 'string', maxLength: 64 },
            equipmentId: { type: 'string', maxLength: 24 },
            devices: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 64 } },
          },
        },
      },
    },
    async (req, reply) => {
      const equipmentId = req.body.equipmentId ? parseId(req.body.equipmentId) : undefined;
      if (equipmentId === null) return reply.code(400).send({ error: 'équipement invalide' });
      try {
        const r = await createEsphomeEquipments(req.body.key, { name: req.body.name, equipmentId, devices: req.body.devices });
        return reply.code(201).send({ id: r.equipment._id.toHexString(), linked: r.linked, created: r.created });
      } catch (err) {
        if (err instanceof EsphomeLinkError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/settings/esphome/:id', async (req, reply) => {
    const current = esphomeRoles().find((r) => r._id === req.params.id);
    if (!current) return reply.code(404).send({ error: 'rôle ESPHome inconnu' });
    await roles.deleteOne({ _id: current._id });
    req.auditNote = { target: { kind: 'role', id: current._id, name: current.name }, details: { type: current.type } };
    await rolesSaved([]);
    await forgetDevices(new Set(esphomeRoles().map((r) => r.config.brokerId)));
    return reply.code(204).send();
  });
}
