import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { measureVpn, PAUSED, SOURCE_TODO, TARGET_TODO, vpnCandidates } from '../src/vpnProbes.js';
import type { Measure } from '../src/probeRunners.js';
import type { OmadaVpn } from '../src/types.js';

// Jarsay_Home as the controller reads it
const vpn = (o: Partial<OmadaVpn> = {}): OmadaVpn => ({
  id: 'v1', siteId: 'jarsay', name: 'Jarsay_Home', enabled: true, established: true,
  localSubnets: ['192.168.10.0/24', '192.168.11.0/24', '192.168.12.0/24'], remoteSubnets: ['192.168.0.0/24', '192.168.20.0/24', '192.168.100.0/24'], ...o,
});
const host = (name: string, ips: string[], caps = ['ping', 'ping_from']) => ({ _id: new ObjectId(), name, info: { ips } as never, capabilities: caps });
const equipment = (name: string, ip: string, type: 'gateway' | 'switch' = 'switch') => ({ _id: new ObjectId(), name, ip, type });

test('candidates: by address, never by the site of the host; a gateway first among the targets', () => {
  const hosts = [
    host('pje1', ['192.168.10.241']),
    // site jarsay in the hub, but it runs at vouille: not a source of jarsay, a target there
    host('HAOS (Jarsay)', ['192.168.100.31']),
    host('pve1', ['192.168.101.241', '192.168.100.241']),
    // an agent that cannot choose its source address
    host('vieux', ['192.168.10.50'], ['ping']),
  ];
  const { sources, targets } = vpnCandidates(vpn(), hosts, [equipment('SG2210MP', '192.168.0.3'), equipment('ER707-M2', '192.168.0.1', 'gateway'), equipment('EAP', '192.168.10.3')]);
  assert.deepEqual(sources.map((s) => [s.name, s.ip]), [['pje1', '192.168.10.241']]);
  assert.deepEqual(targets.map((t) => [t.name, t.ip, t.gateway]), [['ER707-M2', '192.168.0.1', true], ['HAOS (Jarsay)', '192.168.100.31', false], ['pve1', '192.168.100.241', false], ['SG2210MP', '192.168.0.3', false]]);
});

const hostId = new ObjectId();
const probe = (o: { host?: string; runFrom?: 'hub' | { hostId: ObjectId } } = {}) => ({ target: { type: 'vpn' as const, roleId: 'omada', vpnId: 'v1', host: o.host ?? '192.168.100.31' }, timeoutSec: 5, runFrom: o.runFrom ?? { hostId } });
function deps(o: { v?: OmadaVpn | null; ips?: string[] | null; ping?: Measure } = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      findVpn: async () => (o.v === undefined ? vpn() : o.v),
      findHost: async () => (o.ips === null ? null : { name: 'pve1', info: { ips: o.ips ?? ['192.168.101.241', '192.168.10.241'] } as never }),
      ping: async (_h: ObjectId, address: string, _t: number, from: string) => {
        calls.push(`${from} -> ${address}`);
        return o.ping ?? { state: 'up' as const, latencyMs: 9 };
      },
    },
  };
}

test('vpn measure: pings from the address of the source in the local networks', async () => {
  const d = deps();
  assert.deepEqual(await measureVpn(probe(), d.deps), { state: 'up', latencyMs: 9 });
  assert.deepEqual(d.calls, ['192.168.10.241 -> 192.168.100.31']);
});

test('vpn measure: not set up, or out of the networks: down at once', async () => {
  const at = async (p: ReturnType<typeof probe>, o: Parameters<typeof deps>[0] = {}) => measureVpn(p, deps(o).deps);
  assert.deepEqual(await at(probe({ runFrom: 'hub' })), { state: 'down', message: SOURCE_TODO, immediate: true });
  assert.deepEqual(await at(probe({ host: '' })), { state: 'down', message: TARGET_TODO, immediate: true });
  assert.equal((await at(probe(), { ips: null })).message, 'source supprimée : à choisir');
  const outside = await at(probe(), { ips: ['192.168.100.5'] });
  assert.equal(outside.state, 'down');
  assert.ok(outside.immediate && outside.message?.includes('hors des réseaux locaux'));
  assert.ok((await at(probe({ host: '192.168.50.4' }))).message?.includes('hors des réseaux distants'));
});

test('vpn measure: a disabled tunnel pauses the probe, a failure says what the controller thinks of the tunnel', async () => {
  const paused = deps({ v: vpn({ enabled: false }) });
  assert.deepEqual(await measureVpn(probe(), paused.deps), { state: 'unknown', message: PAUSED });
  assert.deepEqual(paused.calls, []);
  const lost = { state: 'down' as const, message: 'pas de réponse en 5 s' };
  assert.equal((await measureVpn(probe(), deps({ ping: lost }).deps)).message, 'pas de réponse en 5 s (tunnel établi selon Omada)');
  assert.equal((await measureVpn(probe(), deps({ ping: lost, v: vpn({ established: false }) }).deps)).message, 'pas de réponse en 5 s (tunnel non établi selon Omada)');
  assert.equal((await measureVpn(probe(), deps({ v: null }).deps)).state, 'unknown');
});
