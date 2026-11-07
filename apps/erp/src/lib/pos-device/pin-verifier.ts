/**
 * T-526 R4 - the offline PIN verifier: PBKDF2-SHA256 over a per-verifier salt, made in the browser, kept only on the tablet.
 * Pure WebCrypto: no storage, no network, no logging. The PIN is never stored or sent anywhere.
 */

/**
 * Security constant, not a business setting: the current OWASP figure for PBKDF2-HMAC-SHA256 (210,000). A verifier made with fewer
 * is refused on both sides, so a weakened record cannot be planted. Raise it with the OWASP figure; old verifiers expire in a day.
 */
export const POS_VERIFIER_ITERATIONS = 210_000;
/** A stored record claiming more than this is refused unrun: a planted verifier must not be able to freeze the tablet with a huge PBKDF2 (about ten times the floor). */
export const POS_VERIFIER_MAX_ITERATIONS = 2_000_000;

const SALT_BYTES = 16;
const HASH_BITS = 256;

export interface PinVerifier {
  salt: string;
  hash: string;
  iterations: number;
}

const toBase64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pbkdf2(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, HASH_BITS);
  return new Uint8Array(bits);
}

export async function deriveVerifier(pin: string, opts: { iterations?: number } = {}): Promise<PinVerifier> {
  const iterations = opts.iterations ?? POS_VERIFIER_ITERATIONS;
  if (iterations < POS_VERIFIER_ITERATIONS) throw new Error(`pin verifier: iterations must be at least ${POS_VERIFIER_ITERATIONS}`);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return { salt: toBase64(salt), hash: toBase64(await pbkdf2(pin, salt, iterations)), iterations };
}

/** The XOR of every byte pair, so the loop never stops early; a length difference counts too. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i % (b.length || 1)] ?? 0); // `?? 0` is never taken inside the loop bound; it only satisfies noUncheckedIndexedAccess
  return diff === 0;
}

/** False, never a throw, for a wrong PIN, a verifier outside the iteration bounds, or a record that does not decode. */
export async function verifyPin(pin: string, v: PinVerifier): Promise<boolean> {
  if (!(v.iterations >= POS_VERIFIER_ITERATIONS && v.iterations <= POS_VERIFIER_MAX_ITERATIONS)) return false;
  try {
    return constantTimeEqual(await pbkdf2(pin, fromBase64(v.salt), v.iterations), fromBase64(v.hash));
  } catch {
    return false;
  }
}
