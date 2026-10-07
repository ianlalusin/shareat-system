import { describe, expect, it } from 'vitest';
import { findingsForFile, findingsForSource } from './no-typed-values-in-urls';

/**
 * T-380 S4 - G-S4. Every S4 file is clean under the guard with NO PENDING cover (`findingsForFile`
 * applies no exemption). docs/tasks/380-no-typed-values-in-urls.md, S4.
 *
 * Red on HEAD: every action still has a local `back()` / template `redirect(...?error=)` (G1a), and
 * every page that reads `sp.error` / `sp.ok` still gets `sp` from the bare `searchParams` (G2).
 * Named mutant: leave one local `back()` in `expenses/actions.ts` (or any S4 action) -> that
 * file's row goes red. The last test pins the mutant's shape on an inline fixture so the guard
 * cannot silently stop seeing it.
 */
const ACTIONS = [
  'ap', 'expenses', 'expenses/recurring', 'expenses/reimbursements', 'sales-days', 'settings/attendance',
  'settings/expense-categories', 'settings/organization', 'settings/sales-channels',
  'settings/wastage-monitor', 'commissary/catalogue', 'commissary/orders', 'commissary/orders/[id]',
  'commissary/discrepancies', 'trade/orders', 'trade/returns',
].map((d) => `app/${d}/actions.ts`);

const PAGES = [
  'app/ap/page.tsx', 'app/ap/invoices/[id]/page.tsx', 'app/ap/suppliers/page.tsx', 'app/ap/suppliers/[id]/page.tsx',
  'app/expenses/[id]/page.tsx', 'app/expenses/new/page.tsx', 'app/expenses/recurring/page.tsx',
  'app/expenses/reimbursements/page.tsx', 'app/sales-days/new/page.tsx', 'app/sales-days/[id]/page.tsx',
  'app/sales-days/[id]/edit/page.tsx', 'app/reports/pos-reconciliation/page.tsx', 'app/settings/attendance/page.tsx',
  'app/settings/expense-categories/page.tsx', 'app/settings/organization/page.tsx', 
  'app/settings/sales-channels/page.tsx', 'app/settings/wastage-monitor/page.tsx', 'app/commissary/catalogue/page.tsx',
  'app/commissary/discrepancies/page.tsx', 'app/commissary/orders/page.tsx', 'app/commissary/orders/[id]/page.tsx',
  'app/trade/orders/page.tsx', 'app/trade/orders/[id]/page.tsx', 'app/trade/returns/page.tsx',
];

describe('G-S4: the S4 files carry no query in a redirect and read banners through withFlash', () => {
  it.each([...ACTIONS, ...PAGES])('%s has no guard finding', (file) => {
    const found = findingsForFile(file);
    expect(found.map((f) => `${f.rule}@${f.line}: ${f.detail}`)).toEqual([]);
  });

  it('the named mutant: a local back() beside redirectWithFlash in an S4 action is flagged', () => {
    const src = `
      import { redirect } from 'next/navigation';
      import { redirectWithFlash } from '@/lib/flash';
      function back(p: string, q: Record<string, string>): never { redirect(\`\${p}?\${new URLSearchParams(q)}\`); }
      export async function recordExpenseAction() {
        back('/expenses', { error: 'x' });
        return await redirectWithFlash('/expenses', {}, { ok: 'created' });
      }`;
    expect(findingsForSource(src, 'app/expenses/actions.ts').map((f) => f.rule)).toEqual(['G1a']);
  });
});
