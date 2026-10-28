import { ObjectId } from 'mongodb';
import mqtt, { type MqttClient } from 'mqtt';
import type { FastifyBaseLogger } from 'fastify';
import { agentOutdated, hostBinary } from '../agentBinaries.js';
import { loadAgentSettings } from '../agentUpdate.js';
import { isOnline } from '../agents.js';
import { evaluateAll } from '../monitoring.js';
import { config } from '../config.js';
import { isUnmanaged } from '../docker.js';
import { backups, hosts } from '../db.js';
import { backupState, loadPbsSettings, pbsConnected } from '../pbs.js';
import { subscribe } from '../events.js';
import { createJob, hasRunningJob } from '../jobs.js';
import type { HaDetail, HaHostDetail, HomeAssistantSettings } from '../types.js';
import { build, deviceOf, NODE_ID, parseDiscoveryTopic, type Command } from './discovery.js';

export type BridgeState = 'disabled' | 'connecting' | 'connected' | 'error';

// Publishes the homelab to Home Assistant over MQTT and runs the commands it sends back.
export class HomeAssistantBridge {
  private client: MqttClient | null = null;
  private settings: HomeAssistantSettings | null = null;
  private sent = new Map<string, string>(); // topic -> last published value
  private known = new Map<string, string>(); // announced devices: id -> discovery topic
  private states = new Set<string>(); // state topics of the current devices
  private rendered = false; // known reflects the current devices
  private seen = new Map<string, string | null>(); // discovery configs of the hub found on the broker before the first publication: topic -> device id
  private seenStates = new Set<string>(); // retained states of the hub found on the broker before the first publication
  private watching: NodeJS.Timeout | null = null;
  private commands = new Map<string, Command>();
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  state: BridgeState = 'disabled';
  error: string | null = null;
  lastPublishAt: Date | null = null;

  constructor(private log: FastifyBaseLogger) {}

  status() {
    return { state: this.state, error: this.error, devices: this.known.size, lastPublishAt: this.lastPublishAt };
  }

  async apply(next: HomeAssistantSettings | null) {
    const prev = this.settings;
    const same =
      prev && next && prev.enabled === next.enabled && prev.broker === next.broker && prev.username === next.username &&
      prev.password === next.password && prev.topic === next.topic && prev.discoveryPrefix === next.discoveryPrefix;
    if (same) {
      // only the link changed: republish the devices
      this.settings = next;
      if (prev.publicUrl !== next.publicUrl || JSON.stringify(prev.detail) !== JSON.stringify(next.detail)) this.refresh();
      return;
    }
    // devices are removed from Home Assistant when the integration is disabled or moved to other topics
    const removeDevices = !next?.enabled || prev?.topic !== next.topic || prev?.discoveryPrefix !== next.discoveryPrefix;
    await this.stop(removeDevices);
    this.settings = next;
    if (next?.enabled) this.start(next);
  }

  private start(s: HomeAssistantSettings) {
    this.state = 'connecting';
    this.error = null;
    const client = mqtt.connect(s.broker, {
      username: s.username || undefined,
      password: s.password || undefined,
      clientId: `homelab-manager-${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: 5000,
      connectTimeout: 10_000,
      will: { topic: `${s.topic}/lwt`, payload: Buffer.from('offline'), qos: 1, retain: true },
    });
    this.client = client;

    client.on('connect', () => {
      this.log.info({ broker: s.broker }, 'Home Assistant: connected to the MQTT broker');
      this.state = 'connected';
      this.error = null;
      this.sent.clear();
      this.rendered = false;
      client.publish(`${s.topic}/lwt`, 'online', { qos: 1, retain: true });
      client.subscribe([`${s.discoveryPrefix}/status`, `${s.topic}/+/+/set`]);
      this.watchDiscovery(s);
      this.schedule(0);
    });
    client.on('error', (err) => {
      if (this.error !== err.message) this.log.warn({ err: err.message }, 'Home Assistant: MQTT error');
      this.state = 'error';
      this.error = err.message;
    });
    client.on('offline', () => {
      if (this.state === 'connected') this.state = 'connecting';
    });
    client.on('message', (topic, payload, packet) => this.onMessage(s, topic, payload.toString(), packet.retain));

    // hosts, jobs and agent connections all change what Home Assistant shows
    this.unsubscribe = subscribe((event) => {
      if (event === 'host' || event === 'host.deleted' || event === 'job' || event === 'backups') this.schedule(1000);
    });
    // time based states (stale package lists) without any event
    this.timer = setInterval(() => this.schedule(0), 60_000);
  }

  async stop(removeDevices: boolean) {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    if (this.watching) clearTimeout(this.watching);
    this.timer = this.debounce = this.watching = null;
    const client = this.client;
    const s = this.settings;
    this.client = null;
    if (client && s) {
      if (removeDevices && client.connected) {
        for (const topic of [...this.known.values(), ...this.states]) client.publish(topic, '', { qos: 1, retain: true });
        this.log.info({ devices: this.known.size }, 'Home Assistant: devices removed');
      }
      if (client.connected) client.publish(`${s.topic}/lwt`, 'offline', { qos: 1, retain: true });
      await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
    }
    if (removeDevices) {
      this.known.clear();
      this.states.clear();
    }
    this.sent.clear();
    this.state = 'disabled';
    this.error = null;
  }

  // republishes the devices, e.g. after the hub URL changed
  refresh() {
    if (this.client) this.schedule(0);
  }

  // forgets what was sent: discovery configs and states all go out again, stale configs are removed
  republish() {
    if (!this.client?.connected || !this.settings) return false;
    this.log.info('Home Assistant: publishing everything again (requested)');
    this.sent.clear();
    this.watchDiscovery(this.settings);
    this.schedule(0);
    return true;
  }

  // (re)subscribing makes the broker send the retained discovery configs and states again: the stale ones get
  // removed. The states are only watched for that burst (our own publications would come back otherwise).
  private watchDiscovery(s: HomeAssistantSettings) {
    const states = [`${s.topic}/+/+/state`, `${s.topic}/+/+/attributes`];
    this.client?.subscribe([`${s.discoveryPrefix}/device/${NODE_ID}/+/config`, `${s.discoveryPrefix}/device/+/config`, ...states]);
    if (this.watching) clearTimeout(this.watching);
    this.watching = setTimeout(() => {
      this.watching = null;
      this.client?.unsubscribe(states);
    }, 15_000);
  }

  private clear(topic: string, why: string) {
    this.client?.publish(topic, '', { qos: 1, retain: true });
    this.sent.delete(topic);
    this.log.info({ topic }, `Home Assistant: ${why} discovery config removed`);
  }

  // a retained discovery config of the hub: legacy topic, device moved to another topic (renamed host) or gone
  private sweep(topic: string, id: string | null, legacy: boolean) {
    if (!this.rendered) {
      this.seen.set(topic, id);
      return;
    }
    const current = id ? this.known.get(id) : undefined;
    if (current === topic) return;
    this.clear(topic, legacy ? 'legacy' : current ? 'moved' : 'stale');
    if (current) {
      // the current config may have been refused (same unique ids) and Home Assistant drops the entities with the
      // old one: reset the current topic too and announce the device again once it is done
      if (this.sent.has(current)) this.client?.publish(current, '', { qos: 1, retain: true });
      this.sent.delete(current);
      this.schedule(3000);
    }
  }

  private schedule(delay: number) {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.render().catch((err) => this.log.error({ err }, 'Home Assistant: publication failed'));
    }, delay);
  }

  private pub(topic: string, value: string) {
    if (this.sent.get(topic) === value) return false;
    this.sent.set(topic, value);
    this.client?.publish(topic, value, { qos: 1, retain: true });
    return true;
  }

  // what would be published with this level of detail (devices and entities), without publishing anything.
  // hosts: only the devices of these hosts, with this level for them (undefined: their own)
  async preview(detail: HaDetail, s: HomeAssistantSettings, hostsScope?: { ids: string[]; haDetail?: HaHostDetail | null }) {
    const override = hostsScope && { ids: new Set(hostsScope.ids), haDetail: hostsScope.haDetail };
    let { devices } = await this.compute({ ...s, detail }, override);
    if (hostsScope) devices = devices.filter((d) => hostsScope.ids.some((id) => d.id === `hm_${id}` || d.id.startsWith(`hm_${id}_`)));
    return {
      devices: devices.length,
      entities: devices.reduce((n, d) => n + Object.keys(d.discovery.components as object).length, 0),
    };
  }

  private async compute(s: HomeAssistantSettings, override?: { ids: Set<string>; haDetail?: HaHostDetail | null }) {
    const list = (await hosts.find().sort({ name: 1 }).toArray()).map((h) => {
      if (override?.haDetail === undefined || !override.ids.has(h._id.toHexString())) return h;
      const { haDetail: _own, haExcluded: _legacy, ...rest } = h;
      return override.haDetail === null ? rest : { ...rest, haDetail: override.haDetail };
    });
    const status = evaluateAll(list, await backups.find({ hostId: { $ne: null } }).toArray());
    const hubUrl = s.publicUrl || (await loadAgentSettings()).hubUrl || undefined;
    return build(
      list.map((host) => {
        const id = host._id.toHexString();
        const bin = hostBinary(host);
        return {
          host,
          online: isOnline(id),
          busy: hasRunningJob(id),
          agentOutdated: agentOutdated(host),
          latestAgentVersion: bin?.version ?? null,
          status: status[id],
        };
      }),
      { topic: s.topic, discoveryPrefix: s.discoveryPrefix, version: config.version, hubUrl, detail: s.detail, backups: await backupsForHa() },
    );
  }

  private async render() {
    const s = this.settings;
    if (!this.client?.connected || !s) return;
    const built = await this.compute(s);
    this.commands = built.commands;
    const current = new Map(built.devices.map((d) => [d.id, d.discoveryTopic]));
    // a device whose topic changed (renamed host, or found under an older topic) is removed first and announced
    // a bit later: Home Assistant refuses a new config while an old one holds its unique ids
    const held = new Set<string>();
    for (const [id, topic] of this.known) {
      const next = current.get(id);
      if (next === topic) continue;
      this.pub(topic, '');
      if (next) held.add(id);
      this.log.info({ device: id }, next ? 'Home Assistant: device moved' : 'Home Assistant: device removed');
    }
    for (const [topic, id] of this.seen) {
      const next = id ? current.get(id) : undefined;
      if (next === topic) continue;
      const legacy = parseDiscoveryTopic(s.discoveryPrefix, topic)?.legacy;
      this.clear(topic, legacy ? 'legacy' : next ? 'moved' : 'stale');
      if (next) held.add(id!);
    }
    this.seen.clear();
    if (held.size) this.schedule(3000);
    const announced = built.devices.filter((d) => !held.has(d.id) && this.pub(d.discoveryTopic, JSON.stringify(d.discovery)));
    const states = new Set<string>();
    for (const d of built.devices) {
      for (const [t, v] of d.states) {
        states.add(t);
        this.pub(t, v);
      }
    }
    // retained states nothing reads any more: removed devices and entities, older topics
    for (const t of new Set([...this.states, ...this.seenStates])) if (!states.has(t)) this.pub(t, '');
    this.seenStates.clear();
    this.states = states;
    // Home Assistant may miss the states of a device it is still setting up: send them again a bit later
    if (announced.length) {
      for (const d of announced) for (const [t] of d.states) this.sent.delete(t);
      this.schedule(5000);
    }
    for (const id of current.keys()) if (!this.known.has(id)) this.log.info({ device: id }, 'Home Assistant: device announced');
    this.known = current;
    this.rendered = true;
    this.lastPublishAt = new Date();
  }

  private onMessage(s: HomeAssistantSettings, topic: string, payload: string, retained: boolean) {
    const found = parseDiscoveryTopic(s.discoveryPrefix, topic);
    if (found) {
      // an empty payload is a removal; our own publications come back too
      if (payload && retained) this.sweep(topic, deviceOf(payload), found.legacy);
      return;
    }
    if (/\/(state|attributes)$/.test(topic)) {
      // retained state of the hub (watchDiscovery): stale when no current device publishes it
      if (!payload || !retained) return;
      if (!this.rendered) this.seenStates.add(topic);
      else if (!this.states.has(topic)) this.pub(topic, '');
      return;
    }
    if (topic === `${s.discoveryPrefix}/status`) {
      if (payload === 'online' && !retained) {
        this.log.info('Home Assistant restarted: publishing everything again');
        this.sent.clear();
        this.schedule(0);
      }
      return;
    }
    // a retained command would replay at every reconnection
    if (retained) return;
    const cmd = this.commands.get(topic);
    if (!cmd || payload !== cmd.payload) return;
    this.log.info({ action: cmd.action, hosts: cmd.hostIds.length }, 'Home Assistant: command received');
    this.run(cmd).catch((err) => this.log.error({ err }, 'Home Assistant: command failed'));
  }

  private async run(cmd: Command) {
    for (const id of cmd.hostIds) {
      const host = await hosts.findOne({ _id: ObjectId.createFromHexString(id) });
      // a command left over from before the stack became unmanaged
      if (host && cmd.target && isUnmanaged(host, cmd.target.stack)) continue;
      if (host && isOnline(id) && !hasRunningJob(id)) await createJob(host, cmd.action, [], 'homeassistant', cmd.target);
    }
  }
}

// Checks that a broker accepts the connection, without touching the running bridge.
export function testConnection(broker: string, username: string, password: string) {
  return new Promise<void>((resolve, reject) => {
    const client = mqtt.connect(broker, {
      username: username || undefined,
      password: password || undefined,
      connectTimeout: 5000,
      reconnectPeriod: 0,
    });
    const done = (err?: Error) => {
      client.end(true);
      if (err) reject(err);
      else resolve();
    };
    client.once('connect', () => done());
    client.once('error', (err) => done(err));
    client.once('close', () => done(new Error('connexion fermée par le broker')));
    setTimeout(() => done(new Error('délai dépassé (5 s)')), 6000).unref();
  });
}

// Backup groups and datastores for the discovery: without PBS, the backups of Home Assistant only.
async function backupsForHa() {
  const s = await loadPbsSettings();
  const list = await backups.find().toArray();
  return {
    groups: list.map((b) => ({
      id: b._id,
      // a job of the hub writes it: its name, not the backup id (the host name); Home Assistant: its destination
      backupId: b.managed?.name ?? (b.ha ? `Home Assistant (${b.backupId})` : b.backupId),
      source: b.source,
      hostId: b.hostId ? b.hostId.toHexString() : null,
      state: backupState(b),
      lastBackup: b.lastBackup,
    })),
    datastores: pbsConnected(s) ? (s.datastores ?? []) : [],
  };
}
