import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CAPABILITY_MATRIX,
  CAPABILITY_SCOPE,
  SUPER_ADMIN_ONLY_CAPABILITIES,
  type Capability,
} from '../../packages/auth/src/capabilities';
import { GRANT_SOURCE_RANK, grantSourceRank, type GrantSource } from '../../packages/db/src/repo/access';
import { OFFERABLE_TO_POSITIONS } from '../../packages/domain/src/people/position-defaults';
import { EVERYDAY_CAPABILITIES } from '../../packages/domain/tests/integration/_fixtures/staff-everyday-access';

/**
 * T-289 §C10, §C4, §C5 — no database. `docs/tasks/289-position-access-defaults-spine.md`.
 *
 * `OFFERABLE_TO_POSITIONS` and `GRANT_SOURCE_RANK` are both pure derivations; the ROW-LEVEL
 * effect of a rank transition (does `person_grants` actually get rewritten) is proven in
 * `packages/domain/tests/integration/position-defaults.test.ts` against real Postgres — this
 * file only pins the logic those integration cases lean on.
 */

describe('OFFERABLE_TO_POSITIONS — derived, not hand-listed', () => {
  it('OFFERABLE_TO_POSITIONS is derived, not hand-listed — the three excluded sets, by construction', () => {
    for (const c of SUPER_ADMIN_ONLY_CAPABILITIES) {
      expect(OFFERABLE_TO_POSITIONS, `${c} is SUPER_ADMIN_ONLY and must not be offerable`).not.toContain(c);
    }

    const platformCapabilities = CAPABILITIES.filter((c) => CAPABILITY_SCOPE[c] === 'platform');
    for (const c of platformCapabilities) {
      expect(OFFERABLE_TO_POSITIONS, `${c} is platform-scoped and must not be offerable`).not.toContain(c);
    }

    expect(OFFERABLE_TO_POSITIONS).not.toContain('close_period');
    // T-344/DEF-422 (R1.3): `create_missing_period` changes closed books like `close_period` and
    // `override_period_lock` — admin/super_admin only, never offerable to a position.
    expect(OFFERABLE_TO_POSITIONS).not.toContain('create_missing_period');
    // T-345 §3.4: `book_missed_month` is the same shape — admin/super_admin only, never
    // offerable to a position. ⛔ RED until the builder adds it; today this assertion passes
    // vacuously (the string is absent because the capability does not exist yet), but the
    // "every OTHER capability must be present" loop below is what actually pins it, once it exists.
    expect(OFFERABLE_TO_POSITIONS).not.toContain('book_missed_month' as Capability);

    // Every OTHER capability must be present — the five exclusions above are the ONLY ones.
    const excluded = new Set<Capability>([
      ...SUPER_ADMIN_ONLY_CAPABILITIES,
      ...platformCapabilities,
      'close_period',
      'create_missing_period',
      'book_missed_month' as Capability,
    ]);
    for (const c of CAPABILITIES) {
      if (!excluded.has(c)) {
        expect(OFFERABLE_TO_POSITIONS, `${c} should be offerable — it is in none of the three excluded sets`).toContain(c);
      }
    }

    // DEF-179 — a floor so an empty (or accidentally over-narrow) derivation cannot pass silently.
    expect(OFFERABLE_TO_POSITIONS.length).toBeGreaterThan(50);
  });
});

describe('GRANT_SOURCE_RANK — elevation < position < grant = owner, null ranks as elevation', () => {
  it('GRANT_SOURCE_RANK orders elevation < position < grant = owner, and null ranks as elevation', () => {
    expect(GRANT_SOURCE_RANK.elevation).toBe(0);
    expect(GRANT_SOURCE_RANK.position).toBe(1);
    expect(GRANT_SOURCE_RANK.grant).toBe(2);
    expect(GRANT_SOURCE_RANK.owner).toBe(2);
    expect(grantSourceRank(null)).toBe(GRANT_SOURCE_RANK.elevation);
  });

  /**
   * §C5's four transitions, asserted against the idempotent branch's own rule
   * (`grantCapability` rewrites `grant_source` only when `incoming rank > stored rank`).
   * The ROW-level effect (does the UPDATE actually run, is `source_ref` written) is
   * integration case 3/5/6's job; this pins the boolean the branch decides on.
   */
  const rewrites = (stored: GrantSource | null, incoming: GrantSource) => grantSourceRank(incoming) > grantSourceRank(stored);

  it("transition 1 — stored 'position', incoming 'grant' ⇒ REWRITE (upgrade; ref kept)", () => {
    expect(rewrites('position', 'grant')).toBe(true);
  });

  it("transition 2 — stored 'grant' or 'owner', incoming 'position' ⇒ NO rewrite (never demoted)", () => {
    expect(rewrites('grant', 'position')).toBe(false);
    expect(rewrites('owner', 'position')).toBe(false);
  });

  it("transition 3 — stored 'elevation' or null, incoming 'position' ⇒ REWRITE (superseded; ref written)", () => {
    expect(rewrites('elevation', 'position')).toBe(true);
    expect(rewrites(null, 'position')).toBe(true);
  });

  it("transition 4 — stored 'position', incoming 'position' (different ref) ⇒ NO rewrite (one row, one ref)", () => {
    expect(rewrites('position', 'position')).toBe(false);
  });
});

describe('T-318 — OFFERABLE_TO_POSITIONS is unaffected by the staff-matrix flip', () => {
  it('no capability is CAPABILITY_MATRIX[c].staff === true any more — the second check T-318 deleted', () => {
    // Before T-318, this described block proved "the staff-matrix set is 21, and it is NOT
    // removed from OFFERABLE_TO_POSITIONS despite a SEPARATE refusal in setPositionDefault —
    // two checks, not one" (§C10). T-318 (docs/tasks/318-position-decides-access.md Contract 1)
    // deleted that second check and flipped every one of the 21 to staff: false, so "the
    // staff-matrix set" can no longer be DERIVED from CAPABILITY_MATRIX — it is empty by
    // design now (position-defaults.test.ts's Contract-2 case proves the refusal itself is
    // gone). Pin that emptiness here explicitly, once, so nobody re-derives a stale 21 from
    // the matrix again by accident.
    expect(CAPABILITIES.filter((c) => CAPABILITY_MATRIX[c].staff)).toEqual([]);
  });

  it('Contract 3 — the 21 are still fully offerable; this derivation was never keyed on role', () => {
    // "The 21" now lives only as the named list T-318's own fixture helper carries (the
    // single place a caller needs it — its own header comment) — reusing it here instead of
    // hand-copying a second list, which is the exact drift T-317 invariant 6 exists to stop.
    expect(EVERYDAY_CAPABILITIES.length).toBe(21); // floor: an emptied import must not pass silently
    for (const c of EVERYDAY_CAPABILITIES) {
      expect(
        OFFERABLE_TO_POSITIONS,
        `${c} moved off the staff matrix onto position grants but must still be OFFERABLE — ` +
          'this derivation excludes only SUPER_ADMIN_ONLY, platform-scope and close_period, never a role',
      ).toContain(c);
    }
  });
});
