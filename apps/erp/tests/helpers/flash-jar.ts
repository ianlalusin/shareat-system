/**
 * flash-jar.ts - T-380 S1a. What a test imports: the jar, the redirect capture, and `outcomeOf`.
 *
 * `outcomeOf(signal, jar)` is the ONE way a banner test reads an action's result (S1b moves every
 * banner test to it). It reads the redirect URL for navigation and the flash cookie for banner and
 * refill text.
 *
 * DUAL READ (S1-S5): when the cookie holds no flash for this redirect (absent, or its token does not
 * match the URL's `f`), the URL's own flash/keep keys are used. That keeps every test green while an
 * action has not moved yet. S6 deletes the fallback (`URL_FALLBACK = false`), at which point a test
 * that still depends on a banner in the URL goes red - which is the proof S6 asks for (X2).
 *
 * ASSUMPTION about `decodeFlash` (the spec exports it "for the test helper only" without a
 * signature): it takes the raw cookie value and returns the payload object of R3
 * `{ v, n, p, exp, msg, keep }`, or null when the value is unsigned, tampered, or malformed.
 * `msg` holds the banner keys, `keep` the refill keys. If the builder's shape differs, THIS file is
 * the one place to adjust.
 */
import type { FlashJar } from './flash-jar-core';
import { currentJar, type RedirectSignal } from './flash-jar-core';

export * from './flash-jar-core';

// Loaded at module top level, not statically: while `lib/flash.ts` does not exist (S1a before the
// builder) a test file importing this helper must fail per test, by name, not at collection.
const flashModule = await import('@/lib/flash').catch(() => null);
function decodeFlash(raw: string): unknown {
  if (!flashModule) throw new Error('@/lib/flash does not exist yet (T-380 S1a builder file)');
  return (flashModule as { decodeFlash: (v: string) => unknown }).decodeFlash(raw);
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

/** S6 sets this to false. */
export const URL_FALLBACK = true;

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

export function outcomeOf(signal: RedirectSignal, jar: FlashJar = currentJar()): Outcome {
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
  } else if (URL_FALLBACK) {
    const all: string[] = [...FLASH_URL_KEYS, ...KEEP_URL_KEYS];
    for (const k of all) {
      const v = u.searchParams.get(k);
      if (v !== null) (flash as Record<string, string>)[k] = v;
    }
  }
  if (URL_FALLBACK) {
    for (const k of [...FLASH_URL_KEYS, ...KEEP_URL_KEYS]) nav.delete(k);
  }
  return { path: u.pathname, nav, flash, f };
}
