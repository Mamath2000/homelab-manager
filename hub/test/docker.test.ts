import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dockerLogsCard, dockerSummary, dockerView, findStack, isDockerReport, isExternal, isUnmanaged, stackLogs, staleRegistryCheck, updatableStacks } from '../src/docker.js';
import type { DockerStack } from '../src/types.js';
import { dockerHost } from './fixtures.js';

const NEW = 'sha256:' + 'b'.repeat(64);
const OLD = 'sha256:' + 'a'.repeat(64);

function stack(name: string, status: DockerStack['status'], services: [string, string, string, string?][]): DockerStack {
  // [service, image ref, container state, image id of the container]
  return {
    name,
    workingDir: `/srv/${name}`,
    configFiles: [`/srv/${name}/compose.yml`],
    envFiles: [],
    status,
    services: services.map(([svc, image, state, imageId]) => ({
      name: svc,
      image,
      containers: state ? [{ id: svc, name: `${name}-${svc}-1`, state, status: '', imageId: imageId ?? 'img-current' }] : [],
    })),
  };
}

test('update state per service: available, recreate, up to date, unknown', () => {
  const h = dockerHost(
    {
      stacks: [
        stack('web', 'running', [
          ['app', 'nginx:latest', 'running'],
          ['db', 'postgres:16', 'running', 'img-old'],
          ['cache', 'redis:7', 'running'],
          ['tool', 'local/tool', 'running'],
        ]),
      ],
      images: [
        { ref: 'nginx:latest', id: 'img-current', digest: OLD },
        { ref: 'postgres:16', id: 'img-current', digest: NEW },
        { ref: 'redis:7', id: 'img-current', digest: NEW },
        { ref: 'local/tool', id: 'img-current', digest: '' },
      ],
    },
    {
      checkedAt: Date.now(),
      images: [
        { ref: 'nginx:latest', digest: NEW },
        { ref: 'postgres:16', digest: NEW },
        { ref: 'redis:7', digest: NEW },
        { ref: 'local/tool', error: 'local image' },
      ],
    },
  );
  const v = dockerView(h)!;
  const svc = Object.fromEntries(v.stacks[0].services.map((s) => [s.name, s.update]));
  assert.deepEqual(svc, { app: 'available', db: 'recreate', cache: 'uptodate', tool: 'unknown' });
  assert.equal(v.stacks[0].update, 'available');
  assert.equal(v.stacks[0].updates, 2);
  assert.equal(v.stacks[0].services.find((s) => s.name === 'tool')!.checkError, 'local image');
});

test('image known under several digests: up to date when the registry one is among them', () => {
  // tag republished with the same layers: the pull adds a digest to the same image
  const h = dockerHost(
    {
      stacks: [stack('sure', 'running', [['db', 'postgres:16', 'running'], ['app', 'nginx', 'running']])],
      images: [
        { ref: 'postgres:16', id: 'img-current', digest: OLD, digests: [OLD, NEW] },
        { ref: 'nginx', id: 'img-current', digest: OLD, digests: [OLD] },
      ],
    },
    { checkedAt: Date.now(), images: [{ ref: 'postgres:16', digest: NEW }, { ref: 'nginx', digest: NEW }] },
  );
  const [db, app] = dockerView(h)!.stacks[0].services;
  assert.equal(db.update, 'uptodate');
  assert.equal(db.localDigest, NEW);
  assert.equal(app.update, 'available');
});

test('never checked: unknown, except an image pulled but not redeployed', () => {
  const h = dockerHost({
    stacks: [stack('a', 'running', [['app', 'nginx', 'running']]), stack('b', 'running', [['app', 'redis', 'running', 'img-old']])],
    images: [
      { ref: 'nginx', id: 'img-current', digest: OLD },
      { ref: 'redis', id: 'img-current', digest: OLD },
    ],
  });
  const v = dockerView(h)!;
  assert.equal(v.stacks[0].update, 'unknown');
  assert.equal(v.stacks[1].update, 'recreate');
  assert.equal(v.updatesCheckedAt, null);
});

test('problems: partial stack, unhealthy or restarting containers, not a stopped stack', () => {
  const partial = stack('web', 'partial', [['app', 'nginx', 'running'], ['db', 'postgres', 'exited']]);
  const sick = stack('media', 'running', [['plex', 'plex', 'running']]);
  sick.services[0].containers[0].health = 'unhealthy';
  const loop = stack('mqtt', 'partial', [['broker', 'mosquitto', 'restarting']]);
  const off = stack('old', 'stopped', [['app', 'nginx', 'exited']]);
  const down = stack('gone', 'down', [['app', 'nginx', '']]);
  const v = dockerView(dockerHost({ stacks: [partial, sick, loop, off, down] }))!;
  const problems = Object.fromEntries(v.stacks.map((s) => [s.name, s.problems]));
  assert.deepEqual(problems.web, ['1/2 conteneurs en marche']);
  assert.deepEqual(problems.media, ['plex : en mauvaise santé']);
  assert.ok(problems.mqtt.includes('broker : redémarre en boucle'));
  assert.deepEqual(problems.old, []);
  assert.deepEqual(problems.gone, []);
  assert.deepEqual(dockerSummary(v), { stacks: 5, running: 1, partial: 2, stopped: 1, down: 1, updates: 0, problems: 3, unmanaged: 0 });
});

test('unmanaged stack: image updates only, no state nor problems, out of the counts', () => {
  const sick = stack('media', 'partial', [['plex', 'plex:latest', 'restarting'], ['db', 'postgres', 'exited']]);
  const web = stack('web', 'running', [['app', 'nginx:latest', 'running']]);
  const h = {
    ...dockerHost(
      { stacks: [sick, web], images: [{ ref: 'plex:latest', id: 'img-current', digest: OLD }, { ref: 'nginx:latest', id: 'img-current', digest: OLD }] },
      { checkedAt: Date.now(), images: [{ ref: 'plex:latest', digest: NEW }, { ref: 'nginx:latest', digest: NEW }] },
    ),
    unmanagedStacks: ['media'],
  };
  const v = dockerView(h)!;
  const media = v.stacks.find((s) => s.name === 'media')!;
  assert.equal(media.managed, false);
  assert.deepEqual(media.problems, []);
  assert.equal(media.updates, 1);
  assert.equal(media.update, 'available');
  assert.equal(media.total, 0);
  assert.deepEqual(media.services.map((s) => [s.name, s.containers.length, s.update]), [['plex', 0, 'available'], ['db', 0, 'unknown']]);
  assert.equal(v.stacks.find((s) => s.name === 'web')!.managed, true);
  assert.deepEqual(dockerSummary(v), { stacks: 1, running: 1, partial: 0, stopped: 0, down: 0, updates: 1, problems: 0, unmanaged: 1 });
  assert.ok(isUnmanaged(h, 'media'));
  assert.ok(!isUnmanaged(h, 'web'));
});

test('no docker view without the capability or a report', () => {
  const h = dockerHost({ stacks: [stack('web', 'running', [['app', 'nginx', 'running']])] });
  assert.ok(dockerView(h));
  assert.equal(dockerView({ ...h, capabilities: [] }), null);
  assert.equal(dockerView({ ...h, docker: undefined }), null);
  assert.equal(dockerSummary(null), null);
});

test('stack and service lookups use the last report', () => {
  const h = dockerHost({ stacks: [stack('web', 'running', [['app', 'nginx', 'running']])] });
  assert.ok(findStack(h, 'web'));
  assert.ok(findStack(h, 'web', 'app'));
  assert.equal(findStack(h, 'web', 'db'), null);
  assert.equal(findStack(h, 'other'), null);
  h.docker!.stacks[0].services.push({ name: 'aio-apache', image: 'apache', containers: [], external: true });
  assert.ok(isExternal(h, 'web', 'aio-apache'));
  assert.ok(!isExternal(h, 'web', 'app'));
  assert.ok(!isExternal(h, 'web'));
});

test('malformed reports are refused', () => {
  assert.ok(isDockerReport({ checkedAt: 1, engine: '', compose: '', stacks: [], images: [] }));
  assert.ok(!isDockerReport({ checkedAt: 1, stacks: [{ name: 'x' }], images: [] }));
  assert.ok(!isDockerReport({ stacks: [], images: [] }));
  assert.ok(!isDockerReport(null));
});

test('journals of the containers: followed, to recreate, or nothing while the collector is not set up', () => {
  const st = (marks: (boolean | undefined)[]) => ({ services: [{ name: 'app', image: 'app', containers: marks.map((m, i) => ({ id: `c${i}`, name: `c${i}`, state: 'running', status: '', imageId: 'x', ...(m === undefined ? {} : { logFollowed: m }) })) }] });
  assert.equal(stackLogs(st([true, true]), true), 'followed');
  assert.equal(stackLogs(st([true, false]), true), 'recreate');
  // a stack without container (down) or not inspected: no state
  assert.equal(stackLogs(st([]), true), null);
  assert.equal(stackLogs(st([undefined]), true), null);
  assert.equal(stackLogs(st([true]), false), null);

  const state = { address: '192.168.100.172', port: 517, daemon: 'ok' as const, collector: 'running' as const };
  const h = dockerHost({ stacks: [stack('web', 'running', [['app', 'app:1', 'running']])], logCollect: state });
  h.capabilities = ['docker', 'docker_log_collect'];
  h.docker!.stacks[0].services[0].containers[0].logFollowed = false;
  h.dockerLogs = { enabled: true };
  const v = dockerView(h)!;
  assert.deepEqual(v.logs, { available: true, enabled: true, state });
  assert.equal(v.stacks[0].logs, 'recreate');
  // not set up, agent without the capability
  assert.deepEqual(dockerView(dockerHost({}))!.logs, { available: false, enabled: false, state: null });

  assert.ok(isDockerReport({ checkedAt: 1, engine: '', compose: '', stacks: [], images: [], logCollect: state }));
  assert.ok(!isDockerReport({ checkedAt: 1, engine: '', compose: '', stacks: [], images: [], logCollect: { address: 1 } }));
});

test('journals of the containers on the card of Paramètres › Logs', () => {
  const ok = { address: '192.168.100.172', port: 517, daemon: 'ok' as const, collector: 'running' as const };
  const host = (logCollect?: typeof ok | Record<string, unknown>, enabled = true, followed = true, caps = ['docker', 'docker_log_collect']) => {
    const h = dockerHost({ stacks: [stack('web', 'running', [['app', 'app:1', 'running']])], ...(logCollect ? { logCollect } : {}) });
    h.capabilities = caps;
    if (logCollect) h.docker!.stacks[0].services[0].containers[0].logFollowed = followed;
    if (enabled) h.dockerLogs = { enabled: true };
    return h;
  };
  const now = 1_000_000_000;
  const o = { lastAt: now - 60_000, receivingMs: 3600_000, running: false, now };
  const state = (h: ReturnType<typeof host>, x: Partial<typeof o> & { lastJob?: { status: string; error?: string } } = {}) => {
    const c = dockerLogsCard(h, { ...o, ...x })!;
    return [c.state, c.detail];
  };
  assert.deepEqual(state(host(ok)), ['ok', null]);
  assert.deepEqual(state(host(ok), { lastAt: now - 7200_000 }), ['silent', null]);
  assert.deepEqual(state(host(ok), { lastAt: null }), ['silent', null]);
  assert.deepEqual(state(host(ok, true, false)), ['drift', 'une stack à recréer : web']);
  assert.equal(dockerLogsCard(host(ok, true, false), o)!.recreate[0], 'web');
  assert.deepEqual(state(host({ ...ok, daemon: 'drift', daemonDetail: 'log-driver journald' })), ['drift', 'log-driver journald']);
  assert.deepEqual(state(host({ ...ok, collector: 'stopped' })), ['error', 'collecteur arrêté']);
  assert.deepEqual(state(host({ ...ok, unreachable: 'connection refused' })), ['error', 'serveur de logs injoignable (connection refused)']);
  assert.deepEqual(state(host(undefined)), ['error', 'collecteur absent']);
  assert.deepEqual(state(host(undefined), { lastJob: { status: 'failed', error: 'dial tcp: refused' } }), ['error', 'dial tcp: refused']);
  assert.deepEqual(state(host(undefined, false)), ['off', null]);
  assert.deepEqual(state(host(undefined), { running: true }), ['pending', null]);
  assert.deepEqual(state(host(undefined, false, true, ['docker'])), ['unavailable', 'agent à mettre à jour (Docker et systemd requis)']);
  // no stack: nothing to show
  const empty = dockerHost({ stacks: [] });
  empty.capabilities = ['docker', 'docker_log_collect'];
  assert.equal(dockerLogsCard(empty, o), null);
});

test('registry check stale after a local image change', () => {
  const report = (id: string, digest: string) => dockerHost({ images: [{ ref: 'app:latest', id, digest, digests: [digest] }] }).docker!;
  const MID = 'sha256:' + 'c'.repeat(64);
  const checked = { checkedAt: 1, images: [{ ref: 'app:latest', digest: MID }] };
  // release N checked, then N+1 pulled: the recorded digest is neither
  assert.equal(staleRegistryCheck(report('img-old', OLD), report('img-new', NEW), checked), true);
  // the pulled image is the one the check saw
  assert.equal(staleRegistryCheck(report('img-old', OLD), report('img-new', MID), checked), false);
  // nothing changed locally, no previous report, never checked
  assert.equal(staleRegistryCheck(report('img-old', OLD), report('img-old', OLD), checked), false);
  assert.equal(staleRegistryCheck(undefined, report('img-new', NEW), checked), false);
  assert.equal(staleRegistryCheck(report('img-old', OLD), report('img-new', NEW), undefined), false);
});

test('stacks to update: managed ones with a newer image only', () => {
  const h = dockerHost(
    {
      stacks: [stack('web', 'running', [['app', 'nginx:latest', 'running']]), stack('db', 'running', [['pg', 'postgres:16', 'running']]), stack('aio', 'running', [['nc', 'nextcloud:30', 'running']])],
      images: [
        { ref: 'nginx:latest', id: 'img-current', digest: OLD },
        { ref: 'postgres:16', id: 'img-current', digest: NEW },
        { ref: 'nextcloud:30', id: 'img-current', digest: OLD },
      ],
    },
    { checkedAt: Date.now(), images: [{ ref: 'nginx:latest', digest: NEW }, { ref: 'postgres:16', digest: NEW }, { ref: 'nextcloud:30', digest: NEW }] },
  );
  assert.deepEqual(updatableStacks({ ...h, unmanagedStacks: ['aio'] }), ['web']);
  assert.deepEqual(updatableStacks({ ...h, capabilities: [] }), []);
});
