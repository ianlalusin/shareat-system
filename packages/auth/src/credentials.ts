/**
 * Credential crypto — PIN hashing, the store-scoped lookup key, and session tokens.
 * docs/tasks/138-identity-and-sessions.md §3.2, bible §7.1.
 *
 * ## ⛔ Everything here is keyed by a secret that MUST exist
 *
 * `SESSION_SECRET` is `requiredSecret(32)` in `packages/core/src/env.ts` — **no default, no
 * fallback, and a missing value aborts startup** (bible §7 rule 9). That is the whole answer to
 * DEF-062, where v1 falls back to a key hardcoded in its own source, logs an error, and carries
 * on: *"anyone could forge a passcodeLookupHash."*
 *
 * > **A control whose degraded mode is a publicly-known key is not degraded, it is off.**
 *
 * ## No native dependency, deliberately
 *
 * PIN verification uses **`node:crypto`'s scrypt**, not bcrypt. Two reasons: bcrypt is a native
 * module, and native modules are a known trap in this stack (bible §12 — Next.js server bundling
 * of native deps, `serverExternalPackages`); and scrypt is a memory-hard KDF that is at least as
 * appropriate for a 6-digit secret. **One less thing that can fail to build on a different
 * machine.**
 *
 * ## ⚠️ A 6-digit PIN is a weak secret, and the design has to admit that
 *
 * A million possibilities is not much. What makes it acceptable is everything around it: the
 * lookup is **store-scoped** so a PIN only means anything inside one store, the hash is **unique**
 * so a check touches exactly one row, and rate limiting belongs at the sign-in route.
 * **The KDF cost is doing less work here than the scoping is.**
 */
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { env } from '@shareat/core/env';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEY_BYTES = 64;
const SALT_BYTES = 16;

/**
 * Domain-separated key derivation from the one secret.
 *
 * ⭐ **One secret, several purposes, and they must not be interchangeable.** A token signed with
 * the same key that produces lookup hashes would let one be used as the other. The label is what
 * keeps them apart, and it is cheaper and less error-prone than a second environment variable
 * somebody will forget to set — which is exactly how DEF-062's secret came to be unset.
 */
function derivedKey(label: 'pin-lookup' | 'session-token' | 'setup-identity'): string {
  return createHmac('sha256', env().SESSION_SECRET).update(`shareat:${label}:v1`).digest('hex');
}

// -------------------------------------------------------------------------------------
// The store-scoped lookup key
// -------------------------------------------------------------------------------------

/**
 * A deterministic, store-scoped key for finding the ONE credential a typed PIN could belong to.
 *
 * ⭐ **Store scoping is v1's own good idea and it survives unchanged** — *"so the same passcode in
 * different stores never correlates."* Two cashiers in different branches may both use 123456 and
 * neither hash reveals it.
 *
 * ⚠️ **This is a lookup key, not a verifier.** It narrows to one row; `verifyPin` then decides.
 * Deterministic means an attacker with the secret could compute it — which is why the secret is
 * required rather than defaulted, and why the row still holds a real KDF hash behind it.
 */
export function pinLookupHash(storeId: string, pin: string): string {
  return createHmac('sha256', derivedKey('pin-lookup')).update(`${storeId}:${pin}`).digest('hex');
}

// -------------------------------------------------------------------------------------
// PIN verification
// -------------------------------------------------------------------------------------

/** `scrypt$<saltHex>$<keyHex>` — self-describing, so a future parameter change can be detected
 *  rather than silently mis-verified. */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(pin, salt, SCRYPT_KEY_BYTES);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

/**
 * Constant-time compare against ONE stored hash.
 *
 * ⚠️ **Takes a single hash on purpose.** v1's `matchLegacyPasscode` iterates bcrypt over every
 * candidate, which is O(n) hashing per attempt and leaks timing proportional to how far down the
 * list the match sits. Here the caller has already narrowed to one row via `pinLookupHash`, so
 * this runs exactly once (T-138 invariant 5).
 */
export async function verifyPin(pin: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1]!, 'hex');
  const expected = Buffer.from(parts[2]!, 'hex');
  if (expected.length !== SCRYPT_KEY_BYTES) return false;

  const actual = await scrypt(pin, salt, SCRYPT_KEY_BYTES);
  return timingSafeEqual(actual, expected);
}

// -------------------------------------------------------------------------------------
// Session tokens
// -------------------------------------------------------------------------------------

/** 32 random bytes. **Opaque** — it carries no claims, so nothing about it can be tampered with
 *  or read; every fact about a session is looked up server-side from its row. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * What we STORE for a token. ⚠️ The token itself is returned once, at issue, and never persisted:
 * **a sessions table readable by an operator must not be a table of live credentials.**
 *
 * A keyed HMAC rather than a bare SHA — with a bare digest, anyone who obtained the table could
 * confirm a guessed token offline. Cheap (tokens are already high-entropy, so no KDF is needed),
 * and it removes that.
 */
export function sessionTokenHash(token: string): string {
  return createHmac('sha256', derivedKey('session-token')).update(token).digest('hex');
}

// -------------------------------------------------------------------------------------
// The first-run setup identity
// -------------------------------------------------------------------------------------

/**
 * Signs the setup-identity payload that carries a **verified** Firebase uid from `/sign-in` to
 * `/setup`. T-232 §2.4.
 *
 * ⭐ **It lives here, not in `apps/erp`, for one reason: the key.** A bare
 * `createHmac('sha256', SESSION_SECRET)` in the app layer would sign with the same key that
 * produces session-token hashes, and two things signed with one key can be used as each other.
 * `derivedKey('setup-identity')` is the domain separation this module's header already argues for
 * — *"One secret, several purposes, and they must not be interchangeable."*
 *
 * ⚠️ **This proves origin, not authority.** What it signs is a name Firebase already vouched for;
 * what may be DONE with that name is decided by `bootstrapOrganization`'s zero-organization
 * refusal, which is a database fact and cannot be forged at all. A signature is the wrong place
 * to put a permission.
 *
 * The caller passes the already-encoded payload segment rather than an object, so the bytes that
 * are signed are exactly the bytes that are read back — no re-serialisation between the two, and
 * therefore no way for a key ordering or a JSON escape to change the message under the signature.
 */
export function signSetupIdentity(encodedPayload: string): string {
  return createHmac('sha256', derivedKey('setup-identity')).update(encodedPayload).digest('base64url');
}

/**
 * Constant-time verification of {@link signSetupIdentity}.
 *
 * ⚠️ Returns false rather than throwing for a malformed signature: the caller answers absent,
 * expired, malformed and tampered with the same `null`, and an exception here would make one of
 * the four loud for no reason a user could act on.
 */
export function setupIdentitySignatureMatches(encodedPayload: string, signature: string): boolean {
  const expected = Buffer.from(signSetupIdentity(encodedPayload), 'base64url');
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || actual.length === 0) return false;
  return timingSafeEqual(actual, expected);
}

/** Constant-time equality for two hex digests of equal length. */
export function hashesMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/** A 6-digit PIN, and nothing else. Rejected early so a weak or malformed value never reaches
 *  the KDF — and so "0" and "000000" are not quietly the same credential. */
export function isValidPinFormat(pin: string): boolean {
  return /^\d{6}$/.test(pin);
}
