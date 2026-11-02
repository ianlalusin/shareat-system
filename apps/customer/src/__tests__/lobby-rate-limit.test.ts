import { describe, expect, it, vi } from 'vitest';

/**
 * T-455 S9a item 3 -- the in-process per-IP limiter for the public lobby reads: docs/tasks/455-customer-lobby.md "S9 rulings" item 3.
 * Stock Caddy has no limit_req, so the customer server counts: 60 requests per minute per IP, one process, memory only, fixed window.
 *
 * CONTRACT (apps/customer/src/server/lobby/rate-limit.ts):
 *   createFixedWindowLimiter({ limit, windowMs, maxKeys, now }) -> { hit(key: string): boolean /* true = allowed *\/; size(): number }
 *   LOBBY_READ_LIMIT (60), LOBBY_READ_WINDOW_MS (60_000)
 *   lobbyReadAllowed(req: Request): boolean   // keyed by a keyed hash of x-real-ip; no x-real-ip = not limited (Caddy always sets it; the store route must work without one)
 *   resetLobbyReadLimiterForTests(): void
 *
 * RED TODAY, for one reason: rate-limit.ts does not exist.
 *
 * MUTANT INDEX: limit off by one (59 or 61 allowed); one global counter instead of per key; the window never resets; the window resets on every hit (sliding by
 * accident); a key's count survives its window; the table grows without bound; the raw IP kept as the key; a limiter that allows everything.
 */
vi.mock('server-only', () => ({}));

import { addressBucket, createFixedWindowLimiter, LOBBY_READ_LIMIT, LOBBY_READ_WINDOW_MS, lobbyReadAllowed, resetLobbyReadLimiterForTests } from '@/server/lobby/rate-limit';

describe('createFixedWindowLimiter', () => {
  it('L1 allows exactly `limit` hits per key in a window and refuses the next [kills: off by one either way; allow-all]', () => {
    let t = 1_000;
    const l = createFixedWindowLimiter({ limit: 60, windowMs: 60_000, maxKeys: 100, now: () => t });
    for (let i = 1; i <= 60; i++) expect(l.hit('a'), `hit ${i}`).toBe(true);
    expect(l.hit('a')).toBe(false);
    expect(l.hit('a')).toBe(false);
  });

  it('L2 keys are independent: one key over its limit does not refuse another [kills: one global counter]', () => {
    const l = createFixedWindowLimiter({ limit: 2, windowMs: 60_000, maxKeys: 100, now: () => 5 });
    expect(l.hit('a')).toBe(true);
    expect(l.hit('a')).toBe(true);
    expect(l.hit('a')).toBe(false);
    expect(l.hit('b')).toBe(true);
  });

  it('L3 the window resets at its end, not before and not by activity: hits at the edge [kills: never resets; resets on every hit; resets early]', () => {
    let t = 0;
    const l = createFixedWindowLimiter({ limit: 2, windowMs: 60_000, maxKeys: 100, now: () => t });
    expect(l.hit('a')).toBe(true); // window starts at t=0
    t = 59_999;
    expect(l.hit('a')).toBe(true);
    expect(l.hit('a')).toBe(false); // still inside the first window, even though a hit just happened
    t = 60_000;
    expect(l.hit('a')).toBe(true); // new window: count is 1 again
    expect(l.hit('a')).toBe(true);
    expect(l.hit('a')).toBe(false);
  });

  it('L4 memory is bounded: after many one-off keys the table never exceeds maxKeys (expired windows are dropped first) [kills: unbounded growth]', () => {
    let t = 0;
    const l = createFixedWindowLimiter({ limit: 5, windowMs: 60_000, maxKeys: 50, now: () => t });
    for (let i = 0; i < 500; i++) l.hit(`k${i}`);
    expect(l.size()).toBeLessThanOrEqual(50);
    t = 120_000;
    for (let i = 0; i < 500; i++) l.hit(`z${i}`);
    expect(l.size()).toBeLessThanOrEqual(50);
  });

  it('L5 a flood of new keys cannot reset a live key\'s count by evicting it while its window is open and the table is not full [kills: clearing the whole table when it fills with live keys is accepted ONLY at the cap]', () => {
    const t = 0;
    const l = createFixedWindowLimiter({ limit: 2, windowMs: 60_000, maxKeys: 1000, now: () => t });
    l.hit('victim');
    l.hit('victim');
    for (let i = 0; i < 200; i++) l.hit(`other${i}`);
    expect(l.hit('victim')).toBe(false);
  });
});

describe('lobbyReadAllowed', () => {
  const req = (ip?: string) => new Request('http://order.test/api/lobby/store?s=X', { headers: ip ? { 'x-real-ip': ip } : {} });

  it('L6 the live limit is 60 per minute per IP: the 61st from one IP is refused, a different IP is not [kills: wrong constant; global counter]', () => {
    expect(LOBBY_READ_LIMIT).toBe(60);
    expect(LOBBY_READ_WINDOW_MS).toBe(60_000);
    resetLobbyReadLimiterForTests();
    for (let i = 1; i <= 60; i++) expect(lobbyReadAllowed(req('203.0.113.7')), `hit ${i}`).toBe(true);
    expect(lobbyReadAllowed(req('203.0.113.7'))).toBe(false);
    expect(lobbyReadAllowed(req('203.0.113.8'))).toBe(true);
  });

  it('L7 the limiter reads only x-real-ip: a forged x-forwarded-for does not move the key [kills: keying on a header the diner controls]', () => {
    resetLobbyReadLimiterForTests();
    const forged = (n: number) => new Request('http://order.test/api/lobby/store', { headers: { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': `10.0.0.${n}` } });
    for (let i = 1; i <= 60; i++) expect(lobbyReadAllowed(forged(i))).toBe(true);
    expect(lobbyReadAllowed(forged(61))).toBe(false);
  });

  it('L8 a request with no x-real-ip is not limited (the store route works without a proxy) [kills: one shared bucket for every no-ip request]', () => {
    resetLobbyReadLimiterForTests();
    for (let i = 0; i < 100; i++) expect(lobbyReadAllowed(req())).toBe(true);
  });

  it('L9 resetLobbyReadLimiterForTests starts a fresh count [kills: a reset that does nothing]', () => {
    resetLobbyReadLimiterForTests();
    for (let i = 0; i < 61; i++) lobbyReadAllowed(req('203.0.113.50'));
    expect(lobbyReadAllowed(req('203.0.113.50'))).toBe(false);
    resetLobbyReadLimiterForTests();
    expect(lobbyReadAllowed(req('203.0.113.50'))).toBe(true);
  });
});

describe('IPv6 is limited per /64, IPv4 per address', () => {
  const req = (ip: string) => new Request('http://order.test/api/lobby/store?s=X', { headers: { 'x-real-ip': ip } });

  it('L10 two addresses in the same /64 share one count: a household or a rotating-suffix attacker cannot get 60 per address [kills: keying on the full IPv6 address]', () => {
    resetLobbyReadLimiterForTests();
    for (let i = 1; i <= 60; i++) expect(lobbyReadAllowed(req(`2001:db8:abcd:12::${i.toString(16)}`)), `hit ${i}`).toBe(true);
    expect(lobbyReadAllowed(req('2001:db8:abcd:12:ffff:eeee:dddd:cccc'))).toBe(false);
    expect(lobbyReadAllowed(req('2001:0db8:abcd:0012:0:0:0:99'))).toBe(false); // the same /64 written long, with leading zeros
    expect(lobbyReadAllowed(req('2001:DB8:ABCD:12::1'))).toBe(false); // and in capitals
  });

  it('L11 a different /64 is a different bucket; IPv4 stays per address [kills: a /48 or /32 bucket; IPv4 grouped]', () => {
    resetLobbyReadLimiterForTests();
    for (let i = 1; i <= 60; i++) lobbyReadAllowed(req('2001:db8:abcd:12::1'));
    expect(lobbyReadAllowed(req('2001:db8:abcd:13::1'))).toBe(true); // next /64
    expect(lobbyReadAllowed(req('2001:db8:abce:12::1'))).toBe(true); // differs in the third group
    for (let i = 1; i <= 60; i++) expect(lobbyReadAllowed(req('203.0.113.7')), `v4 hit ${i}`).toBe(true);
    expect(lobbyReadAllowed(req('203.0.113.7'))).toBe(false);
    expect(lobbyReadAllowed(req('203.0.113.8'))).toBe(true);
  });

  it('L12 an IPv4-mapped IPv6 address counts as that IPv4 address, not as one shared /64 [kills: ::ffff:a.b.c.d collapsing every IPv4 client into one bucket]', () => {
    resetLobbyReadLimiterForTests();
    for (let i = 1; i <= 60; i++) expect(lobbyReadAllowed(req('::ffff:203.0.113.20'))).toBe(true);
    expect(lobbyReadAllowed(req('203.0.113.20'))).toBe(false); // the same client
    expect(lobbyReadAllowed(req('::ffff:203.0.113.21'))).toBe(true); // another client
  });

  it('L13 addressBucket: the /64 prefix, and an unparseable value falls back to itself [kills: a throw on junk; a wrong prefix length]', () => {
    expect(addressBucket('2001:db8:abcd:12:1:2:3:4')).toBe('v6:2001:db8:abcd:12');
    expect(addressBucket('2001:db8::1')).toBe('v6:2001:db8:0:0');
    expect(addressBucket('::1')).toBe('v6:0:0:0:0');
    expect(addressBucket('fe80::1%eth0')).toBe('v6:fe80:0:0:0');
    expect(addressBucket('203.0.113.7')).toBe('v4:203.0.113.7');
    expect(addressBucket('not an address:')).toBe('raw:not an address:');
  });
});
