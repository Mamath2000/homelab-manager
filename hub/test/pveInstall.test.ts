import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkVerdict, staticEligibility, type GuestCheck } from '../src/pveInstall.js';

const carrier = { capabilities: ['pve', 'pve_guest_check', 'agent_install:lxc'], online: true };
const ct = { type: 'lxc' as const, status: 'running', ambiguous: false, hostId: null, ostype: 'debian' };

test('static: a running CT without host on a node with an up to date agent is eligible', () => {
  assert.deepEqual(staticEligibility(ct, carrier), { eligible: true, reasons: [] });
});

test('static: reasons', () => {
  const why = (g: Partial<typeof ct> | { type: 'qemu' }, c: typeof carrier | null) => staticEligibility({ ...ct, ...g } as typeof ct, c).reasons.join('|');
  assert.match(why({ type: 'qemu' }, carrier), /pas les VM/);
  assert.match(why({ status: 'stopped' }, carrier), /pas démarré/);
  assert.match(why({ hostId: 'abc' as never }, carrier), /déjà relié/);
  assert.match(why({ ambiguous: true }, carrier), /ambiguë/);
  assert.match(why({ ostype: 'unmanaged' }, carrier), /unmanaged/);
  assert.match(why({}, null), /aucun agent/);
  assert.match(why({}, { ...carrier, online: false }), /hors ligne/);
  assert.match(why({}, { ...carrier, capabilities: ['pve'] }), /trop ancien/);
});

const ok: GuestCheck = { vmid: 101, status: 'running', osId: 'debian', versionId: '12', arch: 'x86_64', systemd: true, curl: true, apt: true, agentInstalled: false, hubReachable: true };

test('check: a Debian CT with curl', () => {
  assert.deepEqual(checkVerdict(ok), { eligible: true, reasons: [], installCurl: false, relink: false });
});

test('check: blocking reasons', () => {
  const why = (c: Partial<GuestCheck>) => checkVerdict({ ...ok, ...c });
  assert.match(why({ systemd: false }).reasons.join(), /systemd/);
  assert.match(why({ arch: 'armv7l' }).reasons.join(), /armv7l/);
  assert.match(why({ curl: false, apt: false }).reasons.join(), /curl absent/);
  assert.match(why({ hubReachable: false }).reasons.join(), /injoignable/);
  assert.equal(why({ status: 'stopped' }).eligible, false);
  assert.equal(why({ error: 'pct: boom' }).reasons[0], 'pct: boom');
  assert.equal(why({ systemd: false }).eligible, false);
});

test('check: curl installed by apt, other OS, agent already there', () => {
  const v = checkVerdict({ ...ok, curl: false, hubReachable: undefined });
  assert.equal(v.eligible, true);
  assert.equal(v.installCurl, true);
  assert.match(v.reasons.join(), /curl sera installé/);
  assert.match(checkVerdict({ ...ok, osId: 'fedora' }).reasons.join(), /hors Debian/);
  assert.equal(checkVerdict({ ...ok, osId: 'ubuntu' }).reasons.length, 0);
  assert.equal(checkVerdict({ ...ok, osId: 'linuxmint', idLike: 'ubuntu debian' }).reasons.length, 0);
  const r = checkVerdict({ ...ok, agentInstalled: true });
  assert.equal(r.relink, true);
  assert.equal(r.eligible, true);
});
