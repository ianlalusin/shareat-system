/**
 * DEF-803 (a) - the three commissary nav items ("Branch orders", "Commissary catalogue", "Transit discrepancies") show only when the org uses them.
 * Found by the T-398 S7 smoketest: a franchisee's owner (Padre Garcia) saw all three, each an empty state. ADR-008 s6 / T-398 O5: PG sees no commissary screen.
 * Nav only: the routes themselves are untouched (a direct visit still shows the empty state).
 *
 * MUTANTS: (1) filter not wired into AppShell (the helper exists, the sidebar ignores it); (2) "Branch orders" shown to an org with a branch link but hidden
 * for one with only a commissary; (3) catalogue / discrepancies shown to a branch-only org; (4) the filter hides an unrelated link (Items, Stock on hand);
 * (5) an org with a commissary loses an item; (6) the filter replaces the capability filter instead of adding to it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMISSARY_NAV_HREFS, commissaryNavAllowed } from '../../apps/erp/src/lib/route-capability';

const NONE = { hasCommissary: false, hasBranchLink: false };
const CATALOGUE = '/commissary/catalogue';
const DISCREPANCIES = '/commissary/discrepancies';
const ORDERS = '/commissary/orders';

describe('commissaryNavAllowed', () => {
  it('names exactly the three items - Mutant: a fourth link swept in / one missed', () => {
    expect([...COMMISSARY_NAV_HREFS].sort()).toEqual([CATALOGUE, DISCREPANCIES, ORDERS].sort());
  });

  it('a franchisee org (no commissary, no branch link): all three hidden - Mutant: filter not applied', () => {
    for (const h of COMMISSARY_NAV_HREFS) expect(commissaryNavAllowed(h, NONE), h).toBe(false);
  });

  it('an org with a commissary store: all three shown - Mutant: an org with a commissary loses an item', () => {
    for (const h of COMMISSARY_NAV_HREFS) expect(commissaryNavAllowed(h, { hasCommissary: true, hasBranchLink: false }), h).toBe(true);
    for (const h of COMMISSARY_NAV_HREFS) expect(commissaryNavAllowed(h, { hasCommissary: true, hasBranchLink: true }), h).toBe(true);
  });

  it('a branch-only org: Branch orders shown, catalogue and discrepancies hidden - Mutant: Branch orders keyed to hasCommissary only / catalogue shown to a branch-only org', () => {
    const branchOnly = { hasCommissary: false, hasBranchLink: true };
    expect(commissaryNavAllowed(ORDERS, branchOnly)).toBe(true);
    expect(commissaryNavAllowed(CATALOGUE, branchOnly)).toBe(false);
    expect(commissaryNavAllowed(DISCREPANCIES, branchOnly)).toBe(false);
  });

  it('every other link passes whatever the usage - Mutant: the filter hides an unrelated link', () => {
    for (const h of ['/', '/items', '/inventory', '/inventory/low-stock', '/menu', '/commissary-other']) expect(commissaryNavAllowed(h, NONE), h).toBe(true);
  });
});

describe('AppShell wiring', () => {
  const shell = readFileSync(path.resolve(__dirname, '../../apps/erp/src/components/shell/AppShell.tsx'), 'utf8');
  it('applies commissaryNavAllowed AND still navHrefAllowed to the sidebar hrefs - Mutant: helper not wired / replaces the capability filter', () => {
    expect(shell).toMatch(/commissaryNavAllowed\(/);
    expect(shell).toMatch(/navHrefAllowed\(/);
    expect(shell).toMatch(/commissaryUsage\(/);
  });
});
