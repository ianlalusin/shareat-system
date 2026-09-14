/**
 * Credential crypto — PIN hashing, the org-scoped lookup key, and session tokens.
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
 * A million possibilities is not much. ⭐ **T-302/T-304 changed all three of the things that used
 * to make it acceptable, and the honest statement is the one below — not the one this comment
 * carried until 2026-09-14.** It said the lookup was store-scoped, the hash unique, and that
 * "rate limiting belongs at the sign-in route". The first is deliberately gone, the third was
 * never built where that sentence delegated it to, and only the second was ever true.
 *
 * | | Then | Now |
 * |---|---|---|
 * | Scope | **store**-scoped, so a PIN meant something only inside one store | ⛔ **ORG**-scoped (T-302). A PIN now means something across every branch of one business — **deliberately widened**, and it is what Ian asked for |
 * | Uniqueness | unique, so a check touches exactly one row | ✅ Unchanged, and now global within the org |
 * | Rate limiting | *"belongs at the sign-in route"* — **and nothing discharged that sentence for eleven months** | ✅ **Built.** T-303's per-store throttle, `pinAttemptsRepo`, checked before the lookup and the KDF |
 *
 * ⭐ **And the factor none of the three named, which is now the largest by far: T-304's layer 1.**
 * A PIN is no longer what gets anybody in. The terminal authenticates with its own Firebase
 * credential first, so a stranger cannot reach the PIN box at all — which is why widening the
 * scope from store to org is a convenience decision rather than a security regression.
 *
 * ⚠️ **The KDF cost is still doing less work here than everything around it.** That has not
 * changed; what changed is which things "around it" are real.
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
// The ORG-scoped lookup key
// -------------------------------------------------------------------------------------

/**
 * A deterministic, **organisation-scoped** key for finding the ONE credential a typed PIN could
 * belong to. T-302.
 *
 * ⭐ **`orgId`, not `storeId` — one PIN identifies one person at every branch.** Ian's ruling,
 * 2026-09-13, on the one number that decides it: *several staff work at more than one branch,
 * regularly.* The unique index on `lookup_hash` (`0137`) then enforces "one live PIN ⇒ one person"
 * across the whole business with no new constraint — two people in one org who pick the same six
 * digits produce the same hash and the second insert is refused.
 *
 * ⚠️ **After T-304 this is a CONVENIENCE ruling, not a security one, and the prose must not drift
 * back.** The terminal authenticates first, so a PIN no longer gets anybody in on its own; what
 * this buys is one set of six digits per person instead of one per branch.
 *
 * ⛔⛔ **NEVER a tenant-blind `HMAC(pin)` with no scope at all.** That makes the unique index a
 * cross-organisation oracle: an admin in one organisation learns that six digits are in use in
 * another, and repeated, enumerates the space — bible invariant 7. It is only ever tempting when
 * the org is unknown at lookup time, which is a symptom of PIN-FIRST sign-in. T-304's layer 1
 * hands us the org before the PIN is typed, so it is known here. **If you find yourself needing a
 * tenant-blind key, the thing to fix is the sign-in order, not the key** (T-304 §Q-org).
 *
 * ⚠️ **The `'pin-lookup'` label is unrelated to scoping and stays.** Domain separation is what
 * stops a lookup hash being usable as a session token.
 *
 * ⚠️ **This is a lookup key, not a verifier.** It narrows to one row; `verifyPin` then decides.
 * Deterministic means an attacker with the secret could compute it — which is why the secret is
 * required rather than defaulted, and why the row still holds a real KDF hash behind it.
 */
export function pinLookupHash(orgId: string, pin: string): string {
  return createHmac('sha256', derivedKey('pin-lookup')).update(`${orgId}:${pin}`).digest('hex');
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
