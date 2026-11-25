import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPABILITY_MATRIX } from '@shareat/auth';
import { ROUTE_CAPABILITY } from '../src/lib/route-capability';

/**
 * T-639 - who sees the expense alerts. They appear only in the findings feed, which is shown at /findings behind `view_financial_reports`, limited to the
 * viewer's own stores; staff hold neither that right nor the right to accept a finding, so staff never see a peso amount from one.
 */
const ROOT = join(__dirname, '..', '..', '..');

describe('T-639 visibility', () => {
  it('/findings needs view_financial_reports, which staff do not hold; accepting a finding (close_period) is not a staff right either [kills: opening the feed or the acknowledge to staff]', () => {
    expect(ROUTE_CAPABILITY['/findings']).toBe('view_financial_reports');
    expect(CAPABILITY_MATRIX.view_financial_reports.staff).toBe(false);
    expect(CAPABILITY_MATRIX.close_period.staff).toBe(false);
    expect(CAPABILITY_MATRIX.view_financial_reports.manager).toBe(true);
  });

  it('the feed keeps a store-limited viewer to their own stores, and the six kinds have plain titles on the screen [kills: a store filter dropped; a raw kind id shown]', () => {
    const lib = readFileSync(join(ROOT, 'apps/erp/src/app/findings/lib.ts'), 'utf8');
    expect(lib).toMatch(/storeIds\.includes\(f\.storeId\)/);
    for (const kind of ['expenseCategorySpike', 'expenseFrequencySpike', 'expenseOutlier', 'expenseDuplicate', 'expenseSelfApproved', 'expenseOverBudget']) {
      expect(lib, kind).toMatch(new RegExp(`${kind}: '[A-Z][^']{10,}'`));
    }
  });

  it('the thresholds are an admin screen, not a code constant: the five rules sit in the Expense alerts group of /settings/business-rules, which only manage_business_rules opens [kills: a threshold with no screen]', () => {
    expect(ROUTE_CAPABILITY['/settings/business-rules']).toBe('manage_business_rules');
    const registry = readFileSync(join(ROOT, 'packages/domain/src/business-rules/registry.ts'), 'utf8');
    expect(registry.match(/namespace: 'expenses'/g)?.length).toBe(5);
  });
});
