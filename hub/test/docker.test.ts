import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dockerSummary, dockerView, findStack, isDockerReport } from '../src/docker.js';
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
  assert.deepEqual(dockerSummary(v), { stacks: 5, running: 1, partial: 2, stopped: 1, down: 1, updates: 0, problems: 3 });
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
});

test('malformed reports are refused', () => {
  assert.ok(isDockerReport({ checkedAt: 1, engine: '', compose: '', stacks: [], images: [] }));
  assert.ok(!isDockerReport({ checkedAt: 1, stacks: [{ name: 'x' }], images: [] }));
  assert.ok(!isDockerReport({ stacks: [], images: [] }));
  assert.ok(!isDockerReport(null));
});
