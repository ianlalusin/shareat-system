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

    // Every OTHER capability must be present — the three sets above are the ONLY exclusions.
    const excluded = new Set<Capability>([...SUPER_ADMIN_ONLY_CAPABILITIES, ...platformCapabilities, 'close_period']);
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

describe('the staff-matrix set and OFFERABLE_TO_POSITIONS are two checks, not one', () => {
  it('the staff-matrix set is 21 and is NOT removed from OFFERABLE_TO_POSITIONS', () => {
    const staffMatrixCapabilities = CAPABILITIES.filter((c) => CAPABILITY_MATRIX[c].staff);
    expect(staffMatrixCapabilities.length).toBe(21);
    for (const c of staffMatrixCapabilities) {
      expect(
        OFFERABLE_TO_POSITIONS,
        `${c} is staff-matrix but must still be RENDERABLE (shown as inherited, not hidden) — ` +
          'the derived constant and the separate staff-matrix refusal in setPositionDefault are two checks',
      ).toContain(c);
    }
  });
});
