import { describe, it, expect } from 'vitest';
import { isScanValueCollision } from './scan-value-collision';
import { ATTENDANCE_CREDENTIALS_SCAN_VALUE_LIVE_UNIQUE } from '@shareat/db/schema';

/**
 * T-321/DEF-363 Contract 5/6 — unit-proves `isScanValueCollision`'s MATCHING LOGIC alone: given an
 * error-shaped object, does it correctly recognise Postgres unique-violation code `23505` paired
 * with one of the three constraint names the tolerant catch must still recognise.
 *
 * ⛔⛔ The two LEGACY names below are HARD-CODED LITERALS, deliberately, never imported from the
 * source's own `SCAN_VALUE_UNIQUE_CONSTRAINTS` Set — which stays unexported ON PURPOSE (ruling:
 * the orchestrator, from the tester's own BLOCKED report on the scratch-DB approach — not the
 * auditor, which raised the `prerequisite_refusals` pin, the file-boundary split, and the
 * legacy-name trigger, but was not party to this specific call). Importing that Set and iterating
 * it would make this test a TAUTOLOGY: it would keep passing after someone deleted a legacy name
 * from the Set, because the test's own "expected" value would shrink right along with it — which
 * is the exact rollback regression this test exists to catch. The test's job is to independently
 * PIN what the matcher must still recognise, not to describe whatever the matcher currently
 * happens to do.
 *
 * ⚠️⚠️ WHAT THIS TEST DOES NOT PROVE — read this before concluding the integration tests below are
 * redundant with this one and deleting them. This proves the MATCHER's logic against hand-built
 * error shapes. It CANNOT prove that Postgres and postgres-js actually populate a real violation's
 * `constraint_name` field with these exact strings — that half is only proven by exercising a REAL
 * collision through the real domain functions against a REAL database:
 *   legacy CARD name  → attendance-credentials.test.ts:169-173, run against a pre-0153 database
 *   legacy TOKEN name → attendance-credentials-fingerprint-token-collision.test.ts
 *   new name          → the cross-column test, once migration 0153 lands in release N+1
 * ⛔⛔ THAT COVERAGE IS PRE-0153 ONLY, AND IT INVERTS THE MOMENT 0153 LANDS — do not read this as a
 * standing property. Once N+1 ships, both legacy indexes are DROPPED: the two tests named above
 * for the legacy names will then raise the NEW constraint name instead, and neither legacy name
 * will be exercised against a real database by anything at all — you cannot exercise a dropped
 * index. Post-0153, the honest answer to "what still proves these two legacy names are needed?"
 * is: nothing at the integration level; only the hand-built shapes in THIS file, plus the
 * rollback argument itself. T-322 (which removes the legacy names for good) carries the same note
 * and must update this file in the same commit it deletes them from the source Set.
 */
const uniqueViolation = (constraintName: string) => ({ code: '23505', constraint_name: constraintName });

describe('isScanValueCollision — the tolerant catch matches by CODE plus a pinned set of names', () => {
  it('matches the NEW constant name', () => {
    expect(isScanValueCollision(uniqueViolation(ATTENDANCE_CREDENTIALS_SCAN_VALUE_LIVE_UNIQUE))).toBe(true);
  });

  it('matches the legacy CARD index name — historical, tolerated for rollback, not canonical', () => {
    expect(isScanValueCollision(uniqueViolation('attendance_credentials_card_live_unique'))).toBe(true);
  });

  it('matches the legacy TOKEN index name — historical, tolerated for rollback, not canonical', () => {
    expect(isScanValueCollision(uniqueViolation('attendance_credentials_token_live_unique'))).toBe(true);
  });

  it('does NOT match the right code paired with an unrelated constraint name', () => {
    expect(isScanValueCollision(uniqueViolation('some_other_table_unrelated_unique'))).toBe(false);
  });

  it('does NOT match a different Postgres error code, even with a recognised constraint name', () => {
    expect(
      isScanValueCollision({ code: '23503', constraint_name: ATTENDANCE_CREDENTIALS_SCAN_VALUE_LIVE_UNIQUE }),
    ).toBe(false);
  });

  it('does NOT match non-error-shaped values', () => {
    expect(isScanValueCollision(null)).toBe(false);
    expect(isScanValueCollision('a plain string')).toBe(false);
    expect(isScanValueCollision({ code: '23505' })).toBe(false); // no constraint_name at all
  });
});
