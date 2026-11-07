import { isIP } from 'node:net';
import type { FastifyReply } from 'fastify';

// Brute-force protection (homelab#292): counts failures, not requests, in a bounded in-memory store.
// Each counter lets `free` failures through, then refuses (429) for a delay that doubles at each further failure,
// up to `maxDelayMs`. A key is forgotten `windowMs` after its last failure, once its delay has run out.
// In memory on purpose: one hub, and a restart (the way out of a lock) clears everything.

export interface LimiterOptions {
  // failures allowed before the first delay
  free: number;
  // first delay, doubled at each further failure
  baseDelayMs: number;
  maxDelayMs: number;
  // a key is forgotten this long after its last failure (and once its delay is over)
  windowMs: number;
  // most keys kept: the oldest one not blocked is dropped beyond it
  capacity?: number;
  now?: () => number;
}

interface Entry {
  count: number;
  last: number;
  until: number;
}

// beyond this many entries scanned, the oldest one goes even if it is blocked
const EVICT_SCAN = 1000;

export class FailureLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly capacity: number;

  constructor(private readonly opts: LimiterOptions) {
    this.now = opts.now ?? Date.now;
    this.capacity = opts.capacity ?? 10_000;
  }

  get size() {
    return this.entries.size;
  }

  private live(key: string, now: number) {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (now > Math.max(e.until, e.last + this.opts.windowMs)) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }

  // milliseconds to wait before the next attempt, 0 when it may go ahead
  check(key: string) {
    const now = this.now();
    const e = this.live(key, now);
    return e && e.until > now ? e.until - now : 0;
  }

  // records a failure, returns the delay it starts (0 while within the free failures)
  fail(key: string) {
    const now = this.now();
    const e = this.live(key, now);
    const count = (e?.count ?? 0) + 1;
    const delay =
      count < this.opts.free ? 0 : Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** Math.min(count - this.opts.free, 30));
    // re-inserted: the Map keeps the most recent failures last
    this.entries.delete(key);
    this.entries.set(key, { count, last: now, until: delay ? now + delay : 0 });
    if (this.entries.size > this.capacity) this.evict(now);
    return delay;
  }

  reset(key: string) {
    this.entries.delete(key);
  }

  // Drops the oldest key that is not blocked: flooding the store with junk keys must not free a blocked one.
  private evict(now: number) {
    let scanned = 0;
    let oldest: string | undefined;
    for (const [key, e] of this.entries) {
      oldest ??= key;
      if (e.until <= now) {
        this.entries.delete(key);
        return;
      }
      if (++scanned >= EVICT_SCAN) break;
    }
    if (oldest !== undefined) this.entries.delete(oldest);
  }
}

// Client key: an IPv4 address as is, an IPv6 one by its /64 (a single machine usually holds a whole /64).
export function ipKey(ip: string | undefined) {
  if (!ip) return '?';
  const bare = ip.split('%')[0];
  const v4 = bare.toLowerCase().startsWith('::ffff:') ? bare.slice(7) : bare;
  if (isIP(v4) === 4) return v4;
  if (isIP(bare) !== 6) return bare;
  const [head, tail = ''] = bare.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = bare.includes('::') && tail ? tail.split(':') : [];
  // an embedded IPv4 (a.b.c.d) is in the low 64 bits, dropped anyway
  const groups = bare.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// Account key: the name as typed, whether the account exists or not (a counter kept for real accounts only
// would tell them apart).
export function accountKey(username: string) {
  return username.trim().toLowerCase();
}

const MIN = 60_000;

// UI login: an account from one client (the ordinary attack), one client over every account, one account from
// every client (rotation of addresses): the last one only slows down, so that nobody can lock the admin out.
export const loginLimits = {
  pair: new FailureLimiter({ free: 5, baseDelayMs: 2_000, maxDelayMs: 15 * MIN, windowMs: 15 * MIN }),
  ip: new FailureLimiter({ free: 20, baseDelayMs: 15 * MIN, maxDelayMs: 15 * MIN, windowMs: 15 * MIN }),
  account: new FailureLimiter({ free: 50, baseDelayMs: 2_000, maxDelayMs: 5 * MIN, windowMs: 60 * MIN }),
};

// unknown API keys, apart from the logins: a script holding a revoked key must not lock the UI out
export const apiKeyLimit = new FailureLimiter({ free: 10, baseDelayMs: MIN, maxDelayMs: 15 * MIN, windowMs: 15 * MIN });

// agent enrollment codes
export const enrollLimit = new FailureLimiter({ free: 10, baseDelayMs: 10 * MIN, maxDelayMs: 10 * MIN, windowMs: 10 * MIN });

export function pairKey(account: string, ip: string) {
  return `${account}\n${ip}`;
}

export function tooManyAttempts(reply: FastifyReply, waitMs: number, error = 'too_many_attempts') {
  const retryAfter = Math.max(1, Math.ceil(waitMs / 1000));
  return reply.code(429).header('Retry-After', String(retryAfter)).send({ error, retryAfter });
}
