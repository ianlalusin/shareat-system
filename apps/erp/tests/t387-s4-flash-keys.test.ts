import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLASH_COOKIE, captureRedirect, currentJar, resetJar } from './helpers/flash-jar';

/**
 * T-387 S4 (TESTER) - flash.ts gains `stamp` and `field`. Spec: docs/tasks/387-warm-theme-and-grill-night-dark.md S4 and
 * the `t387-q5-stamp-words` table.
 *
 * Pinned: FLASH_KEYS carries both; `STAMP_WORDS` is exported with EXACTLY the q5 vocabulary; `redirectWithFlash`
 * throws on a stamp outside it and on a `field` that is not `^[a-z0-9-]{1,40}$`; both round-trip through the cookie and
 * `withFlash`; neither is honoured from the URL (R9).
 * Mutants: drop the vocabulary check; widen the field regex; omit `stamp`/`field` from pick(); leave them out of FLASH_KEYS.
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
});

/** The q5 table, verbatim. */
const Q5 = ['VERIFIED', 'POSTED', 'APPROVED', 'RELEASED', 'RECEIVED', 'VOID', 'REVERSED'] as const;

const go = (flashArg: object) => captureRedirect(() => flash.redirectWithFlash('/expenses/x', {}, flashArg as never));
const stampWords = () => (flash as unknown as { STAMP_WORDS?: readonly string[] }).STAMP_WORDS;
const keys = () => flash.FLASH_KEYS as readonly string[];

async function roundTrip(flashArg: object) {
  const signal = await go(flashArg);
  const f = new URL(signal.url, 'http://x.test').searchParams.get('f');
  const sp = (await flash.withFlash(Promise.resolve({ f: f! }))) as unknown as Record<string, string | undefined>;
  return { signal, f, sp };
}

describe('S4 flash keys', () => {
  it('FLASH_KEYS carries stamp and field', () => {
    expect(keys()).toContain('stamp');
    expect(keys()).toContain('field');
  });

  it('STAMP_WORDS is exported and is exactly the q5 vocabulary', () => {
    const words = stampWords();
    expect(words, 'STAMP_WORDS must be exported from flash.ts').toBeDefined();
    expect([...(words ?? [])].sort()).toEqual([...Q5].sort());
  });
});

describe('S4 stamp vocabulary is enforced in redirectWithFlash', () => {
  it.each(Q5)('accepts %s and round-trips it through the cookie and withFlash', async (word) => {
    const { sp } = await roundTrip({ ok: 'Done.', stamp: word });
    expect(sp['stamp']).toBe(word);
    expect(sp['ok']).toBe('Done.');
  });

  it.each(['APPROVE', 'posted', 'Posted', 'DONE', 'REJECTED', 'DISPATCHED', 'VOIDED', 'POSTED ', ' POSTED', '', 'POSTED\n', '<b>'])(
    'refuses %j',
    async (word) => {
      await expect(go({ ok: 'x', stamp: word })).rejects.toThrow();
      // a refusal writes no cookie
      expect(currentJar().has(FLASH_COOKIE)).toBe(false);
    },
  );

  it('no stamp is fine (most redirects carry none)', async () => {
    const { sp } = await roundTrip({ ok: 'Saved.' });
    expect(sp['stamp']).toBeUndefined();
  });
});

describe('S4 field is an element id', () => {
  it.each(['store', 'requested-for', 'a', 'amount-2', 'a'.repeat(40)])('accepts %s and round-trips', async (id) => {
    const { sp } = await roundTrip({ error: 'Choose a store.', field: id });
    expect(sp['field']).toBe(id);
  });

  it.each(['Store', 'store_id', 'storeId', 'a b', '', 'a'.repeat(41), 'x"y', '<script>', '#store', 'a/b', 'é'])(
    'refuses %j',
    async (id) => {
      await expect(go({ error: 'x', field: id })).rejects.toThrow();
      expect(currentJar().has(FLASH_COOKIE)).toBe(false);
    },
  );
});

describe('S4 URL cannot forge them (R9)', () => {
  it('?stamp= and ?field= in the address are stripped by withFlash', async () => {
    const sp = (await flash.withFlash(Promise.resolve({ stamp: 'POSTED', field: 'store' }))) as unknown as Record<string, string | undefined>;
    expect(sp['stamp']).toBeUndefined();
    expect(sp['field']).toBeUndefined();
  });

  it('the redirect URL carries only the f token, never the word', async () => {
    const { signal } = await roundTrip({ ok: 'Done.', stamp: 'POSTED', field: 'store' });
    expect(signal.url).not.toContain('POSTED');
    expect(signal.url).not.toContain('field=');
    expect(signal.url).not.toContain('stamp=');
  });
});
