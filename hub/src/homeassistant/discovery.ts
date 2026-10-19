// ===============================
// Home Assistant device discovery (device-based format) + states
// ===============================
// Hierarchy (via_device):
//   Homelab Manager (root)
//   └── one device per host: agent connectivity, alerts rolled up from its sub-components
//       └── one device per sub-component, with the details: APT, one per Docker compose stack, UPS
// Retained topics: <topic>/lwt, <topic>/<device>/<key>/state, <topic>/<device>/<key>/set (commands).
import { hasApt, type HostDoc, type JobAction } from '../types.js';
import { needsReboot } from '../reboot.js';
import { alertsOf, hostAlerts as rolledUp, type Alert } from './alerts.js';
import { evaluate, type HostStatus } from '../monitoring.js';
import { upsFlags } from '../ups.js';
import { sessionSummary } from '../sessions.js';
import { dockerView } from '../docker.js';

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
  status?: HostStatus; // registry status (monitoring.ts); computed without backup groups when missing
}

export interface Command {
  payload: string;
  action: JobAction;
  hostIds: string[];
  // docker actions: the stack they apply to
  target?: { stack: string };
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
  // backup groups of the PBS (see pbs.ts) and the space of its datastores
  backups?: {
    // source: see BackupDoc (haos: Home Assistant backups, the others are on the PBS)
    groups: { id: string; backupId: string; hostId: string | null; state: string; lastBackup: number; source?: string }[];
    datastores: { store: string; total: number; used: number }[];
  };
}

type Component = Record<string, unknown>;

export function build(all: HostState[], opts: BuildOptions) {
  const { topic, discoveryPrefix, version, hubUrl, backups } = opts;
  // hosts excluded from Home Assistant: no device, and left out of the totals and alerts of the root
  const hosts = all.filter((h) => !h.host.haExcluded);
  const excluded = new Set(all.filter((h) => h.host.haExcluded).map((h) => h.host._id.toHexString()));
  // followed: groups attached to a published host (gone ones are reported as alerts only)
  const tracked = (backups?.groups ?? []).filter((g) => g.hostId && !excluded.has(g.hostId));
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
  let stacks = 0;
  let stacksToUpdate = 0;
  let withDocker = 0;

  const stackLabel: Record<string, string> = { running: 'En marche', partial: 'Partielle', stopped: 'Arrêtée', down: 'Down' };

  for (const { host, online: isOnline, busy, agentOutdated, latestAgentVersion, status: given } of hosts) {
    const hid = host._id.toHexString();
    const hostId = `hm_${hid}`;
    const r = host.apt;
    const status = given ?? evaluate(host, { online: isOnline, groups: [], now: Date.now(), agentOutdated });

    // --- APT sub-component: the details
    const apt = alertsOf(status.domains.apt, 'apt');
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

    // --- Docker: one sub-component per compose stack
        const view = dockerView(host);
    if (view) withDocker++;
    // unmanaged stacks (own update system) are not published at all
    for (const st of view?.stacks.filter((v) => v.managed) ?? []) {
      stacks++;
      if (st.updates) stacksToUpdate++;
      const alerts = alertsOf(status.domains.docker, 'docker', (c) => c.key === st.name);
      const id = `${hostId}_docker_${st.name}`;
      const target = { stack: st.name };
      const d = device(id, {
        name: `${host.name} · ${st.name}`, model: 'Stack Docker', via_device: hostId,
        ...(hubUrl ? { configuration_url: `${hubUrl}/docker/${hid}/${st.name}` } : {}),
      }, [{ topic: `${topic}/${hostId}/agent/state`, payload_available: 'ON', payload_not_available: 'OFF' }]);
      d.sensor('status', 'État', stackLabel[st.status] ?? st.status, {
        icon: 'mdi:docker', json_attributes_topic: `${topic}/${id}/status/attributes`,
      });
      d.attributes('status', {
        services: st.services.map((s) => ({
          name: s.name, image: s.image, update: s.update,
          containers: s.containers.map((c) => ({ name: c.name, state: c.state, health: c.health ?? null })),
        })),
      });
      d.sensor('containers', 'Conteneurs', `${st.running}/${st.total}`, { icon: 'mdi:package-variant' });
      const pending = st.services.filter((s) => s.update === 'available' || s.update === 'recreate');
      const summary = pending.length ? pending.map((s) => `${s.name} (${s.image})`).join(', ') : 'Images à jour';
      d.update('images', 'Images', {
        installed_version: 'actuelles',
        latest_version: pending.length ? `${pending.length} mise(s) à jour` : 'actuelles',
        title: st.name,
        release_summary: summary.length > 255 ? `${summary.slice(0, 252)}...` : summary,
        in_progress: busy,
      }, { action: 'docker_update', hostIds: [hid], target });
      d.button('restart', 'Redémarrer', { action: 'docker_restart', hostIds: [hid], target }, { device_class: 'restart' });
      d.button('start', 'Démarrer', { action: 'docker_up', hostIds: [hid], target }, { icon: 'mdi:play' });
      d.button('stop', 'Arrêter', { action: 'docker_stop', hostIds: [hid], target }, { icon: 'mdi:stop' });
      d.alerts(alerts, diag);
      d.finish();
    }

    // --- backups of the host (Proxmox Backup Server, Home Assistant)
    const mine = tracked.filter((g) => g.hostId === hid);
    const backup = alertsOf(status.domains.backup, 'backup');
    if (mine.length) {
      const model = [
        ...(mine.some((g) => g.source !== 'haos') ? ['Proxmox Backup Server'] : []),
        ...(mine.some((g) => g.source === 'haos') ? ['Home Assistant'] : []),
      ].join(' · ');
      const d = device(`${hostId}_backup`, {
        name: `${host.name} · Sauvegardes`, model, via_device: hostId,
        ...(hubUrl ? { configuration_url: `${hubUrl}/backups?host=${hid}` } : {}),
      });
      const last = Math.max(...mine.map((g) => g.lastBackup));
      // placeholders of PVE jobs never backed up have no date
      d.sensor('last_backup', 'Dernière sauvegarde', last ? new Date(last).toISOString() : null, {
        device_class: 'timestamp', json_attributes_topic: `${topic}/${hostId}_backup/last_backup/attributes`,
      });
      d.attributes('last_backup', {
        groups: mine.map((g) => ({ id: g.backupId, state: g.state, last: g.lastBackup ? new Date(g.lastBackup).toISOString() : null })),
      });
      d.sensor('late', 'Sauvegardes en retard', mine.filter((g) => g.state === 'stale').length, { icon: 'mdi:backup-restore', state_class: 'measurement' });
      d.alerts(backup, diag);
      d.finish();
    }

    // --- UPS (NUT) of the host
    const ups = alertsOf(status.domains.ups, 'ups');
    const u = host.ups;
    if (u) {
      const flags = upsFlags(u.status);
      const d = device(`${hostId}_ups`, {
        name: `${host.name} · Onduleur`, model: u.model || 'Onduleur', via_device: hostId,
        ...(hubUrl ? { configuration_url: `${hubUrl}/hosts/${hid}` } : {}),
      }, [{ topic: `${topic}/${hostId}/agent/state`, payload_available: 'ON', payload_not_available: 'OFF' }]);
      d.sensor('status', 'État', u.status, { icon: 'mdi:power-plug-battery' });
      d.sensor('battery', 'Charge batterie', u.charge ?? null, {
        device_class: 'battery', unit_of_measurement: '%', state_class: 'measurement',
      });
      d.sensor('runtime', 'Autonomie', u.runtime ?? null, {
        device_class: 'duration', unit_of_measurement: 's', state_class: 'measurement',
      });
      d.sensor('load', 'Charge', u.load ?? null, { icon: 'mdi:gauge', unit_of_measurement: '%', state_class: 'measurement' });
      d.sensor('input_voltage', "Tension d'entrée", u.inputVoltage ?? null, {
        device_class: 'voltage', unit_of_measurement: 'V', state_class: 'measurement',
      });
      d.sensor('battery_voltage', 'Tension batterie', u.batteryVoltage ?? null, {
        device_class: 'voltage', unit_of_measurement: 'V', state_class: 'measurement', ...diag,
      });
      d.binary('on_battery', 'Sur batterie', flags.has('OB'), { icon: 'mdi:battery-alert-variant-outline' });
      d.binary('replace_battery', 'Batterie à remplacer', flags.has('RB'), { device_class: 'problem', icon: 'mdi:battery-sync' });
      d.alerts(ups, diag);
      d.finish();
    }

    // --- host: connectivity + alerts rolled up from the sub-components
    const hostAlerts = rolledUp(status);
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
    // Windows: the sessions, unavailable while the agent is offline (the computer is off: nobody on it)
    const sessions = host.capabilities?.includes('session') ? sessionSummary(host.sessions) : null;
    if (sessions) {
      const whileOnline = {
        availability: [...availability, { topic: `${topic}/${hostId}/agent/state`, payload_available: 'ON', payload_not_available: 'OFF' }],
        availability_mode: 'all',
      };
      d.binary('users_logged_in', 'Utilisateur connecté', sessions.loggedIn, { device_class: 'occupancy', ...whileOnline });
      d.binary('interactive', 'Activité clavier/souris', sessions.interactive, { icon: 'mdi:mouse', ...whileOnline });
      d.binary('session_locked', 'Session verrouillée', sessions.locked, { icon: 'mdi:monitor-lock', ...whileOnline });
      d.sensor('session_changed', 'Dernier changement de session', sessions.changedAt ? new Date(sessions.changedAt).toISOString() : null, {
        icon: 'mdi:clock-outline', device_class: 'timestamp', ...whileOnline,
      });
      d.sensor('users', 'Utilisateurs', sessions.users.length, {
        icon: 'mdi:account-multiple', json_attributes_topic: `${topic}/${hostId}/users/attributes`, ...whileOnline,
      });
      d.attributes('users', { users: sessions.users, sessions: host.sessions?.sessions ?? [] });
    }
    if (selfUpdate) {
      const installed = host.agentVersion || 'inconnue';
      let latest = installed;
      if (agentOutdated) latest = latestAgentVersion && latestAgentVersion !== installed ? latestAgentVersion : `${installed} (nouveau binaire)`;
      d.update('agent_update', 'Agent', {
        installed_version: installed,
        latest_version: latest,
        title: 'Agent Homelab Manager',
        in_progress: busy,
      }, { action: 'agent_update', hostIds: [hid] }, {
        entity_category: 'config',
        // unavailable while the agent is offline (no phantom update); the connectivity sensor above stays available
        availability: [...availability, { topic: `${topic}/${hostId}/agent/state`, payload_available: 'ON', payload_not_available: 'OFF' }],
        availability_mode: 'all',
      });
    }
    // reported with the packages, but a reboot concerns the whole host
    if (r) d.binary('reboot_required', 'Redémarrage requis', r.rebootRequired, { device_class: 'problem', icon: 'mdi:restart-alert' });
    if (host.capabilities?.includes('reboot')) {
      d.button('reboot', 'Redémarrer', { action: 'reboot', hostIds: [hid] }, { device_class: 'restart' });
    }
    if (view) d.button('docker_check', 'Vérifier les images Docker', { action: 'docker_check', hostIds: [hid] }, { icon: 'mdi:docker' });
    d.alerts(hostAlerts);
    d.sensor('os', 'Système', host.info?.osName ?? null, { icon: host.info?.osId === 'windows' ? 'mdi:microsoft-windows' : 'mdi:linux', ...diag });
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
  // a roaming host is expected to be offline
  root.sensor('hosts_offline', 'Hôtes hors ligne', hosts.filter((h) => !h.online && !h.host.roaming).length, { icon: 'mdi:server-network-off' });
  root.sensor('updates', 'Mises à jour disponibles', updates, { icon: 'mdi:package-up' });
  root.sensor('security', 'Mises à jour de sécurité', security, { icon: 'mdi:shield-alert-outline' });
  root.sensor('hosts_to_update', 'Hôtes à mettre à jour', toUpdate, { icon: 'mdi:server-plus' });
  root.sensor('hosts_to_reboot', 'Hôtes à redémarrer', toReboot, { icon: 'mdi:restart-alert' });
  root.sensor('agents_outdated', 'Agents à mettre à jour', hosts.filter((h) => h.agentOutdated).length, { icon: 'mdi:update' });
  root.sensor('hosts_to_clean', 'Hôtes à nettoyer', toClean, { icon: 'mdi:broom' });
  if (withDocker) {
    root.sensor('stacks', 'Stacks Docker', stacks, { icon: 'mdi:docker' });
    root.sensor('stacks_to_update', 'Stacks à mettre à jour', stacksToUpdate, { icon: 'mdi:update' });
  }
  if (backups) {
    root.sensor('backups_late', 'Sauvegardes en retard', tracked.filter((g) => g.state === 'stale').length, { icon: 'mdi:backup-restore' });
    for (const ds of backups.datastores) {
      const key = `datastore_${ds.store.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
      root.sensor(key, `Datastore ${ds.store}`, ds.total ? Math.round((ds.used / ds.total) * 1000) / 10 : null, {
        icon: 'mdi:harddisk', unit_of_measurement: '%', state_class: 'measurement',
      });
    }
  }
  root.alerts(allAlerts);
  root.button('check_all', 'Tout vérifier', { action: 'apt_update', hostIds: ids(online.filter((h) => hasApt(h.host))) }, { icon: 'mdi:refresh' });
  root.finish();

  return { devices, commands };
}
