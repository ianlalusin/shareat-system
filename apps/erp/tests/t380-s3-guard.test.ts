import { describe, expect, it } from 'vitest';
import { findingsForFile, findingsForSource } from './no-typed-values-in-urls';

/**
 * T-380 S3 - G-S3. Every S3 file is clean under the guard with NO PENDING cover (`findingsForFile`
 * applies no exemption). docs/tasks/380-no-typed-values-in-urls.md, S3.
 *
 * Red on HEAD: every action still has a local `back()` / template `redirect(...?error=)` (G1a), and
 * every page that reads `sp.error` / `sp.ok` still gets `sp` from the bare `searchParams` (G2).
 * Named mutant: leave one local `back()` in `money-transfers/actions.ts` (or any S3 action) -> that
 * file's row goes red. The last test pins the mutant's shape on an inline fixture so the guard
 * cannot silently stop seeing it.
 */
const ACTIONS = [
  'loans', 'liabilities', 'owners', 'cash-requests', 'money-accounts', 'money-transfers', 'remittance', 'till',
  'service-charge', 'budgets', 'channel-settlements', 'customers', 'statutory-discounts',
].map((d) => `app/${d}/actions.ts`);

const PAGES = [
  'app/loans/page.tsx', 'app/loans/[id]/page.tsx', 'app/liabilities/page.tsx', 'app/liabilities/[id]/page.tsx',
  'app/owners/page.tsx', 'app/owners/[id]/page.tsx', 'app/cash-requests/page.tsx', 'app/cash-requests/[id]/page.tsx',
  'app/money-accounts/page.tsx', 'app/money-transfers/page.tsx', 'app/remittance/page.tsx', 'app/till/page.tsx',
  'app/service-charge/page.tsx', 'app/budgets/page.tsx', 'app/channel-settlements/page.tsx',
  'app/customers/page.tsx', 'app/customers/[customerId]/page.tsx', 'app/customers/price-lists/page.tsx',
  'app/customers/price-lists/[id]/page.tsx', 'app/statutory-discounts/page.tsx',
];

describe('G-S3: the S3 files carry no query in a redirect and read banners through withFlash', () => {
  it.each([...ACTIONS, ...PAGES])('%s has no guard finding', (file) => {
    const found = findingsForFile(file);
    expect(found.map((f) => `${f.rule}@${f.line}: ${f.detail}`)).toEqual([]);
  });

  it('the named mutant: a local back() beside redirectWithFlash in an S3 action is flagged', () => {
    const src = `
      import { redirect } from 'next/navigation';
      import { redirectWithFlash } from '@/lib/flash';
      function back(p: string, q: Record<string, string>): never { redirect(\`\${p}?\${new URLSearchParams(q)}\`); }
      export async function createMoneyTransferAction() {
        back('/money-transfers', { error: 'x' });
        return await redirectWithFlash('/money-transfers', {}, { ok: 'created' });
      }`;
    expect(findingsForSource(src, 'app/money-transfers/actions.ts').map((f) => f.rule)).toEqual(['G1a']);
  });
});
