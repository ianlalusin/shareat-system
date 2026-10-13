import { describe, expect, it } from 'vitest';
// ⚠️ ONE module, not the `@shareat/auth` barrel — and `capabilities.ts` specifically, which
// imports nothing at all. The barrel re-exports `sessions.ts`, and `roles.ts` imports
// `@shareat/db`; either route costs ~2 s of schema import to run 4 ms of assertions about two
// constants. ⭐ Measured, not assumed: deep-importing `roles.ts` moved it 1.94 s → 2.03 s, i.e.
// nothing, which is what sent the constant to this file in the first place.
import { CAPABILITIES, CAPABILITY_MATRIX, SUPER_ADMIN_ONLY_CAPABILITIES } from '../src/capabilities';

/**
 * ⛔ **A PIN, not a description — T-232 slice 2, lane C's finding F2.**
 *
 * `SUPER_ADMIN_ONLY_CAPABILITIES` is derived from `CAPABILITY_MATRIX`, so the *set* is always
 * current. The **grants** it produces are not: `createFirstAdmin` materialises them as
 * `person_grants` rows, once, at the moment an organisation is created. So the equivalence
 * *"admin + these grants authorizes exactly what super_admin authorizes"* is a statement about
 * creation time, and a later matrix change silently breaks it for everyone already created —
 * no error, no failing test, just a refusal on a screen months afterwards.
 *
 * ⭐ **This test is how that day arrives loudly.** It is a unit test on purpose: it reads the
 * matrix and a derived constant, touches no database, and therefore runs in `npm run test`, which
 * CI runs before migrations are applied.
 *
 * ⚠️ **The list below is hand-written, and that is the one place in this codebase where hand-
 * writing it is correct.** Everywhere else the set is derived so it cannot drift; here the whole
 * point is to notice that it drifted.
 */

/**
 * The six members, sorted. Four as of 2026-09-08; T-382 (2026-10-08) adds `unlink_store_from_pos`, WITH the
 * backfill in migration 0187 (R6a) in the same slice; T-385 S3 (2026-10-09) adds `verify_own_sales_day`, WITH the
 * backfill in migration 0188; T-401 (2026-10-13) adds `add_menu_item`, WITH the backfill in migration 0196 (B0196, tested by
 * packages/db/tests/integration/t401-s1-add-menu-item-backfill.test.ts). ⛔ Do not update this to make the test pass.
 */
const PINNED = ['add_menu_item', 'approve_item', 'cross_org_access', 'post_journal_entry', 'unlink_store_from_pos', 'verify_own_sales_day', 'view_franchise_sales'];

const WHAT_TO_DO =
  'A capability was added to or removed from the super_admin-only set.\n\n' +
  '⛔ Write a BACKFILL for existing owners\' person_grants (and a REVOCATION, for a removal)\n' +
  'BEFORE updating this list. Those grants were materialised once, at createFirstAdmin, so\n' +
  'every organisation created before today is now missing the new capability — or still holds\n' +
  'a revoked one, which is worse: a live authority nobody decided to give.\n\n' +
  'See packages/domain/src/organizations/index.ts (createFirstAdmin) and T-232 §2.2.';

describe('SUPER_ADMIN_ONLY_CAPABILITIES — pinned, because the grants are materialised', () => {
  it('is exactly the seven capabilities existing owners must hold (four granted at creation, the fifth backfilled by 0187, the sixth by 0188, the seventh by 0196)', () => {
    expect([...SUPER_ADMIN_ONLY_CAPABILITIES].sort(), WHAT_TO_DO).toEqual(PINNED);
  });

  it('still matches the matrix it claims to be derived from', () => {
    // ⚠️ The pin above would happily pass against a hand-listed constant that had stopped being a
    // derivation at all. This is the other half: every member really is super_admin-only, and no
    // super_admin-only capability is missing from it.
    const derived = CAPABILITIES.filter(
      (c) => CAPABILITY_MATRIX[c].super_admin && !CAPABILITY_MATRIX[c].admin,
    );
    expect([...SUPER_ADMIN_ONLY_CAPABILITIES].sort()).toEqual([...derived].sort());
  });

  it('is non-empty — an empty set makes every "holds all of them" check vacuously true', () => {
    // `holdsSuperAdminAuthority` refuses on an empty set rather than admitting everyone, and this
    // is the assertion that says the refusal is a safety net rather than the live path.
    expect(SUPER_ADMIN_ONLY_CAPABILITIES.length).toBeGreaterThan(0);
  });

  it('no capability is admin-true and super_admin-false — the equivalence depends on it', () => {
    // ⭐ The claim "admin + this set = super_admin" is only true because admin's capabilities are a
    // SUBSET of super_admin's. If one ever were not, the first admin would hold something the
    // equivalence never accounted for and `assignRoleAsActor`'s widened check would be wrong.
    const adminOnly = CAPABILITIES.filter(
      (c) => CAPABILITY_MATRIX[c].admin && !CAPABILITY_MATRIX[c].super_admin,
    );
    expect(adminOnly).toEqual([]);
  });
});
