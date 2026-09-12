import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CAPABILITY_MATRIX,
  CAPABILITY_SCOPE,
  SUPER_ADMIN_ONLY_CAPABILITIES,
  type Capability,
} from '@shareat/auth';
import {
  SCOPE_ORDER,
  bannerMessage,
  bulkBannerMessage,
  copyableDefaults,
  gridCapabilityGroups,
} from '../src/app/admin/access-defaults/lib';

/**
 * T-290 §T1. The PURE decisions only — no database — mirroring `admin-users-lib.test.ts`'s shape.
 * `docs/tasks/290-access-defaults-screen.md`.
 *
 * ⚠️ The three excluded sets are computed here directly from `@shareat/auth`'s own exports ON
 * PURPOSE, even though `lib.ts` now imports the domain's `OFFERABLE_TO_POSITIONS`: a test that
 * imported the same constant would only prove the grid equals itself. Deriving the expectation
 * independently proves the grid agrees with the RULE (T-289 §C10), which is what
 * `tests/unit/position-defaults-offerable.test.ts` pins on the domain side.
 */

describe('gridCapabilityGroups — exactly the offerable set, grouped by CAPABILITY_SCOPE', () => {
  const groups = gridCapabilityGroups();
  const rendered = groups.flatMap((g) => g.capabilities.map((c) => c.capability));

  it('the grouping keys are store / org / platform, in that order', () => {
    expect(groups.map((g) => g.scope)).toEqual([...SCOPE_ORDER]);
    expect(SCOPE_ORDER).toEqual(['store', 'org', 'platform']);
  });

  it('the three excluded sets (T-289 §C10) are absent from every group', () => {
    for (const c of SUPER_ADMIN_ONLY_CAPABILITIES) {
      expect(rendered, `${c} is SUPER_ADMIN_ONLY and must not be rendered at all`).not.toContain(c);
    }
    const platformCapabilities = CAPABILITIES.filter((c) => CAPABILITY_SCOPE[c] === 'platform');
    for (const c of platformCapabilities) {
      expect(rendered, `${c} is platform-scoped and must not be rendered at all`).not.toContain(c);
    }
    expect(rendered).not.toContain('close_period');
  });

  it('every capability outside the three excluded sets IS rendered, exactly once', () => {
    const platformCapabilities = new Set(CAPABILITIES.filter((c) => CAPABILITY_SCOPE[c] === 'platform'));
    const excluded = new Set<Capability>([...SUPER_ADMIN_ONLY_CAPABILITIES, ...platformCapabilities, 'close_period']);
    for (const c of CAPABILITIES) {
      if (excluded.has(c)) continue;
      const hits = rendered.filter((r) => r === c);
      expect(hits.length, `${c} should appear exactly once across the groups`).toBe(1);
    }
  });

  it('each rendered capability lands in the group matching its own CAPABILITY_SCOPE', () => {
    for (const group of groups) {
      for (const cell of group.capabilities) {
        expect(CAPABILITY_SCOPE[cell.capability]).toBe(group.scope);
      }
    }
  });

  // DEF-179 — a floor so an empty (or accidentally over-narrow) derivation cannot pass silently.
  it('the offered set clears a floor — an empty derivation cannot pass silently', () => {
    expect(rendered.length).toBeGreaterThan(50);
  });
});

describe('staff-matrix capabilities are shown as inherited-and-disabled, not omitted (§C6)', () => {
  it('every staff-matrix capability (21 today) is present and flagged inherited', () => {
    const groups = gridCapabilityGroups();
    const byCapability = new Map(groups.flatMap((g) => g.capabilities).map((c) => [c.capability, c]));
    const staffMatrixCapabilities = CAPABILITIES.filter((c) => CAPABILITY_MATRIX[c].staff);
    expect(staffMatrixCapabilities.length).toBe(21);
    for (const c of staffMatrixCapabilities) {
      const cell = byCapability.get(c);
      expect(cell, `${c} is staff-matrix and must still be RENDERABLE, not hidden`).toBeDefined();
      expect(cell!.inherited, `${c} must be flagged inherited (shown, disabled)`).toBe(true);
    }
  });

  it('a non-staff-matrix capability is NOT flagged inherited', () => {
    const groups = gridCapabilityGroups();
    const nonStaff = groups.flatMap((g) => g.capabilities).find((c) => !CAPABILITY_MATRIX[c.capability].staff);
    expect(nonStaff).toBeDefined();
    expect(nonStaff!.inherited).toBe(false);
  });
});

describe('bannerMessage — names the skipped self only when one was skipped (plan §5.1, decision 4)', () => {
  it('no self-skip: exactly "Applied to N people."', () => {
    expect(bannerMessage(7, false)).toBe('Applied to 7 people.');
  });

  it('self-skip: the second sentence is appended verbatim', () => {
    expect(bannerMessage(7, true)).toBe(
      'Applied to 7 people. Your own row was skipped — ask another administrator.',
    );
  });

  it('singular wording for exactly one person', () => {
    expect(bannerMessage(1, false)).toBe('Applied to 1 person.');
  });

  it('nothing changed is said plainly, never a success banner over a no-op', () => {
    expect(bannerMessage(0, false)).toBe('Nothing changed.');
  });

  it('nothing changed AND self was skipped: both are said', () => {
    expect(bannerMessage(0, true)).toBe(
      'Nothing changed. Your own row was skipped — ask another administrator.',
    );
  });
});

describe('bulkBannerMessage — rows and people are counted separately, because they differ honestly', () => {
  it('rows written but nobody reached: says both, never "Nothing changed" over new rows', () => {
    expect(bulkBannerMessage(4, 4, 0, false)).toBe(
      'Wrote 4 default rows across 4 stores. Nothing changed.',
    );
  });

  it('nothing new to write: says so, and still reports people', () => {
    expect(bulkBannerMessage(0, 0, 0, false)).toBe(
      'No new default rows — every target already had them. Nothing changed.',
    );
  });

  it('singular row and store, with a skipped self', () => {
    expect(bulkBannerMessage(1, 1, 2, true)).toBe(
      'Wrote 1 default row across 1 store. Applied to 2 people. Your own row was skipped — ask another administrator.',
    );
  });
});

describe('copyableDefaults — copy-from-store offers canonical positions only (plan §5.1, decision 2)', () => {
  it('a store-invented position never appears in the copy set', () => {
    const defaults = [
      { positionId: 'p1', isCanonical: true, capability: 'view_reports' },
      { positionId: 'p2', isCanonical: false, capability: 'view_reports' },
    ];
    expect(copyableDefaults(defaults)).toEqual([{ positionId: 'p1', isCanonical: true, capability: 'view_reports' }]);
  });

  it('an empty input yields an empty output, not a throw', () => {
    expect(copyableDefaults([])).toEqual([]);
  });

  it('all-canonical input passes through unchanged', () => {
    const defaults = [
      { positionId: 'p1', isCanonical: true, capability: 'a' },
      { positionId: 'p3', isCanonical: true, capability: 'b' },
    ];
    expect(copyableDefaults(defaults)).toEqual(defaults);
  });
});
