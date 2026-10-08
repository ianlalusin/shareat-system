import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureRedirect, resetJar } from './helpers/flash-jar';

/**
 * T-384 S1a (TESTER) - `redirectWithFlash(path, nav, flash, opts?)` gains `opts.anchor` (R7, DEF-612).
 * `docs/tasks/384-pos-link-tenders-and-width.md` S1a, F1-F4. Same harness as `flash.test.ts` (T-380).
 *
 * Red on HEAD: the 4th parameter is ignored, so the redirect target has no `#store-<uuid>` (F1), and a hostile anchor
 * logs nothing (F2). F3 and F4 are controls and pass on HEAD.
 *
 * Mutants: F1 - ignore opts.anchor; F2 - append the anchor without the shape test (a hostile value lands in the URL);
 * F2 - log the value instead of the key; F3 - drop the `#`-in-path refusal.
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

type FlashMod = typeof import('../src/lib/flash');
let flash: FlashMod;

beforeAll(async () => {
  process.env = { ...process.env, ...BASE } as unknown as NodeJS.ProcessEnv;
  const specifier = '@/lib/flash';
  flash = (await import(/* @vite-ignore */ specifier)) as FlashMod;
}, 60_000);

beforeEach(() => {
  resetJar();
  for (const fn of [logSpy.warn, logSpy.info, logSpy.error, logSpy.debug]) fn.mockClear();
});

const STORE = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const PATH = '/settings/pos-link';

/** The 4th parameter is not in HEAD's signature; the cast keeps this file compiling on both sides. */
type RedirectFn = (path: string, nav: object, flash?: object, opts?: { anchor?: string }) => Promise<never>;
async function go(nav: object, flashArg: object | undefined, opts?: { anchor?: string }) {
  const fn = flash.redirectWithFlash as unknown as RedirectFn;
  const signal = await captureRedirect(() => (opts === undefined ? fn(PATH, nav, flashArg) : fn(PATH, nav, flashArg, opts)));
  return signal.url;
}

describe('F1 - a valid anchor is appended after the query', () => {
  it('with a flash: /settings/pos-link?store=<uuid>&f=<n>#store-<uuid>', async () => {
    const url = await go({ store: STORE }, { error: 'Another tender already answers to Gcash.' }, { anchor: `store-${STORE}` });
    expect(url).toMatch(new RegExp(`^${PATH}\\?store=${STORE}&f=[A-Za-z0-9_-]+#store-${STORE}$`));
  });

  it('with no flash (no f): /settings/pos-link?store=<uuid>#store-<uuid>', async () => {
    const url = await go({ store: STORE }, undefined, { anchor: `store-${STORE}` });
    expect(url).toBe(`${PATH}?store=${STORE}#store-${STORE}`);
  });

  it('the anchor never enters the flash cookie or the query string', async () => {
    const url = await go({ store: STORE }, { ok: 'Gcash added.' }, { anchor: `store-${STORE}` });
    const u = new URL(url, 'http://x.test');
    expect(u.hash).toBe(`#store-${STORE}`);
    expect([...u.searchParams.keys()].sort()).toEqual(['f', 'store']);
  });
});

describe('F2 - a hostile anchor is dropped, and only the key name is logged', () => {
  it('anchor `x"><b`: no # in the target; one warn naming the key; the value is not logged', async () => {
    const hostile = 'x"><b';
    const url = await go({ store: STORE }, { error: 'e' }, { anchor: hostile });
    expect(url, 'no fragment at all').not.toContain('#');
    expect(url).not.toContain('<b');
    expect(logSpy.warn, 'one log line for the dropped anchor').toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(logSpy.warn.mock.calls);
    expect(logged, 'the key name is logged').toContain('anchor');
    expect(logged, 'the value is never logged').not.toContain(hostile);
    expect(logged).not.toContain('<b');
  });

  it.each([
    ['another shape', 'store-not-a-uuid'],
    ['the right shape with a prefix', 'xstore-' + STORE],
    ['the right shape with a suffix', `store-${STORE}x`],
    ['empty', ''],
  ])('%s is dropped: no #', async (_n, anchor) => {
    const url = await go({ store: STORE }, { error: 'e' }, { anchor });
    expect(url).not.toContain('#');
  });

  it('control: a valid anchor on the same call is kept and logs nothing', async () => {
    const url = await go({ store: STORE }, { error: 'e' }, { anchor: `store-${STORE}` });
    expect(url).toContain(`#store-${STORE}`);
    expect(logSpy.warn).not.toHaveBeenCalled();
  });
});

describe('F3 - control: a # in the path is still refused', () => {
  it('throws, with or without an anchor', async () => {
    const fn = flash.redirectWithFlash as unknown as (p: string, n: object, f?: object, o?: object) => Promise<never>;
    await expect(captureRedirect(() => fn('/settings/pos-link#x', {}, { ok: 'x' }))).rejects.toThrow(/path/);
    await expect(captureRedirect(() => fn('/settings/pos-link#x', {}, { ok: 'x' }, { anchor: `store-${STORE}` }))).rejects.toThrow(/path/);
  });
});

describe('F4 - control: no opts is byte-identical to HEAD', () => {
  it('with a flash: path?store=<uuid>&f=<n>, no fragment', async () => {
    const url = await go({ store: STORE }, { ok: 'x' });
    expect(url).toMatch(new RegExp(`^${PATH}\\?store=${STORE}&f=[A-Za-z0-9_-]+$`));
  });
  it('with no flash: path?store=<uuid>', async () => {
    expect(await go({ store: STORE }, undefined)).toBe(`${PATH}?store=${STORE}`);
  });
  it('with empty opts: no fragment', async () => {
    expect(await go({ store: STORE }, undefined, {})).toBe(`${PATH}?store=${STORE}`);
  });
});
