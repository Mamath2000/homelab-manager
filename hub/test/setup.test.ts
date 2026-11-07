import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { authorize } from '../src/profiles.js';
import { DEFAULT_SETUP, buildSpec, effectiveValues, overridesError, profileError, resetError } from '../src/setup.js';
import { setupDto } from '../src/hostDto.js';
import { config } from '../src/config.js';
import { DEFAULT_FASTFETCH } from '../src/fastfetch.js';
import { DEFAULT_STARSHIP } from '../src/starship.js';
import { SETUP_OPTIONS, type AccessManifest, type HostDoc, type SetupOption, type SetupOverrides, type SetupProfile, type SetupValues } from '../src/types.js';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGg0bWM3Y2xhdWRlLXRlc3Qta2V5 mamath@pc';
const KEY2 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGg0bWM3Y2xhdWRlLXRlc3Qta2V5Mg ops@pc';
// profile with some options changed: enabled with this value, or disabled with null. The keys and the user are the
// content of the signed access manifest (issue #312), not values of the profile.
const profile = (o: { [K in SetupOption]?: SetupValues[K] | null } = {}, rest: Partial<SetupProfile> = {}): SetupProfile => {
  const options = structuredClone(DEFAULT_SETUP.options);
  const manifest: AccessManifest = { v: 1, serial: 1, issuedAt: 0, signers: [], root: { sshKeys: [] } };
  for (const [k, v] of Object.entries(o) as [SetupOption, unknown][]) {
    (options as Record<string, unknown>)[k] = v === null ? { ...options[k], enabled: false } : { enabled: true, value: k === 'root_keys' || k === 'user' || k === 'user_keys' ? options[k].value : v };
    if (v === null) continue;
    if (k === 'root_keys') manifest.root.sshKeys = v as string[];
    if (k === 'user') manifest.user = { ...(v as { name: string; sudoNoPassword: boolean }), sshKeys: manifest.user?.sshKeys ?? [] };
    if (k === 'user_keys' && o.user) manifest.user = { ...manifest.user!, sshKeys: v as string[] };
  }
  const access = { _id: 'access' as const, bundle: { payload: 'cGF5bG9hZA==', signature: 'sig' }, manifest, signer: 'SHA256:x', uploadedAt: new Date() };
  return { ...DEFAULT_SETUP, ...rest, options, access };
};
const USER = { name: 'mamath', sudoNoPassword: true };

test('the agent only receives the managed options and their values, in order', () => {
  const spec = buildSpec(profile({ packages: null, root_prompt: null, root_keys: [KEY], user: USER, user_motd: 'fastfetch' }));
  assert.deepEqual(spec.modules, ['root_keys', 'root_aliases', 'root_motd', 'user', 'user_motd']);
  assert.ok(!('packages' in spec) && !('allowPassword' in spec));
  assert.deepEqual(spec.root.sshKeys, [KEY]);
  assert.deepEqual(spec.access, { payload: 'cGF5bG9hZA==', signature: 'sig' });
  // no access option managed: the manifest is not relayed
  assert.ok(!('access' in buildSpec(profile({ root_keys: null, user: null }), undefined, ['packages'])));
  assert.equal(spec.root.motd, 'homelab');
  assert.ok(!('prompt' in spec.root));
  assert.deepEqual(spec.user, { name: 'mamath', sudoNoPassword: true, motd: 'fastfetch' });
  assert.equal(spec.fastfetch, DEFAULT_FASTFETCH);
  // no fastfetch welcome screen nor Starship prompt: no configuration sent
  assert.ok(!('fastfetch' in buildSpec(profile())));
  assert.ok(!('starship' in buildSpec(profile())));
  assert.equal(buildSpec(profile({ user: USER, user_prompt: 'starship' })).starship, DEFAULT_STARSHIP);
});

test('bulk application: only the chosen options, the user values travel with them', () => {
  const p = profile({ root_keys: [KEY], user: USER, user_keys: [KEY2] });
  const spec = buildSpec(p, { packages: { mode: 'off' } }, ['packages', 'user_keys', 'root_prompt']);
  // packages not managed on this host: skipped
  assert.deepEqual(spec.modules, ['root_prompt', 'user_keys']);
  assert.equal(spec.user?.name, 'mamath');
});

test('bulk reset to the standard: refused when it would lock the host out', () => {
  const p = profile({ ssh_password: false, root_keys: [KEY] });
  const h = { _id: new ObjectId(), name: 'h1', createdAt: new Date(), setupOverrides: { root_keys: { mode: 'off' }, ssh_password: { mode: 'custom', value: true } } } as HostDoc;
  // back to "password forbidden" while the host keeps its keys unmanaged: no key pushed
  assert.match(resetError(p, h, ['ssh_password'])!, /^h1 : .*clés SSH/);
  assert.equal(resetError(p, h, ['ssh_password', 'root_keys']), null);
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
    root_motd: { mode: 'off' },
    root_prompt: { mode: 'custom', value: 'starship' },
  });
  assert.equal(v.ssh_password, false);
  assert.deepEqual(v.root_keys, [KEY]);
  assert.ok(!('root_motd' in v));
  assert.equal(v.root_prompt, 'starship');
  assert.deepEqual(v.packages, ['htop']);
  // an option outside the standard can be enabled on a host
  assert.deepEqual(effectiveValues(profile({ packages: null }), { packages: { mode: 'extra', add: ['jq'] } }).packages, ['jq']);
  // the user and the keys are the manifest's: a host cannot bring its own, only stop managing them
  assert.ok(!('user' in effectiveValues(profile({ user: null }), { user: { mode: 'custom', value: USER } })));
  assert.deepEqual(effectiveValues(profile({ root_keys: [KEY] }), { root_keys: { mode: 'custom', value: [KEY2] } }).root_keys, [KEY]);
  assert.ok(!('root_keys' in effectiveValues(profile({ root_keys: [KEY] }), { root_keys: { mode: 'off' } })));
});

test('a host created unmanaged (every option off) has nothing to apply', () => {
  const off: SetupOverrides = Object.fromEntries(SETUP_OPTIONS.map((k) => [k, { mode: 'off' }]));
  assert.deepEqual(effectiveValues(DEFAULT_SETUP, off), {});
  assert.equal(overridesError(DEFAULT_SETUP, off), null);
});

test('profile and overrides validation', () => {
  assert.equal(profileError(DEFAULT_SETUP), null);
  assert.equal(profileError(profile({ user: USER, user_keys: [KEY], root_motd: 'fastfetch' })), null);
  assert.match(profileError(profile({ packages: ['htop', 'rm -rf'] }))!, /paquet/);
  assert.match(profileError(profile({ root_motd: 'fastfetch' }, { fastfetch: '{ "logo": ' }))!, /fastfetch/);
  assert.match(profileError(profile({ root_prompt: 'starship' }, { starship: 'format = "x' }))!, /Starship/);
  assert.equal(profileError(profile({ root_prompt: 'starship' })), null);
  // only checked when it is used
  assert.equal(profileError(profile({}, { fastfetch: '{', starship: '[' })), null);
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
  config.featureStandardisation = true;
  try {
    assert.equal(setupDto(h)!.drift, 2);
    assert.equal(setupDto({ ...h, setup: undefined }), null);
  } finally {
    config.featureStandardisation = false;
  }
  // FEATURE_STANDARDISATION off: the stored check is not shown
  assert.equal(setupDto(h), null);
});

test('profiles: the setup profile is admin only, operators apply and check without changing the values of a host', () => {
  assert.ok(!authorize('operator', 'GET', '/api/settings/setup'));
  assert.ok(!authorize('operator', 'PUT', '/api/settings/setup'));
  assert.ok(authorize('operator', 'GET', '/api/setup'));
  assert.ok(authorize('operator', 'POST', '/api/hosts/:id/setup/check'));
  assert.ok(authorize('viewer', 'GET', '/api/setup'));
  assert.ok(!authorize('viewer', 'POST', '/api/hosts/:id/setup/check'));
  // the values of a host give root on it (SSH keys, account, aliases): admins only (F-02)
  assert.ok(!authorize('operator', 'PUT', '/api/hosts/:id/setup'));
  assert.ok(authorize('admin', 'PUT', '/api/hosts/:id/setup'));
  assert.ok(!authorize('viewer', 'PUT', '/api/hosts/:id/setup'));
  assert.ok(authorize('admin', 'PUT', '/api/settings/setup'));
  // validating a key outside the manifest: admins only
  assert.ok(authorize('admin', 'PUT', '/api/hosts/:id/access-keys/ack'));
  assert.ok(!authorize('operator', 'PUT', '/api/hosts/:id/access-keys/ack'));
  assert.ok(!authorize('viewer', 'PUT', '/api/hosts/:id/access-keys/ack'));
});

test('setupDto: only a validated key outside the manifest is acknowledged, bound to account and fingerprint', () => {
  const key = (account: string, fingerprint: string, managed: boolean) => ({ account, type: 'ssh-ed25519', fingerprint, managed });
  const h = {
    setup: { checkedAt: 1, user: 'root', modules: [], drift: 0, access: { status: 'ok', applied: 1, signers: [], keys: [key('root', 'SHA256:a', false), key('root', 'SHA256:b', false), key('mat', 'SHA256:a', false), key('root', 'SHA256:m', true)] } },
    ackedKeys: [{ account: 'root', fingerprint: 'SHA256:a' }, { account: 'root', fingerprint: 'SHA256:m' }],
  } as unknown as HostDoc;
  config.featureStandardisation = true;
  try {
    assert.deepEqual(setupDto(h)!.access!.keys.map((k) => k.acknowledged), [true, false, false, false]);
  } finally {
    config.featureStandardisation = false;
  }
});

test('access options: a host can only stop managing them', () => {
  const p = profile({ root_keys: [KEY] });
  assert.match(overridesError(p, { root_keys: { mode: 'custom', value: [KEY2] } })!, /manifeste/);
  assert.match(overridesError(p, { user_keys: { mode: 'extra', add: [KEY2] } })!, /manifeste/);
  assert.match(overridesError(p, { user: { mode: 'custom', value: USER } })!, /manifeste/);
  assert.equal(overridesError(p, { user: { mode: 'off' }, user_keys: { mode: 'off' } }), null);
});

test('profiles: the access manifest is admin only, the profile of an operator cannot publish or push it', () => {
  for (const [method, route] of [['GET', '/api/settings/access'], ['PUT', '/api/settings/access'], ['POST', '/api/settings/access/apply']] as const) {
    assert.ok(authorize('admin', method, route));
    assert.ok(!authorize('operator', method, route), `operator ${method} ${route}`);
    assert.ok(!authorize('viewer', method, route), `viewer ${method} ${route}`);
  }
});
