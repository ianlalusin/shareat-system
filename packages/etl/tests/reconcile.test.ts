import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ReconciliationError,
  assertCaptureTallyReconciles,
  assertConversionTallyReconciles,
  tallyConversionOutcomes,
  type ClassifyOutcome,
} from '../src/reconcile';

/**
 * Unit tests for the reconciliation computation — docs/tasks/112-etl-framework.md §5.
 * No database (task Scope). Proves invariants 14-17 directly against the pure
 * tally/assert functions, independent of run.ts's orchestration and of any real
 * converter — see reconcile.ts's top comment for why this file never imports convert.ts.
 */

function converted(sourceType: string, lines: { debit?: string; credit?: string }[]): ClassifyOutcome {
  return {
    sourceType,
    caseClass: null,
    status: 'converted',
    entries: [
      {
        entryDate: '2026-01-05',
        sourceType,
        sourceId: 'doc-1',
        idempotencyKey: 'etl:doc-1',
        memo: null,
        lines: lines.map((l) => ({ accountCode: '1110', debit: l.debit, credit: l.credit })),
      },
    ],
  };
}

function skipped(sourceType: string, reason = 'voided'): ClassifyOutcome {
  return { sourceType, caseClass: null, status: 'skipped', reason };
}

function quarantined(sourceType: string, reasonCode = 'unmapped_expense_category'): ClassifyOutcome {
  return {
    sourceType,
    caseClass: 'expense.ap',
    status: 'quarantined',
    reasonCode,
    reasonDetail: 'category "widgets" is not in the crosswalk',
  };
}

describe('tallyConversionOutcomes', () => {
  it('buckets converted/skipped/quarantined and sums debit/credit only from converted entries', () => {
    const outcomes: ClassifyOutcome[] = [
      converted('sale', [{ debit: '100.00' }, { credit: '100.00' }]),
      converted('sale', [{ debit: '50.00' }, { credit: '50.00' }]),
      skipped('sale'),
      quarantined('sale'),
    ];
    const tally = tallyConversionOutcomes('sale', 4, outcomes, 0);

    expect(tally.convertedCount).toBe(2);
    expect(tally.skippedCount).toBe(1);
    expect(tally.quarantinedCount).toBe(1);
    expect(tally.landedCount).toBe(4);
    expect(tally.debitTotal).toBe('150.00');
    expect(tally.creditTotal).toBe('150.00');
  });

  it('sums sourceAmount across EVERY outcome regardless of status (Contract §5: recorded, never gated)', () => {
    const outcomes: ClassifyOutcome[] = [
      { ...converted('sale', [{ debit: '10.00' }]), sourceAmount: '10.00' },
      { ...skipped('sale'), sourceAmount: '5.00' },
      { ...quarantined('sale'), sourceAmount: '3.00' },
    ];
    const tally = tallyConversionOutcomes('sale', 3, outcomes, 0);
    expect(tally.sourceAmountTotal).toBe('18.00');
  });

  it('landedCount is whatever the caller supplies — NEVER derived from outcomes.length', () => {
    // Only 2 outcomes, but the caller independently counted 5 landed documents — this
    // is exactly the shape invariant 15's regression case takes (a document dropped
    // between landing and classification never produced an outcome at all).
    const outcomes: ClassifyOutcome[] = [converted('sale', [{ debit: '1.00' }]), skipped('sale')];
    const tally = tallyConversionOutcomes('sale', 5, outcomes, 0);
    expect(tally.landedCount).toBe(5);
    expect(tally.convertedCount + tally.skippedCount + tally.quarantinedCount).toBe(2);
  });

  it('entriesPosted is passed through verbatim, never computed from the outcomes', () => {
    const tally = tallyConversionOutcomes('sale', 1, [converted('sale', [{ debit: '1.00' }])], 7);
    expect(tally.entriesPosted).toBe(7);
  });
});

describe('assertConversionTallyReconciles — invariant 14 (converted+skipped+quarantined=landed, HARD)', () => {
  it('does not throw when the bucket sum equals landedCount', () => {
    const tally = tallyConversionOutcomes(
      'sale',
      3,
      [converted('sale', [{ debit: '1.00' }, { credit: '1.00' }]), skipped('sale'), quarantined('sale')],
      0,
    );
    expect(() => assertConversionTallyReconciles(tally, 'analyze')).not.toThrow();
  });

  it('invariant 15 — a deliberately induced drop (landedCount > bucket sum) throws, naming the numbers', () => {
    // The regression test for invariant 14, per the task spec's own words: simulates a
    // document that landed but never produced an outcome at all (a bug in whatever
    // walked the landed set, not a legitimate skip/quarantine).
    const outcomes: ClassifyOutcome[] = [converted('sale', [{ debit: '1.00' }, { credit: '1.00' }])];
    const tally = tallyConversionOutcomes('sale', 2, outcomes, 0); // landedCount=2, only 1 outcome
    expect(() => assertConversionTallyReconciles(tally, 'analyze')).toThrow(ReconciliationError);
    expect(() => assertConversionTallyReconciles(tally, 'analyze')).toThrow(/landed_count is 2/);
  });

  it('also throws when the bucket sum EXCEEDS landedCount (double counting is equally a bug)', () => {
    const outcomes: ClassifyOutcome[] = [converted('sale', [{ debit: '1.00' }]), skipped('sale')];
    const tally = tallyConversionOutcomes('sale', 1, outcomes, 0); // landedCount=1, but 2 outcomes
    expect(() => assertConversionTallyReconciles(tally, 'analyze')).toThrow(ReconciliationError);
  });
});

describe('assertConversionTallyReconciles — invariant 17 (debit_total=credit_total, HARD only in load mode)', () => {
  it('throws in load mode when debit and credit totals disagree', () => {
    const outcomes: ClassifyOutcome[] = [converted('sale', [{ debit: '100.00' }, { credit: '90.00' }])];
    const tally = tallyConversionOutcomes('sale', 1, outcomes, 1);
    expect(() => assertConversionTallyReconciles(tally, 'load')).toThrow(ReconciliationError);
    expect(() => assertConversionTallyReconciles(tally, 'load')).toThrow(/debit_total/);
  });

  it('does NOT throw for the same imbalance in analyze mode — the gate is load-only (Contract §5)', () => {
    const outcomes: ClassifyOutcome[] = [converted('sale', [{ debit: '100.00' }, { credit: '90.00' }])];
    const tally = tallyConversionOutcomes('sale', 1, outcomes, 0);
    expect(() => assertConversionTallyReconciles(tally, 'analyze')).not.toThrow();
  });

  it('does not throw in load mode when debit equals credit', () => {
    const outcomes: ClassifyOutcome[] = [converted('sale', [{ debit: '100.00' }, { credit: '100.00' }])];
    const tally = tallyConversionOutcomes('sale', 1, outcomes, 1);
    expect(() => assertConversionTallyReconciles(tally, 'load')).not.toThrow();
  });
});

describe('structural — invariant 22', () => {
  it('packages/etl/package.json declares NO Firebase/Firestore dependency', () => {
    const pkgPath = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies?: Record<string, string> };
    const deps = Object.keys(pkg.dependencies ?? {});
    const firebaseDeps = deps.filter((d) => /firebase/i.test(d));
    expect(
      firebaseDeps,
      `the read-only guarantee (Contract §1) is a fact about the dependency graph, not a ` +
        `promise — found: ${firebaseDeps.join(', ')}`,
    ).toEqual([]);
  });
});

describe('assertCaptureTallyReconciles — invariant 16 (source_count=landed_count, HARD)', () => {
  it('does not throw when source_count equals landed_count', () => {
    expect(() =>
      assertCaptureTallyReconciles({ sourceType: 'stores/A/salesDays', sourceCount: 10, landedCount: 10 }),
    ).not.toThrow();
  });

  it('throws, naming both numbers, when a read/land failure makes them disagree', () => {
    expect(() =>
      assertCaptureTallyReconciles({ sourceType: 'stores/A/salesDays', sourceCount: 10, landedCount: 9 }),
    ).toThrow(ReconciliationError);
    expect(() =>
      assertCaptureTallyReconciles({ sourceType: 'stores/A/salesDays', sourceCount: 10, landedCount: 9 }),
    ).toThrow(/source_count \(10\) != landed_count \(9\)/);
  });
});
