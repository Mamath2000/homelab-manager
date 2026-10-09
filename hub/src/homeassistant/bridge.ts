import { ObjectId } from 'mongodb';
import mqtt, { type MqttClient } from 'mqtt';
import type { FastifyBaseLogger } from 'fastify';
import { isOnline } from '../agents.js';
import { config } from '../config.js';
import { hosts } from '../db.js';
import { subscribe } from '../events.js';
import { createJob, hasRunningJob } from '../jobs.js';
import type { HomeAssistantSettings } from '../types.js';
import { build, type Command } from './discovery.js';

export type BridgeState = 'disabled' | 'connecting' | 'connected' | 'error';

// Publishes the homelab to Home Assistant over MQTT and runs the commands it sends back.
export class HomeAssistantBridge {
  private client: MqttClient | null = null;
  private settings: HomeAssistantSettings | null = null;
  private sent = new Map<string, string>(); // topic -> last published value
  private known = new Set<string>(); // announced device ids
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
    if (same) return;
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
      client.publish(`${s.topic}/lwt`, 'online', { qos: 1, retain: true });
      client.subscribe([`${s.discoveryPrefix}/status`, `${s.topic}/+/+/set`]);
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
      if (event === 'host' || event === 'host.deleted' || event === 'job') this.schedule(1000);
    });
    // time based states (stale package lists) without any event
    this.timer = setInterval(() => this.schedule(0), 60_000);
  }

  async stop(removeDevices: boolean) {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = this.debounce = null;
    const client = this.client;
    const s = this.settings;
    this.client = null;
    if (client && s) {
      if (removeDevices && client.connected) {
        for (const id of this.known) client.publish(`${s.discoveryPrefix}/device/${id}/config`, '', { qos: 1, retain: true });
        this.log.info({ devices: this.known.size }, 'Home Assistant: devices removed');
      }
      if (client.connected) client.publish(`${s.topic}/lwt`, 'offline', { qos: 1, retain: true });
      await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
    }
    if (removeDevices) this.known.clear();
    this.sent.clear();
    this.state = 'disabled';
    this.error = null;
  }

  private schedule(delay: number) {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.render().catch((err) => this.log.error({ err }, 'Home Assistant: publication failed'));
    }, delay);
  }

  private pub(topic: string, value: string) {
    if (this.sent.get(topic) === value) return;
    this.sent.set(topic, value);
    this.client?.publish(topic, value, { qos: 1, retain: true });
  }

  private async render() {
    const s = this.settings;
    if (!this.client?.connected || !s) return;
    const list = await hosts.find().sort({ name: 1 }).toArray();
    const built = build(
      list.map((host) => {
        const id = host._id.toHexString();
        return { host, online: isOnline(id), busy: hasRunningJob(id) };
      }),
      { topic: s.topic, discoveryPrefix: s.discoveryPrefix, version: config.version, hubUrl: config.publicUrl },
    );
    this.commands = built.commands;
    const ids = new Set(built.devices.map((d) => d.id));
    for (const d of built.devices) this.pub(d.discoveryTopic, JSON.stringify(d.discovery));
    for (const id of this.known) {
      if (!ids.has(id)) {
        this.pub(`${s.discoveryPrefix}/device/${id}/config`, '');
        this.log.info({ device: id }, 'Home Assistant: device removed');
      }
    }
    for (const d of built.devices) for (const [t, v] of d.states) this.pub(t, v);
    for (const id of ids) if (!this.known.has(id)) this.log.info({ device: id }, 'Home Assistant: device announced');
    this.known = ids;
    this.lastPublishAt = new Date();
  }

  private onMessage(s: HomeAssistantSettings, topic: string, payload: string, retained: boolean) {
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
      if (host && isOnline(id) && !hasRunningJob(id)) await createJob(host, cmd.action, [], 'homeassistant');
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
