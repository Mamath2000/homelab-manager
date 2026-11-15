import type { FastifyInstance } from 'fastify';
import { settingsDiff } from '../audit.js';
import { loadSites } from '../catalog.js';
import { equipments, parseId, roles } from '../db.js';
import { brokerSites, esphomeDevices, esphomeShipper, forgetDevices, lastLineOf, setDeviceLogs } from '../esphome.js';
import { logRole, logRoles } from '../logs.js';
import { candidatesFor, createEsphomeEquipments, EsphomeLinkError, subKey, syncAllEsphomeEquipments } from '../esphomeEquipments.js';
import { probeEngine } from '../probes.js';
import { rolesSaved } from '../roleEvents.js';
import { allRoles, esphomeRole, roleConflict } from '../roles.js';
import type { EquipmentDoc, EsphomeBroker, EsphomeConfig, EsphomeDeviceDoc, EsphomeRole, MqttBrokerRole } from '../types.js';

// Paramètres › ESPHome (admin, homelab#352): the esphome role, carried by the hub, declared and removed here, and the
// brokers it listens to (mqtt-broker roles), each with the site of its devices when it is not the one of its host. The
// devices found on each broker, as their messages left them (esphome.ts).

const brokerRoles = () => allRoles().filter((r): r is MqttBrokerRole => r.type === 'mqtt-broker');

const configBody = {
  type: 'object',
  required: ['brokers'],
  additionalProperties: false,
  properties: {
    brokers: {
      type: 'array',
      maxItems: 32,
      items: {
        type: 'object',
        required: ['brokerId'],
        additionalProperties: false,
        // siteId absent or "": the site of the host of the broker
        properties: { brokerId: { type: 'string', maxLength: 32 }, siteId: { type: 'string', maxLength: 24 } },
      },
    },
    // the log-server role the lines go to ("" or absent: the first one)
    logServer: { type: 'string', maxLength: 32 },
  },
} as const;

// null: the brokers may be listened to, else why not
export function brokersError(list: EsphomeBroker[], brokerIds: Set<string>, siteIds: Set<string>) {
  const seen = new Set<string>();
  for (const b of list) {
    if (!brokerIds.has(b.brokerId)) return `broker inconnu : ${b.brokerId}`;
    if (seen.has(b.brokerId)) return `broker en double : ${b.brokerId}`;
    seen.add(b.brokerId);
    if (b.siteId && !siteIds.has(b.siteId)) return `site inconnu : ${b.siteId}`;
  }
  return null;
}

export const toEsphomeConfig = (list: EsphomeBroker[], logServer?: string): EsphomeConfig => ({
  brokers: list.map((b) => ({ brokerId: b.brokerId, ...(b.siteId ? { siteId: b.siteId } : {}) })),
  ...(logServer ? { logServer } : {}),
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
  firstSeenAt: d.firstSeenAt,
  lastSeenAt: d.lastSeenAt,
});

export function registerEsphomeRoutes(app: FastifyInstance) {
  app.get('/api/settings/esphome', async () => {
    const role = esphomeRole();
    const sites = await brokerSites();
    const engine = probeEngine();
    const boxes = await equipments.find({ source: { $in: ['esphome', 'manual'] } }, { projection: { name: 1, ip: 1, siteId: 1, source: 1, externalId: 1 } }).toArray();
    const brokers = brokerRoles().map((b) => ({ id: b._id, name: b.name, siteId: sites.get(b._id) ?? null }));
    return {
      role: role
        ? {
            name: role.name,
            // where the lines go (null: no log server, the logs cannot be turned on), and how the writing goes
            logServer: logRole(role.config.logServer)?._id ?? null,
            logServerSet: role.config.logServer ?? null,
            shipping: (() => {
              const s = esphomeShipper();
              return s ? { sent: s.sent, dropped: s.dropped, waiting: s.waiting, error: s.lastError } : null;
            })(),
            brokers: role.config.brokers.map((b) => ({
              brokerId: b.brokerId,
              name: brokers.find((x) => x.id === b.brokerId)?.name ?? b.brokerId,
              // the site set for it, and the one its devices are in
              siteId: b.siteId ?? null,
              site: sites.get(b.brokerId) ?? null,
              status: engine?.pool.status(b.brokerId) ?? null,
              devices: esphomeDevices(b.brokerId).map((d) => ({ ...deviceView(d), ...equipmentsOf(d, boxes, sites.get(b.brokerId)) })),
            })),
          }
        : null,
      // the brokers that may be listened to, the log servers the lines may go to
      brokers,
      logServers: logRoles().map((r) => ({ id: r._id, name: r.name })),
    };
  });

  // declared with no broker: they are chosen in the screen
  app.post('/api/settings/esphome', async (req, reply) => {
    if (!brokerRoles().length) return reply.code(409).send({ error: 'déclarer d’abord un rôle Broker MQTT' });
    const why = roleConflict(allRoles(), 'esphome', 'ESPHome', null, { brokers: [] });
    if (why) return reply.code(409).send({ error: why });
    const doc: EsphomeRole = { _id: 'esphome', type: 'esphome', name: 'ESPHome', carrier: { kind: 'hub' }, config: { brokers: [] }, createdAt: new Date() };
    await roles.insertOne(doc);
    req.auditNote = { target: { kind: 'role', id: doc._id, name: doc.name }, details: { type: doc.type, carrier: 'hub' } };
    await rolesSaved([]);
    return reply.code(201).send({ id: doc._id });
  });

  app.put<{ Body: { brokers: EsphomeBroker[]; logServer?: string } }>('/api/settings/esphome', { schema: { body: configBody } }, async (req, reply) => {
    const current = esphomeRole();
    if (!current) return reply.code(404).send({ error: 'rôle ESPHome non déclaré' });
    const sites = await loadSites();
    const bad = brokersError(req.body.brokers, new Set(brokerRoles().map((b) => b._id)), new Set(sites.map((s) => s.id)));
    if (bad) return reply.code(400).send({ error: bad });
    if (req.body.logServer && !logRoles().some((r) => r._id === req.body.logServer)) return reply.code(400).send({ error: `serveur de logs inconnu : ${req.body.logServer}` });
    const config = toEsphomeConfig(req.body.brokers, req.body.logServer);
    await roles.replaceOne({ _id: current._id }, { ...current, config });
    req.auditNote = { target: { kind: 'role', id: current._id, name: current.name }, details: { type: current.type, ...settingsDiff(current.config, config) } };
    await rolesSaved([]);
    await forgetDevices(new Set(config.brokers.map((b) => b.brokerId)));
    // the site of a broker may have changed: its equipments follow
    await syncAllEsphomeEquipments();
    return { id: current._id };
  });

  // The lines of an ESP forwarded to the log server, or not. Only for an ESP that is an equipment.
  app.put<{ Body: { key: string; enabled: boolean } }>(
    '/api/settings/esphome/logs',
    { schema: { body: { type: 'object', required: ['key', 'enabled'], additionalProperties: false, properties: { key: { type: 'string', minLength: 3, maxLength: 128 }, enabled: { type: 'boolean' } } } } },
    async (req, reply) => {
      const role = esphomeRole();
      if (!role) return reply.code(404).send({ error: 'rôle ESPHome non déclaré' });
      const d = esphomeDevices().find((x) => x._id === req.body.key);
      if (!d) return reply.code(404).send({ error: 'appareil inconnu' });
      if (req.body.enabled) {
        if (!logRole(role.config.logServer)) return reply.code(409).send({ error: 'aucun serveur de logs : déclarer un rôle Serveur de logs' });
        if (!(await equipments.countDocuments({ source: 'esphome', externalId: d._id }, { limit: 1 }))) return reply.code(409).send({ error: "créer d'abord l'équipement de l'appareil" });
      }
      await setDeviceLogs(d._id, req.body.enabled);
      req.auditNote = { target: { kind: 'equipment', id: d._id, name: d.info?.name ?? d.uniqueId }, details: { enabled: req.body.enabled } };
      return { key: d._id, logs: req.body.enabled };
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

  app.delete('/api/settings/esphome', async (req, reply) => {
    const current = esphomeRole();
    if (!current) return reply.code(404).send({ error: 'rôle ESPHome non déclaré' });
    await roles.deleteOne({ _id: current._id });
    req.auditNote = { target: { kind: 'role', id: current._id, name: current.name }, details: { type: current.type } };
    await rolesSaved([]);
    await forgetDevices(new Set());
    return reply.code(204).send();
  });
}
