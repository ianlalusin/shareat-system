import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { PgDialect } from 'drizzle-orm/pg-core';
import { suppliers } from '../../schema/suppliers';

/**
 * T-367 S3 T5 / DEF-500 — the Drizzle schema DECLARES `suppliers_credit_terms_days_check`.
 * `docs/tasks/367-ap-ar-money.md` §S3: the check exists in the database since migration 0141 but `schema/suppliers.ts`
 * never declared it, so the schema and the database disagreed (a regenerated schema would drop it). The name must be
 * byte-equal to the migration's, and the bounds must be the live ones (0..365, NULL allowed).
 *
 * ⛔ TESTER. Pure unit: reads the table config only — no database. The integration half (the live
 * `pg_get_constraintdef`, 365 accepted / 366 refused) is `packages/domain/tests/integration/t367-s3-invoice-total-due-date.test.ts` T5.
 */
describe('T5 (DEF-500) — the Drizzle declaration of the terms CHECK', () => {
  const checks = getTableConfig(suppliers).checks;

  it('declares a check named exactly suppliers_credit_terms_days_check', () => {
    expect(checks.map((c) => c.name), 'the Drizzle schema does not declare the terms CHECK').toContain('suppliers_credit_terms_days_check');
  });

  it('its SQL bounds are NULL-or-(0..365), the same as the live constraint', () => {
    const declared = checks.find((c) => c.name === 'suppliers_credit_terms_days_check');
    expect(declared, 'the check is missing').toBeDefined();
    const text = new PgDialect().sqlToQuery(declared!.value).sql.replace(/\s+/g, ' ');
    expect(text).toMatch(/credit_terms_days"? is null/i);
    expect(text).toMatch(/>=\s*0/);
    expect(text).toMatch(/<=\s*365/);
  });
});
