import { describe, expect, it } from 'vitest';
// One module (capabilities.ts imports nothing), same reason as super-admin-capability-set.test.ts.
import { CAPABILITY_AREA, CAPABILITY_MATRIX, CAPABILITY_SCOPE, type Capability } from '../src/capabilities';

/**
 * T-401 S2, I12 (pure half). docs/tasks/401-erp-menu-catalog-master.md section 3 "Capabilities", Q1 recommended option (a).
 * The four cells and scopes are PINNED here by hand, because the matrix test only proves code = document: a wrong cell
 * written into BOTH would pass it. The DB-backed refusals are in packages/domain/tests/integration/t401-s2-capabilities.test.ts.
 *
 * Red today: none of the four exists, so every lookup is undefined.
 */
const CELLS: Record<string, { scope: 'org' | 'store'; super_admin: boolean; admin: boolean; manager: boolean; staff: boolean; killsMutant: string }> = {
  view_menu: { scope: 'org', super_admin: true, admin: true, manager: true, staff: false, killsMutant: 'staff allowed to read the menu' },
  manage_menu: { scope: 'org', super_admin: true, admin: true, manager: false, staff: false, killsMutant: 'manager allowed to edit the menu (Q1 option c)' },
  set_menu_price: { scope: 'store', super_admin: true, admin: true, manager: false, staff: false, killsMutant: "set_menu_price scoped 'org' instead of 'store'" },
  set_menu_depletion: { scope: 'org', super_admin: true, admin: true, manager: true, staff: false, killsMutant: 'manager refused depletion rules' },
};

describe('T-401 S2 / I12 - the four menu capabilities, cell by cell', () => {
  for (const [cap, want] of Object.entries(CELLS)) {
    it(`${cap}: scope ${want.scope}; super ${want.super_admin} admin ${want.admin} manager ${want.manager} staff ${want.staff}. Mutant: ${want.killsMutant}`, () => {
      const row = (CAPABILITY_MATRIX as Record<string, Record<string, boolean> | undefined>)[cap];
      expect(row, `${cap} is not in CAPABILITY_MATRIX`).toBeDefined();
      expect(row).toEqual({ super_admin: want.super_admin, admin: want.admin, manager: want.manager, staff: want.staff });
      expect((CAPABILITY_SCOPE as Record<string, string | undefined>)[cap]).toBe(want.scope);
      expect((CAPABILITY_AREA as Record<string, string | undefined>)[cap], 'area sales').toBe('sales');
    });
  }

  it('the only store-scoped one of the four is set_menu_price (a price is per store; the menu itself is org master data)', () => {
    const scopes = Object.keys(CELLS).filter((c) => (CAPABILITY_SCOPE as Record<string, string | undefined>)[c] === 'store');
    expect(scopes).toEqual(['set_menu_price']);
  });

  it('type check: the four names are Capability members (compile-time; fails tsc until the builder adds them)', () => {
    const names: Capability[] = ['view_menu', 'manage_menu', 'set_menu_price', 'set_menu_depletion'];
    expect(names).toHaveLength(4);
  });
});
