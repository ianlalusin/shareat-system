import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * T-597 DEF-888 - the supplier-return page hands the domain a refund account it will accept: a live account (a retired one is
 * refused for good) that is not a staff float (its 1120 line needs a cash-request party, so a refund into it fails).
 */
describe('T-597 DEF-888 - inventory/returns page picks the refund account', () => {
  const page = readFileSync(new URL('../src/app/inventory/returns/page.tsx', import.meta.url), 'utf8');
  const query = page.slice(page.indexOf('.from(schema.moneyAccounts)'), page.indexOf('.limit(1)', page.indexOf('.from(schema.moneyAccounts)')));

  it('filters on the store, on cash, on active, and not on the staff custodian', () => {
    expect(query).toMatch(/eq\(schema\.moneyAccounts\.storeId, storeId\)/);
    expect(query).toMatch(/eq\(schema\.moneyAccounts\.instrument, 'cash'\)/);
    expect(query).toMatch(/eq\(schema\.moneyAccounts\.isActive, true\)/);
    expect(query).toMatch(/ne\(schema\.moneyAccounts\.custodian, 'staff'\)/);
  });
});
