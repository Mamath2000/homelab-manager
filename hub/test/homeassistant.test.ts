import assert from 'node:assert/strict';
import { createServer, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Aedes } from 'aedes';
import { ObjectId } from 'mongodb';
import { testConnection } from '../src/homeassistant/bridge.js';
import { evaluateAll } from '../src/monitoring.js';
import { build, deviceOf, INSTALL, PRESS, ROOT_ID, ROOT_KEY, parseDiscoveryTopic, topicKeys, type Device, type HostState } from '../src/homeassistant/discovery.js';
import type { HostDoc, ProbeDoc } from '../src/types.js';
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

// topic prefix of a device: its key (host name as a slug), not its id
const at = (devices: Device[], id: string) => `hm/${devices.find((d) => d.id === id)!.key}`;

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
  // topics by host name, unique ids by host id
  assert.deepEqual(devices.map((d) => d.discoveryTopic).sort(), [
    'homeassistant/device/homelab/manager/config', 'homeassistant/device/homelab/pve1/config', 'homeassistant/device/homelab/pve1_apt/config',
  ]);
  for (const d of devices) {
    assert.deepEqual(parseDiscoveryTopic('homeassistant', d.discoveryTopic), { legacy: false });
    assert.equal(deviceOf(JSON.stringify(d.discovery)), d.id);
    for (const [t] of d.states) assert.ok(t.startsWith(`hm/${d.key}/`));
  }
  assert.ok(devices.find((d) => d.id === hid)!.states.some(([t]) => t === 'hm/pve1/alerts/state'));
  // connectivity: readable unique id and entity id
  const etat = (devices.find((d) => d.id === hid)!.discovery.components as Record<string, Record<string, unknown>>).etat;
  assert.equal(etat.unique_id, `${hid}_etat`);
  assert.equal(etat.default_entity_id, 'binary_sensor.pve1_etat');
  // topics of 0.1.6 and earlier are recognised, other integrations are left alone
  assert.deepEqual(parseDiscoveryTopic('homeassistant', `homeassistant/device/${hid}_apt/config`), { legacy: true });
  assert.deepEqual(parseDiscoveryTopic('homeassistant', 'homeassistant/device/homelab_manager/config'), { legacy: true });
  assert.equal(deviceOf(''), null);
  assert.equal(parseDiscoveryTopic('homeassistant', 'homeassistant/device/komodo/config'), null);
});

test('topic keys: host name as a slug, the oldest host keeps a shared name', () => {
  const first = { _id: new ObjectId('000000000000000000000001'), name: 'Pve 1' };
  const twin = { _id: new ObjectId('0000000000000000000abc02'), name: 'pve-1' };
  const keys = topicKeys([twin, first, { _id: new ObjectId(), name: 'Électricité/Garage' }, { _id: new ObjectId('0000000000000000000def03'), name: 'Manager' }]);
  assert.equal(keys.get(first._id.toHexString()), 'pve_1');
  assert.equal(keys.get(twin._id.toHexString()), 'pve_1_0abc02');
  assert.ok([...keys.values()].includes('electricite_garage'));
  // the root device keeps its topic
  assert.equal(keys.get('0000000000000000000def03'), 'manager_0def03');
});

test('alerts roll up from the sub-component to the host and the root', () => {
  const ok = host('ok', { upgradable: [pkg('curl')] });
  const bad = host('bad', { upgradable: [pkg('openssl', true)], rebootRequired: true });
  const off = { ...host('off'), critical: true };
  const { devices } = build([
    { host: ok, online: true, busy: false },
    { host: bad, online: true, busy: false },
    { host: off, online: false, busy: false },
  ], opts);
  const state = (id: string, key: string, suffix = 'state') =>
    devices.flatMap((d) => d.states).find(([t]) => t === `${at(devices, id)}/${key}/${suffix}`)?.[1];
  const id = (h: HostDoc) => `hm_${h._id.toHexString()}`;

  assert.equal(state(`${id(bad)}_apt`, 'alerts'), '2');
  assert.equal(state(id(bad), 'alerts'), '2');
  assert.equal(state(id(bad), 'problem'), 'ON');
  // a pending package is a warning of the registry
  assert.equal(state(id(ok), 'alerts'), '1');
  assert.equal(state(id(ok), 'problem'), 'ON');
  assert.equal(state(id(off), 'etat'), 'OFF');
  assert.equal(state(id(off), 'problem'), 'ON');
  assert.equal(state(ROOT_ID, 'hosts_offline'), '1');
  assert.equal(state(ROOT_ID, 'alerts'), '4');
  const attrs = JSON.parse(state(ROOT_ID, 'alerts', 'attributes')!);
  // unreachable critical host, security update of `bad`
  assert.equal(attrs.critical, 2);
  assert.ok(attrs.alerts.every((a: { host?: string }) => a.host));
  // no package report yet: no APT sub-component
  assert.equal(devices.some((d) => d.id === `${id(off)}_apt`), false);
});

test('a roaming host offline is neither an alert nor counted offline', () => {
  const away = { ...host('laptop', { listsUpdatedAt: Date.now() - 10 * 24 * 3600 * 1000 }), roaming: true };
  const { devices } = build([{ host: away, online: false, busy: false }], opts);
  const state = (id: string, key: string, suffix = 'state') =>
    devices.flatMap((d) => d.states).find(([t]) => t === `${at(devices, id)}/${key}/${suffix}`)?.[1];
  const id = `hm_${away._id.toHexString()}`;

  assert.equal(state(id, 'etat'), 'OFF');
  assert.equal(state(id, 'problem'), 'OFF');
  assert.equal(state(id, 'alerts'), '0');
  // stale package lists are expected while away
  assert.equal(state(`${id}_apt`, 'alerts'), '0');
  assert.equal(state(ROOT_ID, 'hosts_offline'), '0');
  assert.equal(state(ROOT_ID, 'alerts'), '0');
});

test('session entities are unavailable when their agent is offline', () => {
  const h = {
    ...host('windows'),
    capabilities: ['session'],
    sessions: {
      checkedAt: Date.now(),
      sessions: [{ id: 1, user: 'Mamath', state: 'active' as const, interactive: true }],
    },
  };
  const { devices } = build([{ host: h, online: false, busy: false }], opts);
  const id = `hm_${h._id.toHexString()}`;
  const components = devices.find((d) => d.id === id)!.discovery.components as Record<
    string,
    { availability?: { topic: string }[]; availability_mode?: string }
  >;

  for (const key of ['users_logged_in', 'interactive', 'session_locked', 'session_changed', 'logged_users', 'users']) {
    assert.deepEqual(components[key].availability?.map(({ topic }) => topic), ['hm/lwt', `${at(devices, id)}/etat/state`]);
    assert.equal(components[key].availability_mode, 'all');
  }
});

test('a host excluded from Home Assistant has no device and is left out of the totals', () => {
  const kept = host('pve1', { upgradable: [pkg('openssl', true)] });
  const hidden = { ...host('lab', { upgradable: [pkg('curl')] }), haExcluded: true };
  const groups = [{ id: 'g1', backupId: 'lab', hostId: hidden._id.toHexString(), state: 'stale', lastBackup: 0 }];
  const { devices } = build([{ host: kept, online: true, busy: false }, { host: hidden, online: false, busy: false }], {
    ...opts, backups: { groups, datastores: [] },
  });
  const state = (key: string) => devices.flatMap((d) => d.states).find(([t]) => t === `hm/${ROOT_KEY}/${key}/state`)?.[1];

  assert.equal(devices.some((d) => d.id.startsWith(`hm_${hidden._id.toHexString()}`)), false);
  assert.equal(state('hosts'), '1');
  assert.equal(state('hosts_offline'), '0');
  assert.equal(state('updates'), '1');
  assert.equal(state('backups_late'), '0');
});

test('update entity and commands map to jobs', () => {
  const h = host('pve1', { upgradable: [pkg('linux-image-6.12.48-amd64', true), pkg('curl')] });
  const offline = host('off', { upgradable: [pkg('curl')] });
  const states: HostState[] = [{ host: h, online: true, busy: true }, { host: offline, online: false, busy: false }];
  const { devices, commands } = build(states, opts);
  const hid = h._id.toHexString();
  const upd = devices.flatMap((d) => d.states).find(([t]) => t === `${at(devices, `hm_${hid}_apt`)}/system/state`)!;
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
  assert.deepEqual((apt.availability as { topic: string }[]).map((a) => a.topic), ['hm/lwt', `${at(devices, `hm_${hid}`)}/etat/state`]);

  assert.deepEqual(commands.get(`${at(devices, `hm_${hid}_apt`)}/system/set`), { payload: INSTALL, action: 'apt_upgrade', hostIds: [hid] });
  assert.deepEqual(commands.get(`${at(devices, `hm_${hid}_apt`)}/check/set`), { payload: PRESS, action: 'apt_update', hostIds: [hid] });
  // root buttons only target online hosts
  assert.equal(commands.get(`hm/${ROOT_KEY}/update_all/set`), undefined);
  assert.deepEqual(commands.get(`hm/${ROOT_KEY}/check_all/set`)!.hostIds, [hid]);
  // a host without APT (Unraid) is left out of "Tout vérifier"
  const unraid = { ...host('nas'), capabilities: ['agent_update', 'docker'] };
  const built = build([{ host: h, online: true, busy: false }, { host: unraid, online: true, busy: false }], opts);
  assert.deepEqual(built.commands.get(`hm/${ROOT_KEY}/check_all/set`)!.hostIds, [hid]);
});

test('autoremove entities appear only when the agent reports them', () => {
  const recent = host('new', { autoremovable: ['libyuv0', 'linux-image-6.18.33+rpt-rpi-v8'] });
  const old = host('old', {});
  const { devices, commands } = build([{ host: recent, online: true, busy: false }, { host: old, online: true, busy: false }], opts);
  const comps = (h: HostDoc) => (devices.find((d) => d.id === `hm_${h._id.toHexString()}_apt`)!.discovery.components as Record<string, unknown>);
  assert.ok(comps(recent).autoremovable && comps(recent).autoremove);
  assert.equal(comps(old).autoremovable, undefined);
  const rid = recent._id.toHexString();
  assert.deepEqual(commands.get(`${at(devices, `hm_${rid}_apt`)}/autoremove/set`), { payload: PRESS, action: 'apt_autoremove', hostIds: [rid] });
  const states = new Map(devices.flatMap((d) => d.states));
  assert.equal(states.get(`${at(devices, `hm_${rid}_apt`)}/autoremovable/state`), '2');
  assert.deepEqual(JSON.parse(states.get(`${at(devices, `hm_${rid}_apt`)}/autoremovable/attributes`)!).packages.length, 2);
  assert.equal(states.get(`hm/${ROOT_KEY}/hosts_to_clean/state`), '1');
});

test('reboot button only for agents able to reboot', () => {
  const able = { ...host('able'), capabilities: ['reboot'] };
  const old = host('old');
  const { devices, commands } = build([{ host: able, online: true, busy: false }, { host: old, online: true, busy: false }], opts);
  const comps = (h: HostDoc) => devices.find((d) => d.id === `hm_${h._id.toHexString()}`)!.discovery.components as Record<string, Record<string, unknown>>;
  assert.equal(comps(able).reboot.device_class, 'restart');
  assert.equal(comps(old).reboot, undefined);
  const id = able._id.toHexString();
  assert.deepEqual(commands.get(`${at(devices, `hm_${id}`)}/reboot/set`), { payload: PRESS, action: 'reboot', hostIds: [id] });
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
  const u = JSON.parse(states.get(`${at(devices, `hm_${id}`)}/agent_update/state`)!);
  assert.deepEqual([u.installed_version, u.latest_version], ['0.1.1', '0.1.2']);
  // the agent update follows the agent connectivity; the connectivity sensor itself stays available
  const comps = devices.find((d) => d.id === `hm_${id}`)!.discovery.components as Record<string, { availability?: { topic: string }[]; availability_mode?: string }>;
  assert.equal(comps.agent_update.availability_mode, 'all');
  assert.deepEqual(comps.agent_update.availability!.map((a) => a.topic), ['hm/lwt', `${at(devices, `hm_${id}`)}/etat/state`]);
  assert.equal(comps.etat.availability, undefined);
  // an agent unable to update itself gets the alert but no update entity
  assert.equal(states.get(`${at(devices, `hm_${old._id.toHexString()}`)}/agent_update/state`), undefined);
  assert.equal(states.get(`${at(devices, `hm_${old._id.toHexString()}`)}/alerts/state`), '1');
  assert.equal(states.get(`hm/${ROOT_KEY}/agents_outdated/state`), '2');
  // agents update themselves: no root button
  assert.equal(commands.get(`hm/${ROOT_KEY}/update_agents/set`), undefined);
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
  assert.equal(states.get(`${at(devices, id)}/status/state`), 'Partielle');
  assert.equal(states.get(`${at(devices, id)}/containers/state`), '1/2');
  const update = JSON.parse(states.get(`${at(devices, id)}/images/state`)!);
  assert.equal(update.latest_version, '1 mise(s) à jour');
  assert.match(update.release_summary, /app \(nginx\)/);
  assert.deepEqual(commands.get(`${at(devices, id)}/images/set`), { payload: INSTALL, action: 'docker_update', hostIds: [hid], target: { stack: 'web' } });
  assert.deepEqual(commands.get(`${at(devices, id)}/restart/set`), { payload: PRESS, action: 'docker_restart', hostIds: [hid], target: { stack: 'web' } });
  // the partial stack is an alert of the stack, the host and the root
  assert.equal(states.get(`${at(devices, id)}/alerts/state`), '1');
  assert.equal(states.get(`${at(devices, `hm_${hid}`)}/alerts/state`), '1');
  assert.equal(states.get(`hm/${ROOT_KEY}/stacks_to_update/state`), '1');
  assert.deepEqual(commands.get(`${at(devices, `hm_${hid}`)}/docker_check/set`), { payload: PRESS, action: 'docker_check', hostIds: [hid] });
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
  assert.equal(states.get(`${at(devices, `hm_${hid}`)}/alerts/state`), '0');
  assert.equal(states.get(`hm/${ROOT_KEY}/stacks/state`), '0');
});

test('UPS: sub-device with its sensors, battery to replace rolls up as a critical alert', () => {
  const h = host('pbs');
  h.ups = { checkedAt: Date.now(), name: 'ups', model: 'Back-UPS XS 1400U', driver: 'usbhid-ups', status: 'ALARM OL RB', charge: 100, runtime: 528, load: 20, inputVoltage: 228 };
  const { devices } = build([{ host: h, online: true, busy: false }], opts);
  const hostId = `hm_${h._id.toHexString()}`;
  const ups = devices.find((d) => d.id === `${hostId}_ups`);
  assert.ok(ups);
  assert.equal((ups.discovery.device as Record<string, unknown>).via_device, hostId);
  const states = new Map(ups.states);
  assert.equal(states.get(`${at(devices, `${hostId}_ups`)}/battery/state`), '100');
  assert.equal(states.get(`${at(devices, `${hostId}_ups`)}/runtime/state`), '528');
  assert.equal(states.get(`${at(devices, `${hostId}_ups`)}/replace_battery/state`), 'ON');
  assert.equal(states.get(`${at(devices, `${hostId}_ups`)}/on_battery/state`), 'OFF');
  const rolled = JSON.parse(devices.find((d) => d.id === hostId)!.states.find(([t]) => t.endsWith('/alerts/attributes'))![1]);
  assert.ok(rolled.critical >= 1);
  // a host without UPS gets no such device
  assert.ok(!build([{ host: host('pve2'), online: true, busy: false }], opts).devices.some((d) => d.id.endsWith('_ups')));
});

// --- level of detail ---------------------------------------------------------------------------------

const withLoad = (h: HostDoc, cpu: number, mem: number, volumes: { mountpoint: string; percent: number }[]): HostDoc => ({
  ...h,
  health: {
    system: { checkedAt: Date.now(), cpuPercent: cpu, memPercent: mem, memUsed: 0, memTotal: 0 },
    disks: { checkedAt: Date.now(), volumes: volumes.map((v) => ({ device: 'x', fstype: 'ext4', used: 0, total: 0, ...v })) },
  },
});
const find = (devices: ReturnType<typeof build>['devices'], id: string, key: string, suffix = 'state') =>
  devices.flatMap((d) => d.states).find(([t]) => t === `${at(devices, id)}/${key}/${suffix}`)?.[1];

test('minimal level: host device with connectivity and alerts only, totals still count every host', () => {
  const a = host('a', { upgradable: [pkg('openssl', true)] });
  const b = { ...host('b', { upgradable: [pkg('curl')] }), haDetail: 'full' as const };
  const states: HostState[] = [{ host: a, online: true, busy: false }, { host: b, online: true, busy: false }];
  const { devices, commands } = build(states, { ...opts, detail: { level: 'minimal', sections: [] } });
  const ida = `hm_${a._id.toHexString()}`;
  const idb = `hm_${b._id.toHexString()}`;
  const comps = (id: string) => Object.keys(devices.find((d) => d.id === id)!.discovery.components as object).sort();

  // global minimal: no APT sub-device, no buttons, no diagnostics
  assert.deepEqual(comps(ida), ['alerts', 'etat', 'problem']);
  assert.equal(devices.some((d) => d.id === `${ida}_apt`), false);
  // the alert of the sub-component still rolls up
  assert.equal(find(devices, ida, 'alerts'), '1');
  // a host set to full keeps its details
  assert.equal(devices.some((d) => d.id === `${idb}_apt`), true);
  assert.ok(comps(idb).includes('os'));
  assert.deepEqual([...commands.keys()].filter((k) => k.includes(ida)), []);
  // root: alerts and tops only, no counters
  assert.deepEqual(comps(ROOT_ID), ['alerts', 'problem', 'top_cpu', 'top_disk', 'top_mem']);
});

test('counters section counts the hosts below the global level too', () => {
  const a = { ...host('a', { upgradable: [pkg('openssl', true)] }), haDetail: 'minimal' as const };
  const b = host('b', { upgradable: [pkg('curl')] });
  const { devices } = build([{ host: a, online: true, busy: false }, { host: b, online: true, busy: false }], {
    ...opts, detail: { level: 'custom', sections: ['counters'] },
  });
  assert.equal(find(devices, ROOT_ID, 'updates'), '2');
  assert.equal(find(devices, ROOT_ID, 'security'), '1');
  assert.equal(find(devices, ROOT_ID, 'hosts'), '2');
});

test('haDetail none behaves like the old exclusion, the legacy flag still works', () => {
  const kept = host('kept');
  const none = { ...host('none'), haDetail: 'none' as const };
  const legacy = { ...host('legacy'), haExcluded: true };
  const { devices } = build(
    [kept, none, legacy].map((h) => ({ host: h, online: true, busy: false })),
    opts,
  );
  assert.equal(find(devices, ROOT_ID, 'hosts'), '1');
  assert.equal(devices.filter((d) => d.id.startsWith('hm_')).length, 1);
});

test('tops rank online hosts that are not roaming; disk = worst volume', () => {
  const a = withLoad(host('a'), 10, 80, [{ mountpoint: '/', percent: 30 }, { mountpoint: '/data', percent: 91.26 }]);
  const b = withLoad(host('b'), 55.55, 20, [{ mountpoint: '/', percent: 60 }]);
  const away = { ...withLoad(host('away'), 99, 99, [{ mountpoint: '/', percent: 99 }]), roaming: true };
  const off = withLoad(host('off'), 98, 98, [{ mountpoint: '/', percent: 98 }]);
  const none = host('nodata');
  const { devices } = build(
    [a, b, away, off, none].map((h) => ({ host: h, online: h !== off, busy: false })),
    { ...opts, detail: { level: 'minimal', sections: [] } },
  );
  assert.equal(find(devices, ROOT_ID, 'top_cpu'), 'b');
  assert.equal(find(devices, ROOT_ID, 'top_mem'), 'a');
  assert.equal(find(devices, ROOT_ID, 'top_disk'), 'a');
  const cpu = JSON.parse(find(devices, ROOT_ID, 'top_cpu', 'attributes')!);
  assert.deepEqual([cpu.top1_name, cpu.top1_cpu, cpu.top2_name, cpu.top2_cpu, cpu.top3_name], ['b', 55.6, 'a', 10, null]);
  const disk = JSON.parse(find(devices, ROOT_ID, 'top_disk', 'attributes')!);
  assert.deepEqual([disk.top1_disk, disk.top1_volume, disk.top2_disk, disk.top2_volume], [91.3, '/data', 60, '/']);
});

test('every attributes topic of a config is one the hub publishes', () => {
  const a = withLoad({ ...host('pve1', { upgradable: [pkg('curl')], autoremovable: ['libx'] }), capabilities: ['session'] }, 50, 40, [{ mountpoint: '/', percent: 70 }]);
  a.sessions = { checkedAt: Date.now(), sessions: [{ id: 1, user: 'u', state: 'active', interactive: true }] };
  a.ups = { checkedAt: Date.now(), name: 'ups', model: 'X', driver: 'usbhid-ups', status: 'OL', charge: 100, runtime: 500, load: 10, inputVoltage: 230 };
  const { devices } = build([{ host: a, online: true, busy: false }], { ...opts, detail: { level: 'full', sections: [] } });
  const published = new Set(devices.flatMap((d) => d.states.map(([t]) => t)));
  let checked = 0;
  for (const d of devices) {
    for (const c of Object.values(d.discovery.components as Record<string, { json_attributes_topic?: string }>)) {
      if (!c.json_attributes_topic) continue;
      checked++;
      assert.ok(published.has(c.json_attributes_topic), c.json_attributes_topic);
    }
  }
  assert.ok(checked >= 5);
});

test('custom level of a host: its own sections, kept to the host ones', async () => {
  const { haLevelSchema, normalizeHostDetail } = await import('../src/homeassistant/detail.js');
  const { Ajv } = await import('ajv');
  const valid = new Ajv().compile(haLevelSchema);
  assert.ok(valid(null) && valid('none') && valid({ level: 'custom', sections: ['apt', 'actions'] }));
  assert.ok(!valid({ level: 'custom', sections: ['tops'] }) && !valid({ level: 'full', sections: [] }) && !valid('custom'));
  assert.deepEqual(normalizeHostDetail({ level: 'custom', sections: ['actions', 'apt', 'tops'] }), { level: 'custom', sections: ['apt', 'actions'] });

  const h = { ...host('pve1', { upgradable: [pkg('curl')] }), capabilities: ['apt_report', 'apt_update', 'reboot'], haDetail: { level: 'custom' as const, sections: ['actions' as const] } };
  const { devices } = build([{ host: h, online: true, busy: false }], { ...opts, detail: { level: 'full', sections: [] } });
  const hid = `hm_${h._id.toHexString()}`;
  // actions without the APT sub-device, no diagnostics
  assert.equal(devices.some((d) => d.id === `${hid}_apt`), false);
  const comps = devices.find((d) => d.id === hid)!.discovery.components as Record<string, unknown>;
  assert.ok(comps.reboot);
  assert.equal(comps.os, undefined);
});

// --- probes ------------------------------------------------------------------------------------------

const probe = (h: HostDoc, name: string, state: ProbeDoc['state'], extra: Partial<ProbeDoc> = {}): ProbeDoc => ({
  _id: new ObjectId(),
  subject: { kind: 'host', id: h._id },
  name,
  target: { type: 'tcp', host: '10.0.0.1', port: 8123 },
  runFrom: 'hub',
  intervalSec: 60,
  timeoutSec: 10,
  retries: 0,
  state,
  since: new Date('2026-01-01T00:00:00Z'),
  message: state === 'down' ? 'connexion refusée' : null,
  createdAt: new Date(),
  ...extra,
});

const stackOf = (name: string) => ({
  name, workingDir: `/srv/${name}`, configFiles: [`/srv/${name}/compose.yml`], envFiles: [], status: 'running' as const,
  services: [{ name: 'app', image: 'nginx', containers: [{ id: 'a', name: `${name}-app-1`, state: 'running', status: '', imageId: 'i' }] }],
});

test('probes: a binary sensor per probe on the host device, unavailable when unknown', () => {
  const h = host('pve1');
  const up = probe(h, 'Zigbee2MQTT', 'up', { target: { type: 'mqtt', brokerId: 'vouille', topic: 'zigbee2mqtt/bridge/state', contains: 'online' } });
  const down = probe(h, 'HA', 'down');
  const unknown = probe(h, 'ESP', 'unknown', { message: 'broker injoignable' });
  const { devices } = build([{ host: h, online: true, busy: false, probes: [up, down, unknown] }], { ...opts, detail: { level: 'standard', sections: [] } });
  const hid = `hm_${h._id.toHexString()}`;
  const comps = devices.find((d) => d.id === hid)!.discovery.components as Record<string, Record<string, unknown>>;
  const key = (p: ProbeDoc) => `probe_${p._id.toHexString()}`;
  assert.equal(comps[key(up)].platform, 'binary_sensor');
  assert.equal(comps[key(up)].name, 'Zigbee2MQTT');
  assert.equal(comps[key(up)].device_class, 'connectivity');
  assert.equal(comps[key(up)].unique_id, `${hid}_${key(up)}`);
  assert.equal(find(devices, hid, key(up)), 'ON');
  assert.equal(find(devices, hid, key(down)), 'OFF');
  // readable: available whatever the state, unknown: unavailable
  assert.equal(find(devices, hid, `${key(up)}_available`), 'ON');
  assert.equal(find(devices, hid, `${key(down)}_available`), 'ON');
  assert.equal(find(devices, hid, `${key(unknown)}_available`), 'OFF');
  // the availability of the entity is its own: the connectivity of the host does not apply (the hub measures it)
  const avail = comps[key(up)].availability as { topic: string }[];
  assert.ok(avail.some((a) => a.topic === `${at(devices, hid)}/${key(up)}_available/state`));
  assert.ok(!avail.some((a) => a.topic.endsWith('/etat/state')));
  const attrs = JSON.parse(find(devices, hid, key(down), 'attributes')!);
  assert.deepEqual(attrs, { type: 'tcp', target: '10.0.0.1:8123', since: '2026-01-01T00:00:00.000Z', message: 'connexion refusée' });
  assert.equal(JSON.parse(find(devices, hid, key(up), 'attributes')!).target, 'vouille · zigbee2mqtt/bridge/state');
});

test('probes: those of a stack go on its device, the others on the host', () => {
  const h = dockerHost({ stacks: [stackOf('web')] });
  const onStack = probe(h, 'Web', 'up', { subject: { kind: 'host', id: h._id, stack: 'web' } });
  const onHost = probe(h, 'SSH', 'up');
  const { devices } = build([{ host: h, online: true, busy: false, probes: [onStack, onHost] }], { ...opts, detail: { level: 'standard', sections: [] } });
  const comps = (id: string) => Object.keys(devices.find((d) => d.id === id)!.discovery.components as object);
  const hid = `hm_${h._id.toHexString()}`;
  assert.ok(comps(`${hid}_docker_web`).includes(`probe_${onStack._id.toHexString()}`));
  assert.ok(!comps(hid).includes(`probe_${onStack._id.toHexString()}`));
  assert.ok(comps(hid).includes(`probe_${onHost._id.toHexString()}`));
  // the stack's entity does not follow the connectivity of the host either
  const c = (devices.find((d) => d.id === `${hid}_docker_web`)!.discovery.components as Record<string, { availability?: { topic: string }[] }>)[`probe_${onStack._id.toHexString()}`];
  assert.ok(!c.availability!.some((a) => a.topic.endsWith('/etat/state')));
});

test('probes: a stack without a published device puts its probes on the host; section off: nothing', () => {
  const h = dockerHost({ stacks: [stackOf('web')] });
  const p = probe(h, 'Web', 'down', { subject: { kind: 'host', id: h._id, stack: 'web' } });
  const hid = `hm_${h._id.toHexString()}`;
  const key = `probe_${p._id.toHexString()}`;
  // Docker not published: the probe stays reachable on the host
  const noDocker = build([{ host: h, online: true, busy: false, probes: [p] }], { ...opts, detail: { level: 'custom', sections: ['probes'] } });
  assert.ok(key in (noDocker.devices.find((d) => d.id === hid)!.discovery.components as object));
  // minimal level (no probes section): no entity, but the alert of the registry still rolls up
  const status = evaluateAll([h], [], Date.now(), [p])[h._id.toHexString()];
  const minimal = build([{ host: h, online: true, busy: false, probes: [p], status }], { ...opts, detail: { level: 'minimal', sections: [] } });
  assert.ok(!(key in (minimal.devices.find((d) => d.id === hid)!.discovery.components as object)));
  assert.equal(find(minimal.devices, hid, 'alerts'), '1');
});

test('probes: a roaming host away makes them unavailable', () => {
  const h = { ...host('laptop'), roaming: true };
  const p = probe(h, 'SSH', 'up');
  const hid = `hm_${h._id.toHexString()}`;
  const away = build([{ host: h, online: false, busy: false, probes: [p] }], { ...opts, detail: { level: 'standard', sections: [] } });
  assert.equal(find(away.devices, hid, `probe_${p._id.toHexString()}_available`), 'OFF');
  const here = build([{ host: h, online: true, busy: false, probes: [p] }], { ...opts, detail: { level: 'standard', sections: [] } });
  assert.equal(find(here.devices, hid, `probe_${p._id.toHexString()}_available`), 'ON');
  // a fixed host that is offline: its services are still judged by the hub
  const fixed = { ...host('nas') };
  const q = probe(fixed, 'SMB', 'up');
  const off = build([{ host: fixed, online: false, busy: false, probes: [q] }], { ...opts, detail: { level: 'standard', sections: [] } });
  assert.equal(find(off.devices, `hm_${fixed._id.toHexString()}`, `probe_${q._id.toHexString()}_available`), 'ON');
});

test('probes section: in the standard and full presets, per host, not in minimal', async () => {
  const { HA_HOST_SECTIONS, HA_PRESETS, normalizeHostDetail } = await import('../src/homeassistant/detail.js');
  assert.ok(HA_PRESETS.standard.includes('probes') && HA_PRESETS.full.includes('probes'));
  assert.ok(!HA_PRESETS.minimal.includes('probes'));
  assert.ok(HA_HOST_SECTIONS.includes('probes'));
  assert.deepEqual(normalizeHostDetail({ level: 'custom', sections: ['probes', 'apt'] }), { level: 'custom', sections: ['apt', 'probes'] });
});
