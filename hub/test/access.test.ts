import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { accessSummary, checkBundle, fingerprint, parseKeyLine } from '../src/access.js';
import { evaluateBundle, readBundleFile } from '../src/accessFile.js';
import { DEFAULT_SETUP } from '../src/setup.js';
import type { AccessBundle, AccessManifest, AccessSettings } from '../src/types.js';

const hasTool = (bin: string) => spawnSync('which', [bin]).status === 0;
const skip = !hasTool('ssh-keygen') || !hasTool('jq');

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGg0bWM3Y2xhdWRlLXRlc3Qta2V5LTAwMDAwMDAwMDA mamath@pc';

function newKey(dir: string, name: string) {
  const priv = join(dir, name);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', priv]);
  return { priv, pub: readFileSync(priv + '.pub', 'utf8').trim() };
}

function sign(priv: string, ns: string, payload: Buffer): AccessBundle {
  const dir = mkdtempSync(join(tmpdir(), 'access-'));
  const f = join(dir, 'payload');
  writeFileSync(f, payload);
  execFileSync('ssh-keygen', ['-Y', 'sign', '-f', priv, '-n', ns, f], { stdio: 'pipe' });
  return { payload: payload.toString('base64'), signature: readFileSync(f + '.sig', 'utf8') };
}

const manifest = (signers: string[], over: Partial<AccessManifest> = {}): AccessManifest => ({
  v: 1,
  serial: 1,
  issuedAt: 1,
  signers,
  root: { sshKeys: [KEY] },
  user: { name: 'ops', sudoNoPassword: true, sshKeys: [KEY] },
  ...over,
});

test('access bundle: the signature is checked with the signers the manifest lists', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-'));
  const admin = newKey(dir, 'admin');
  const other = newKey(dir, 'other');
  const b = sign(admin.priv, 'homelab-manager-access', Buffer.from(JSON.stringify(manifest([admin.pub]))));
  const { manifest: m, signer } = checkBundle(b);
  assert.equal(m.user?.name, 'ops');
  assert.equal(signer, fingerprint(parseKeyLine(admin.pub).blob));

  // another namespace (a signature made for something else)
  assert.throws(() => checkBundle(sign(admin.priv, 'file', Buffer.from(JSON.stringify(manifest([admin.pub]))))), /espace de noms/);
  // signed by a key the manifest does not list
  assert.throws(() => checkBundle(sign(other.priv, 'homelab-manager-access', Buffer.from(JSON.stringify(manifest([admin.pub]))))), /signataires/);
  // payload changed after the signature
  const forged = { ...b, payload: Buffer.from(JSON.stringify(manifest([admin.pub], { serial: 2 }))).toString('base64') };
  assert.throws(() => checkBundle(forged), /signature invalide/);
  assert.throws(() => checkBundle({ payload: b.payload, signature: 'garbage' }), /signature/);
});

test('access manifest: content rules', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-'));
  const admin = newKey(dir, 'admin');
  const check = (m: unknown) => checkBundle(sign(admin.priv, 'homelab-manager-access', Buffer.from(JSON.stringify(m))));
  assert.ok(check(manifest([admin.pub])));
  assert.throws(() => check(manifest([admin.pub], { user: { name: 'root', sudoNoPassword: false, sshKeys: [] } })), /utilisateur/);
  assert.throws(() => check(manifest([admin.pub], { root: { sshKeys: ['command="x" ' + KEY] } })), /clés SSH/);
  assert.throws(() => check({ ...manifest([admin.pub]), extra: 1 }), /champ inconnu/);
  assert.throws(() => check(manifest([admin.pub], { serial: 0 })), /série/);
  assert.throws(() => check(manifest([]) ), /signataires/);
});

test('access summary: fingerprints for the interface, no private data', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-'));
  const admin = newKey(dir, 'admin');
  const b = sign(admin.priv, 'homelab-manager-access', Buffer.from(JSON.stringify(manifest([admin.pub]))));
  const { manifest: m, signer } = checkBundle(b);
  const s = accessSummary({ _id: 'access', bundle: b, manifest: m, signer, uploadedAt: new Date(0), uploadedBy: 'mamath' })!;
  assert.equal(s.root[0].comment, 'mamath@pc');
  assert.match(s.root[0].fingerprint, /^SHA256:/);
  assert.equal(s.user?.name, 'ops');
  assert.equal(accessSummary(null), null);
});

// the script of tools/ makes what the hub accepts
test('tools/access-manifest.sh output is accepted', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-'));
  const admin = newKey(dir, 'admin');
  const cfg = join(dir, 'access.json');
  const out = join(dir, 'manifest.sig.json');
  writeFileSync(cfg, JSON.stringify({ signers: [admin.pub], root: { sshKeys: [KEY] }, user: { name: 'ops', sudoNoPassword: true, sshKeys: [KEY] } }));
  const script = resolve(import.meta.dirname, '../../tools/access-manifest.sh');
  execFileSync('bash', [script, '-c', cfg, '-k', admin.priv, '-o', out], { stdio: 'pipe' });
  const first = checkBundle(JSON.parse(readFileSync(out, 'utf8')));
  assert.equal(first.manifest.serial, 1);
  execFileSync('bash', [script, '-c', cfg, '-k', admin.priv, '-o', out], { stdio: 'pipe' });
  assert.equal(checkBundle(JSON.parse(readFileSync(out, 'utf8'))).manifest.serial, 2);
});

test('access folder: file read and evaluation of what it holds', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-'));
  assert.deepEqual(readBundleFile(dir), { missing: true });
  writeFileSync(join(dir, 'manifest.sig.json'), 'not json');
  assert.ok('error' in readBundleFile(dir));
  writeFileSync(join(dir, 'manifest.sig.json'), JSON.stringify({ payload: 'x' }));
  assert.ok('error' in readBundleFile(dir));

  const admin = newKey(dir, 'admin');
  const bundle = (serial: number) => sign(admin.priv, 'homelab-manager-access', Buffer.from(JSON.stringify(manifest([admin.pub], { serial }))));
  const b1 = bundle(1);
  writeFileSync(join(dir, 'manifest.sig.json'), JSON.stringify(b1));
  const read = readBundleFile(dir);
  assert.ok('bundle' in read);

  // first load
  const first = evaluateBundle(b1, null, DEFAULT_SETUP);
  assert.ok('next' in first && first.next.manifest.serial === 1);
  const stored = (first as { next: AccessSettings }).next;
  // same file again: nothing to do
  assert.deepEqual(evaluateBundle(b1, stored, DEFAULT_SETUP), { unchanged: true });
  // a newer serial replaces it, an older or equal one is refused
  assert.ok('next' in evaluateBundle(bundle(2), stored, DEFAULT_SETUP));
  // same serial, other content (the signature is deterministic: the same content is the same bundle)
  const other = sign(admin.priv, 'homelab-manager-access', Buffer.from(JSON.stringify(manifest([admin.pub], { serial: 1, root: { sshKeys: [] } }))));
  const sameSerial = evaluateBundle(other, stored, DEFAULT_SETUP);
  assert.ok('error' in sameSerial && /série/.test(sameSerial.error));
  // a bad signature is refused
  const forged = { ...b1, payload: Buffer.from(JSON.stringify(manifest([admin.pub], { serial: 9 }))).toString('base64') };
  const bad = evaluateBundle(forged, stored, DEFAULT_SETUP);
  assert.ok('error' in bad && /signature/.test(bad.error));
});
