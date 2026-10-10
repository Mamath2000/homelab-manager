import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { authorize } from '../src/roles.js';
import { DEFAULT_SETUP, buildSpec, hostModules, hostUser, profileError } from '../src/setup.js';
import { setupDto } from '../src/hostDto.js';
import { DEFAULT_FASTFETCH } from '../src/fastfetch.js';
import type { HostDoc, SetupProfile } from '../src/types.js';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGg0bWM3Y2xhdWRlLXRlc3Qta2V5 mamath@pc';
const profile = (p: Partial<SetupProfile> = {}): SetupProfile => ({ ...DEFAULT_SETUP, ...p });

test('the agent only receives the parameters of the selected modules, in application order', () => {
  const p = profile({ user: 'mamath', sshKeys: [KEY] });
  const spec = buildSpec(p, ['motd', 'ssh_password', 'user', 'aliases'], 'mamath');
  assert.deepEqual(spec.modules, ['user', 'aliases', 'motd', 'ssh_password']);
  assert.equal(spec.user, 'mamath');
  assert.equal(spec.motd, 'homelab');
  assert.equal(spec.allowPassword, true);
  assert.equal(spec.sudoNoPassword, false);
  assert.ok(spec.aliases?.includes("alias ll='ls -lh'"));
  for (const k of ['packages', 'sshKeys', 'prompt', 'fastfetch']) assert.ok(!(k in spec), k);
});

test('the fastfetch configuration is only sent with the fastfetch welcome screen', () => {
  assert.ok(!('fastfetch' in buildSpec(profile({ motd: 'homelab' }), ['motd'], '')));
  assert.equal(buildSpec(profile({ motd: 'fastfetch' }), ['motd'], '').fastfetch, DEFAULT_FASTFETCH);
  assert.ok(!('fastfetch' in buildSpec(profile({ motd: 'fastfetch' }), ['aliases'], '')));
});

test('profile validation', () => {
  assert.equal(profileError(DEFAULT_SETUP), null);
  assert.equal(profileError(profile({ user: 'mamath', sshKeys: [KEY], motd: 'fastfetch' })), null);
  assert.match(profileError(profile({ user: 'Mamath' }))!, /utilisateur/);
  assert.match(profileError(profile({ packages: ['htop', 'rm -rf'] }))!, /paquet/);
  assert.match(profileError(profile({ sshKeys: ['not a key'] }))!, /clé SSH/);
  assert.match(profileError(profile({ sshKeys: [KEY + '\nssh-rsa AAAA'] }))!, /clé SSH/);
  assert.match(profileError(profile({ motd: 'fastfetch', fastfetch: '{ "logo": ' }))!, /fastfetch/);
  // only checked when it is used
  assert.equal(profileError(profile({ motd: 'homelab', fastfetch: '{' })), null);
  // forbidding passwords without pushing keys could lock every new host out
  assert.match(profileError(profile({ modules: ['ssh_password'], allowPassword: false }))!, /Clés SSH/);
  assert.equal(profileError(profile({ modules: ['ssh_keys', 'ssh_password'], allowPassword: false, sshKeys: [KEY] })), null);
});

test('host user overrides the profile one, "" meaning root only', () => {
  const h = { _id: new ObjectId(), name: 'h', createdAt: new Date() } as HostDoc;
  assert.equal(hostUser(h, profile({ user: 'mamath' })), 'mamath');
  assert.equal(hostUser({ ...h, setupUser: '' }, profile({ user: 'mamath' })), '');
  assert.equal(hostUser({ ...h, setupUser: 'ops' }, profile({ user: 'mamath' })), 'ops');
});

test('host modules override the standard ones, removed modules dropped', () => {
  const h = { _id: new ObjectId(), name: 'h', createdAt: new Date() } as HostDoc;
  const p = profile({ modules: ['packages', 'prompt', 'motd'] });
  assert.deepEqual(hostModules(h, p), ['packages', 'prompt', 'motd']);
  assert.deepEqual(hostModules({ ...h, setupModules: ['packages'] }, p), ['packages']);
  assert.deepEqual(hostModules({ ...h, setupModules: ['packages', 'apt_proxy'] } as unknown as HostDoc, p), ['packages']);
});

test('drift counts modules that differ or failed to check', () => {
  const h = {
    _id: new ObjectId(),
    name: 'h',
    createdAt: new Date(),
    setup: {
      checkedAt: 1,
      user: 'mamath',
      modules: [
        { module: 'packages', state: 'drift', detail: 'missing: jq' },
        { module: 'aliases', state: 'ok' },
        { module: 'ssh_password', state: 'na' },
        { module: 'motd', state: 'error' },
        // removed module, checked before the upgrade
        { module: 'apt_proxy', state: 'drift' },
      ],
    },
  } as unknown as HostDoc;
  assert.equal(setupDto(h)!.drift, 2);
  assert.equal(setupDto({ ...h, setup: undefined }), null);
});

test('roles: the profile is admin only, operators apply and check', () => {
  assert.ok(!authorize('operator', 'GET', '/api/settings/setup'));
  assert.ok(!authorize('operator', 'PUT', '/api/settings/setup'));
  assert.ok(authorize('operator', 'GET', '/api/setup'));
  assert.ok(authorize('operator', 'POST', '/api/hosts/:id/setup/check'));
  assert.ok(authorize('viewer', 'GET', '/api/setup'));
  assert.ok(!authorize('viewer', 'POST', '/api/hosts/:id/setup/check'));
  assert.ok(authorize('admin', 'PUT', '/api/settings/setup'));
});
