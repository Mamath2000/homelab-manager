import type { FastifyBaseLogger } from 'fastify';
import { insertJsonLines, logRole, SEVERITIES } from './logs.js';
import type { EsphomeDeviceDoc, EsphomeSubDevice } from './types.js';

// The lines of the ESPHome devices (homelab#352), received on esphome/<unique_id>/logs (mqtt.log_topic) for the devices
// whose logs are on, written by the hub to the log server of the esphome role (JSON lines). A line is
// "[L][tag:line]: message" in the colours of the logger (ANSI codes, removed), without a time (the time it is received).
// It goes to one of the sub-devices of the ESP (field `device`) when its tag names it, else it stays on the ESP.

// The severities of the logger as the syslog component of ESPHome gives them (the lines received before, homelab#340):
// INFO is notice, CONFIG info.
export const SEVERITY_OF: Record<string, number> = { E: 3, W: 4, I: 5, C: 6, D: 7, V: 7, VV: 7 };

const ANSI = /\x1b\[[0-9;]*m/g;
const LINE = /^\[(VV|[EWICDV])\]\[([^\]:]+)(?::(\d+))?\]:? ?([\s\S]*)$/;

export interface EsphomeLine {
  severity: number;
  tag: string;
  line?: string;
  message: string;
}

// A payload of the logs topic; one that does not look like a line of the logger is kept whole, as info.
export function parseLine(payload: string): EsphomeLine {
  const text = payload.replace(ANSI, '').trim();
  const m = LINE.exec(text);
  if (!m) return { severity: 6, tag: '', message: text };
  return { severity: SEVERITY_OF[m[1]], tag: m[2], ...(m[3] ? { line: m[3] } : {}), message: m[4] };
}

// The sub-device a line belongs to (null: the ESP itself):
//   1. its tag is the id of a sub-device, or starts with it and a dot (cmd_portail, cmd_portail.safety): the lines of
//      the YAML of the device (logger.log, ESP_LOGx);
//   2. else its tag is one of the tags of the drivers a sub-device declares in info (bme280, pn532.i2c for pn532), and
//      only that one declares it: the errors of a sensor.
export function attach(tag: string, devices: EsphomeSubDevice[] = []): string | null {
  if (!tag) return null;
  const own = devices.find((d) => tag === d.id || tag.startsWith(`${d.id}.`));
  if (own) return own.id;
  const drivers = devices.filter((d) => d.tags?.some((t) => tag === t || tag.startsWith(`${t}.`)));
  return drivers.length === 1 ? drivers[0].id : null;
}

// The record written for a line. hostname: the name of the device (the one its syslog lines carried), unique_id apart.
export function recordOf(d: Pick<EsphomeDeviceDoc, 'brokerId' | 'uniqueId' | 'info'>, l: EsphomeLine, siteId: string | null | undefined, at: Date): Record<string, string> {
  const device = attach(l.tag, d.info?.devices);
  return {
    _time: at.toISOString(),
    _msg: l.message,
    hostname: d.info?.name ?? d.uniqueId,
    app_name: l.tag,
    severity: String(l.severity),
    level: SEVERITIES[l.severity],
    facility: '16',
    facility_keyword: 'local0',
    source: 'esphome',
    unique_id: d.uniqueId,
    broker: d.brokerId,
    ...(device ? { device } : {}),
    ...(siteId ? { site: siteId } : {}),
    ...(l.line ? { esp_line: l.line } : {}),
    ...(d.info?.ip ? { ip: d.info.ip } : {}),
  };
}

// --- shipping -------------------------------------------------------------------------------------------------------

const FLUSH_MS = 1000;
const BATCH = 500;
// lines kept while the server does not answer; the oldest are dropped beyond
export const MAX_PENDING = 20_000;

// The lines waiting to be written, sent every second (or as soon as a batch is full) to the log server of the role.
export class LogShipper {
  private pending: Record<string, string>[] = [];
  private timer: NodeJS.Timeout | null = null;
  private sending = false;
  dropped = 0;
  sent = 0;
  lastError: string | null = null;
  private warnedAt = 0;

  constructor(
    private roleId: () => string | undefined,
    private log?: FastifyBaseLogger,
    private send = insertJsonLines,
  ) {}

  push(rec: Record<string, string>) {
    this.pending.push(rec);
    if (this.pending.length > MAX_PENDING) {
      const over = this.pending.length - MAX_PENDING;
      this.pending.splice(0, over);
      this.dropped += over;
    }
    if (this.pending.length >= BATCH) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), FLUSH_MS);
  }

  get waiting() {
    return this.pending.length;
  }

  async flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.sending || !this.pending.length) return;
    const role = logRole(this.roleId());
    if (!role) {
      // no log server: nothing to write to
      this.dropped += this.pending.length;
      this.pending = [];
      return;
    }
    this.sending = true;
    const batch = this.pending.slice(0, BATCH);
    try {
      await this.send(role.config, batch);
      this.pending.splice(0, batch.length);
      this.sent += batch.length;
      this.lastError = null;
    } catch (err) {
      this.lastError = (err as Error).message;
      if (Date.now() - this.warnedAt > 60_000) {
        this.warnedAt = Date.now();
        this.log?.warn({ err: this.lastError, waiting: this.pending.length }, 'esphome: lines not written to the log server');
      }
    } finally {
      this.sending = false;
    }
    if (this.pending.length) this.timer ??= setTimeout(() => void this.flush(), this.lastError ? 10 * FLUSH_MS : 0);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
