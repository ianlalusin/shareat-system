/**
 * T-353 (DEF-484) — `docs/tasks/353-def-484-money-lines-errors-before-input.md`, R2/R3/R6, legs
 * H1-H6.
 *
 * ⛔ This file imports `apps/erp/src/components/money/money-line-visibility.ts`, which the BUILDER
 * has not written yet. Until it exists, EVERY leg below fails at import time (a structural red),
 * not on its own assertion — that is expected and is the red this file records. Once the module
 * exists, each leg's own assertion is what must hold.
 *
 * The input issues are built with the REAL `validateMoneyLines` (`@shareat/domain/money-lines`),
 * never hand-written `MoneyLineIssue` objects — `visibleIssues` is judged against what the domain
 * actually returns, matching R6's "the component decides WHEN, never WHAT" split.
 */
import { describe, expect, it } from 'vitest';
import {
  accountAsSource,
  validateMoneyLines,
  type MoneyAccountOption,
  type MoneyLine,
  type MoneyLineIssue,
} from '@shareat/domain/money-lines';
// ⛔ Does not exist yet — the BUILDER's item 2. Every leg in this file is red until it does.
import { visibleIssues, type LineField } from '../src/components/money/money-line-visibility';

const cashierAccount: MoneyAccountOption = {
  id: 'acct-cashier-1',
  name: 'Front cashier',
  storeId: 'store-lipa',
  custodian: 'cashier',
  instrument: 'cash',
  glAccountCode: '1110',
  balance: '5000.00',
  overdraftLimit: '0.00',
  floatTarget: null,
};

const blankCashLineNoSource: MoneyLine = { method: 'cash', amount: '', moneyAccountId: null };

function issuesFor(lines: MoneyLine[], mustTotal?: string | null): MoneyLineIssue[] {
  return validateMoneyLines({
    direction: 'out',
    lines,
    sources: [accountAsSource(cashierAccount)],
    mustTotal: mustTotal ?? null,
  });
}

const touchedSet = (fields: LineField[] = []): Set<LineField> => new Set(fields);

/**
 * `noUncheckedIndexedAccess` (tsconfig.json) types `arr[0]` as possibly `undefined` even right
 * after `toHaveLength(1)` — a bare `!` would silently switch that check off at the point of use
 * (docs/RULES.md §2 row 206), so this is the guard instead (same idiom as
 * `remittance-overage-wiring.test.ts`'s `atIndex` helper).
 */
function first<T>(arr: readonly T[]): T {
  const [item] = arr;
  expect(item, 'expected at least one element').toBeDefined();
  return item as T;
}

describe('H1 — untouched, no submit attempt: nothing shows on a fresh blank line', () => {
  it(
    'wanted: [] — red today: the module does not exist (import fails). ' +
      'Same premise for H2-H6 below',
    () => {
      const issues = issuesFor([blankCashLineNoSource]);
      const visible = visibleIssues(issues, [touchedSet()], false);
      expect(visible).toEqual([]);
    },
  );
});

describe('H2 — touching only "amount" shows only the amount issue', () => {
  it('wanted: only the amount issue, no moneyAccountId issue — red today: import fails', () => {
    const issues = issuesFor([blankCashLineNoSource]);
    const visible = visibleIssues(issues, [touchedSet(['amount'])], false);
    expect(visible).toHaveLength(1);
    expect(first(visible).field).toBe('amount');
    expect(visible.some((i) => i.field === 'moneyAccountId')).toBe(false);
  });
});

describe('H3 — touching only the source fields shows only the Choose-where issue', () => {
  it('wanted: only the moneyAccountId issue, no amount issue — red today: import fails', () => {
    const issues = issuesFor([blankCashLineNoSource]);
    const visible = visibleIssues(
      issues,
      [touchedSet(['moneyAccountId', 'cashRequestId'])],
      false,
    );
    expect(visible).toHaveLength(1);
    expect(first(visible).field).toBe('moneyAccountId');
    expect(visible.some((i) => i.field === 'amount')).toBe(false);
  });
});

describe('H4 — a submit attempt shows every issue regardless of touch', () => {
  it('wanted: both issues (amount + moneyAccountId) — red today: import fails', () => {
    const issues = issuesFor([blankCashLineNoSource]);
    const visible = visibleIssues(issues, [touchedSet()], true);
    expect(visible).toHaveLength(2);
    expect(visible.some((i) => i.field === 'amount')).toBe(true);
    expect(visible.some((i) => i.field === 'moneyAccountId')).toBe(true);
  });
});

describe('H5 — a document-level issue (mustTotal mismatch) only shows once a field is touched', () => {
  const line: MoneyLine = { method: 'cash', amount: '50.00', moneyAccountId: cashierAccount.id };

  it('(a) untouched, no attempt: no document issue — red today: import fails', () => {
    const issues = issuesFor([line], '100.00');
    const visible = visibleIssues(issues, [touchedSet()], false);
    expect(visible.some((i) => i.line === null)).toBe(false);
  });

  it('(b) one field touched: the mismatch sentence shows — red today: import fails', () => {
    const issues = issuesFor([line], '100.00');
    const visible = visibleIssues(issues, [touchedSet(['amount'])], false);
    expect(visible.some((i) => i.field === 'document')).toBe(true);
    expect(
      visible.find((i) => i.field === 'document')!.message,
    ).toBe('The lines total 50.00 but this document is for 100.00.');
  });

  it('(c) untouched but a submit was attempted: the mismatch sentence shows — red today: import fails', () => {
    const issues = issuesFor([line], '100.00');
    const visible = visibleIssues(issues, [touchedSet()], true);
    expect(visible.some((i) => i.field === 'document')).toBe(true);
    expect(
      visible.find((i) => i.field === 'document')!.message,
    ).toBe('The lines total 50.00 but this document is for 100.00.');
  });
});

describe('H6 — touch is tracked per LINE, not globally across the form', () => {
  it(
    'wanted: only line 1\'s amount issue, nothing for line 0 — red today: import fails',
    () => {
      const lines: MoneyLine[] = [blankCashLineNoSource, { ...blankCashLineNoSource }];
      const issues = issuesFor(lines);
      const visible = visibleIssues(issues, [touchedSet(), touchedSet(['amount'])], false);

      expect(visible).toHaveLength(1);
      expect(first(visible).line).toBe(1);
      expect(first(visible).field).toBe('amount');
      expect(visible.some((i) => i.line === 0)).toBe(false);
    },
  );
});
