import { hosts, roles, settings } from '../db.js';
import { loadMqttBrokers } from '../probes.js';
import { haRoles, loadRoles, newRoleId, allRoles } from '../roles.js';
import { openSettings } from '../storedSecrets.js';
import type { HomeAssistantRole, LegacyHomeAssistantSettings, MqttBroker } from '../types.js';
import { normalizeDetail } from './detail.js';

// The broker role that is the broker typed before the roles: same address and account.
export function matchHaBroker(brokers: MqttBroker[], s: Pick<LegacyHomeAssistantSettings, 'broker' | 'username' | 'password'>) {
  const url = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();
  return brokers.find((b) => b.url && url(b.url) === url(s.broker) && b.username === s.username && b.password === s.password) ?? null;
}

// The role made of the bridge of before the roles (pure): the whole homelab, same broker, prefixes and level, so that the
// devices stay as they are in Home Assistant (same topics, same unique ids).
export function roleOfLegacy(s: LegacyHomeAssistantSettings, brokerId: string, id: string, now: Date): HomeAssistantRole {
  return {
    _id: id,
    type: 'home-assistant',
    name: 'Home Assistant',
    carrier: { kind: 'hub' },
    config: {
      brokerId,
      mode: 'full',
      topic: s.topic || 'homelab-manager',
      discoveryPrefix: s.discoveryPrefix || 'homeassistant',
      publicUrl: s.publicUrl ?? '',
      detail: normalizeDetail(s.detail),
      ...(s.groupBySite ? { groupBySite: true } : {}),
    },
    createdAt: now,
  };
}

// Home Assistant becomes a role of the hub (homelab#361): the bridge of the settings (one for the homelab) is made a
// home-assistant role, then forgotten; the levels of detail of the hosts go (the level is the role's). A bridge still on a
// broker typed before the roles is first linked to the broker role that matches it; one that matches none is kept, off,
// until a broker role matches it (the migration runs at every start).
export async function migrateHaSettings(log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }) {
  const cleared = await hosts.updateMany({ $or: [{ haDetail: { $exists: true } }, { haExcluded: { $exists: true } }] } as never, { $unset: { haDetail: '', haExcluded: '' } } as never);
  if (cleared.modifiedCount) log.info({ hosts: cleared.modifiedCount }, 'Home Assistant: levels of the hosts removed');
  const s = openSettings('homeassistant', (await settings.findOne({ _id: 'homeassistant' })) as LegacyHomeAssistantSettings | null);
  if (!s) return;
  if (!s.enabled) {
    await settings.deleteOne({ _id: 'homeassistant' });
    log.info({}, 'Home Assistant: bridge of the settings off, forgotten');
    return;
  }
  const brokers = (await loadMqttBrokers()).brokers;
  const brokerId = s.brokerRoleId ?? (s.broker ? matchHaBroker(brokers, s)?.id : undefined);
  if (!brokerId || !brokers.some((b) => b.id === brokerId)) {
    log.warn({ broker: s.broker || null }, 'Home Assistant: bridge of the settings on no broker role, not migrated (declare the broker role)');
    return;
  }
  if (!haRoles().some((r) => r.config.brokerId === brokerId)) {
    const taken = new Set(allRoles().map((r) => r._id));
    const role = roleOfLegacy(s, brokerId, newRoleId('Home Assistant', (id) => taken.has(id)), new Date());
    await roles.insertOne(role);
    log.info({ role: role._id, broker: brokerId }, 'Home Assistant: bridge of the settings migrated to a role');
  }
  await settings.deleteOne({ _id: 'homeassistant' });
  await loadRoles();
}
