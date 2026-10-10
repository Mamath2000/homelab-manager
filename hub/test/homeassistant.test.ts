import assert from 'node:assert/strict';
import { createServer, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Aedes } from 'aedes';
import { ObjectId } from 'mongodb';
import { testConnection } from '../src/homeassistant/bridge.js';
import { build, INSTALL, PRESS, ROOT_ID, parseDiscoveryTopic, type HostState } from '../src/homeassistant/discovery.js';
import type { HostDoc } from '../src/types.js';
import { dockerHost } from './fixtures.js';

const opts = { topic: 'hm', discoveryPrefix: 'homeassistant', version: '1.2.3' };

function host(name: string, apt?: Partial<NonNullable<HostDoc['apt']>>): HostDoc {
  return {
    _id: new ObjectId(),
    name,
    tokenHash: 'x',
    createdAt: new Date(),
    enrolledAt: new Date(),
    info: { hostname: name, osId: 'debian', osName: 'Debian 13 (trixie)', kernel: '6.12', arch: 'amd64', uptime: 10, ips: ['10.0.0.1'], virt: 'lxc' },
    // agents announce APT only where apt-get exists
    ...(apt ? { capabilities: ['apt_report', 'apt_update', 'apt_upgrade', 'apt_autoremove'] } : {}),
    apt: apt && {
      checkedAt: Date.now(),
      listsUpdatedAt: Date.now(),
      upgradable: [],
      held: [],
      rebootRequired: false,
      rebootPkgs: [],
      ...apt,
    },
  };
}

const pkg = (name: string, security = false) => ({ name, current: '1', candidate: '2', repo: 'trixie', security });

test('devices are nested root > host > sub-component', () => {
  const h = host('pve1', { upgradable: [pkg('openssl', true)] });
  const { devices } = build([{ host: h, online: true, busy: false }], opts);
  const byId = new Map(devices.map((d) => [d.id, d.discovery.device as Record<string, unknown>]));
  const hid = `hm_${h._id.toHexString()}`;
  assert.deepEqual([...byId.keys()].sort(), [ROOT_ID, hid, `${hid}_apt`].sort());
  assert.equal(byId.get(hid)!.via_device, ROOT_ID);
  assert.equal(byId.get(`${hid}_apt`)!.via_device, hid);
  assert.equal(byId.get(ROOT_ID)!.via_device, undefined);
  for (const d of devices) {
    assert.equal(d.discoveryTopic, d.id === ROOT_ID ? 'homeassistant/device/homelab/manager/config' : `homeassistant/device/homelab/${d.id}/config`);
    assert.deepEqual(parseDiscoveryTopic('homeassistant', d.discoveryTopic), { id: d.id, legacy: false });
  }
  // topics of 0.1.6 and earlier are recognised, other integrations are left alone
  assert.deepEqual(parseDiscoveryTopic('homeassistant', `homeassistant/device/${hid}_apt/config`), { id: `${hid}_apt`, legacy: true });
  assert.deepEqual(parseDiscoveryTopic('homeassistant', 'homeassistant/device/homelab_manager/config'), { id: ROOT_ID, legacy: true });
  assert.equal(parseDiscoveryTopic('homeassistant', 'homeassistant/device/komodo/config'), null);
});

test('alerts roll up from the sub-component to the host and the root', () => {
  const ok = host('ok', { upgradable: [pkg('curl')] });
  const bad = host('bad', { upgradable: [pkg('openssl', true)], rebootRequired: true });
  const off = host('off');
  const { devices } = build([
    { host: ok, online: true, busy: false },
    { host: bad, online: true, busy: false },
    { host: off, online: false, busy: false },
  ], opts);
  const state = (id: string, key: string, suffix = 'state') =>
    devices.flatMap((d) => d.states).find(([t]) => t === `hm/${id}/${key}/${suffix}`)?.[1];
  const id = (h: HostDoc) => `hm_${h._id.toHexString()}`;

  assert.equal(state(`${id(bad)}_apt`, 'alerts'), '2');
  assert.equal(state(id(bad), 'alerts'), '2');
  assert.equal(state(id(bad), 'problem'), 'ON');
  assert.equal(state(id(ok), 'problem'), 'OFF');
  assert.equal(state(id(off), 'agent'), 'OFF');
  assert.equal(state(id(off), 'problem'), 'ON');
  assert.equal(state(ROOT_ID, 'hosts_offline'), '1');
  assert.equal(state(ROOT_ID, 'alerts'), '3');
  const attrs = JSON.parse(state(ROOT_ID, 'alerts', 'attributes')!);
  assert.equal(attrs.critical, 1);
  assert.ok(attrs.alerts.every((a: { host?: string }) => a.host));
  // no package report yet: no APT sub-component
  assert.equal(devices.some((d) => d.id === `${id(off)}_apt`), false);
});

test('a roaming host offline is neither an alert nor counted offline', () => {
  const away = { ...host('laptop', { listsUpdatedAt: Date.now() - 10 * 24 * 3600 * 1000 }), roaming: true };
  const { devices } = build([{ host: away, online: false, busy: false }], opts);
  const state = (id: string, key: string, suffix = 'state') =>
    devices.flatMap((d) => d.states).find(([t]) => t === `hm/${id}/${key}/${suffix}`)?.[1];
  const id = `hm_${away._id.toHexString()}`;

  assert.equal(state(id, 'agent'), 'OFF');
  assert.equal(state(id, 'problem'), 'OFF');
  assert.equal(state(id, 'alerts'), '0');
  // stale package lists are expected while away
  assert.equal(state(`${id}_apt`, 'alerts'), '0');
  assert.equal(state(ROOT_ID, 'hosts_offline'), '0');
  assert.equal(state(ROOT_ID, 'alerts'), '0');
});

test('update entity and commands map to jobs', () => {
  const h = host('pve1', { upgradable: [pkg('linux-image-6.12.48-amd64', true), pkg('curl')] });
  const offline = host('off', { upgradable: [pkg('curl')] });
  const states: HostState[] = [{ host: h, online: true, busy: true }, { host: offline, online: false, busy: false }];
  const { devices, commands } = build(states, opts);
  const hid = h._id.toHexString();
  const upd = devices.flatMap((d) => d.states).find(([t]) => t === `hm/hm_${hid}_apt/system/state`)!;
  const u = JSON.parse(upd[1]);
  assert.notEqual(u.installed_version, u.latest_version);
  assert.equal(u.in_progress, true);
  assert.match(u.release_summary, /redémarrage à prévoir/);
  // reboot flag on the host, not on its APT sub-component
  const comps = (id: string) => devices.find((d) => d.id === id)!.discovery.components as Record<string, unknown>;
  assert.ok(comps(`hm_${hid}`).reboot_required);
  assert.equal(comps(`hm_${hid}_apt`).reboot_required, undefined);
  // APT entities follow the agent connectivity
  const apt = devices.find((d) => d.id === `hm_${hid}_apt`)!.discovery;
  assert.equal(apt.availability_mode, 'all');
  assert.deepEqual((apt.availability as { topic: string }[]).map((a) => a.topic), ['hm/lwt', `hm/hm_${hid}/agent/state`]);

  assert.deepEqual(commands.get(`hm/hm_${hid}_apt/system/set`), { payload: INSTALL, action: 'apt_upgrade', hostIds: [hid] });
  assert.deepEqual(commands.get(`hm/hm_${hid}_apt/check/set`), { payload: PRESS, action: 'apt_update', hostIds: [hid] });
  // root buttons only target online hosts
  assert.equal(commands.get(`hm/${ROOT_ID}/update_all/set`), undefined);
  assert.deepEqual(commands.get(`hm/${ROOT_ID}/check_all/set`)!.hostIds, [hid]);
  // a host without APT (Unraid) is left out of "Tout vérifier"
  const unraid = { ...host('nas'), capabilities: ['agent_update', 'docker'] };
  const built = build([{ host: h, online: true, busy: false }, { host: unraid, online: true, busy: false }], opts);
  assert.deepEqual(built.commands.get(`hm/${ROOT_ID}/check_all/set`)!.hostIds, [hid]);
});

test('autoremove entities appear only when the agent reports them', () => {
  const recent = host('new', { autoremovable: ['libyuv0', 'linux-image-6.18.33+rpt-rpi-v8'] });
  const old = host('old', {});
  const { devices, commands } = build([{ host: recent, online: true, busy: false }, { host: old, online: true, busy: false }], opts);
  const comps = (h: HostDoc) => (devices.find((d) => d.id === `hm_${h._id.toHexString()}_apt`)!.discovery.components as Record<string, unknown>);
  assert.ok(comps(recent).autoremovable && comps(recent).autoremove);
  assert.equal(comps(old).autoremovable, undefined);
  const rid = recent._id.toHexString();
  assert.deepEqual(commands.get(`hm/hm_${rid}_apt/autoremove/set`), { payload: PRESS, action: 'apt_autoremove', hostIds: [rid] });
  const states = new Map(devices.flatMap((d) => d.states));
  assert.equal(states.get(`hm/hm_${rid}_apt/autoremovable/state`), '2');
  assert.deepEqual(JSON.parse(states.get(`hm/hm_${rid}_apt/autoremovable/attributes`)!).packages.length, 2);
  assert.equal(states.get(`hm/${ROOT_ID}/hosts_to_clean/state`), '1');
});

test('reboot button only for agents able to reboot', () => {
  const able = { ...host('able'), capabilities: ['reboot'] };
  const old = host('old');
  const { devices, commands } = build([{ host: able, online: true, busy: false }, { host: old, online: true, busy: false }], opts);
  const comps = (h: HostDoc) => devices.find((d) => d.id === `hm_${h._id.toHexString()}`)!.discovery.components as Record<string, Record<string, unknown>>;
  assert.equal(comps(able).reboot.device_class, 'restart');
  assert.equal(comps(old).reboot, undefined);
  const id = able._id.toHexString();
  assert.deepEqual(commands.get(`hm/hm_${id}/reboot/set`), { payload: PRESS, action: 'reboot', hostIds: [id] });
});

test('outdated agents: update entity, alert and root counter', () => {
  const h = { ...host('pve1'), agentVersion: '0.1.1', capabilities: ['agent_update'] };
  const old = { ...host('old'), agentVersion: '0.1.0' };
  const { devices, commands } = build([
    { host: h, online: true, busy: false, agentOutdated: true, latestAgentVersion: '0.1.2' },
    { host: old, online: true, busy: false, agentOutdated: true, latestAgentVersion: '0.1.2' },
  ], opts);
  const states = new Map(devices.flatMap((d) => d.states));
  const id = h._id.toHexString();
  const u = JSON.parse(states.get(`hm/hm_${id}/agent_update/state`)!);
  assert.deepEqual([u.installed_version, u.latest_version], ['0.1.1', '0.1.2']);
  // an agent unable to update itself gets the alert but no update entity
  assert.equal(states.get(`hm/hm_${old._id.toHexString()}/agent_update/state`), undefined);
  assert.equal(states.get(`hm/hm_${old._id.toHexString()}/alerts/state`), '1');
  assert.equal(states.get(`hm/${ROOT_ID}/agents_outdated/state`), '2');
  // agents update themselves: no root button
  assert.equal(commands.get(`hm/${ROOT_ID}/update_agents/set`), undefined);
});

test('testConnection reports broker availability and authentication', async () => {
  const broker = await Aedes.createBroker();
  broker.authenticate = (_client, username, password, done) => done(null, username === 'ha' && password?.toString() === 'secret');
  const server = createServer(broker.handle);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `mqtt://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await testConnection(url, 'ha', 'secret');
    await assert.rejects(testConnection(url, 'ha', 'wrong'));
    await assert.rejects(testConnection('mqtt://127.0.0.1:1', '', ''));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => broker.close(() => r()));
  }
});

test('one sub-component per docker stack, with its update and actions', () => {
  const NEW = 'sha256:' + 'b'.repeat(64);
  const h = dockerHost(
    {
      stacks: [
        {
          name: 'web', workingDir: '/srv/web', configFiles: ['/srv/web/compose.yml'], envFiles: [], status: 'partial',
          services: [
            { name: 'app', image: 'nginx', containers: [{ id: 'a', name: 'web-app-1', state: 'running', status: '', imageId: 'i' }] },
            { name: 'db', image: 'postgres', containers: [{ id: 'b', name: 'web-db-1', state: 'exited', status: '', imageId: 'i' }] },
          ],
        },
      ],
      images: [{ ref: 'nginx', id: 'i', digest: 'sha256:' + 'a'.repeat(64) }, { ref: 'postgres', id: 'i', digest: NEW }],
    },
    { checkedAt: Date.now(), images: [{ ref: 'nginx', digest: NEW }, { ref: 'postgres', digest: NEW }] },
  );
  const { devices, commands } = build([{ host: h, online: true, busy: false }], opts);
  const hid = h._id.toHexString();
  const id = `hm_${hid}_docker_web`;
  const dev = devices.find((d) => d.id === id)!;
  assert.equal((dev.discovery.device as Record<string, unknown>).via_device, `hm_${hid}`);
  const states = new Map(devices.flatMap((d) => d.states));
  assert.equal(states.get(`hm/${id}/status/state`), 'Partielle');
  assert.equal(states.get(`hm/${id}/containers/state`), '1/2');
  const update = JSON.parse(states.get(`hm/${id}/images/state`)!);
  assert.equal(update.latest_version, '1 mise(s) à jour');
  assert.match(update.release_summary, /app \(nginx\)/);
  assert.deepEqual(commands.get(`hm/${id}/images/set`), { payload: INSTALL, action: 'docker_update', hostIds: [hid], target: { stack: 'web' } });
  assert.deepEqual(commands.get(`hm/${id}/restart/set`), { payload: PRESS, action: 'docker_restart', hostIds: [hid], target: { stack: 'web' } });
  // the partial stack is an alert of the stack, the host and the root
  assert.equal(states.get(`hm/${id}/alerts/state`), '1');
  assert.equal(states.get(`hm/hm_${hid}/alerts/state`), '1');
  assert.equal(states.get(`hm/${ROOT_ID}/stacks_to_update/state`), '1');
  assert.deepEqual(commands.get(`hm/hm_${hid}/docker_check/set`), { payload: PRESS, action: 'docker_check', hostIds: [hid] });
});

test('unmanaged stacks are not published', () => {
  const h = {
    ...dockerHost({
      stacks: [
        {
          name: 'web', workingDir: '/srv/web', configFiles: ['/srv/web/compose.yml'], envFiles: [], status: 'partial',
          services: [{ name: 'app', image: 'nginx', containers: [{ id: 'a', name: 'web-app-1', state: 'restarting', status: '', imageId: 'i' }] }],
        },
      ],
    }),
    unmanagedStacks: ['web'],
  };
  const { devices, commands } = build([{ host: h, online: true, busy: false }], opts);
  const hid = h._id.toHexString();
  assert.ok(!devices.some((d) => d.id === `hm_${hid}_docker_web`));
  assert.ok(![...commands.keys()].some((k) => k.includes('_docker_web/')));
  const states = new Map(devices.flatMap((d) => d.states));
  assert.equal(states.get(`hm/hm_${hid}/alerts/state`), '0');
  assert.equal(states.get(`hm/${ROOT_ID}/stacks/state`), '0');
});
