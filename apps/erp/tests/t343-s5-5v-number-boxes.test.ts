/**
 * T-343 S5.5v — DEF-472 census (money / integer count / rate boxes).
 * `docs/tasks/343-def-417-human-readable-refusals.md` §S5.5v item 1.
 *
 * ⛔ TESTER, not BUILDER. Every listed `<input>` still carries `type="number"` and `step`/`min` —
 * measured directly below, never presumed.
 *
 * ⚠️ Several files reuse the literal `name="amount"` for more than one box on the page
 * (cash-requests/[id], loans/[id], liabilities/[id], owners/[id]) — S5.5t's `inputTagFor`
 * ("exactly once per file") does not fit those. `nthInputTagFor` below locates the Nth occurrence
 * by source order instead, which survives line drift the same way name-matching does.
 *
 * ⚠️ Tag slice anchored on the FIRST `/>`, not the first `>` (same fix S5.5v's Amendment A1 makes to
 * `t343-s5-5s-number-boxes.test.ts:46`): `channel-settlements/SettlementForm.tsx`'s boxes carry an
 * inline `onChange={(e) => setGross(e.target.value)}`, and that arrow's own `=>` contains a `>` that
 * would truncate a first-`>` slice before the tag's real attributes (`type`, `step`, `inputMode`).
 */
import { readControlSource } from './helpers/control-source';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..', '..');

/** T-440: the controls are `<Input`/`<input`; the nearest opening tag of either. */
function lastInputTag(src: string, before: number): number {
  return Math.max(src.lastIndexOf('<input', before), src.lastIndexOf('<Input', before));
}

function allInputTags(filePath: string, nameLiteral: string): string[] {
  const src = readControlSource(resolve(repoRoot, filePath), 'utf8');
  const needle = `name=${nameLiteral}`;
  const tags: string[] = [];
  let from = 0;
  for (;;) {
    const nameIdx = src.indexOf(needle, from);
    if (nameIdx === -1) break;
    const tagStart = lastInputTag(src, nameIdx);
    expect(tagStart, `no preceding <input for "${needle}" in ${filePath}`).toBeGreaterThan(-1);
    const tagEnd = src.indexOf('/>', nameIdx);
    expect(tagEnd, `no closing "/>" for the <input carrying "${needle}" in ${filePath}`).toBeGreaterThan(-1);
    tags.push(src.slice(tagStart, tagEnd + 2));
    from = tagEnd + 2;
  }
  return tags;
}

function nthInputTagFor(filePath: string, nameLiteral: string, n: number): string {
  const tags = allInputTags(filePath, nameLiteral);
  expect(tags.length, `"name=${nameLiteral}" must appear at least ${n} time(s) in ${filePath}, found ${tags.length}`).toBeGreaterThanOrEqual(n);
  return tags[n - 1]!;
}

function assertConverted(filePath: string, nameLiteral: string, inputMode: 'numeric' | 'decimal', n = 1) {
  const tag = nthInputTagFor(filePath, nameLiteral, n);
  expect(tag, `${filePath} ${nameLiteral}[${n}]: must not carry type="number"`).not.toMatch(/type=["']number["']/);
  expect(tag, `${filePath} ${nameLiteral}[${n}]: must not carry a step= attribute`).not.toMatch(/\bstep=/);
  expect(tag, `${filePath} ${nameLiteral}[${n}]: must not carry a min= attribute`).not.toMatch(/\bmin=/);
  expect(tag, `${filePath} ${nameLiteral}[${n}]: must not carry a max= attribute`).not.toMatch(/\bmax=/);
  expect(tag, `${filePath} ${nameLiteral}[${n}]: must carry inputMode="${inputMode}"`).toMatch(
    new RegExp(`inputMode=["']${inputMode}["']`),
  );
}

describe('R-legs — source-text: each of the 22 S5.5v boxes has no type="number"/step/min/max, and the assigned inputMode', () => {
  it('channel-settlements/SettlementForm.tsx — grossAmount (decimal)', () => {
    assertConverted('apps/erp/src/app/channel-settlements/SettlementForm.tsx', '"grossAmount"', 'decimal');
  });
  it('channel-settlements/SettlementForm.tsx — netDeposited (decimal)', () => {
    assertConverted('apps/erp/src/app/channel-settlements/SettlementForm.tsx', '"netDeposited"', 'decimal');
  });
  it('cash-requests/page.tsx — amount (decimal)', () => {
    assertConverted('apps/erp/src/app/cash-requests/page.tsx', '"amount"', 'decimal');
  });
  it('cash-requests/[id]/page.tsx — amount[1] approve (decimal)', () => {
    assertConverted('apps/erp/src/app/cash-requests/[id]/page.tsx', '"amount"', 'decimal', 1);
  });
  it('cash-requests/[id]/page.tsx — amount[2] release (decimal)', () => {
    assertConverted('apps/erp/src/app/cash-requests/[id]/page.tsx', '"amount"', 'decimal', 2);
  });
  it('money-transfers/RecordTransferForm.tsx — amountOut (decimal)', () => {
    assertConverted('apps/erp/src/app/money-transfers/RecordTransferForm.tsx', '"amountOut"', 'decimal');
  });
  it('cutover/opening/page.tsx — amount (decimal)', () => {
    assertConverted('apps/erp/src/app/cutover/opening/page.tsx', '"amount"', 'decimal');
  });
  it('fixed-assets/new/page.tsx — usefulLifeMonths (numeric)', () => {
    assertConverted('apps/erp/src/app/fixed-assets/new/page.tsx', '"usefulLifeMonths"', 'numeric');
  });
  it('fixed-assets/[id]/page.tsx — usefulLifeMonths (numeric)', () => {
    assertConverted('apps/erp/src/app/fixed-assets/[id]/page.tsx', '"usefulLifeMonths"', 'numeric');
  });
  it('loans/page.tsx — principalAmount (decimal)', () => {
    assertConverted('apps/erp/src/app/loans/page.tsx', '"principalAmount"', 'decimal');
  });
  it('loans/page.tsx — interestRate (decimal)', () => {
    assertConverted('apps/erp/src/app/loans/page.tsx', '"interestRate"', 'decimal');
  });
  it('loans/page.tsx — termPeriods (numeric)', () => {
    assertConverted('apps/erp/src/app/loans/page.tsx', '"termPeriods"', 'numeric');
  });
  it('loans/[id]/page.tsx — amount[1] disburse (decimal)', () => {
    assertConverted('apps/erp/src/app/loans/[id]/page.tsx', '"amount"', 'decimal', 1);
  });
  it('loans/[id]/page.tsx — amount[2] payment (decimal)', () => {
    assertConverted('apps/erp/src/app/loans/[id]/page.tsx', '"amount"', 'decimal', 2);
  });
  it('liabilities/[id]/page.tsx — amount[1] charge (decimal)', () => {
    assertConverted('apps/erp/src/app/liabilities/[id]/page.tsx', '"amount"', 'decimal', 1);
  });
  it('liabilities/[id]/page.tsx — amount[2] pay (decimal)', () => {
    assertConverted('apps/erp/src/app/liabilities/[id]/page.tsx', '"amount"', 'decimal', 2);
  });
  it('customers/price-lists/[id]/page.tsx — rate (decimal)', () => {
    assertConverted('apps/erp/src/app/customers/price-lists/[id]/page.tsx', '"rate"', 'decimal');
  });
  it('payroll/page.tsx — amount (decimal)', () => {
    assertConverted('apps/erp/src/app/payroll/page.tsx', '"amount"', 'decimal');
  });
  it('owners/[id]/SettleForm.tsx — amount settle (decimal; the settle form moved to a client component in T-440)', () => {
    assertConverted('apps/erp/src/app/owners/[id]/SettleForm.tsx', '"amount"', 'decimal');
  });
  it('owners/[id]/page.tsx — amount[1] contribution (decimal)', () => {
    assertConverted('apps/erp/src/app/owners/[id]/page.tsx', '"amount"', 'decimal', 1);
  });
  it('owners/[id]/page.tsx — amount[2] drawing (decimal)', () => {
    assertConverted('apps/erp/src/app/owners/[id]/page.tsx', '"amount"', 'decimal', 2);
  });
  it('service-charge/page.tsx — amount (decimal)', () => {
    assertConverted('apps/erp/src/app/service-charge/page.tsx', '"amount"', 'decimal');
  });
});

describe('PV4 (S5.5v Amendment A3) — SettlementForm.check() must pass gross/net through UNCOERCED', () => {
  it(
    '`grossAmount: gross,` / `netDeposited: net,` with no `|| \'0\'` fallback (builder landed) — so ' +
      'a blank box reaches the domain\'s figureBlank refusal, not a silently-substituted zero; ' +
      '"Check the numbers" can no longer show "reconciles exactly" and enable Post for a genuinely ' +
      'blank gross',
    () => {
      const src = readControlSource(
        resolve(repoRoot, 'apps/erp/src/app/channel-settlements/SettlementForm.tsx'),
        'utf8',
      );
      const checkStart = src.indexOf('function check()');
      expect(checkStart, 'expected a function check() in SettlementForm.tsx').toBeGreaterThan(-1);
      const checkEnd = src.indexOf('\n  }\n', checkStart);
      const body = src.slice(checkStart, checkEnd);
      expect(body, 'grossAmount must no longer be coerced').not.toMatch(/grossAmount:\s*gross\s*\|\|\s*'0'/);
      expect(body, 'netDeposited must no longer be coerced').not.toMatch(/netDeposited:\s*net\s*\|\|\s*'0'/);
      expect(body, 'grossAmount must be passed through as-is').toMatch(/grossAmount:\s*gross,/);
      expect(body, 'netDeposited must be passed through as-is').toMatch(/netDeposited:\s*net,/);
    },
  );
});

describe('⛔ green, unedited — the one box S5.5v/S5.5w deliberately leave as type="number"', () => {
  it('payroll/thirteenth-month/page.tsx — year stays type="number" (GET preview parameter, harmless)', () => {
    // ⚠️ `name="year"` also appears on two `type="hidden"` carry-through fields (the post form
    // replays the previewed year); only the VISIBLE box (the one also carrying `type="number"`) is
    // this leg's subject, so this pins on that combination rather than a bare "exactly once" count.
    const tags = allInputTags('apps/erp/src/app/payroll/thirteenth-month/page.tsx', '"year"');
    const visible = tags.filter((t) => /type=["']number["']/.test(t));
    expect(visible, `expected exactly one visible number box named "year", found ${tags.length} "year" inputs total`).toHaveLength(1);
    expect(visible[0]).toMatch(/type=["']number["']/);
  });
});
