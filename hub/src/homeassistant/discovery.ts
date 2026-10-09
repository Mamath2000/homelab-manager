// ===============================
// Home Assistant device discovery (device-based format) + states
// ===============================
// Hierarchy (via_device):
//   Homelab Manager (root)
//   └── one device per host: agent connectivity, alerts rolled up from its sub-components
//       └── one device per sub-component: APT today (docker, backups... later), with the details
// Retained topics: <topic>/lwt, <topic>/<device>/<key>/state, <topic>/<device>/<key>/set (commands).
import type { HostDoc, JobAction } from '../types.js';
import { needsReboot } from '../reboot.js';
import { agentAlerts, aptAlerts, type Alert } from './alerts.js';

export const PRESS = 'PRESS';
export const INSTALL = 'INSTALL';
export const ROOT_ID = 'homelab_manager';
// all the hub's configs under one node id: <prefix>/device/homelab/<object id>/config
export const NODE_ID = 'homelab';

export function discoveryTopic(prefix: string, id: string) {
  return `${prefix}/device/${NODE_ID}/${id === ROOT_ID ? 'manager' : id}/config`;
}

// Device id behind a discovery topic of the hub, current or legacy (<prefix>/device/<id>/config, up to 0.1.6).
export function parseDiscoveryTopic(prefix: string, topic: string): { id: string; legacy: boolean } | null {
  const base = `${prefix}/device/`;
  if (!topic.startsWith(base) || !topic.endsWith('/config')) return null;
  const path = topic.slice(base.length, -'/config'.length).split('/');
  if (path.length === 2 && path[0] === NODE_ID) return { id: path[1] === 'manager' ? ROOT_ID : path[1], legacy: false };
  if (path.length === 1 && /^(homelab_manager|hm_[0-9a-f]{24}(_[a-z]+)?)$/.test(path[0])) return { id: path[0], legacy: true };
  return null;
}

export interface HostState {
  host: HostDoc;
  online: boolean;
  busy: boolean; // a job is running on the host
  agentOutdated?: boolean | null;
  latestAgentVersion?: string | null;
}

export interface Command {
  payload: string;
  action: JobAction;
  hostIds: string[];
}

export interface Device {
  id: string;
  discoveryTopic: string;
  discovery: Record<string, unknown>;
  states: [string, string][];
}

export interface BuildOptions {
  topic: string;
  discoveryPrefix: string;
  version: string;
  hubUrl?: string;
}

type Component = Record<string, unknown>;

export function build(hosts: HostState[], opts: BuildOptions) {
  const { topic, discoveryPrefix, version, hubUrl } = opts;
  const devices: Device[] = [];
  const commands = new Map<string, Command>();
  const availability = [{ topic: `${topic}/lwt` }];
  const origin = { name: 'Homelab Manager', sw_version: version, support_url: 'https://github.com/Mamath2000/homelab-manager' };
  const diag = { entity_category: 'diagnostic' };

  // extra: availability topics on top of the hub's (all must be available)
  function device(id: string, info: Record<string, unknown>, extra: { topic: string; payload_available: string; payload_not_available: string }[] = []) {
    const t = (key: string, suffix = 'state') => `${topic}/${id}/${key}/${suffix}`;
    const components: Record<string, Component> = {};
    const states: [string, string][] = [];
    const add = (key: string, platform: string, name: string, extra: Component) => {
      components[key] = { platform, unique_id: `${id}_${key}`, name, ...extra };
    };

    const dev = {
      sensor(key: string, name: string, value: string | number | null, extra: Component = {}) {
        add(key, 'sensor', name, { state_topic: t(key), ...extra });
        // an empty payload makes Home Assistant show "unknown"
        states.push([t(key), value === null ? '' : String(value)]);
      },
      attributes(key: string, value: unknown) {
        states.push([t(key, 'attributes'), JSON.stringify(value)]);
      },
      binary(key: string, name: string, on: boolean, extra: Component = {}) {
        add(key, 'binary_sensor', name, { state_topic: t(key), payload_on: 'ON', payload_off: 'OFF', ...extra });
        states.push([t(key), on ? 'ON' : 'OFF']);
      },
      // count + "problem" flag, details as attributes
      alerts(list: Alert[], extra: Component = {}) {
        add('alerts', 'sensor', 'Alertes', {
          state_topic: t('alerts'), json_attributes_topic: t('alerts', 'attributes'), icon: 'mdi:alert-outline', ...extra,
        });
        states.push([t('alerts'), String(list.length)]);
        states.push([t('alerts', 'attributes'), JSON.stringify({
          critical: list.filter((a) => a.level === 'critical').length,
          alerts: list.slice(0, 20),
        })]);
        dev.binary('problem', 'Problème', list.length > 0, { device_class: 'problem', ...extra });
      },
      button(key: string, name: string, cmd: Omit<Command, 'payload'>, extra: Component = {}) {
        add(key, 'button', name, { command_topic: t(key, 'set'), payload_press: PRESS, ...extra });
        commands.set(t(key, 'set'), { payload: PRESS, ...cmd });
      },
      update(key: string, name: string, state: Record<string, unknown>, cmd: Omit<Command, 'payload'>, extra: Component = {}) {
        add(key, 'update', name, { state_topic: t(key), command_topic: t(key, 'set'), payload_install: INSTALL, ...extra });
        states.push([t(key), JSON.stringify(state)]);
        commands.set(t(key, 'set'), { payload: INSTALL, ...cmd });
      },
      finish() {
        devices.push({
          id,
          discoveryTopic: discoveryTopic(discoveryPrefix, id),
          discovery: {
            device: { identifiers: [id], manufacturer: 'Homelab Manager', ...info },
            origin,
            ...(extra.length ? { availability: [...availability, ...extra], availability_mode: 'all' } : { availability }),
            components,
          },
          states,
        });
      },
    };
    return dev;
  }

  const allAlerts: Alert[] = [];
  const online = hosts.filter((h) => h.online);
  let updates = 0;
  let security = 0;
  let toUpdate = 0;
  let toReboot = 0;
  let toClean = 0;

  for (const { host, online: isOnline, busy, agentOutdated, latestAgentVersion } of hosts) {
    const hid = host._id.toHexString();
    const hostId = `hm_${hid}`;
    const r = host.apt;

    // --- APT sub-component: the details
    const apt = aptAlerts(host);
    if (r) {
      const sec = r.upgradable.filter((p) => p.security).length;
      const rebootPending = r.upgradable.filter((p) => needsReboot(p.name)).length;
      updates += r.upgradable.length;
      security += sec;
      if (r.upgradable.length) toUpdate++;
      if (r.rebootRequired) toReboot++;

      // unavailable while the agent is offline: its last report may be stale and commands would not run
      const d = device(`${hostId}_apt`, {
        name: `${host.name} · APT`, model: 'Paquets APT', via_device: hostId,
      }, [{ topic: `${topic}/${hostId}/agent/state`, payload_available: 'ON', payload_not_available: 'OFF' }]);
      const os = host.info?.osName || 'Système';
      const names = r.upgradable.map((p) => p.name);
      const summary = names.length
        ? `${names.length} paquet(s) dont ${sec} de sécurité${rebootPending ? ', redémarrage à prévoir' : ''} : ${names.join(', ')}`
        : 'À jour';
      d.update('system', 'Paquets système', {
        installed_version: os,
        latest_version: names.length ? `${os} + ${names.length} MAJ` : os,
        title: os,
        release_summary: summary.length > 255 ? `${summary.slice(0, 252)}...` : summary,
        in_progress: busy,
      }, { action: 'apt_upgrade', hostIds: [hid] });
      d.sensor('updates', 'Mises à jour', r.upgradable.length, { icon: 'mdi:package-up', state_class: 'measurement' });
      d.sensor('security', 'Mises à jour de sécurité', sec, { icon: 'mdi:shield-alert-outline', state_class: 'measurement' });
      d.sensor('held', 'Paquets bloqués', r.held.length, { icon: 'mdi:package-variant-closed-remove', ...diag });
      d.sensor('last_check', 'Dernière vérification', r.listsUpdatedAt ? new Date(r.listsUpdatedAt).toISOString() : null, {
        device_class: 'timestamp', ...diag,
      });
      if (r.autoremovable) {
        if (r.autoremovable.length) toClean++;
        d.sensor('autoremovable', 'Paquets à nettoyer', r.autoremovable.length, {
          icon: 'mdi:broom', json_attributes_topic: `${topic}/${hostId}_apt/autoremovable/attributes`,
        });
        d.attributes('autoremovable', { packages: r.autoremovable });
        d.button('autoremove', 'Nettoyer les paquets', { action: 'apt_autoremove', hostIds: [hid] }, { icon: 'mdi:broom' });
      }
      d.alerts(apt, diag);
      d.button('check', 'Rechercher les mises à jour', { action: 'apt_update', hostIds: [hid] }, { icon: 'mdi:refresh' });
      d.finish();
    }

    // --- host: connectivity + alerts rolled up from the sub-components
    const hostAlerts = [...agentAlerts(host, isOnline, agentOutdated), ...apt];
    const selfUpdate = !!host.capabilities?.includes('agent_update');
    allAlerts.push(...hostAlerts.map((a) => ({ ...a, host: host.name })));

    const d = device(hostId, {
      name: host.name,
      model: host.info?.osName || 'Hôte',
      via_device: ROOT_ID,
      ...(host.agentVersion ? { sw_version: host.agentVersion } : {}),
      ...(hubUrl ? { configuration_url: `${hubUrl}/hosts/${hid}` } : {}),
    });
    d.binary('agent', 'Agent', isOnline, { device_class: 'connectivity' });
    if (selfUpdate) {
      const installed = host.agentVersion || 'inconnue';
      let latest = installed;
      if (agentOutdated) latest = latestAgentVersion && latestAgentVersion !== installed ? latestAgentVersion : `${installed} (nouveau binaire)`;
      d.update('agent_update', 'Agent', {
        installed_version: installed,
        latest_version: latest,
        title: 'Agent Homelab Manager',
        in_progress: busy,
      }, { action: 'agent_update', hostIds: [hid] }, { entity_category: 'config' });
    }
    // reported with the packages, but a reboot concerns the whole host
    if (r) d.binary('reboot_required', 'Redémarrage requis', r.rebootRequired, { device_class: 'problem', icon: 'mdi:restart-alert' });
    if (host.capabilities?.includes('reboot')) {
      d.button('reboot', 'Redémarrer', { action: 'reboot', hostIds: [hid] }, { device_class: 'restart' });
    }
    d.alerts(hostAlerts);
    d.sensor('os', 'Système', host.info?.osName ?? null, { icon: 'mdi:linux', ...diag });
    d.sensor('kernel', 'Noyau', host.info?.kernel ?? null, { icon: 'mdi:chip', ...diag });
    d.sensor('ip', 'Adresse IP', host.info?.ips?.[0] ?? null, { icon: 'mdi:ip-network', ...diag });
    d.sensor('last_seen', 'Vu', host.lastSeenAt ? host.lastSeenAt.toISOString() : null, { device_class: 'timestamp', ...diag });
    d.finish();
  }

  // --- root
  const root = device(ROOT_ID, {
    name: 'Homelab Manager', model: 'Hub', sw_version: version, ...(hubUrl ? { configuration_url: hubUrl } : {}),
  });
  const ids = (list: HostState[]) => list.map((h) => h.host._id.toHexString());
  root.sensor('hosts', 'Hôtes', hosts.length, { icon: 'mdi:server' });
  root.sensor('hosts_offline', 'Hôtes hors ligne', hosts.length - online.length, { icon: 'mdi:server-network-off' });
  root.sensor('updates', 'Mises à jour disponibles', updates, { icon: 'mdi:package-up' });
  root.sensor('security', 'Mises à jour de sécurité', security, { icon: 'mdi:shield-alert-outline' });
  root.sensor('hosts_to_update', 'Hôtes à mettre à jour', toUpdate, { icon: 'mdi:server-plus' });
  root.sensor('hosts_to_reboot', 'Hôtes à redémarrer', toReboot, { icon: 'mdi:restart-alert' });
  root.sensor('agents_outdated', 'Agents à mettre à jour', hosts.filter((h) => h.agentOutdated).length, { icon: 'mdi:update' });
  root.sensor('hosts_to_clean', 'Hôtes à nettoyer', toClean, { icon: 'mdi:broom' });
  root.alerts(allAlerts);
  root.button('check_all', 'Tout vérifier', { action: 'apt_update', hostIds: ids(online) }, { icon: 'mdi:refresh' });
  root.finish();

  return { devices, commands };
}
