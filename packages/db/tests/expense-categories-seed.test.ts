import { describe, expect, it } from 'vitest';
import { COGS_CATEGORY_ACCOUNTS, OPEX_CATEGORY_ACCOUNTS, ACCOUNTS } from '../../etl/src/leg-mapping';
import { EXPENSE_CATEGORY_SEED } from '../seed/expense-categories';

/**
 * Drift guard for packages/db/seed/expense-categories.ts's top-comment claim: the
 * OPEX/COGS crosswalk is a COPY of packages/etl/src/leg-mapping.ts's
 * OPEX_CATEGORY_ACCOUNTS / COGS_CATEGORY_ACCOUNTS (packages/db cannot depend on
 * packages/etl — the reverse would cycle). Same technique as
 * packages/domain/tests/unit/expense-routing-mirror.test.ts.
 */
describe('expense-categories seed mirrors leg-mapping.ts exactly', () => {
  it('every OPEX category in leg-mapping.ts appears in the seed with the same account code', () => {
    for (const [category, accountCode] of Object.entries(OPEX_CATEGORY_ACCOUNTS)) {
      const seeded = EXPENSE_CATEGORY_SEED.find((c) => c.group === 'OPEX' && c.category === category);
      expect(seeded, `OPEX category "${category}" missing from the seed`).toBeDefined();
      expect(seeded!.accountCode).toBe(accountCode);
    }
  });

  it('every COGS category in leg-mapping.ts appears in the seed with the same account code', () => {
    for (const [category, accountCode] of Object.entries(COGS_CATEGORY_ACCOUNTS)) {
      const seeded = EXPENSE_CATEGORY_SEED.find((c) => c.group === 'COGS' && c.category === category);
      expect(seeded, `COGS category "${category}" missing from the seed`).toBeDefined();
      expect(seeded!.accountCode).toBe(accountCode);
    }
  });

  it('the seed introduces no OPEX/COGS category leg-mapping.ts does not name', () => {
    const knownOpex = new Set(Object.keys(OPEX_CATEGORY_ACCOUNTS));
    const knownCogs = new Set(Object.keys(COGS_CATEGORY_ACCOUNTS));
    for (const c of EXPENSE_CATEGORY_SEED) {
      if (c.group === 'OPEX') expect(knownOpex.has(c.category), `unexpected OPEX category "${c.category}"`).toBe(true);
      if (c.group === 'COGS') expect(knownCogs.has(c.category), `unexpected COGS category "${c.category}"`).toBe(true);
    }
  });

  it('PERSONAL routes to leg-mapping.ts ACCOUNTS.OWNERS_DRAWINGS (invariant 8)', () => {
    const personal = EXPENSE_CATEGORY_SEED.filter((c) => c.group === 'PERSONAL');
    expect(personal.length).toBeGreaterThan(0);
    for (const c of personal) expect(c.accountCode).toBe(ACCOUNTS.OWNERS_DRAWINGS);
  });

  it('CAPEX routes to leg-mapping.ts ACCOUNTS.PROPERTY_AND_EQUIPMENT (invariant 9)', () => {
    const capex = EXPENSE_CATEGORY_SEED.filter((c) => c.group === 'CAPEX');
    expect(capex.length).toBeGreaterThan(0);
    for (const c of capex) expect(c.accountCode).toBe(ACCOUNTS.PROPERTY_AND_EQUIPMENT);
  });

  it('no category name is duplicated within the seed (matches the org_id+category unique index)', () => {
    const names = EXPENSE_CATEGORY_SEED.map((c) => c.category);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every account_code in the seed is non-empty', () => {
    for (const c of EXPENSE_CATEGORY_SEED) expect(c.accountCode.trim().length).toBeGreaterThan(0);
  });
});
