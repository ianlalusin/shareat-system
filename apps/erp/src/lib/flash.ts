import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { flashSignatureMatches, signFlash } from '@shareat/auth';
import { logger } from '@shareat/core/logger';

/**
 * The flash: one banner and a few form refills carried across a redirect in a signed, short-lived,
 * httpOnly cookie, never in the page address. T-380 (DEF-476), docs/tasks/380-no-typed-values-in-urls.md.
 *
 * ## Why a cookie and not the URL
 * A page address lands in browser history on a shared till PC, in the reverse proxy's access log and
 * in `Referer` headers (CWE-598). A banner can quote what was typed (`"1,0OO" is not a valid
 * amount`), and a refill IS what was typed, so neither belongs in a URL. The URL keeps only what
 * identifies the page (the closed NAV set below) plus the random token `f`.
 *
 * ## Why the token `f`
 * A Server Component can read a cookie but cannot delete one. Without a token, going back to the same
 * page inside the minute would show "Written off" a second time on a money screen. The cookie carries
 * `n`; the page uses the flash only when the URL's `f` equals it, so only the URL the redirect
 * produced shows the banner. It is not one-time: reload or Back to that `?f=` entry within 60 s shows
 * it again, by design (R3, REV-7). A path check was rejected (REV-3): `withFlash` has no pathname.
 *
 * ## Why it is signed
 * A sibling `*.shareat.net` host can set a cookie with this name. Without a signature that brings back
 * the fake-banner hole this task closes. The key is `derivedKey('flash')`, used for nothing else (R4).
 * The payload is readable by whoever holds the cookie, so nothing secret goes in it.
 *
 * ## Why every call is awaited, as `return await redirectWithFlash(...)`
 * `cookies()` is async, so the helper is async. A call that is not awaited lets the action carry on:
 * a refused write-off would fall through to the success redirect and a guard clause would fall through
 * to the posting call. `return await` (not a bare `await`) because only a returned call keeps
 * TypeScript's narrowing after a guard (REV-1). Guard G1b enforces the form.
 *
 * Flash contents are never logged (I5). A dropped nav value is logged by KEY name only.
 */

/**
 * The one definition of the cookie name. In production it is `__Host-` prefixed (Secure, Path=/, no
 * Domain), so a sibling `*.shareat.net` host cannot plant or overwrite it. Dev stays plain because a
 * `__Host-` cookie is refused over http. Read at call time; session.ts wipes the same name.
 */
export function flashCookieName(): string {
  // Bracket access: a bundler may inline the dotted form at build time; this is read per call.
  return process.env['NODE_ENV'] === 'production' ? '__Host-shareat_flash' : 'shareat_flash';
}
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const TTL_MS = 60_000;
const MAX_COOKIE_BYTES = 3000;
const MAX_BANNER_CHARS = 600;

export const FLASH_KEYS = [
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
  'stamp',
  'field',
] as const;
export type FlashKey = (typeof FLASH_KEYS)[number];

/**
 * T-387 S4 (`t387-q5-stamp-words`): the closed stamp vocabulary, one word per action, following the glossary.
 * A stamp marks a state change that moves money or responsibility; `redirectWithFlash` refuses any other word.
 */
export const STAMP_WORDS = ['VERIFIED', 'POSTED', 'APPROVED', 'RELEASED', 'RECEIVED', 'VOID', 'REVERSED'] as const;
export type StampWord = (typeof STAMP_WORDS)[number];
/** T-387 S4: `field` is an element id (kebab-case), the control a refusal names. */
const FIELD_ID = /^[a-z0-9-]{1,40}$/;

export const KEEP_KEYS = [
  'reason',
  'refundAmount',
  'refundAccountCode',
  'writtenOffOn',
  'inServiceOn',
  'mode',
  'openingDate',
  'separationDate',
] as const;
export type KeepKey = (typeof KEEP_KEYS)[number];

/** `confirm` is the consent text and `plan` is sent back byte for byte: neither is ever truncated (R8, REV-6). */
const UNCAPPED: ReadonlySet<string> = new Set(['confirm', 'plan']);

// Anchored on purpose (REV-4): lib/error-shape.ts UUID_SHAPE is `\b...\b`, built for "contains an id".
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD = /^\d{4}-?\d{2}$/;
const YEAR = /^\d{4}$/;
const CAP = /^[a-z][a-z0-9_]{0,63}$/;
/** R7: the one anchor shape in use, a closed set like NAV_SHAPES. */
const ANCHOR = /^store-[0-9a-f-]{36}$/;

const NAV_SHAPES = {
  store: UUID,
  room: UUID,
  day: UUID,
  pull: UUID,
  supplier: UUID,
  employmentId: UUID,
  branch: UUID,
  commissary: UUID,
  changedChannel: UUID,
  pos: UUID,
  start: ISO_DATE,
  end: ISO_DATE,
  date: ISO_DATE,
  from: ISO_DATE,
  to: ISO_DATE,
  period: PERIOD,
  year: YEAR,
  cap: CAP,
  view: /^(cards|roster|positions)$/,
} as const satisfies Record<string, RegExp>;

export type NavKey = keyof typeof NAV_SHAPES;
export type Nav = Partial<Record<NavKey, string>>;

/**
 * T-389 (DEF-617): what the user typed into ONE saved-record form before its Save was refused. `form` is the
 * `<area>.<form>` key from `defineTypedForm`, `record` the record id ('' only for a singleton form). A repeated name
 * (a checkbox group) is an array. Rides in the signed cookie only, never the address, never a log.
 */
export interface TypedFlash {
  form: string;
  record: string;
  fields: Record<string, string | string[]>;
  /** The person whose Save was refused. `typedFor` shows the slot to that person only (a shared till PC, one minute). */
  actor?: string;
}
/** The typed slot was too big for the cookie and was dropped whole: the page says so instead of reopening the record. */
export interface TypedDropped {
  form: string;
  record: string;
  /** Same binding as the typed slot: the notice is shown to the person whose Save was refused. */
  actor?: string;
}

export interface Flash {
  ok?: string;
  error?: string;
  warning?: string;
  notice?: string;
  confirm?: string;
  plan?: string;
  ran?: string;
  failed?: string;
  posted?: string;
  needsConfirmation?: string;
  /** T-387 S4: one of `STAMP_WORDS`; anything else makes `redirectWithFlash` throw. */
  stamp?: StampWord;
  /** T-387 S4: the id of the control an `error` names; the banner links to it. */
  field?: string;
  keep?: Partial<Record<KeepKey, string>>;
  typed?: TypedFlash | undefined;
}

export type FlashFields = Partial<Record<FlashKey | KeepKey, string>> & {
  typed?: TypedFlash;
  typedDropped?: TypedDropped;
};

export interface FlashPayload {
  v: 1;
  n: string;
  p: string;
  exp: number;
  msg: Partial<Record<FlashKey, string>>;
  keep: Partial<Record<KeepKey, string>>;
  /** T-389: the typed slot. Absent on an old cookie, which decodes as before. */
  t?: TypedFlash;
  /** T-389: set when `t` was dropped for size. */
  td?: TypedDropped;
}

const TYPED_FORM = /^[a-z][a-zA-Z0-9.]{0,63}$/;
const TYPED_RECORD = /^[A-Za-z0-9_:-]{0,80}$/; // '' , a UUID, a short slug, or `<uuid>:<uuid>` (T-390 S5: an item in a room)
const TYPED_FIELD = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Strict shape check of a typed slot. Anything else is not a TypedFlash. */
function asTyped(v: unknown): TypedFlash | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o['form'] !== 'string' || !TYPED_FORM.test(o['form'])) return null;
  if (typeof o['record'] !== 'string' || !TYPED_RECORD.test(o['record'])) return null;
  const f = o['fields'];
  if (typeof f !== 'object' || f === null || Array.isArray(f)) return null;
  const fields: Record<string, string | string[]> = {};
  for (const [k, val] of Object.entries(f as Record<string, unknown>)) {
    if (!TYPED_FIELD.test(k)) return null;
    if (typeof val === 'string') fields[k] = val;
    else if (Array.isArray(val) && val.every((x) => typeof x === 'string')) fields[k] = [...(val as string[])];
    else return null;
  }
  const actor = o['actor'];
  if (actor !== undefined && (typeof actor !== 'string' || !TYPED_RECORD.test(actor) || actor === '')) return null;
  return { form: o['form'], record: o['record'], fields, ...(actor !== undefined ? { actor } : {}) };
}

function asDropped(v: unknown): TypedDropped | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o['form'] !== 'string' || !TYPED_FORM.test(o['form'])) return null;
  if (typeof o['record'] !== 'string' || !TYPED_RECORD.test(o['record'])) return null;
  const actor = o['actor'];
  if (actor !== undefined && (typeof actor !== 'string' || !TYPED_RECORD.test(actor) || actor === '')) return null;
  return { form: o['form'], record: o['record'], ...(actor !== undefined ? { actor } : {}) };
}

function isNavKey(k: string): k is NavKey {
  return Object.prototype.hasOwnProperty.call(NAV_SHAPES, k);
}

/** Keep the nav values that fit their shape; drop the rest and log the KEY only. */
function cleanNav(raw: Record<string, string | undefined>): Nav {
  const out: Nav = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (!isNavKey(k) || !NAV_SHAPES[k].test(v)) {
      logger.warn({ key: k }, 'flash: nav value dropped (not a navigation key or wrong shape)');
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** The same test as sign-in/lib.ts `safeNext`: one `/`, then a character that is neither `/` nor `\`. */
function isSameAppPath(p: string): boolean {
  if (CONTROL_CHARS.test(p)) return false; // a tab or newline is stripped by URL parsers: `/<TAB>/evil.com` becomes `//evil.com`
  return /^\/(?![/\\])/.test(p) && !/[?#\\]/.test(p);
}

function encode(payload: FlashPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${signFlash(body)}`;
}

/** Exported for the test helper only. The payload, or null for anything unsigned, tampered or malformed. Signature first, before the payload is parsed. Expiry is the reader's check. */
export function decodeFlash(raw: string): FlashPayload | null {
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!flashSignatureMatches(body, sig)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (o.v !== 1 || typeof o.n !== 'string' || !o.n) return null;
  if (typeof o.exp !== 'number' || !Number.isFinite(o.exp)) return null;
  const msg = o.msg;
  const keep = o.keep;
  if (typeof msg !== 'object' || msg === null || typeof keep !== 'object' || keep === null) return null;
  const t = o['t'] === undefined ? null : asTyped(o['t']);
  const td = o['td'] === undefined ? null : asDropped(o['td']);
  return {
    v: 1,
    n: o.n,
    p: typeof o.p === 'string' ? o.p : '',
    exp: o.exp,
    msg: pick(msg as Record<string, unknown>, FLASH_KEYS),
    keep: pick(keep as Record<string, unknown>, KEEP_KEYS),
    ...(t ? { t } : {}),
    ...(td ? { td } : {}),
  };
}

function pick<K extends string>(src: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const k of keys) {
    const v = src[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Redirect to `path` carrying a banner and refills in the flash cookie. Always `return await` it.
 * `redirect` from `next/navigation` is called only here (guard G1a).
 */
export async function redirectWithFlash(path: string, nav: Nav, flash?: Flash, opts?: { anchor?: string }): Promise<never> {
  if (!isSameAppPath(path)) throw new Error('redirectWithFlash: path must be a same-app path with no query, hash or backslash');

  let hash = '';
  if (opts?.anchor !== undefined) {
    if (ANCHOR.test(opts.anchor)) hash = `#${opts.anchor}`;
    else logger.warn({ key: 'anchor' }, 'flash: anchor dropped (wrong shape)');
  }

  // T-387 S4: validated before anything is written, so a refusal leaves no cookie.
  if (flash?.stamp !== undefined && !(STAMP_WORDS as readonly string[]).includes(flash.stamp)) {
    throw new Error('redirectWithFlash: stamp is not in the stamp vocabulary');
  }
  if (flash?.field !== undefined && !FIELD_ID.test(flash.field)) {
    throw new Error('redirectWithFlash: field must match ^[a-z0-9-]{1,40}$');
  }

  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(cleanNav(nav as Record<string, string | undefined>))) query.set(k, v);

  const msg: Partial<Record<FlashKey, string>> = {};
  for (const k of FLASH_KEYS) {
    const v = flash?.[k];
    if (typeof v !== 'string') continue;
    msg[k] = UNCAPPED.has(k) ? v : v.slice(0, MAX_BANNER_CHARS);
  }
  let keep: Partial<Record<KeepKey, string>> = {};
  for (const k of KEEP_KEYS) {
    const v = flash?.keep?.[k];
    if (typeof v === 'string') keep[k] = v;
  }

  // T-389: the typed slot. A shape the reader would refuse is dropped here, logged by form key only.
  let typed: TypedFlash | undefined;
  if (flash?.typed !== undefined) {
    const ok = asTyped(flash.typed);
    if (ok) typed = ok;
    else logger.warn({ form: flash.typed.form }, 'flash: typed slot dropped (wrong shape)');
  }

  if (Object.keys(msg).length === 0 && Object.keys(keep).length === 0 && !typed) {
    const qs = query.toString();
    return redirect(`${qs ? `${path}?${qs}` : path}${hash}`);
  }

  const n = randomBytes(12).toString('base64url');
  let dropped: TypedDropped | undefined;
  const payload = (k: Partial<Record<KeepKey, string>>): FlashPayload => ({
    v: 1,
    n,
    p: path,
    exp: Date.now() + TTL_MS,
    msg,
    keep: k,
    ...(typed ? { t: typed } : {}),
    ...(dropped ? { td: dropped } : {}),
  });
  let value = encode(payload(keep));
  if (Buffer.byteLength(value) > MAX_COOKIE_BYTES && typed) {
    // Dropped whole, FIRST, never shortened: a shortened amount would reopen a different figure. Field NAMES only in the log.
    logger.warn({ form: typed.form, keys: Object.keys(typed.fields) }, 'flash: typed slot dropped whole (cookie over budget)');
    dropped = { form: typed.form, record: typed.record, ...(typed.actor !== undefined ? { actor: typed.actor } : {}) };
    typed = undefined;
    value = encode(payload(keep));
  }
  if (Buffer.byteLength(value) > MAX_COOKIE_BYTES && Object.keys(keep).length > 0) {
    // Dropped whole, never shortened: a refilled amount that changed would post a different figure.
    logger.warn({ keys: Object.keys(keep) }, 'flash: keep dropped whole (cookie over budget)');
    keep = {};
    value = encode(payload(keep));
  }
  if (Buffer.byteLength(value) > MAX_COOKIE_BYTES) {
    // confirm/plan are never truncated; a browser would silently drop an oversize cookie. Spec defect (R8): report.
    logger.error({ bytes: Buffer.byteLength(value) }, 'flash: cookie over budget even without keep');
  }

  (await cookies()).set(flashCookieName(), value, {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env['NODE_ENV'] === 'production',
    path: '/',
    maxAge: TTL_MS / 1000,
  });
  query.set('f', n);
  return redirect(`${path}?${query.toString()}${hash}`);
}

/**
 * `const sp = await withFlash(searchParams)`: the URL params with the flash and refills merged in,
 * flash first. Uses the flash only when signature, expiry and token all hold; otherwise it is as if
 * none existed. Never sets or deletes a cookie (a Server Component cannot).
 */
export async function withFlash<T extends object>(
  searchParams: Promise<T>,
  opts?: { getKeys?: readonly string[] },
): Promise<T & FlashFields> {
  const sp = stripFlashKeys(await searchParams, opts?.getKeys ?? []);
  const f = (sp as Record<string, unknown>).f;
  if (typeof f !== 'string' || !f) return sp as T & FlashFields;
  const raw = (await cookies()).get(flashCookieName())?.value;
  if (!raw) return sp as T & FlashFields;
  const payload = decodeFlash(raw);
  if (!payload || payload.exp <= Date.now() || payload.n !== f) return sp as T & FlashFields;
  return {
    ...sp,
    ...payload.msg,
    ...payload.keep,
    ...(payload.t ? { typed: payload.t } : {}),
    ...(payload.td ? { typedDropped: payload.td } : {}),
  } as T & FlashFields;
}

/**
 * R9 (T-380 S6): a flash or keep key that arrives in the URL is never honoured. A crafted `?error=` link must not
 * paint a banner and `?reason=` must not fill a box; only the signed cookie can. Everything else (nav keys, GET-filter
 * keys, `f`) passes through untouched.
 */
function stripFlashKeys<T extends object>(sp: T, allow: readonly string[]): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sp)) {
    if (allow.includes(k)) {
      out[k] = v;
      continue;
    }
    if ((FLASH_KEYS as readonly string[]).includes(k) || (KEEP_KEYS as readonly string[]).includes(k)) continue;
    if (k === 'typed' || k === 'typedDropped') continue; // T-389: only the signed cookie can carry a typed slot
    out[k] = v;
  }
  return out as T;
}

/**
 * Parse a form's `returnTo`: the pathname if it is a same-app path, plus only the nav keys that fit
 * their shapes. Anything else (off-site, `//`, backslash, absolute URL) returns the fallback path
 * and no nav. Fixes C2.
 */
export function splitReturnTo(raw: string, fallback = '/'): { path: string; nav: Nav } {
  if (typeof raw !== 'string' || CONTROL_CHARS.test(raw) || !/^\/(?![/\\])/.test(raw)) return { path: fallback, nav: {} };
  const hash = raw.indexOf('#');
  const noHash = hash === -1 ? raw : raw.slice(0, hash);
  const q = noHash.indexOf('?');
  const path = q === -1 ? noHash : noHash.slice(0, q);
  if (!isSameAppPath(path)) return { path: fallback, nav: {} };
  const nav: Nav = {};
  if (q !== -1) {
    for (const [k, v] of new URLSearchParams(noHash.slice(q + 1))) {
      if (isNavKey(k) && NAV_SHAPES[k].test(v)) nav[k] = v;
    }
  }
  return { path, nav };
}
