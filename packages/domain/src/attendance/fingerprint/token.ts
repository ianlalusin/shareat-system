/**
 * Match-token minting for a fingerprint credential. T-314 slice A.
 *
 * ⛔ THE TOKEN IS MINTED, NEVER DERIVED FROM THE TEMPLATE. A hash of the template would make the
 * credential unrotatable — a person cannot rotate a finger. v1's own M5 fix (carried over here)
 * exists precisely so a leaked or device-cached token can be invalidated by re-enrolment; only
 * randomness independent of the finger can be invalidated that way. See
 * `docs/tasks/314-fingerprint-capture-import.md` invariant 2.
 */

const TOKEN_BYTES = 16;

/**
 * 16 random bytes as 32 lowercase hex characters — v1's `generateFingerprintMatchToken`, same
 * shape. Uses Web Crypto (`globalThis.crypto`), not node's `crypto` module: this file is consumed
 * by both a server path (enrolment) and a client path (the clock terminal, via
 * `buildReaderEntries`/`planArm`/`poolFor` elsewhere in this directory), and `globalThis.crypto`
 * is the one RNG both environments provide.
 */
export function generateMatchToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const MAX_MINT_ATTEMPTS = 12;

/**
 * Retry until a candidate nothing already holds. `isTaken` is injected so this stays a pure,
 * DB-free module — the caller supplies whatever "does this org already have a live credential
 * with this token" check it has access to.
 *
 * ⚠️ v1 drew up to 12 candidates (`attendance-fingerprint.actions.ts:70`) and never specified what
 * happens on the 13th. Here: throw, loudly. At 128 bits of randomness, exhausting every draw means
 * a broken RNG or a broken `isTaken`, not bad luck — a caller inserting an empty/undefined token
 * because nothing threw would be a worse failure than a refused enrolment.
 */
export async function mintUniqueToken(
  isTaken: (token: string) => Promise<boolean>,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
    const candidate = generateMatchToken();
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error(
    `mintUniqueToken: exhausted ${MAX_MINT_ATTEMPTS} candidates without finding a store-unique token`,
  );
}
