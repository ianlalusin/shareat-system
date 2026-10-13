/**
 * T-402 S1b (R5) - redaction at the writer, always, by key TOKENS.
 *
 * Each key is split into lower-case tokens on camelCase boundaries, `_` and `-` (`pinHash` -> `pin`,`hash`;
 * `API_KEY` -> `api`,`key`). A key is a secret when any token is in SECRET_TOKENS, or when two adjacent tokens
 * are one of SECRET_PAIRS. A secret's value (whatever its type; only null/undefined are left alone) becomes
 * `[REDACTED]` and its dot path is reported. Independently of the key, a string that looks like a scrypt hash, a
 * JWT or a session token is redacted. A key whose LAST two tokens are `account`,`number` is MASKED, not
 * redacted: it keeps its last 4 characters (`••••1234`), and when the caller gives the other side of the change
 * (`compareWith`) a sibling `<key>Changed` boolean says whether the UNMASKED values differed.
 *
 * Pure (no imports): the unit tests run before any migration. Returns a COPY; the input is never mutated.
 */
export const REDACTED = '[REDACTED]';

const SECRET_TOKENS: ReadonlySet<string> = new Set([
  'password',
  'passcode',
  'pin',
  'secret',
  'token',
  'otp',
  'hash',
  'salt',
  'scrypt',
  'cookie',
  'authorization',
  'jwt',
  'pwd',
  'passwd',
  'cvv',
  'apikey',
]);
const SECRET_PAIRS: ReadonlySet<string> = new Set(['api+key', 'private+key', 'session+id', 'refresh+token', 'access+key', 'card+number']);

/** Lower-case tokens of a key: camelCase boundaries, `_`, `-` and whitespace separate them. */
export function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter((t) => t.length > 0)
    .map((t) => t.toLowerCase());
}

export function isSecretKey(key: string): boolean {
  const t = keyTokens(key);
  if (t.some((x) => SECRET_TOKENS.has(x))) return true;
  if (t.length === 1 && t[0] === 'session') return true; // a bare `session` (a token); sessionStart etc. are not
  for (let i = 0; i + 1 < t.length; i++) {
    if (SECRET_PAIRS.has(`${t[i]}+${t[i + 1]}`)) return true;
  }
  return false;
}

function isAccountNumberKey(key: string): boolean {
  const t = keyTokens(key);
  return t.length >= 2 && t[t.length - 2] === 'account' && t[t.length - 1] === 'number';
}

const SCRYPT_SHAPE = /scrypt\$/;
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/;
const BEARER_SHAPE = /^Bearer\s+\S/;
const SESSION_TOKEN_SHAPE = /^sess(?:ion)?[_-][A-Za-z0-9_-]{16,}$/i;

function secretShapedString(s: string): boolean {
  return SCRYPT_SHAPE.test(s) || JWT_SHAPE.test(s) || BEARER_SHAPE.test(s) || SESSION_TOKEN_SHAPE.test(s);
}

export interface RedactOptions {
  /** The OTHER side's unmasked payload. When the property is present, a masked key K also gets `KChanged`. */
  readonly compareWith?: unknown;
}
export interface RedactResult {
  readonly value: unknown;
  readonly redactedKeys: string[];
}

function mask(v: unknown): unknown {
  if (v === null || v === undefined) return v ?? null;
  return `••••${String(v).slice(-4)}`;
}

/** An account-number key holding an array or object: every leaf is masked, nothing is left whole. */
function maskDeep(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(maskDeep);
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, maskDeep(x)]));
  return mask(v);
}

function changedFlagName(key: string): string {
  return key.includes('_') ? `${key}_changed` : `${key}Changed`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function walk(value: unknown, path: string, other: unknown, hasOther: boolean, out: string[]): unknown {
  if (typeof value === 'string') return secretShapedString(value) ? (out.push(path), REDACTED) : value;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    return value.map((x, i) => walk(x, path === '' ? String(i) : `${path}.${i}`, Array.isArray(other) ? other[i] : undefined, hasOther, out));
  }
  const src = value as Record<string, unknown>;
  const otherObj = isPlainObject(other) ? other : undefined;
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    const p = path === '' ? k : `${path}.${k}`;
    if (v === undefined) continue;
    if (isSecretKey(k)) {
      if (v === null) copy[k] = null;
      else {
        copy[k] = REDACTED;
        out.push(p);
      }
    } else if (isAccountNumberKey(k)) {
      copy[k] = maskDeep(v);
      if (hasOther && (v === null || typeof v === 'string' || typeof v === 'number')) {
        const o = otherObj ? otherObj[k] : undefined;
        copy[changedFlagName(k)] = String(v ?? '') !== String(o ?? '');
      }
    } else {
      copy[k] = walk(v, p, otherObj ? otherObj[k] : undefined, hasOther, out);
    }
  }
  return copy;
}

export function redactPayload(value: unknown, opts: RedactOptions = {}): RedactResult {
  const redactedKeys: string[] = [];
  const hasOther = 'compareWith' in opts;
  const out = walk(value, '', opts.compareWith, hasOther, redactedKeys);
  return { value: out, redactedKeys };
}
