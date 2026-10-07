/**
 * flash-jar.ts - T-380 S1a. What a test imports: the jar, the redirect capture, and `outcomeOf`.
 *
 * `outcomeOf(signal, jar)` is the ONE way a banner test reads an action's result (S1b moves every
 * banner test to it). It reads the redirect URL for navigation and the flash cookie for banner and
 * refill text.
 *
 * S6 (R9): the banner is read ONLY from the flash cookie, matched to the URL's `f` token. There is no
 * URL fallback: a test that still depends on a banner in the URL goes red, which is the proof (X2).
 *
 * ASSUMPTION about `decodeFlash` (the spec exports it "for the test helper only" without a
 * signature): it takes the raw cookie value and returns the payload object of R3
 * `{ v, n, p, exp, msg, keep }`, or null when the value is unsigned, tampered, or malformed.
 * `msg` holds the banner keys, `keep` the refill keys. If the builder's shape differs, THIS file is
 * the one place to adjust.
 */
import type { FlashJar } from './flash-jar-core';
import { currentJar, RedirectSignal as RedirectSignalClass, type RedirectSignal } from './flash-jar-core';

export * from './flash-jar-core';

// Loaded at module top level, not statically: while `lib/flash.ts` does not exist (S1a before the
// builder) a test file importing this helper must fail per test, by name, not at collection.
const flashModule = await import('@/lib/flash').catch(() => null);
function decodeFlash(raw: string): unknown {
  if (!flashModule) throw new Error('@/lib/flash does not exist yet (T-380 S1a builder file)');
  return (flashModule as { decodeFlash: (v: string) => unknown }).decodeFlash(raw);
}

/** All `outcomeOf` needs of a jar: a test with its own `next/headers` fake passes that fake. */
export interface JarLike {
  get(name: string): { value: string } | undefined;
}

export const FLASH_COOKIE = 'shareat_flash';

export const FLASH_URL_KEYS = [
  'ok',
  'error',
  'warning',
  'notice',
  'confirm',
  'plan',
  'ran',
  'failed',
  'posted',
  'needsConfirmation',
] as const;

export const KEEP_URL_KEYS = [
  'reason',
  'refundAmount',
  'refundAccountCode',
  'writtenOffOn',
  'inServiceOn',
  'mode',
  'openingDate',
  'separationDate',
] as const;

export type FlashSeen = Partial<Record<(typeof FLASH_URL_KEYS)[number] | (typeof KEEP_URL_KEYS)[number], string>>;

export interface Outcome {
  path: string;
  nav: URLSearchParams;
  flash: FlashSeen;
  /** The `f` token in the URL, if any. */
  f: string | null;
}

interface PayloadShape {
  n?: string;
  exp?: number;
  msg?: Record<string, unknown>;
  keep?: Record<string, unknown>;
}

function strings(src: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src ?? {})) if (typeof v === 'string') out[k] = v;
  return out;
}

export function outcomeOf(signal: RedirectSignal, jar: JarLike = currentJar()): Outcome {
  const u = new URL(signal.url, 'http://flash.test');
  const f = u.searchParams.get('f');
  const nav = new URLSearchParams(u.searchParams);
  nav.delete('f');

  let flash: FlashSeen = {};
  const raw = jar.get(FLASH_COOKIE)?.value;
  const payload = raw ? (decodeFlash(raw) as PayloadShape | null) : null;
  const usable = payload && f !== null && payload.n === f;
  if (usable) {
    flash = { ...strings(payload.msg), ...strings(payload.keep) } as FlashSeen;
  }
  // S6: a banner is read ONLY from the flash cookie. The URL's own flash/keep keys are never read,
  // and (R9) are not nav keys either, so they stay out of `nav` and out of `flash`.
  for (const k of [...FLASH_URL_KEYS, ...KEEP_URL_KEYS]) nav.delete(k);
  return { path: u.pathname, nav, flash, f };
}

/**
 * T-380 S1b. `outcomeOf` for a test that already holds the redirect target as a string (its own
 * `RedirectSignal` class, or a `to` it pulled off one). Same jar default.
 */
export function outcomeOfUrl(to: string, jar: JarLike = currentJar()): Outcome {
  return outcomeOf(new RedirectSignalClass(to), jar);
}

/**
 * T-380 S1b. The redirect's navigation keys and its banner/refill keys as ONE `URLSearchParams`
 * (flash wins), read through `outcomeOf`. A drop-in for the `new URL(to, base).searchParams` a
 * banner test used to build, so `.get('error')` / `.has('ok')` / `.get('store')` keep working.
 */
export function paramsOf(to: string, jar: JarLike = currentJar()): URLSearchParams {
  const o = outcomeOfUrl(to, jar);
  const merged = new URLSearchParams(o.nav);
  for (const [k, v] of Object.entries(o.flash)) if (typeof v === 'string') merged.set(k, v);
  return merged;
}

/**
 * T-380 S1b. A real `URL` whose query is the merged outcome (see `paramsOf`), for a test that
 * reads `.pathname` AND `.searchParams` off one object.
 */
export function urlOf(to: string, jar: JarLike = currentJar()): URL {
  const u = new URL(to, 'http://flash.test');
  u.search = paramsOf(to, jar).toString();
  return u;
}

/**
 * T-380 S1b. The `searchParams` a page-render test hands a page after an action redirected: the
 * navigation keys and `f` as the URL carries them, PLUS the banner/refill keys read through
 * `outcomeOf`. On an unconverted screen the page reads the banner keys from here; on a converted
 * one `withFlash` reads them from the jar by `f` - the same object serves both, and keeps serving
 * after S6 strips the URL-side keys.
 */
export function pageParamsOf(to: string, jar: JarLike = currentJar()): Record<string, string> {
  const o = outcomeOfUrl(to, jar);
  const out: Record<string, string> = Object.fromEntries(o.nav.entries());
  if (o.f !== null) out.f = o.f;
  for (const [k, v] of Object.entries(o.flash)) if (typeof v === 'string') out[k] = v;
  return out;
}

/**
 * T-380 S1b. For a page-render test that FABRICATES banner or refill keys in `searchParams` (no
 * action ran): seed the jar with a real, signed flash holding those keys and return the params
 * with its `f` token added. The URL-side keys are left in place, so the page renders the same on
 * an unconverted screen (reads them from the URL) and on a converted one (`withFlash` reads the
 * jar by `f`) - and after S6 strips URL-side keys the jar still carries them.
 */
export async function seedSearch(search: Record<string, string>, jar: JarLike = currentJar()): Promise<Record<string, string>> {
  const flash: Record<string, string> = {};
  const keep: Record<string, string> = {};
  for (const k of FLASH_URL_KEYS) if (typeof search[k] === 'string') flash[k] = search[k]!;
  for (const k of KEEP_URL_KEYS) if (typeof search[k] === 'string') keep[k] = search[k]!;
  if (Object.keys(flash).length === 0 && Object.keys(keep).length === 0) return search;
  if (!flashModule) throw new Error('@/lib/flash does not exist yet (T-380 S1a builder file)');
  // Signing needs the app secret. A unit render test boots without env (`flash.test.ts` sets the
  // same three in `beforeAll`); an integration test already has them, so `??=` changes nothing there.
  process.env['DATABASE_URL'] ??= 'postgresql://postgres:pw@localhost:5435/shareat_dev';
  process.env['SESSION_SECRET'] ??= 'x'.repeat(48);
  process.env['APP_TIMEZONE'] ??= 'Asia/Manila';
  try {
    await (flashModule as { redirectWithFlash: (p: string, n: object, f: object) => Promise<never> }).redirectWithFlash('/seed', {}, { ...flash, keep });
  } catch {
    // The redirect is how `redirectWithFlash` ends (real or mocked); the cookie was set before it.
  }
  const raw = jar.get(FLASH_COOKIE)?.value;
  const payload = raw ? (decodeFlash(raw) as PayloadShape | null) : null;
  if (!payload?.n) throw new Error('seedSearch: the flash cookie was not written to the jar');
  return { ...search, f: payload.n };
}
