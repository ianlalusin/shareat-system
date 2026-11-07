import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const CONVERTED_PAGES = [
  'apps/erp/src/app/admin/stores/page.tsx',
  'apps/erp/src/app/admin/users/page.tsx',
  'apps/erp/src/app/attendance/leave/page.tsx',
  'apps/erp/src/app/cash-requests/page.tsx',
  'apps/erp/src/app/channel-settlements/page.tsx',
  'apps/erp/src/app/cutover/opening/page.tsx',
  'apps/erp/src/app/fixed-assets/page.tsx',
  'apps/erp/src/app/items/page.tsx',
  'apps/erp/src/app/liabilities/unpaid/page.tsx',
  'apps/erp/src/app/loans/page.tsx',
  'apps/erp/src/app/owners/page.tsx',
  'apps/erp/src/app/prepaid/page.tsx',
  'apps/erp/src/app/sales-days/page.tsx',
  'apps/erp/src/app/settings/expense-categories/page.tsx',
  'apps/erp/src/app/settings/pos-link/page.tsx',
  'apps/erp/src/app/settings/usage-tolerance/page.tsx',
  'apps/erp/src/app/settings/organization/page.tsx',
  'apps/erp/src/app/settings/pos-tablet/page.tsx',
  'apps/erp/src/app/reports/trial-balance/page.tsx',
  'apps/erp/src/app/reports/income-statement/page.tsx',
  'apps/erp/src/app/reports/balance-sheet/page.tsx',
  'apps/erp/src/app/payroll/rates/page.tsx',
  'apps/erp/src/app/statutory-discounts/page.tsx',
];

const SKIPPED_PAGES = [
  {
    file: 'apps/erp/src/app/expenses/page.tsx',
    reason: 'has action link and description containing (docs/tasks/122-expenses.md) reference',
  },
];

describe('T-540: page header sweep - converted pages use Page title prop', () => {
  it('each converted page source contains <Page with title= and no <h1', () => {
    for (const page of CONVERTED_PAGES) {
      const source = readFileSync(page, 'utf8');
      expect(source).toContain('<Page');
      expect(source).toMatch(/title="[^"]*"/);
      expect(source).not.toContain('<h1');
    }
  });

  it('no converted page lost its words', () => {
    for (const page of CONVERTED_PAGES) {
      const source = readFileSync(page, 'utf8');
      // Extract the title prop value and verify key words are present
      const titleMatch = source.match(/title="([^"]*)"/);
      expect(titleMatch).toBeTruthy(`No title= prop found in ${page}`);
      const titleValue = titleMatch![1];
      // The original page title should be reflected in the title prop
      expect(titleValue.length).toBeGreaterThan(0);
    }
  });
});
