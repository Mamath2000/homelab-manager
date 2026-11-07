import assert from 'node:assert/strict';
import { test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { checkPassword, registerAuth } from '../src/auth.js';
import { hashPassword } from '../src/crypto.js';
import { accountKey, FailureLimiter, ipKey, loginLimits, pairKey } from '../src/loginGuard.js';
import { SUPERADMIN, type UserDoc } from '../src/types.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test('free failures, then a delay that doubles up to its ceiling', () => {
  const c = clock();
  const l = new FailureLimiter({ free: 3, baseDelayMs: 1000, maxDelayMs: 5000, windowMs: 60_000, now: c.now });
  assert.equal(l.fail('k'), 0);
  assert.equal(l.fail('k'), 0);
  assert.equal(l.check('k'), 0);
  assert.equal(l.fail('k'), 1000);
  assert.equal(l.check('k'), 1000);
  c.advance(400);
  assert.equal(l.check('k'), 600);
  assert.equal(l.fail('k'), 2000);
  assert.equal(l.fail('k'), 4000);
  assert.equal(l.fail('k'), 5000);
  assert.equal(l.fail('k'), 5000);
  assert.equal(l.check('other'), 0);
});

test('a key is forgotten once its window and its delay are over, or on reset', () => {
  const c = clock();
  const l = new FailureLimiter({ free: 2, baseDelayMs: 1000, maxDelayMs: 1000, windowMs: 10_000, now: c.now });
  l.fail('k');
  c.advance(10_001);
  assert.equal(l.fail('k'), 0, 'the first failure was forgotten');
  assert.equal(l.fail('k'), 1000);
  l.reset('k');
  assert.equal(l.check('k'), 0);
  assert.equal(l.fail('k'), 0);
});

test('the store is bounded, and junk keys do not push out a blocked one', () => {
  const c = clock();
  const l = new FailureLimiter({ free: 3, baseDelayMs: 60_000, maxDelayMs: 60_000, windowMs: 60_000, capacity: 100, now: c.now });
  for (let i = 0; i < 3; i++) l.fail('admin');
  assert.ok(l.check('admin') > 0);
  // one failure each: not blocked, so they go first
  for (let i = 0; i < 1000; i++) l.fail(`junk${i}`);
  assert.equal(l.size, 100);
  assert.ok(l.check('admin') > 0, 'the blocked key is still there');
  // all blocked: the oldest goes, the store stays bounded
  const b = new FailureLimiter({ free: 1, baseDelayMs: 60_000, maxDelayMs: 60_000, windowMs: 60_000, capacity: 10, now: c.now });
  for (let i = 0; i < 50; i++) b.fail(`k${i}`);
  assert.equal(b.size, 10);
  assert.equal(b.check('k0'), 0);
  assert.ok(b.check('k49') > 0);
});

test('client keys: IPv4 as is, IPv6 by its /64', () => {
  assert.equal(ipKey('192.168.1.10'), '192.168.1.10');
  assert.equal(ipKey('::ffff:192.168.1.10'), '192.168.1.10');
  assert.equal(ipKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(ipKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(ipKey('::1'), '0:0:0:0::/64');
  assert.equal(ipKey(undefined), '?');
  assert.equal(accountKey('  Admin '), 'admin');
});

test('the password is checked at the same cost whatever the account', async () => {
  const calls: (string | null | undefined)[] = [];
  const spy = async (_pw: string, stored: string | null | undefined) => (calls.push(stored), false);
  const hash = await hashPassword('secret');
  const expired: UserDoc = { username: 'superadmin', profile: SUPERADMIN, passwordHash: hash, passwordExpiresAt: new Date(0) } as UserDoc;
  const keyOnly = { username: 'homepage', profile: 'viewer', passwordHash: null } as unknown as UserDoc;
  const real = { username: 'bob', profile: 'admin', passwordHash: hash } as unknown as UserDoc;
  for (const user of [null, keyOnly, expired, real]) assert.equal(await checkPassword(user, 'guess', spy), false);
  assert.deepEqual(calls, [null, null, null, hash], 'scrypt runs for an unknown account, a key-only one and an expired superadmin');
  assert.equal(await checkPassword(real, 'secret'), true);
  assert.equal(await checkPassword(null, 'secret'), false);
  assert.equal(await checkPassword(expired, 'secret'), false);
});

test('a blocked login gets 429 with Retry-After, before any lookup of the account', async () => {
  const app = Fastify();
  await app.register(cookie);
  registerAuth(app);
  const account = accountKey('nobody');
  const ip = ipKey('127.0.0.1');
  for (let i = 0; i < 5; i++) loginLimits.pair.fail(pairKey(account, ip));
  try {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'Nobody', password: 'x' } });
    assert.equal(res.statusCode, 429);
    assert.ok(Number(res.headers['retry-after']) >= 1);
    assert.equal(res.json().error, 'too_many_attempts');
  } finally {
    loginLimits.pair.reset(pairKey(account, ip));
  }
});
