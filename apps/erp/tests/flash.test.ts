import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { signFlash, signSetupIdentity } from '@shareat/auth';
import { FLASH_COOKIE, captureRedirect, currentJar, outcomeOf, resetJar } from './helpers/flash-jar';

/**
 * T-380 S1a - the flash helper `apps/erp/src/lib/flash.ts` (DEF-476): F1-F5, R3, R5, R6, R8,
 * REV-3/4/6/11 and the sign-out wipe. Spec: docs/tasks/380-no-typed-values-in-urls.md.
 *
 * Red on HEAD because `@/lib/flash` does not exist (the spec's own reason: S1a creates it). Every
 * test loads it through `loadFlash()`, so each fails by name rather than the file failing to load.
 *
 * Each test names its killing mutant in a `Mutant:` line.
 */

vi.mock('next/headers', async () => (await import('./helpers/flash-jar-core')).nextHeadersMock());
vi.mock('next/navigation', async () => (await import('./helpers/flash-jar-core')).nextNavigationMock());

const logSpy = vi.hoisted(() => {
  const fn = () => vi.fn();
  const l = { warn: fn(), info: fn(), error: fn(), debug: fn(), trace: fn(), fatal: fn(), child: undefined as unknown };
  l.child = () => l;
  return l;
});
vi.mock('@shareat/core/logger', () => ({ logger: logSpy, childLogger: () => logSpy }));
vi.mock('@shareat/core', async (orig) => ({ ...(await orig<Record<string, unknown>>()), logger: logSpy }));

const BASE = {
  DATABASE_URL: 'postgresql://postgres:pw@localhost:5435/shareat_dev',
  SESSION_SECRET: 'x'.repeat(48),
  APP_TIMEZONE: 'Asia/Manila',
};

type Flash = typeof import('../src/lib/flash');
let flash: Flash;

beforeAll(async () => {
  process.env = { ...process.env, ...BASE } as unknown as NodeJS.ProcessEnv;
  // A computed specifier: a literal one that does not resolve fails the whole file at collection
  // (vite import analysis) instead of failing each test by name while flash.ts does not exist yet.
  const specifier = '@/lib/flash';
  flash = (await import(/* @vite-ignore */ specifier).catch((err: unknown) => {
    throw new Error(`apps/erp/src/lib/flash.ts cannot be loaded (T-380 S1a builder file): ${String(err)}`);
  })) as Flash;
}, 60_000);

beforeEach(() => {
  resetJar();
  for (const fn of [logSpy.warn, logSpy.info, logSpy.error, logSpy.debug]) fn.mockClear();
});

const UUID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const REASON = 'Refund for broken freezer';
const AMOUNT = '1,000.50';

/** Run redirectWithFlash and return the parsed redirect plus the token the URL carries. */
async function post(path: string, nav: Record<string, string>, flashArg?: Record<string, unknown>) {
  const signal = await captureRedirect(() => flash.redirectWithFlash(path, nav as never, flashArg as never));
  const u = new URL(signal.url, 'http://x.test');
  return { signal, url: signal.url, u, f: u.searchParams.get('f') };
}

/** Read the cookie the helper wrote. */
function cookie(): string {
  const c = currentJar().get(FLASH_COOKIE);
  if (!c) throw new Error('no shareat_flash cookie in the jar');
  return c.value;
}

/** Make the page-side read: what `withFlash` hands a page for `?f=<f>&...`. */
async function read(urlParams: Record<string, string>): Promise<Record<string, string | undefined>> {
  return (await flash.withFlash(Promise.resolve(urlParams))) as Record<string, string | undefined>;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unb64 = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, unknown>;

describe('F1 - nothing typed goes in the URL; the cookie holds it', () => {
  it('URL is /prepaid/X?f=<n>, with neither the reason nor the amount in it; the jar decodes back to exactly those values', async () => {
    const { url, u, f } = await post('/prepaid/X', {}, { error: 'e', keep: { reason: REASON, refundAmount: AMOUNT } });
    expect(u.pathname).toBe('/prepaid/X');
    expect([...u.searchParams.keys()]).toEqual(['f']);
    expect(f).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    for (const needle of [REASON, encodeURIComponent(REASON), AMOUNT, encodeURIComponent(AMOUNT), 'refundAmount', 'reason=', 'error=']) {
      expect(url).not.toContain(needle);
    }

    const decoded = flash.decodeFlash(cookie()) as { n: string; msg: Record<string, string>; keep: Record<string, string> } | null;
    expect(decoded).not.toBeNull();
    expect(decoded!.n).toBe(f);
    expect(decoded!.msg.error).toBe('e');
    expect(decoded!.keep).toEqual({ reason: REASON, refundAmount: AMOUNT });
    // Mutant: put `keep` (or any banner) into the query -> the URL assertions above go red.
  });

  it('R3 cookie flags: httpOnly, sameSite lax, path /, maxAge 60 (secure only in production)', async () => {
    await post('/prepaid/X', {}, { error: 'e' });
    const set = currentJar().sets.find((s) => s.name === FLASH_COOKIE)!;
    expect(set).toBeDefined();
    expect(set.options.httpOnly).toBe(true);
    expect(String(set.options.sameSite).toLowerCase()).toBe('lax');
    expect(set.options.path).toBe('/');
    expect(set.options.maxAge).toBe(60);
    expect(set.options.secure).not.toBe(true); // NODE_ENV is 'test' here
    // Mutant: drop httpOnly (a script could read the typed reason) -> red.
  });

  it('nav keys stay in the URL beside f; with no flash at all the cookie is not set and f is omitted', async () => {
    const withFlashed = await post('/pos-usage', { day: UUID }, { ok: 'done' });
    expect(withFlashed.u.searchParams.get('day')).toBe(UUID);
    expect(withFlashed.f).not.toBeNull();

    resetJar();
    const bare = await post('/pos-usage', { day: UUID });
    expect(bare.u.searchParams.get('day')).toBe(UUID);
    expect(bare.f).toBeNull();
    expect(currentJar().sets).toHaveLength(0);
    // Mutant: always set the cookie / always emit f -> red.
  });

  it('R3: one cookie, overwritten by every call (a second call replaces the first banner)', async () => {
    await post('/a', {}, { error: 'first' });
    const second = await post('/b', {}, { error: 'second' });
    expect(currentJar().store.size).toBe(1);
    const decoded = flash.decodeFlash(cookie()) as { n: string; msg: Record<string, string> };
    expect(decoded.msg.error).toBe('second');
    expect(decoded.n).toBe(second.f);
  });

  it('each call gets a fresh token', async () => {
    const a = await post('/a', {}, { ok: 'x' });
    const b = await post('/a', {}, { ok: 'x' });
    expect(a.f).not.toBe(b.f);
  });
});

describe('F2 - withFlash returns the flash only for the right cookie, token, time and key', () => {
  it('right f and time: banner and refill come back byte for byte, nav params kept, and the read never writes', async () => {
    const odd = '  007.10 ₱ "quoted" é&=?#  ';
    const { f } = await post('/prepaid/X', { store: UUID }, { error: 'e', keep: { reason: REASON, refundAmount: AMOUNT, mode: odd } });
    const writesBefore = currentJar().sets.length;
    const sp = await read({ f: f!, store: UUID });
    expect(sp.error).toBe('e');
    expect(sp.refundAmount).toBe(AMOUNT);
    expect(sp.reason).toBe(REASON);
    expect(sp.mode).toBe(odd);
    expect(sp.store).toBe(UUID);
    expect(currentJar().sets).toHaveLength(writesBefore);
    expect(currentJar().deletes).toHaveLength(0);
    // Mutant: encode keep through Number()/trim()/toFixed -> the refundAmount / mode assertions go red.
  });

  it('wrong f -> no flash (REV-3: the 96-bit token is the only page binding)', async () => {
    await post('/prepaid/X', {}, { error: 'e', keep: { reason: REASON } });
    const sp = await read({ f: 'AAAAAAAAAAAAAAAA' });
    expect(sp.error).toBeUndefined();
    expect(sp.reason).toBeUndefined();
    const none = await read({});
    expect(none.error).toBeUndefined();
    // Mutant: skip the token check -> red.
  });

  it('exp passed -> no flash, even though the signature is valid (the browser can ignore maxAge)', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
      const { f } = await post('/prepaid/X', {}, { error: 'e' });
      vi.setSystemTime(new Date('2026-10-07T10:00:30Z'));
      expect((await read({ f: f! })).error).toBe('e'); // still inside the 60 s
      vi.setSystemTime(new Date('2026-10-07T10:01:01Z'));
      expect((await read({ f: f! })).error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    // Mutant: skip the exp check -> the last assertion goes red.
  });

  it('tampered payload (banner rewritten, old signature kept) -> no flash', async () => {
    const { f } = await post('/prepaid/X', {}, { error: 'e' });
    const [payload, sig] = cookie().split('.');
    const forged = { ...unb64(payload!), msg: { error: 'Call 0917 to verify your account' } };
    currentJar().set(FLASH_COOKIE, `${b64(forged)}.${sig}`, {});
    expect((await read({ f: f! })).error).toBeUndefined();
    // Mutant: skip the signature check -> this and the next two legs go red.
  });

  it('tampered signature, unsigned, and empty-signature cookies -> no flash', async () => {
    const { f } = await post('/prepaid/X', {}, { error: 'e' });
    const [payload, sig] = cookie().split('.');
    const badSig = (sig![0] === 'A' ? 'B' : 'A') + sig!.slice(1);
    for (const value of [`${payload}.${badSig}`, payload!, `${payload}.`, '', 'garbage']) {
      currentJar().set(FLASH_COOKIE, value, {});
      expect((await read({ f: f! })).error, `value ${value.slice(0, 20)}`).toBeUndefined();
    }
  });

  it('REV-11: a cookie signed with the setup-identity key over the same payload -> no flash', async () => {
    const { f } = await post('/prepaid/X', {}, { error: 'e' });
    const [payload] = cookie().split('.');
    currentJar().set(FLASH_COOKIE, `${payload}.${signSetupIdentity(payload!)}`, {});
    expect((await read({ f: f! })).error).toBeUndefined();
    // Mutant: sign flash with derivedKey('setup-identity') -> red.
  });

  it('R5/R9: the flash wins over the same key in the URL; a URL banner is NOT honoured when there is no flash (S6)', async () => {
    const { f } = await post('/p', {}, { error: 'from flash' });
    expect((await read({ f: f!, error: 'from url' })).error).toBe('from flash');
    resetJar();
    expect((await read({ error: 'from url' })).error).toBeUndefined();
    // Mutant: URL wins -> the first assertion goes red. No strip -> the last one goes red.
  });
});

describe('F3 - nav shapes (R1, REV-4): a bad value is dropped, and the log names the key, never the value', () => {
  it('a sentence in `store` is not in the URL; the warning names `store` and not the sentence', async () => {
    const sentence = 'Refund for broken freezer';
    const { url, u } = await post('/p', { store: sentence }, { ok: 'x' });
    expect(u.searchParams.has('store')).toBe(false);
    expect(url).not.toContain('freezer');
    expect(logSpy.warn).toHaveBeenCalled();
    const logged = JSON.stringify(logSpy.warn.mock.calls);
    expect(logged).toContain('store');
    expect(logged).not.toContain('freezer');
    // Mutant: drop the shape check -> the URL assertions go red. Log the value -> the log assertion goes red.
  });

  it('T-390 S5: the `room` nav key keeps a uuid and drops anything else', async () => {
    const { u } = await post('/cutover/count', { store: UUID, room: UUID });
    expect(u.searchParams.get('room')).toBe(UUID);
    const bad = await post('/cutover/count', { store: UUID, room: 'x ' + UUID });
    expect(bad.u.searchParams.has('room')).toBe(false);
  });

  it('a uuid and a period are both kept', async () => {
    const { u } = await post('/p', { store: UUID, period: '2026-09' });
    expect(u.searchParams.get('store')).toBe(UUID);
    expect(u.searchParams.get('period')).toBe('2026-09');
  });

  it('REV-4: "x " + uuid is dropped (the unanchored UUID_SHAPE would have passed it); an uppercase uuid is kept', async () => {
    const { url, u } = await post('/p', { store: 'x ' + UUID, pull: UUID.toUpperCase() });
    expect(u.searchParams.has('store')).toBe(false);
    expect(url).not.toContain('x%20');
    expect(u.searchParams.get('pull')).toBe(UUID.toUpperCase());
    // Mutant: validate with UUID_SHAPE (error-shape.ts:57) instead of an anchored regex -> red.
  });

  it('REV-4: a uuid with trailing text, a newline, or a query smuggled in is dropped', async () => {
    for (const bad of [UUID + ' Call 0917', UUID + '\n', UUID + '&error=x', UUID + 'a']) {
      const { u } = await post('/p', { store: bad });
      expect(u.searchParams.has('store'), JSON.stringify(bad)).toBe(false);
    }
  });

  it('the other shapes: dates (incl. REV-5 from/to), period, year, cap', async () => {
    const good = { start: '2026-09-01', end: '2026-09-30', date: '2026-10-01', from: '2026-01-01', to: '2026-12-31', period: '202609', year: '2026', cap: 'journal_view' };
    const kept = await post('/p', good);
    for (const [k, v] of Object.entries(good)) expect(kept.u.searchParams.get(k), k).toBe(v);

    const bad = { start: '2026-09-01x', from: '1 Jan', to: '2026-1-1', period: '2026-9', year: '20266', cap: 'Bad Cap', date: 'today' };
    const dropped = await post('/p', bad);
    for (const k of Object.keys(bad)) expect(dropped.u.searchParams.has(k), k).toBe(false);
  });

  it('a key outside the closed set never travels, whatever its value', async () => {
    const { u } = await post('/p', { amount: '12', reason: 'x', notakey: UUID });
    expect([...u.searchParams.keys()]).toEqual([]);
  });
});

describe('F4 - size (R8): keep is dropped whole, never shortened; confirm and plan are never truncated', () => {
  it('a 5,000-character keep -> error survives, keep is gone whole, a warning is logged, the cookie is under 3,000 bytes', async () => {
    const huge = 'r'.repeat(5000);
    const { f } = await post('/p', {}, { error: 'refused', keep: { reason: huge, refundAmount: AMOUNT } });
    expect(Buffer.byteLength(cookie())).toBeLessThanOrEqual(3000);
    const sp = await read({ f: f! });
    expect(sp.error).toBe('refused');
    expect(sp.reason).toBeUndefined();
    expect(sp.refundAmount).toBeUndefined(); // whole, not just the long one
    expect(logSpy.warn).toHaveBeenCalled();
    // Mutant: truncate each keep value to fit -> sp.reason would be a prefix, and red.
  });

  it('a keep that fits is returned complete and exact (2,000 chars)', async () => {
    const mid = 'm'.repeat(1000) + AMOUNT + 'n'.repeat(1000);
    const { f } = await post('/p', {}, { error: 'e', keep: { reason: mid } });
    expect((await read({ f: f! })).reason).toBe(mid);
  });

  it('a banner over 600 characters is capped; confirm and plan are not', async () => {
    const long = 'L'.repeat(700);
    const confirm = 'C'.repeat(1200);
    const plan = 'P'.repeat(300);
    const { f } = await post('/p', {}, { error: long, confirm, plan });
    const sp = await read({ f: f! });
    expect(sp.error!.length).toBeLessThanOrEqual(600);
    expect(sp.confirm).toBe(confirm);
    expect(sp.plan).toBe(plan);
    // Mutant: cap confirm/plan at 600 as well (REV-6) -> red.
  });
});

describe('F5 - path safety (R6)', () => {
  it.each(['https://x.y', '//x', '/\\x', '/a?b=1', '/a#b', '/a\\b', 'a/b', ''])('redirectWithFlash(%j) throws', async (bad) => {
    await expect(flash.redirectWithFlash(bad, {} as never, { ok: 'x' })).rejects.toThrow();
    expect(currentJar().sets).toHaveLength(0);
    // Mutant: accept `//` (or skip the `?` check) -> red.
  });

  it('a plain same-app path redirects', async () => {
    const { u } = await post('/reports/pos-reconciliation', { store: UUID });
    expect(u.pathname).toBe('/reports/pos-reconciliation');
  });

  it('splitReturnTo keeps a same-app path and only the nav keys that fit their shapes', () => {
    const r = flash.splitReturnTo(`/reports/pos-reconciliation?store=${UUID}&date=2026-10-01&x=hi`);
    expect(r.path).toBe('/reports/pos-reconciliation');
    expect(r.nav).toEqual({ store: UUID, date: '2026-10-01' });
  });

  it('splitReturnTo never yields an off-site or protocol-relative path, and carries no nav from one', () => {
    for (const raw of ['https://evil.example/ap?store=' + UUID, '//evil.example/x', '/\\evil.example', 'javascript:alert(1)']) {
      const r = flash.splitReturnTo(raw);
      expect(r.path, raw).not.toContain('evil');
      expect(r.path === '' || /^\/(?![/\\])/.test(r.path), raw).toBe(true);
      expect(r.nav, raw).toEqual({});
    }
    // Mutant: pass the path through unchecked -> red.
  });
});

describe('audit: control characters in a path (browsers strip tab/CR/LF, so these are open redirects)', () => {
  const evil = ['/\t/evil.example', '/\n/evil.example', '/\r/evil.example', '\t//evil.example', '/\u0000/evil.example', '/ok\u007fpath', '/a\u001fb'];

  it.each(evil)('redirectWithFlash(%j) throws and sets no cookie', async (bad) => {
    await expect(flash.redirectWithFlash(bad, {} as never, { ok: 'x' })).rejects.toThrow();
    expect(currentJar().sets).toHaveLength(0);
    // Mutant: isSameAppPath without a control-character test (/[\x00-\x1f\x7f]/) -> red.
  });

  it.each(evil)('splitReturnTo(%j) returns the fallback with empty nav', (bad) => {
    const r = flash.splitReturnTo(bad, '/ap');
    expect(r).toEqual({ path: '/ap', nav: {} });
    // Mutant: same as above -> red.
  });
});

describe('audit: __Host- cookie name in production', () => {
  // vi.stubEnv writes the live process.env at call time (beforeAll replaced process.env with a copy,
  // so a reference captured at describe time never reached the code under test).
  const restore = () => vi.unstubAllEnvs();

  it('production: the cookie is __Host-shareat_flash, Secure, Path=/, no Domain; withFlash reads it back', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const { f } = await post('/prepaid/X', {}, { error: 'e' });
      const sets = currentJar().sets.filter((x) => x.name.endsWith('shareat_flash'));
      expect(sets).toHaveLength(1);
      expect(sets[0]!.name).toBe('__Host-shareat_flash');
      expect(sets[0]!.options.secure).toBe(true);
      expect(sets[0]!.options.path).toBe('/');
      expect(sets[0]!.options.domain).toBeUndefined();
      expect(currentJar().has('shareat_flash')).toBe(false);
      expect((await read({ f: f! })).error).toBe('e');
    } finally {
      restore();
    }
    // Mutant: keep the plain name in production -> red. Drop `secure` in production -> red.
  });

  it('development/test: the plain name (a __Host- cookie is refused over http)', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    try {
      await post('/prepaid/X', {}, { error: 'e' });
      expect(currentJar().has('shareat_flash')).toBe(true);
      expect(currentJar().has('__Host-shareat_flash')).toBe(false);
    } finally {
      restore();
    }
    // Mutant: always use the __Host- name -> red.
  });

  it('production: clearSessionCookie wipes the __Host- name too', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      await post('/p', {}, { error: 'e' });
      const { clearSessionCookie } = await import('@/lib/session');
      await clearSessionCookie();
      expect(currentJar().has('__Host-shareat_flash')).toBe(false);
      expect(currentJar().deletes).toContain('__Host-shareat_flash');
    } finally {
      restore();
    }
  });
});

describe('sign-out wipe (spec BUILDER: session.ts clearSessionCookie)', () => {
  it('clearSessionCookie also deletes shareat_flash, so the next person on a shared PC inherits nothing', async () => {
    await post('/p', {}, { error: 'e', keep: { reason: REASON } });
    expect(currentJar().has(FLASH_COOKIE)).toBe(true);
    const { clearSessionCookie } = await import('@/lib/session');
    await clearSessionCookie();
    expect(currentJar().deletes).toContain(FLASH_COOKIE);
    expect(currentJar().has(FLASH_COOKIE)).toBe(false);
    // Mutant: leave clearSessionCookie as it is -> red.
  });
});

describe('outcomeOf (helper contract the S1b tests depend on)', () => {
  it('reads path, nav and flash through the cookie; flash text is not in nav', async () => {
    const { signal } = await post('/prepaid/X', { store: UUID }, { error: 'e', keep: { reason: REASON } });
    const out = outcomeOf(signal);
    expect(out.path).toBe('/prepaid/X');
    expect(out.nav.get('store')).toBe(UUID);
    expect(out.flash.error).toBe('e');
    expect(out.flash.reason).toBe(REASON);
  });
});

describe('auditor additions (T-380 S1a audit): each kills a mutant that survived the tests above', () => {
  it('the signature is HMAC under derivedKey("flash") exactly, not the raw SESSION_SECRET or any other key', async () => {
    await post('/p', {}, { error: 'e' });
    const [payload, sig] = cookie().split('.');
    const key = createHmac('sha256', BASE.SESSION_SECRET).update('shareat:flash:v1').digest('hex');
    expect(sig).toBe(createHmac('sha256', key).update(payload!).digest('base64url'));
    // Mutant: sign with env().SESSION_SECRET directly (survived F2/REV-11) -> red.
  });

  it('a validly signed payload with v !== 1 -> no flash', async () => {
    const { f } = await post('/p', {}, { error: 'e' });
    const forged = b64({ ...unb64(cookie().split('.')[0]!), v: 2 });
    currentJar().set(FLASH_COOKIE, `${forged}.${signFlash(forged)}`, {});
    expect((await read({ f: f! })).error).toBeUndefined();
    // Mutant: drop the `o.v !== 1` check -> red.
  });

  it('secure is set in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      await post('/p', {}, { error: 'e' });
      expect(currentJar().sets.find((s) => s.name.endsWith('shareat_flash'))!.options.secure).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    // Mutant: secure: false -> red.
  });

  it('the keep-dropped warning names keys only, never a refill value', async () => {
    await post('/p', {}, { error: 'refused', keep: { reason: 'q'.repeat(5000), refundAmount: AMOUNT } });
    const logged = JSON.stringify([logSpy.warn.mock.calls, logSpy.error.mock.calls]);
    expect(logged).toContain('refundAmount');
    expect(logged).not.toContain(AMOUNT);
    expect(logged).not.toContain('qqqq');
    // Mutant: log `keep` instead of its keys -> red.
  });

  it('splitReturnTo: a backslash later in the path, and an encoded //, never become a redirect target that leaves the app', () => {
    expect(flash.splitReturnTo('/ap\\evil.example', '/ap').path).toBe('/ap');
    const enc = flash.splitReturnTo('/%2F%2Fevil.example/x', '/ap').path;
    expect(/^\/(?![/\\])/.test(enc)).toBe(true);
    // Mutants: drop the second isSameAppPath(path) check; decodeURIComponent the path -> red.
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T-389 S1 - K2. The `typed` slot of the flash (R1). Spec: docs/tasks/389-refused-save-keeps-typing.md.
//
// CONTRACT PINNED HERE: redirectWithFlash(path, nav, { error, typed: { form, record, fields }, keep? }).
// The decoded payload gains `t` (the typed slot) and `td` ({ form, record }, "typed dropped"); withFlash returns them
// as `sp.typed` / `sp.typedDropped`. v stays 1. A typed slot alone (no banner, no keep) still writes the cookie.
// Red on HEAD: redirectWithFlash ignores `typed`, so the cookie has no `t` and the page gets no `typed`.
// ---------------------------------------------------------------------------------------------------------------
describe('T-389 K2 - the typed slot in the signed flash', () => {
  const TYPED = { form: 'supplier.edit', record: UUID, fields: { name: 'Typed Co', notes: 'a & b = "c"', positionIds: ['p3', 'p1'] as string[] } };
  type Payload = { n: string; msg: Record<string, string>; keep: Record<string, string>; t?: unknown; td?: unknown };
  const decoded = () => flash.decodeFlash(cookie()) as unknown as Payload;
  const readFull = async (p: Record<string, string>) => (await flash.withFlash(Promise.resolve(p))) as unknown as Record<string, unknown>;
  /** Re-sign a payload we edited ourselves: the signature is valid, so only the shape check can refuse it. */
  function planted(mutate: (o: Record<string, unknown>) => void): string {
    const o = JSON.parse(Buffer.from(cookie().split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    mutate(o);
    const body = b64(o);
    return `${body}.${signFlash(body)}`;
  }

  it('round-trips signed: the cookie holds t exactly; the page gets sp.typed; the URL holds only f', async () => {
    const { f, u, url } = await post('/ap/suppliers/x', {}, { error: 'No.', typed: TYPED });
    expect([...u.searchParams.keys()]).toEqual(['f']);
    for (const needle of ['Typed', 'supplier.edit', encodeURIComponent('a & b'), 'positionIds', 'p3']) expect(url.replace(/f=[^&]*/, '')).not.toContain(needle); // DEF-801: the f= value is a random base64url id and can contain 'p3'; check the URL without it
    expect(decoded().t).toEqual(TYPED);
    const sp = await readFull({ f: f! });
    expect(sp.error).toBe('No.');
    expect(sp.typed).toEqual(TYPED);
    expect(sp.typedDropped).toBeUndefined();
    // Mutant: do not store `t` -> the first expect is red. Put typed in the query -> the URL leg is red.
  });

  it('a typed slot alone (no banner, no keep) still writes the cookie and the token', async () => {
    const { f } = await post('/p', {}, { typed: TYPED });
    expect(f).not.toBeNull();
    expect(decoded().t).toEqual(TYPED);
  });

  it('typed and keep travel together', async () => {
    const { f } = await post('/p', {}, { error: 'e', keep: { reason: REASON }, typed: TYPED });
    const sp = await readFull({ f: f! });
    expect(sp.reason).toBe(REASON);
    expect(sp.typed).toEqual(TYPED);
  });

  it('the exact bytes survive: spaces, a mistyped amount, unicode, an empty string, an empty array (unticked box)', async () => {
    const fields = { amount: '1,0OO', note: '  007.10 ₱ é&=?#  ', blank: '', box: [] as string[] };
    const { f } = await post('/p', {}, { error: 'e', typed: { form: 'a.b', record: '', fields } });
    expect((await readFull({ f: f! })).typed).toEqual({ form: 'a.b', record: '', fields });
    // Mutant: trim, Number() or drop empty values -> red.
  });

  it('a tampered t (old signature kept) drops the WHOLE flash', async () => {
    const { f } = await post('/p', {}, { error: 'e', typed: TYPED });
    const [payload, sig] = cookie().split('.');
    const forged = { ...unb64(payload!), t: { ...TYPED, fields: { name: 'Pay 0917' } } };
    currentJar().set(FLASH_COOKIE, `${b64(forged)}.${sig}`, {});
    const sp = await readFull({ f: f! });
    expect(sp.typed).toBeUndefined();
    expect(sp.error).toBeUndefined();
  });

  it('a validly SIGNED but malformed t is dropped alone; the banner and keep survive', async () => {
    const { f } = await post('/p', {}, { error: 'e', keep: { reason: REASON }, typed: TYPED });
    const bad: Array<[string, unknown]> = [
      ['form with a space', { ...TYPED, form: 'Bad Form!' }],
      ['form starting with a capital', { ...TYPED, form: 'Supplier.edit' }],
      ['record that is not a uuid, a slug or blank', { ...TYPED, record: 'a record; drop table' }],
      ['field name starting with a digit', { ...TYPED, fields: { '1bad': 'x' } }],
      // T-389 S3 ruling: a dash is allowed in a field name (channel_<uuid>); a space or a quote still is not.
      ['field name with a space', { ...TYPED, fields: { 'a b': 'x' } }],
      ['field name with a quote', { ...TYPED, fields: { 'a"b': 'x' } }],
      ['a number value', { ...TYPED, fields: { name: 5 } }],
      ['an array holding a number', { ...TYPED, fields: { name: ['a', 1] } }],
      ['a nested object', { ...TYPED, fields: { name: { x: 1 } } }],
      ['fields missing', { form: TYPED.form, record: TYPED.record }],
      ['t is a string', 'oops'],
    ];
    for (const [label, t] of bad) {
      currentJar().set(FLASH_COOKIE, planted((o) => void (o['t'] = t)), {});
      const sp = await readFull({ f: f! });
      expect(sp.typed, label).toBeUndefined();
      expect(sp.error, label).toBe('e');
      expect(sp.reason, label).toBe(REASON);
    }
    // Mutant: skip the shape check in decodeFlash -> a line above is red.
  });

  it('T-390 S5: a 73-char itemId:locationId record round-trips; a space or a quote is still refused', async () => {
    const record = `${UUID}:${UUID}`.slice(0, 73);
    expect(record.length).toBe(73);
    const { f } = await post('/p', {}, { error: 'e', typed: { form: 'cutover.count', record, fields: { x: '1' } } });
    expect(((await readFull({ f: f! })).typed as { record?: string } | undefined)?.record).toBe(record);
    for (const bad of [`${UUID}:a b`, `${UUID}:a"b`]) {
      const r = await post('/p', {}, { error: 'e', typed: { form: 'cutover.count', record: bad, fields: { x: '1' } } });
      expect((await readFull({ f: r.f! })).typed, JSON.stringify(bad)).toBeFalsy();
    }
  });

  it('a blank record and a uuid record are both valid', async () => {
    for (const record of ['', UUID]) {
      const { f } = await post('/p', {}, { error: 'e', typed: { form: 'a.b', record, fields: { x: '1' } } });
      expect((await readFull({ f: f! })).typed, JSON.stringify(record)).toBeTruthy();
    }
  });

  it('an old cookie with no t (a deploy mid-minute) decodes as before', async () => {
    const { f } = await post('/p', {}, { error: 'e', keep: { reason: REASON } });
    const sp = await readFull({ f: f! });
    expect(sp.error).toBe('e');
    expect(sp.reason).toBe(REASON);
    expect(sp.typed).toBeUndefined();
    expect(sp.typedDropped).toBeUndefined();
    expect(decoded().t).toBeUndefined();
  });

  it('R9: ?typed= and ?typedDropped= in the address are never honoured, with or without a flash', async () => {
    const urlTyped = JSON.stringify(TYPED);
    const bare = await readFull({ typed: urlTyped, typedDropped: urlTyped });
    expect(bare.typed).toBeUndefined();
    expect(bare.typedDropped).toBeUndefined();
    const { f } = await post('/p', {}, { error: 'e' });
    const withCookie = await readFull({ f: f!, typed: urlTyped, typedDropped: urlTyped });
    expect(withCookie.typed).toBeUndefined();
    expect(withCookie.typedDropped).toBeUndefined();
    // Mutant: do not strip `typed` / `typedDropped` in stripFlashKeys -> red.
  });

  it('size: an over-budget typed slot is dropped WHOLE (never shortened), td names the form and record, keep survives, the warning names fields not values', async () => {
    const huge = 'LongTypedNote-'.repeat(400); // 5,600 characters
    const { f } = await post('/p', {}, { error: 'refused', keep: { reason: REASON }, typed: { form: 'supplier.edit', record: UUID, fields: { notes: huge, name: 'Short' } } });
    expect(Buffer.byteLength(cookie())).toBeLessThanOrEqual(3000);
    const p = decoded();
    expect(p.t).toBeUndefined();
    expect(p.td).toEqual({ form: 'supplier.edit', record: UUID });
    const sp = await readFull({ f: f! });
    expect(sp.error).toBe('refused');
    expect(sp.reason).toBe(REASON); // keep survives: typed goes first
    expect(sp.typed).toBeUndefined();
    expect(sp.typedDropped).toEqual({ form: 'supplier.edit', record: UUID });
    const logged = JSON.stringify(logSpy.warn.mock.calls);
    expect(logSpy.warn).toHaveBeenCalled();
    expect(logged).toContain('notes');
    expect(logged).toContain('supplier.edit');
    expect(logged).not.toContain('LongTypedNote');
    expect(logged).not.toContain('Short');
    // Mutant: shorten each value to fit -> t is present, red. Drop keep before typed -> reason missing, red. Log values -> red.
  });

  it('size: typed that fits on its own but not beside a large keep is the one dropped; keep (now fitting) survives', async () => {
    const typedNote = 'T'.repeat(1200);
    const keepReason = 'K'.repeat(1200);
    await post('/p', {}, { error: 'e', typed: { form: 'a.b', record: UUID, fields: { notes: typedNote } } });
    expect(decoded().t, 'fits alone').toBeTruthy();
    expect(Buffer.byteLength(cookie())).toBeLessThanOrEqual(3000);
    resetJar();
    const { f } = await post('/p', {}, { error: 'e', keep: { reason: keepReason }, typed: { form: 'a.b', record: UUID, fields: { notes: typedNote } } });
    expect(Buffer.byteLength(cookie())).toBeLessThanOrEqual(3000);
    const sp = await readFull({ f: f! });
    expect(sp.typed).toBeUndefined();
    expect(sp.typedDropped).toEqual({ form: 'a.b', record: UUID });
    expect(sp.reason).toBe(keepReason);
  });

  it('I5: no typed value is logged on the normal path either', async () => {
    await post('/p', {}, { error: 'e', typed: { form: 'a.b', record: UUID, fields: { name: 'Very-Private-Typed-Value', pinLike: '4242' } } });
    const all = JSON.stringify([logSpy.warn.mock.calls, logSpy.info.mock.calls, logSpy.error.mock.calls, logSpy.debug.mock.calls]);
    expect(all).not.toContain('Very-Private-Typed-Value');
    expect(all).not.toContain('4242');
  });

  it('the five tender keep keys are gone from KEEP_KEYS (the tender form moved onto typed); the other keep keys stay', () => {
    const keys = flash.KEEP_KEYS as readonly string[];
    for (const gone of ['tenderId', 'tenderName', 'tenderKind', 'tenderAccount', 'tenderAlias']) expect(keys, gone).not.toContain(gone);
    for (const stays of ['reason', 'refundAmount', 'refundAccountCode', 'writtenOffOn', 'inServiceOn', 'mode', 'openingDate', 'separationDate']) {
      expect(keys, stays).toContain(stays);
    }
    // Red on HEAD: KEEP_KEYS still lists the five tender keys.
  });
});
