import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { authorize } from '../src/roles.js';
import { DEFAULT_SETUP, buildSpec, effectiveValues, overridesError, profileError } from '../src/setup.js';
import { setupDto } from '../src/hostDto.js';
import { DEFAULT_FASTFETCH } from '../src/fastfetch.js';
import type { HostDoc, SetupOption, SetupOverrides, SetupProfile, SetupValues } from '../src/types.js';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGg0bWM3Y2xhdWRlLXRlc3Qta2V5 mamath@pc';
const KEY2 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGg0bWM3Y2xhdWRlLXRlc3Qta2V5Mg ops@pc';
// profile with some options changed: enabled with this value, or disabled with null
const profile = (o: { [K in SetupOption]?: SetupValues[K] | null } = {}, rest: Partial<SetupProfile> = {}): SetupProfile => {
  const options = structuredClone(DEFAULT_SETUP.options);
  for (const [k, v] of Object.entries(o) as [SetupOption, unknown][]) {
    (options as Record<string, unknown>)[k] = v === null ? { ...options[k], enabled: false } : { enabled: true, value: v };
  }
  return { ...DEFAULT_SETUP, ...rest, options };
};
const USER = { name: 'mamath', sudoNoPassword: true };

test('the agent only receives the managed options and their values, in order', () => {
  const spec = buildSpec(profile({ packages: null, root_prompt: null, root_keys: [KEY], user: USER, user_motd: 'fastfetch' }));
  assert.deepEqual(spec.modules, ['root_keys', 'root_aliases', 'root_motd', 'user', 'user_motd']);
  assert.ok(!('packages' in spec) && !('allowPassword' in spec));
  assert.deepEqual(spec.root.sshKeys, [KEY]);
  assert.equal(spec.root.motd, 'homelab');
  assert.ok(!('prompt' in spec.root));
  assert.deepEqual(spec.user, { name: 'mamath', sudoNoPassword: true, motd: 'fastfetch' });
  assert.equal(spec.fastfetch, DEFAULT_FASTFETCH);
  // no fastfetch welcome screen: no configuration sent
  assert.ok(!('fastfetch' in buildSpec(profile())));
});

test('the user options need the user', () => {
  const spec = buildSpec(profile({ user: null, user_keys: [KEY], user_prompt: 'starship' }));
  assert.ok(!spec.modules.some((m) => m.startsWith('user')));
  assert.ok(!('user' in spec));
});

test('host overrides: off, own value, standard list plus additions', () => {
  const p = profile({ ssh_password: true, root_keys: [KEY], packages: ['htop'] });
  const v = effectiveValues(p, {
    ssh_password: { mode: 'custom', value: false },
    root_keys: { mode: 'extra', add: [KEY2, KEY] },
    root_motd: { mode: 'off' },
    root_prompt: { mode: 'custom', value: 'starship' },
  });
  assert.equal(v.ssh_password, false);
  assert.deepEqual(v.root_keys, [KEY, KEY2]);
  assert.ok(!('root_motd' in v));
  assert.equal(v.root_prompt, 'starship');
  assert.deepEqual(v.packages, ['htop']);
  // an option outside the standard can be enabled on a host
  assert.deepEqual(effectiveValues(profile({ packages: null }), { packages: { mode: 'extra', add: ['jq'] } }).packages, ['jq']);
  assert.deepEqual(effectiveValues(profile({ user: null }), { user: { mode: 'custom', value: USER } }).user, USER);
});

test('profile and overrides validation', () => {
  assert.equal(profileError(DEFAULT_SETUP), null);
  assert.equal(profileError(profile({ user: USER, user_keys: [KEY], root_motd: 'fastfetch' })), null);
  assert.match(profileError(profile({ user: { name: 'Mamath', sudoNoPassword: false } }))!, /utilisateur/);
  assert.match(profileError(profile({ user: { name: 'root', sudoNoPassword: false } }))!, /utilisateur/);
  assert.match(profileError(profile({ packages: ['htop', 'rm -rf'] }))!, /paquet/);
  assert.match(profileError(profile({ root_keys: ['not a key'] }))!, /clé SSH/);
  assert.match(profileError(profile({ user_keys: [KEY + '\nssh-rsa AAAA'] }))!, /clé SSH/);
  assert.match(profileError(profile({ root_motd: 'fastfetch' }, { fastfetch: '{ "logo": ' }))!, /fastfetch/);
  // only checked when it is used
  assert.equal(profileError(profile({}, { fastfetch: '{' })), null);
  // forbidding passwords without pushing keys could lock the hosts out
  assert.match(profileError(profile({ ssh_password: false }))!, /clés SSH/);
  assert.equal(profileError(profile({ ssh_password: false, root_keys: [KEY] })), null);
  // user keys only count with the user
  assert.match(profileError(profile({ ssh_password: false, user_keys: [KEY] }))!, /clés SSH/);
  assert.equal(profileError(profile({ ssh_password: false, user: USER, user_keys: [KEY] })), null);
  // host: same checks on its values
  const p = profile({ root_keys: [KEY] });
  assert.equal(overridesError(p, { ssh_password: { mode: 'custom', value: false } }), null);
  assert.match(overridesError(p, { ssh_password: { mode: 'custom', value: false }, root_keys: { mode: 'off' } })!, /clés SSH/);
  assert.match(overridesError(p, { packages: { mode: 'extra', add: ['a b'] } })!, /paquet/);
  assert.match(overridesError(p, { root_prompt: { mode: 'extra', add: [] } } as SetupOverrides)!, /ajouts/);
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
        { module: 'root_aliases', state: 'ok' },
        { module: 'ssh_password', state: 'na' },
        { module: 'root_motd', state: 'error' },
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
  assert.ok(authorize('operator', 'PUT', '/api/hosts/:id/setup'));
  assert.ok(!authorize('viewer', 'PUT', '/api/hosts/:id/setup'));
  assert.ok(authorize('admin', 'PUT', '/api/settings/setup'));
});
