import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CAPABILITY_MATRIX,
  CAPABILITY_SCOPE,
  SUPER_ADMIN_ONLY_CAPABILITIES,
  type Capability,
} from '@shareat/auth';
import { CAPABILITY_AREAS } from '@shareat/auth';
import {
  SCOPE_ORDER,
  areaOnCount,
  bannerMessage,
  bulkBannerMessage,
  computeOverlapCounts,
  copyableDefaults,
  gridCapabilityGroups,
  overlapDisclosure,
  type GridCapability,
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
  // T-337: capabilities live on the AREA group now, never flat on the scope group (lib.ts's own
  // comment) — flattened one level further here, same fix as the T-318 describe block below.
  const rendered = groups.flatMap((g) => g.areas.flatMap((a) => a.capabilities.map((c) => c.capability)));

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
    // ⛔ T-344/DEF-422 (R1.3): `create_missing_period` changes closed books like `close_period` and
    // `override_period_lock` — admin/super_admin only, never offerable to a position, so it must
    // never appear on this grid either.
    expect(rendered).not.toContain('create_missing_period');
    // ⛔ T-345 §3.4: `book_missed_month` is the same shape — admin/super_admin only, never
    // offerable to a position, so it must never appear on this grid either.
    expect(rendered).not.toContain('book_missed_month');
  });

  it('every capability outside the three excluded sets IS rendered, exactly once', () => {
    const platformCapabilities = new Set(CAPABILITIES.filter((c) => CAPABILITY_SCOPE[c] === 'platform'));
    const excluded = new Set<Capability>([
      ...SUPER_ADMIN_ONLY_CAPABILITIES,
      ...platformCapabilities,
      'close_period',
      'create_missing_period',
      'book_missed_month' as Capability,
    ]);
    for (const c of CAPABILITIES) {
      if (excluded.has(c)) continue;
      const hits = rendered.filter((r) => r === c);
      expect(hits.length, `${c} should appear exactly once across the groups`).toBe(1);
    }
  });

  it('each rendered capability lands in the group matching its own CAPABILITY_SCOPE', () => {
    for (const group of groups) {
      for (const area of group.areas) {
        for (const cell of area.capabilities) {
          expect(CAPABILITY_SCOPE[cell.capability]).toBe(group.scope);
        }
      }
    }
  });

  // DEF-179 — a floor so an empty (or accidentally over-narrow) derivation cannot pass silently.
  it('the offered set clears a floor — an empty derivation cannot pass silently', () => {
    expect(rendered.length).toBeGreaterThan(50);
  });
});

/**
 * T-337 — L1. `docs/tasks/337-access-defaults-grouped-collapsible.md` §7. Per-scope AREA grouping,
 * layered on top of the SCOPE grouping the describe block above already proves.
 */
describe('L1 — gridCapabilityGroups: area order, exactly-91-once, and the 76/15 split', () => {
  const groups = gridCapabilityGroups();

  it('within each scope, area order is a subsequence of CAPABILITY_AREAS order', () => {
    for (const group of groups) {
      const areaIndexes = group.areas.map((a) => CAPABILITY_AREAS.indexOf(a.area));
      const sorted = [...areaIndexes].sort((x, y) => x - y);
      expect(areaIndexes, `${group.scope}'s areas are out of CAPABILITY_AREAS order`).toEqual(sorted);
    }
  });

  // ⭐ 91 -> 92 (T-350/DEF-477): `set_channel_payout` is store-scoped, admin-yes/manager-no, same
  // shape as `set_cash_policy` — offerable to a position, none of the three excluded sets.
  // ⭐ 92 -> 93 (T-403): `manage_recipes` (org, admin-only) is offerable to a position.
  it('the 93 offerable capabilities each appear exactly once across every area of every scope', () => {
    const rendered = groups.flatMap((g) => g.areas.flatMap((a) => a.capabilities.map((c) => c.capability)));
    expect(rendered.length).toBe(93);
    expect(new Set(rendered).size, 'no capability appears twice').toBe(93);
  });

  // ⭐ store 76 -> 77 (T-350/DEF-477): `set_channel_payout` joins store, same as `set_cash_policy`.
  it('store holds 77, org holds 16 (§1\'s totals)', () => {
    const countFor = (scope: (typeof SCOPE_ORDER)[number]) =>
      groups.find((g) => g.scope === scope)!.areas.reduce((n, a) => n + a.capabilities.length, 0);
    expect(countFor('store')).toBe(77);
    expect(countFor('org')).toBe(16);
  });

  it('NEGATIVE: no area group is ever empty — gridCapabilityGroups filters them out', () => {
    for (const group of groups) {
      for (const area of group.areas) {
        expect(area.capabilities.length, `${group.scope}/${area.area} is empty and should have been filtered out`).toBeGreaterThan(0);
      }
    }
  });

  it('NEGATIVE: org has no sales area (§1: sales is 14/0 — store only)', () => {
    const org = groups.find((g) => g.scope === 'org')!;
    expect(org.areas.map((a) => a.area)).not.toContain('sales');
  });

  it('NEGATIVE: the excluded set (SUPER_ADMIN_ONLY + platform-scoped + close_period + create_missing_period + book_missed_month) is absent from every area', () => {
    const rendered = new Set(groups.flatMap((g) => g.areas.flatMap((a) => a.capabilities.map((c) => c.capability))));
    for (const c of SUPER_ADMIN_ONLY_CAPABILITIES) expect(rendered.has(c)).toBe(false);
    for (const c of CAPABILITIES.filter((c) => CAPABILITY_SCOPE[c] === 'platform')) expect(rendered.has(c)).toBe(false);
    expect(rendered.has('close_period')).toBe(false);
    expect(rendered.has('create_missing_period')).toBe(false);
    // ⛔ T-345 §3.4
    expect(rendered.has('book_missed_month' as Capability)).toBe(false);
  });

  it('NEGATIVE: the platform SCOPE has 0 areas', () => {
    expect(groups.find((g) => g.scope === 'platform')!.areas).toEqual([]);
  });

  it('NEGATIVE: no scope contains the franchise AREA (its two members are platform-scoped and super-admin-only, so never offerable)', () => {
    for (const group of groups) {
      expect(group.areas.map((a) => a.area)).not.toContain('franchise');
    }
  });
});

/**
 * T-337 — L2. `areaOnCount`: "on" = active in the activeSet, OR inherited (§3).
 */
describe('L2 — areaOnCount: 0/n, n/n, partial, and an active capability outside the area', () => {
  const cap = (capability: Capability, inherited = false): GridCapability => ({ capability, inherited });
  const activeSet = (...caps: Capability[]): ReadonlySet<Capability> => new Set(caps);

  it('0/n: nothing active, nothing inherited', () => {
    const capabilities = [cap('record_sale'), cap('submit_sales_day')];
    expect(areaOnCount(capabilities, activeSet())).toBe(0);
  });

  it('n/n: every capability active', () => {
    const capabilities = [cap('record_sale'), cap('submit_sales_day')];
    expect(areaOnCount(capabilities, activeSet('record_sale', 'submit_sales_day'))).toBe(2);
  });

  it('partial: one active, one not', () => {
    const capabilities = [cap('record_sale'), cap('submit_sales_day')];
    expect(areaOnCount(capabilities, activeSet('record_sale'))).toBe(1);
  });

  it('an inherited capability counts as on even with no activeSet entry (T-318: currently vacuous, but the logic must still count it)', () => {
    const capabilities = [cap('record_sale', true)];
    expect(areaOnCount(capabilities, activeSet())).toBe(1);
  });

  it('activeSet undefined (no defaults loaded yet) behaves like an empty set, never throws', () => {
    const capabilities = [cap('record_sale')];
    expect(areaOnCount(capabilities, undefined)).toBe(0);
  });

  it('NEGATIVE: a capability active but OUTSIDE this area\'s own list is not counted', () => {
    const capabilities = [cap('record_sale')];
    // 'submit_sales_day' is active, but it is not one of THIS area's capabilities — areaOnCount
    // must count only what is in `capabilities`, never scan the whole activeSet.
    expect(areaOnCount(capabilities, activeSet('submit_sales_day'))).toBe(0);
  });
});

describe('T-318 — the staff matrix has emptied: nothing is rendered inherited any more', () => {
  // ⛔ Formerly titled 'staff-matrix capabilities are shown as inherited-and-disabled, not
  // omitted (§C6)' — that sentence is now the exact behaviour these two tests prove is GONE, and
  // leaving it above them would scroll past in green as a false label (bible §13 row 206: a
  // plausible wrong reason is worse than none). The §C6 citation is dropped rather than kept
  // pointing at a section (docs/tasks/290-access-defaults-screen.md) that still reads "the staff
  // matrix IS rendered [inherited-and-disabled]" — that citation is now stale too, is out of this
  // lane's scope (docs/tasks/*.md), and is reported to the planner rather than edited here.
  //
  // T-318 (2026-09-14/16) shrank the staff baseline: the 21 everyday capabilities this block used
  // to pin as "inherited" moved off the automatic `staff` matrix cell onto position grants
  // (docs/tasks/318-position-decides-access.md, Contract 1) — `/admin/access-defaults` no longer
  // shows `record_sale` or `submit_sales_day` as a flat, undisableable badge, which was Ian's
  // original complaint. Their PRESENCE in the grid is already proven by the sibling
  // 'gridCapabilityGroups' describe above (the 21 are not in any of the three excluded sets);
  // what changed, and what is left to prove here, is `inherited` itself.
  //
  // ⭐ Deliberately NOT re-deriving "the 21" from any list (T-318's own fixture, the matrix, or
  // CAPABILITY-MATRIX.md) — this file's header says the point is to prove the grid against the
  // RULE independently, never against a second copy of the same list. Post-flip there is no
  // staff:true cell left at all (measured: zero), so the rule collapses to one honest claim: no
  // rendered capability is inherited. That is both simpler than naming 21 capabilities and a
  // strictly more general proof of Contract 5 ("`GridCapability.inherited` becomes false for
  // them by the matrix change alone") than checking only the 21 would have been.
  it('CAPABILITY_MATRIX now holds ZERO staff:true cells — T-318 moved every one to position grants', () => {
    const staffMatrixCapabilities = CAPABILITIES.filter((c) => CAPABILITY_MATRIX[c].staff);
    expect(staffMatrixCapabilities).toEqual([]);
  });

  it('so no rendered capability is flagged inherited — every one is a live, position-granted toggle', () => {
    const groups = gridCapabilityGroups();
    const rendered = groups.flatMap((g) => g.areas.flatMap((a) => a.capabilities));
    // DEF-179 floor, same reasoning as the sibling describe block above: an empty derivation
    // must not make the loop below pass vacuously.
    expect(rendered.length).toBeGreaterThan(50);
    for (const cell of rendered) {
      expect(cell.inherited, `${cell.capability} must not be flagged inherited (T-318)`).toBe(false);
    }
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

/**
 * T-318 D3 — the multi-position disclosure. Pure; no database (`gridDataForStore` in `lib.ts`
 * supplies the two real inputs — `employmentPositionsForStore`'s rows and
 * `activeDefaultsMapForStore`'s map — via the one batched read each; the integration case for
 * that wiring lives in `apps/erp/tests/integration/access-defaults-lib.test.ts`).
 */
describe('computeOverlapCounts — the T-318 MULTI-POSITION RULING, made visible', () => {
  const asMap = (entries: readonly (readonly [string, readonly Capability[]])[]) =>
    new Map(entries.map(([k, v]) => [k, new Set(v)]));

  it('one position only: nothing to report — there is no OTHER position to hold it through', () => {
    const links = [{ employmentId: 'e1', positionId: 'dishwasher' }];
    const activeDefaults = asMap([['dishwasher', ['submit_sales_day']]]);
    expect(computeOverlapCounts(links, activeDefaults).size).toBe(0);
  });

  it('two positions, one supplies the capability the other lacks: the LACKING one is credited', () => {
    const links = [
      { employmentId: 'e1', positionId: 'dishwasher' },
      { employmentId: 'e1', positionId: 'server' },
    ];
    const activeDefaults = asMap([['server', ['submit_sales_day']]]); // dishwasher has nothing
    const overlap = computeOverlapCounts(links, activeDefaults);
    expect(overlap.get('dishwasher')?.get('submit_sales_day' as Capability)).toBe(1);
    // Server already holds it directly — nothing to disclose FROM Server's own column.
    expect(overlap.get('server')?.get('submit_sales_day' as Capability)).toBeUndefined();
  });

  it('both positions hold it directly: neither is credited — holding it here needs no disclosure', () => {
    const links = [
      { employmentId: 'e1', positionId: 'dishwasher' },
      { employmentId: 'e1', positionId: 'server' },
    ];
    const activeDefaults = asMap([
      ['dishwasher', ['submit_sales_day']],
      ['server', ['submit_sales_day']],
    ]);
    const overlap = computeOverlapCounts(links, activeDefaults);
    expect(overlap.get('dishwasher')?.get('submit_sales_day' as Capability)).toBeUndefined();
    expect(overlap.get('server')?.get('submit_sales_day' as Capability)).toBeUndefined();
  });

  it('two DIFFERENT employments both credit the same (position, capability): counted as 2 people', () => {
    const links = [
      { employmentId: 'e1', positionId: 'dishwasher' },
      { employmentId: 'e1', positionId: 'server' },
      { employmentId: 'e2', positionId: 'dishwasher' },
      { employmentId: 'e2', positionId: 'server' },
    ];
    const activeDefaults = asMap([['server', ['submit_sales_day']]]);
    expect(computeOverlapCounts(links, activeDefaults).get('dishwasher')?.get('submit_sales_day' as Capability)).toBe(2);
  });

  it('one employment holding THREE positions, two of which supply the same capability: counted ONCE, by person', () => {
    const links = [
      { employmentId: 'e1', positionId: 'dishwasher' },
      { employmentId: 'e1', positionId: 'server' },
      { employmentId: 'e1', positionId: 'cashier' },
    ];
    const activeDefaults = asMap([
      ['server', ['submit_sales_day']],
      ['cashier', ['submit_sales_day']],
    ]);
    // §C5 — count PEOPLE, not rows: this is one person, not two, even though two other
    // positions each supply the capability.
    expect(computeOverlapCounts(links, activeDefaults).get('dishwasher')?.get('submit_sales_day' as Capability)).toBe(1);
  });

  it('an empty input yields an empty map, not a throw', () => {
    expect(computeOverlapCounts([], new Map()).size).toBe(0);
  });
});

describe('overlapDisclosure — rendered only when true, never as an ambient zero', () => {
  it('zero renders nothing at all', () => {
    expect(overlapDisclosure(0)).toBeNull();
  });

  it('singular wording for exactly one person', () => {
    expect(overlapDisclosure(1)).toBe('Still held by 1 person through another position.');
  });

  it('plural wording for more than one', () => {
    expect(overlapDisclosure(3)).toBe('Still held by 3 people through another position.');
  });
});
