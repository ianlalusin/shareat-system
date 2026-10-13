import { describe, expect, it } from 'vitest';
// One module (capabilities.ts imports nothing), same reason as super-admin-capability-set.test.ts.
import { CAPABILITY_AREA, CAPABILITY_MATRIX, CAPABILITY_SCOPE, type Capability } from '../src/capabilities';

/**
 * T-401 S2, I12 (pure half), revised for Ian's answers Q1/Q2 and the recipes ruling.
 * docs/tasks/401-erp-menu-catalog-master.md section 3 "Capabilities", R14, "Ian ruling on recipes".
 * The seven cells and scopes are PINNED here by hand, because the matrix test only proves code = document: a wrong cell written into
 * BOTH would pass it. The DB-backed refusals are in packages/domain/tests/integration/t401-s2-capabilities.test.ts.
 *
 * Red today: none of the seven exists, so every lookup is undefined.
 */
type Cell = { scope: 'org' | 'store'; super_admin: boolean; admin: boolean; manager: boolean; staff: boolean; killsMutant: string };
const CELLS: Record<string, Cell> = {
  view_menu: { scope: 'org', super_admin: true, admin: true, manager: true, staff: false, killsMutant: 'staff allowed to read the menu' },
  add_menu_item: { scope: 'org', super_admin: true, admin: false, manager: false, staff: false, killsMutant: 'add_menu_item wired like manage_menu (admin adds items)' },
  manage_menu: { scope: 'org', super_admin: true, admin: true, manager: false, staff: false, killsMutant: 'manager allowed to edit the menu' },
  request_menu_item: { scope: 'store', super_admin: true, admin: true, manager: true, staff: false, killsMutant: 'staff may request, or the scope is org' },
  set_menu_price: { scope: 'store', super_admin: true, admin: true, manager: true, staff: false, killsMutant: "set_menu_price scoped 'org' (the manager then prices every store); manager cell left at the old false" },
  set_menu_depletion: { scope: 'org', super_admin: true, admin: true, manager: false, staff: false, killsMutant: 'manager allowed to edit recipes (Ian: only admin edits recipes)' },
  switch_usage_source: { scope: 'store', super_admin: true, admin: true, manager: false, staff: false, killsMutant: 'manager may switch what live stock posts from' },
};

describe('T-401 S2 / I12 - the seven menu capabilities, cell by cell', () => {
  for (const [cap, want] of Object.entries(CELLS)) {
    it(`${cap}: scope ${want.scope}; super ${want.super_admin} admin ${want.admin} manager ${want.manager} staff ${want.staff}. Mutant: ${want.killsMutant}`, () => {
      const row = (CAPABILITY_MATRIX as Record<string, Record<string, boolean> | undefined>)[cap];
      expect(row, `${cap} is not in CAPABILITY_MATRIX`).toBeDefined();
      expect(row).toEqual({ super_admin: want.super_admin, admin: want.admin, manager: want.manager, staff: want.staff });
      expect((CAPABILITY_SCOPE as Record<string, string | undefined>)[cap]).toBe(want.scope);
      expect((CAPABILITY_AREA as Record<string, string | undefined>)[cap], 'area sales').toBe('sales');
    });
  }

  it('exactly three of the seven are store-scoped: set_menu_price, request_menu_item, switch_usage_source (the menu itself is org master data)', () => {
    const scopes = Object.keys(CELLS).filter((c) => (CAPABILITY_SCOPE as Record<string, string | undefined>)[c] === 'store').sort();
    expect(scopes).toEqual(['request_menu_item', 'set_menu_price', 'switch_usage_source']);
  });

  it('add_menu_item is the ONLY one of the seven that super admin holds and admin lacks (the super-admin-only seam)', () => {
    const m = CAPABILITY_MATRIX as Record<string, Record<string, boolean> | undefined>;
    const superOnly = Object.keys(CELLS).filter((c) => m[c]?.super_admin && !m[c]?.admin);
    expect(superOnly).toEqual(['add_menu_item']);
  });

  it('type check: the seven names are Capability members (compile-time; fails tsc until the builder adds them)', () => {
    const names: Capability[] = ['view_menu', 'add_menu_item', 'manage_menu', 'request_menu_item', 'set_menu_price', 'set_menu_depletion', 'switch_usage_source'];
    expect(names).toHaveLength(7);
  });
});
