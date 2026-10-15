import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Same relative-import pattern as tests/integration/constraint-message-lookup.test.ts.
import { CHART_OF_ACCOUNTS } from '../../../packages/db/seed/chart-of-accounts';

/**
 * T-406 — batch-1 guard: no ordinary screen prints a GL account number. Spec:
 * docs/tasks/406-account-label-helper.md. Bible row 229 (words, never a code).
 *
 * Mutants: M4 restores "Owed (2110)" in app/ap/page.tsx; M5 restores `{a.glAccountCode}` in
 * app/money-transfers/page.tsx; M6 removes or renames a SWEPT file (the existence check goes red).
 *
 * Method: for each SWEPT file, strip comments, the arguments of accountLabel/accountCodeAndName,
 * the `account: '6400'` data-table key, and value=/name= attributes (line numbers preserved), then
 * fail on any postable chart code as a whole word, or a bare `{…accountCode}` / `{…glAccountCode}`
 * JSX child.
 */

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const SRC = join(appRoot, 'src');

// Paths relative to apps/erp/src. Items 2-11 of the spec (batch 1). Item 1 is the helper itself and
// item 12 (reports) belongs to ACCOUNTANT_PAGES, so neither is here.
const SWEPT = [
  'app/money-accounts/lib.ts',
  'app/money-accounts/page.tsx',
  'app/money-transfers/page.tsx',
  'app/money-transfers/RecordTransferForm.tsx',
  'app/channel-settlements/page.tsx',
  'app/channel-settlements/SettlementForm.tsx',
  'app/customers/[customerId]/page.tsx',
  'app/customers/[customerId]/AutoAllocateCollectionForm.tsx',
  'app/ap/page.tsx',
  'app/ap/invoices/[id]/page.tsx',
  'app/ap/suppliers/[id]/page.tsx',
  'app/ap/suppliers/[id]/AutoAllocatePaymentForm.tsx',
  'app/payroll/page.tsx',
  'app/inventory/deliveries/[id]/page.tsx',
  'app/inventory/counts/page.tsx',
  'app/inventory/counts/[id]/page.tsx',
  'app/commissary/discrepancies/page.tsx',
  'app/prepaid/[id]/page.tsx',
  'app/till/page.tsx',
  // batch 2 (T-406b)
  'app/sales-days/SalesDayForm.tsx',
  'app/sales-days/[id]/page.tsx',
  'app/expenses/[id]/page.tsx',
  'app/settings/sales-channels/page.tsx',
  'app/budgets/page.tsx',
  'app/cash-requests/[id]/page.tsx',
  'app/commissary/orders/[id]/page.tsx',
  'app/commissary/orders/[id]/actions.ts',
  'app/trade/orders/[id]/page.tsx',
  'app/trade/orders/actions.ts',
  'app/fixed-assets/new/page.tsx',
  'app/fixed-assets/[id]/page.tsx',
  'app/liabilities/[id]/page.tsx',
  'app/remittance/page.tsx',
  'app/remittance/actions.ts',
  'app/service-charge/page.tsx',
  'app/statutory-discounts/page.tsx',
  'app/wastage/page.tsx',
  'app/wastage/[id]/page.tsx',
  'app/customers/actions.ts',
  'app/inventory/counts/actions.ts',
  'app/till/actions.ts',
];

// Accountant pages: keep "code · name" on purpose. Never scanned. Globs relative to apps/erp/src.
const ACCOUNTANT_PAGES = [
  'components/reports/*Table.tsx',
  'app/reports/**',
  'app/cutover/opening/**',
  'app/settings/expense-categories/**', // batch 2 ruling (b): admin picker maps a category to a code
];

function globToRegex(glob: string): RegExp {
  const esc = glob
    .split('**')
    .map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${esc}$`);
}

const POSTABLE_CODES = CHART_OF_ACCOUNTS.filter((a) => a.isPostable).map((a) => a.code);
const CODE_PATTERNS = POSTABLE_CODES.map((code) => ({
  code,
  re: new RegExp(`(?<!\\w)${code}(?!\\w)`),
}));
const BARE_JSX_CHILD = /\{\s*(?:[\w$]+\??\.)*\w*[aA]ccountCode\s*\}/;

/** Blank comments but keep every newline, so line numbers still match the original file. */
function stripForScan(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1')
    // accountLabel(...) / accountCodeAndName(...) arguments: a safe helper call may name any code.
    .replace(/\b(accountLabel|accountCodeAndName)\(([^()]*)\)/g, (_m, fn: string, args: string) =>
      `${fn}(${args.replace(/[^\n]/g, ' ')})`,
    )
    // Data-table key `account: '6400'` (not rendered; the table keeps the code and renders it via accountLabel).
    .replace(/\baccount:\s*(['"])(\d{4})\1/g, (_m, q: string, code: string) =>
      `account: ${q}${' '.repeat(code.length)}${q}`,
    )
    // value= / name= attributes (a <select> option value is the code by design).
    .replace(/\b(value|name|key)=(\{[^{}]*\}|"[^"]*"|'[^']*')/g, (_m, attr: string, val: string) =>
      `${attr}=${val.replace(/[^\n]/g, ' ')}`,
    );
}

function scanFile(relPath: string): string[] {
  const original = readFileSync(join(SRC, relPath), 'utf8').split(/\r?\n/);
  const stripped = stripForScan(original.join('\n')).split('\n');
  const hits: string[] = [];
  stripped.forEach((line, i) => {
    const bareCode = CODE_PATTERNS.find(({ re }) => re.test(line));
    const bareChild = BARE_JSX_CHILD.test(line);
    if (bareCode || bareChild) {
      const why = bareCode ? `bare code ${bareCode.code}` : 'bare {…accountCode} JSX child';
      hits.push(`apps/erp/src/${relPath}:${i + 1}  [${why}]  ${(original[i] ?? '').trim()}`);
    }
  });
  return hits;
}

describe('T-406 batch 1 + 2 — no bare account code in rendered text', () => {
  it('finds no swept file that prints a GL number on screen', () => {
    const present = SWEPT.filter((p) => existsSync(join(SRC, p)));
    const hits = present.flatMap((p) => scanFile(p));
    expect(
      hits,
      `Bare account code on screen. Use accountLabel(code) from src/lib/account-label.ts:\n${hits.join('\n')}`,
    ).toEqual([]);
  });
});

describe('T-406 — the SWEPT list is complete and honest', () => {
  it('every SWEPT path exists (a rename must not silently drop a file, M6)', () => {
    const missing = SWEPT.filter((p) => !existsSync(join(SRC, p)));
    expect(missing, `SWEPT paths missing on disk:\n${missing.join('\n')}`).toEqual([]);
  });

  it('no SWEPT file is also an ACCOUNTANT_PAGES file', () => {
    const accountantRes = ACCOUNTANT_PAGES.map(globToRegex);
    const overlap = SWEPT.filter((p) => accountantRes.some((re) => re.test(p)));
    expect(overlap).toEqual([]);
  });

  it('the batch 1 + 2 list is the 41 files from the spec', () => {
    expect(SWEPT).toHaveLength(41);
  });
});

describe('the scanner itself (self-check)', () => {
  const scan = (src: string) => {
    const stripped = stripForScan(src);
    return stripped.split('\n').some(
      (line) => CODE_PATTERNS.some(({ re }) => re.test(line)) || BARE_JSX_CHILD.test(line),
    );
  };

  it.each([
    'Owed (2110)',
    '<span>posts to 5400</span>',
    '{a.glAccountCode}',
    '{cat?.accountCode}',
    '`settled to ${c.receivableAccountCode}`',
    '<Row label="Cash → 1110" />',
  ])('flags a bare code in rendered text: %s', (line) => {
    expect(scan(line)).toBe(true);
  });

  it.each([
    '{accountLabel(a.glAccountCode)}',
    '{accountCodeAndName("2110")}',
    '<option value="2110">Owed to suppliers</option>',
    '{/* posts to 5400 */}',
    '// Owed (2110) was removed',
    '{cat?.accountCode ? accountLabel(cat.accountCode) : "unmapped"}',
    '{accountCodeAndName(l.accountCode)}',
    '<option key={a.accountCode} value="1110">Till cash</option>',
    '<tr key={a.accountCode}>',
    "{ name: 'commission', label: 'Commission', account: '6400', hint: 'The core transaction fee' },",
  ])('does not flag a sanctioned use: %s', (line) => {
    expect(scan(line)).toBe(false);
  });
});
