/**
 * T-353 (DEF-484) — `docs/tasks/353-def-484-money-lines-errors-before-input.md`, R2/R3/R6, legs
 * H1-H6. Plus S2 follow-ups K2/K3 (review of `f69a9ff`, 2026-09-29).
 *
 * ⛔ This file imports `apps/erp/src/components/money/money-line-visibility.ts`, which the BUILDER
 * has not written yet. Until it exists, EVERY leg below fails at import time (a structural red),
 * not on its own assertion — that is expected and is the red this file records. Once the module
 * exists, each leg's own assertion is what must hold.
 *
 * The input issues are built with the REAL `validateMoneyLines` (`@shareat/domain/money-lines`),
 * never hand-written `MoneyLineIssue` objects — `visibleIssues` is judged against what the domain
 * actually returns, matching R6's "the component decides WHEN, never WHAT" split.
 *
 * ⭐ S2 SIGNATURE CHANGE (K2/K3), for the builder: `visibleIssues`'s third parameter is renamed from
 * `attempted: boolean` to `attemptedLineCount: number | null` —
 *   - `null` = no submit attempt yet (was `false`);
 *   - a number = a submit attempt WAS made, and it is the number of lines that existed AT that
 *     attempt (was `true`). K2's ruling: "a submit attempt reveals the lines that existed AT the
 *     attempt; rows added later start quiet." A per-line issue shows once attempted if
 *     `issue.line < attemptedLineCount`, so a row appended afterwards (index `>= attemptedLineCount`)
 *     stays quiet until its own field is touched.
 *   - K3's ruling: a document-level issue (`line: null`) shows once ANY line's `amount` field has
 *     been touched, or once `attemptedLineCount !== null` — no longer "any field on any line",
 *     because a bare tab-through the method select (which has a default and marks touched on blur)
 *     must not unlock a document-level sentence nobody asked for yet.
 * Every call to `visibleIssues` below already uses the new signature.
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
 * T-353 S3 H1 — mirrors `MoneyLines.tsx`'s `ALL_LINE_FIELDS`. After H1's remedy, `onAttempt` marks
 * every one of these touched for each THEN-EXISTING line — this is what a leg simulating that
 * component behaviour passes as the line's touched set, instead of relying on `attemptedLineCount`
 * alone (the retired per-line mechanic).
 */
const ALL_FIELDS_TOUCHED: LineField[] = ['method', 'amount', 'moneyAccountId', 'cashRequestId', 'staffId'];

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
      const visible = visibleIssues(issues, [touchedSet()], null);
      expect(visible).toEqual([]);
    },
  );
});

describe('H2 — touching only "amount" shows only the amount issue', () => {
  it('wanted: only the amount issue, no moneyAccountId issue — red today: import fails', () => {
    const issues = issuesFor([blankCashLineNoSource]);
    const visible = visibleIssues(issues, [touchedSet(['amount'])], null);
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
      null,
    );
    expect(visible).toHaveLength(1);
    expect(first(visible).field).toBe('moneyAccountId');
    expect(visible.some((i) => i.field === 'amount')).toBe(false);
  });
});

/**
 * H4 — RE-PINNED by T-353 S3's H1 (not weakened). The ORIGINAL H4 asserted
 * `visibleIssues(issues, [touchedSet()], 1)` (an UNTOUCHED line, attemptedLineCount 1) shows BOTH
 * issues — but S3's H1 leg (below, "append then remove the ORIGINAL row") calls `visibleIssues` with
 * the IDENTICAL arguments (an untouched line, attemptedLineCount 1) and wants `[]`. A pure function
 * cannot satisfy both on the same input — H1's remedy RETIRES attemptedLineCount as the per-line
 * gate entirely: the COMPONENT (`MoneyLines.tsx`'s `onAttempt`) now marks every then-existing line's
 * fields TOUCHED at attempt time, and `visibleIssues` reveals a per-line issue only via `touched`,
 * never via `issue.line < attemptedLineCount`. attemptedLineCount survives only for the
 * DOCUMENT-level gate (K3).
 */
describe('H4 (re-pinned by T-353 S3 H1) — after H1: an attempt reveals a line\'s issues because the COMPONENT marks its fields touched, never via attemptedLineCount alone', () => {
  it('touched already carries the fields an attempt would have marked (simulating onAttempt\'s post-H1 behaviour) — wanted: both issues (amount + moneyAccountId)', () => {
    const issues = issuesFor([blankCashLineNoSource]);
    // attemptedLineCount is still set (K2/K3 bookkeeping, and it still gates the document-level
    // issue below) — but per-line revelation here comes from `touched`, not from `0 < 1`.
    const visible = visibleIssues(issues, [touchedSet(ALL_FIELDS_TOUCHED)], 1);
    expect(visible).toHaveLength(2);
    expect(visible.some((i) => i.field === 'amount')).toBe(true);
    expect(visible.some((i) => i.field === 'moneyAccountId')).toBe(true);
  });

  it('the document-level "attempted" gate still shows document issues on its own (K3, unaffected by H1\'s per-line retirement)', () => {
    const line: MoneyLine = { method: 'cash', amount: '50.00', moneyAccountId: cashierAccount.id };
    const issues = issuesFor([line], '100.00');
    const visible = visibleIssues(issues, [touchedSet()], 1);
    expect(visible.some((i) => i.field === 'document')).toBe(true);
  });
});

describe('H5 — a document-level issue (mustTotal mismatch) only shows once a field is touched', () => {
  const line: MoneyLine = { method: 'cash', amount: '50.00', moneyAccountId: cashierAccount.id };

  it('(a) untouched, no attempt: no document issue — red today: import fails', () => {
    const issues = issuesFor([line], '100.00');
    const visible = visibleIssues(issues, [touchedSet()], null);
    expect(visible.some((i) => i.line === null)).toBe(false);
  });

  it('(b) one field touched: the mismatch sentence shows — red today: import fails', () => {
    const issues = issuesFor([line], '100.00');
    const visible = visibleIssues(issues, [touchedSet(['amount'])], null);
    expect(visible.some((i) => i.field === 'document')).toBe(true);
    expect(
      visible.find((i) => i.field === 'document')!.message,
    ).toBe('The lines total 50.00 but this document is for 100.00.');
  });

  it('(c) untouched but a submit was attempted: the mismatch sentence shows — red today: import fails', () => {
    const issues = issuesFor([line], '100.00');
    // K2: one line existed at the attempt, so attemptedLineCount is 1.
    const visible = visibleIssues(issues, [touchedSet()], 1);
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
      const visible = visibleIssues(issues, [touchedSet(), touchedSet(['amount'])], null);

      expect(visible).toHaveLength(1);
      expect(first(visible).line).toBe(1);
      expect(first(visible).field).toBe('amount');
      expect(visible.some((i) => i.line === 0)).toBe(false);
    },
  );
});

describe('K2 (S2 follow-up) — a line added AFTER a submit attempt starts quiet', () => {
  /**
   * Legs 1-2 RE-PINNED by T-353 S3 H1 (not weakened) — the ORIGINAL legs passed
   * `[touchedSet(), touchedSet()]` (both lines UNTOUCHED) and relied on `attemptedLineCount` alone
   * to reveal line 0's issues, which is the exact per-line mechanic H1 retires (same contradiction
   * as H4's, against the H1 leg below). Post-H1, `onAttempt` marks every THEN-EXISTING line's
   * fields touched at attempt time, so these legs now pass touched sets reflecting that: only the
   * lines present AT each attempt are marked, lines appended afterwards stay untouched. The
   * OUTCOME (line 0 shows, line 1 stays quiet until it existed at its own attempt) is unchanged —
   * only how it's produced changes, from "attemptedLineCount" to "touched".
   */
  it(
    'attempt when only line 0 existed: onAttempt marks line 0 touched, line 1 (appended later, ' +
      'still untouched) shows nothing',
    () => {
      const lines: MoneyLine[] = [blankCashLineNoSource, { ...blankCashLineNoSource }];
      const issues = issuesFor(lines);
      // Both lines are identical and blank, so `issues` has 2 amount + 2 moneyAccountId issues,
      // one pair per line. Only line 0 existed at the attempt, so only its fields were marked
      // touched; line 1 was appended afterwards and neither of its fields has been touched.
      const visible = visibleIssues(issues, [touchedSet(ALL_FIELDS_TOUCHED), touchedSet()], 1);

      expect(visible.every((i) => i.line === 0)).toBe(true);
      expect(visible.some((i) => i.field === 'amount')).toBe(true);
      expect(visible.some((i) => i.field === 'moneyAccountId')).toBe(true);
      expect(visible.some((i) => i.line === 1)).toBe(false);
    },
  );

  it(
    'a later attempt, both lines now present: onAttempt marks BOTH lines touched, revealing line 1 ' +
      'too — the quiet period is only until the NEXT attempt, not forever',
    () => {
      const lines: MoneyLine[] = [blankCashLineNoSource, { ...blankCashLineNoSource }];
      const issues = issuesFor(lines);
      const visible = visibleIssues(
        issues,
        [touchedSet(ALL_FIELDS_TOUCHED), touchedSet(ALL_FIELDS_TOUCHED)],
        2,
      );

      expect(visible.some((i) => i.line === 0)).toBe(true);
      expect(visible.some((i) => i.line === 1)).toBe(true);
    },
  );

  it(
    'a line 1 field that IS touched shows regardless of attemptedLineCount — touch always wins, ' +
      'independent of the attempt bookkeeping',
    () => {
      const lines: MoneyLine[] = [blankCashLineNoSource, { ...blankCashLineNoSource }];
      const issues = issuesFor(lines);
      const visible = visibleIssues(issues, [touchedSet(), touchedSet(['amount'])], 1);

      const line1Issues = visible.filter((i) => i.line === 1);
      expect(line1Issues).toHaveLength(1);
      expect(first(line1Issues).field).toBe('amount');
    },
  );
});

describe('H1 (S3 follow-up) — append then remove the ORIGINAL row: the remaining, never-touched row must show nothing', () => {
  it(
    'attempt with 1 line, append a row, delete the ORIGINAL (index 0) — attemptedLineCount survives ' +
      'the shift unchanged (1) and the re-indexed appended row lands at index 0, so 0 < 1 still holds — ' +
      'wanted: [] (nobody touched this row and it was not present at the attempt), got today: both ' +
      "DEF-484 sentences, on a row nobody touched. A count can't survive an index shift.",
    () => {
      // The remaining row IS the appended one, re-indexed to 0 by MoneyLines.tsx's remove handler
      // (`setLines`/`setTouched` both `.filter((_, n) => n !== i)`) — its own validation issues, from
      // the real domain function, exactly like every other leg in this file. Its touched set is
      // genuinely empty: it was appended after the attempt and nobody has touched it.
      const issues = issuesFor([blankCashLineNoSource]);
      const visible = visibleIssues(issues, [touchedSet()], 1);
      expect(visible, `expected [], got: ${JSON.stringify(visible)}`).toEqual([]);
    },
  );
});

describe('K3 (S2 follow-up) — a document-level issue needs an AMOUNT touch, not just any field', () => {
  const line: MoneyLine = { method: 'cash', amount: '50.00', moneyAccountId: cashierAccount.id };

  it(
    'only "method" touched (the select has a default and marks touched on blur — a bare tab-' +
      'through), no attempt: the document issue stays hidden — red today: any touched field ' +
      'unlocks it',
    () => {
      const issues = issuesFor([line], '100.00');
      const visible = visibleIssues(issues, [touchedSet(['method'])], null);
      expect(visible.some((i) => i.line === null)).toBe(false);
    },
  );

  it(
    'only "moneyAccountId"/"cashRequestId" touched, no attempt: still hidden — a source pick is ' +
      'not an amount touch either',
    () => {
      const issues = issuesFor([line], '100.00');
      const visible = visibleIssues(
        issues,
        [touchedSet(['moneyAccountId', 'cashRequestId'])],
        null,
      );
      expect(visible.some((i) => i.line === null)).toBe(false);
    },
  );

  it('"amount" touched, no attempt: the document issue shows', () => {
    const issues = issuesFor([line], '100.00');
    const visible = visibleIssues(issues, [touchedSet(['amount'])], null);
    expect(visible.some((i) => i.field === 'document')).toBe(true);
  });

  it('no field touched at all, but a submit was attempted: the document issue shows', () => {
    const issues = issuesFor([line], '100.00');
    const visible = visibleIssues(issues, [touchedSet()], 1);
    expect(visible.some((i) => i.field === 'document')).toBe(true);
  });
});
