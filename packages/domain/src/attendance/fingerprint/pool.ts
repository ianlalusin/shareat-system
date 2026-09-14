import { buildReaderEntries } from './core';

// Which fingerprints the native matcher should be holding at any moment. Ported from v1's
// fingerprint-pool.ts (T-314 slice A). v1's `localUserId` is renamed `employmentId` — v2's actual
// domain concept, matching `MirroredCredential.employmentId` and the schema's `employment_id`; v1's
// Firestore local-user id has no v2 equivalent. `poolFor` is new, added as the slice A contract's
// single dispatch entry point over the two pools below.
//
// The terminal used to load EVERY enrolled staffer and 1:N search that whole set
// for every action. Two problems: the pool only grows, and a 1:N match at
// MATCH_THRESHOLD=70 can return the wrong person.
//
// Now the matcher holds only the people who could plausibly be pressing:
//   - idle           → staff who are NOT on shift (the only ones who can clock IN),
//                      so the pool shrinks as a shift fills
//   - a row tapped   → exactly ONE person, which makes the press a 1:1
//                      VERIFICATION rather than a search
//
// A one-entry DB is how 1:1 verify is achieved without touching the native
// plugin: ZKFingerService.verify exists but is not exposed over the bridge, and
// adding it would force an APK rebuild, re-sign and reinstall on every device.
// loadDb + identify over a single candidate has the same false-accept
// characteristics and ships as ordinary web code.

export interface FingerprintCredential {
  employmentId: string;
  matchToken: string;
  templates: string[];
}

/** Staff who can clock IN: enrolled, and not already on shift. */
export function loggedOutPool(
  all: FingerprintCredential[],
  onShiftEmploymentIds: Iterable<string>,
): FingerprintCredential[] {
  const onShift = new Set(onShiftEmploymentIds);
  return all.filter((c) => !onShift.has(c.employmentId));
}

/** The single candidate behind a tapped roster row, or null when that staffer
 *  has no fingerprint enrolled (they must fall back to passcode/NFC). */
export function soloPool(
  all: FingerprintCredential[],
  employmentId: string,
): FingerprintCredential[] | null {
  const one = all.find((c) => c.employmentId === employmentId);
  return one ? [one] : null;
}

/** Native matcher entries for a set of credentials. */
export function poolEntries(pool: FingerprintCredential[]) {
  return buildReaderEntries(pool.map((c) => ({ matchToken: c.matchToken, templates: c.templates })));
}

/** What the matcher currently holds, so an arm can skip reloading an identical
 *  pool. Order-independent — the caller builds pools by filtering, and a
 *  reordered but identical set is not worth a bridge round trip. */
export function poolKey(pool: FingerprintCredential[]): string {
  return pool.map((c) => c.employmentId).sort().join(',');
}

/** Which pool a given arm needs: everyone not on shift, or one tapped candidate. */
export type PoolMode =
  | { kind: 'loggedOut'; onShiftEmploymentIds: Iterable<string> }
  | { kind: 'solo'; employmentId: string };

/** Single dispatch entry point over `loggedOutPool` / `soloPool` — the pair does the real work. */
export function poolFor(
  mode: PoolMode,
  all: FingerprintCredential[],
): FingerprintCredential[] | null {
  return mode.kind === 'loggedOut' ? loggedOutPool(all, mode.onShiftEmploymentIds) : soloPool(all, mode.employmentId);
}
