import { describe, expect, it } from 'vitest';
import { REQUIRED_PUBLIC_ENV_KEYS } from '../src/env';

/**
 * T-259/DEF-235 — pins `REQUIRED_PUBLIC_ENV_KEYS`, the list the deploy preflight
 * (`scripts/deploy-preflight.ts`) trusts to know which `NEXT_PUBLIC_FIREBASE_*` values are
 * required.
 *
 * ⛔ This is not a style test. `REQUIRED_PUBLIC_ENV_KEYS` is derived from `publicSchema` via
 * `.isOptional()` — sound, but if that derivation ever returns nothing (a schema refactor that
 * makes every field report optional, a typo in the filter), the preflight built on top of it
 * checks nothing and exits 0. Green, forever. A test that only asserts "the array is non-empty"
 * would not catch a field silently falling out of it, so this pins the exact set.
 */
describe('REQUIRED_PUBLIC_ENV_KEYS', () => {
  it('⭐ is exactly the three identity keys signInWithEmailAndPassword needs — not empty, not everything', () => {
    expect([...REQUIRED_PUBLIC_ENV_KEYS].sort()).toEqual([
      'NEXT_PUBLIC_FIREBASE_API_KEY',
      'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
      'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
    ]);
  });

  it('does NOT include the two blankAsAbsent() keys', () => {
    expect(REQUIRED_PUBLIC_ENV_KEYS).not.toContain('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET');
    expect(REQUIRED_PUBLIC_ENV_KEYS).not.toContain('NEXT_PUBLIC_FIREBASE_APP_ID');
  });
});
