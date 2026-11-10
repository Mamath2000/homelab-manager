import { randomUUID } from 'node:crypto';
import mqtt from 'mqtt';
import { tlsOptions } from './mqttTls.js';
import type { MqttBroker } from './types.js';

// The control interface of the dynamic-security plugin ($CONTROL/dynamic-security/v1): commands sent as one JSON message,
// the answer comes on the response topic. One short connection per call, with the certificate of the hub (the broker
// takes its CN as the account); commands carry secrets (passwords), so nothing of them is logged.

const CONTROL = '$CONTROL/dynamic-security/v1';
const TIMEOUT_MS = 10_000;

export type DynsecCommand = { command: string } & Record<string, unknown>;
export interface DynsecResponse {
  command: string;
  data?: Record<string, unknown>;
  error?: string;
}

/** Runs the commands in order and returns their answers (an answer may hold an error: the caller decides). */
export function dynsecRun(broker: Pick<MqttBroker, 'url' | 'tls'>, commands: DynsecCommand[]): Promise<DynsecResponse[]> {
  return new Promise((resolve, reject) => {
    const tag = randomUUID();
    const client = mqtt.connect(broker.url, {
      ...tlsOptions(broker.tls),
      clientId: `homelab-manager-dynsec-${tag.slice(0, 8)}`,
      reconnectPeriod: 0,
      connectTimeout: TIMEOUT_MS,
    });
    let done = false;
    const finish = (err: Error | null, value?: DynsecResponse[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.end(true);
      if (err) reject(err);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('dynamic-security ne répond pas')), TIMEOUT_MS);
    client.on('error', (err) => finish(new Error(err.message || 'connexion impossible')));
    client.on('connect', () => {
      client.subscribe(`${CONTROL}/response`, { qos: 1 }, (err, granted) => {
        if (err || granted?.some((g) => g.qos === 128)) return finish(new Error('abonnement refusé : le compte du hub n’a pas le droit d’administrer dynamic-security'));
        const payload = JSON.stringify({ commands: commands.map((c) => ({ ...c, correlationData: tag })) });
        client.publish(CONTROL, payload, { qos: 1 }, (perr) => perr && finish(perr));
      });
    });
    client.on('message', (topic, buf) => {
      if (topic !== `${CONTROL}/response`) return;
      try {
        const body = JSON.parse(buf.toString()) as { responses?: (DynsecResponse & { correlationData?: string })[] };
        const mine = body.responses?.filter((r) => r.correlationData === tag);
        // another administrator's answer, or an answer to something else: not ours
        if (mine?.length) finish(null, mine.map(({ correlationData: _c, ...r }) => r));
      } catch {
        // not JSON: not ours
      }
    });
  });
}
