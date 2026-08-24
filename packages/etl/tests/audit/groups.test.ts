import { describe, expect, it } from 'vitest';
import { classifyGroups } from '../../src/audit/groups';
import type { LandedDocLike } from '../../src/audit/balances';

const LIPA = 'b9DzsnPbr1BUnY88lyT4';

let seq = 0;

function journalLeg(
  storeCode: string,
  sourceType: string,
  sourceId: string,
  overrides: Record<string, unknown> = {},
): LandedDocLike {
  seq += 1;
  const legKey = (overrides.legKey as string) ?? `leg-${seq}`;
  const docId = `${sourceType}:${sourceId}:${legKey}`;
  return {
    docPath: `stores/${storeCode}/journal/${docId}`,
    collectionPath: `stores/${storeCode}/journal`,
    storeCode,
    payload: {
      id: docId,
      storeId: storeCode,
      sourceType,
      sourceId,
      legKey,
      direction: 'in',
      amount: 100,
      businessDate: '2026-06-15',
      supplierId: null,
      customerId: null,
      employeeId: null,
      ...overrides,
    },
  };
}

function expenseDoc(storeCode: string, sourceId: string, payload: Record<string, unknown>): LandedDocLike {
  return {
    docPath: `stores/${storeCode}/expenses/${sourceId}`,
    collectionPath: `stores/${storeCode}/expenses`,
    storeCode,
    payload: { id: sourceId, dayKey: '2026-06-15', ...payload },
  };
}

function salesDayDoc(storeCode: string, sourceId: string, payload: Record<string, unknown>): LandedDocLike {
  return {
    docPath: `stores/${storeCode}/salesDays/${sourceId}`,
    collectionPath: `stores/${storeCode}/salesDays`,
    storeCode,
    payload: { id: sourceId, status: 'verified', ...payload },
  };
}

describe('invariant 9 — a balanced two-leg group classifies balances_as_is', () => {
  it('a transfer group whose two balance-sheet legs already net to zero', () => {
    const docs: LandedDocLike[] = [
      journalLeg(LIPA, 'transfer', 'T1', { accountId: 'cash__cashier', direction: 'out', amount: 500, legKey: 'a' }),
      journalLeg(LIPA, 'transfer', 'T1', { accountId: 'cash__office', direction: 'in', amount: 500, legKey: 'b' }),
    ];
    const result = classifyGroups(docs, { asOf: '2026-12-31' });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.classification).toBe('balances_as_is');
    expect(result.groups[0]!.imbalance).toBe('0.00');
  });
});

describe('invariant 10 — a single-leg expense group classifies balances_synthesized once the nominal leg is derived', () => {
  it('a lone cash funding leg + the matching expenses doc together balance', () => {
    const docs: LandedDocLike[] = [
      journalLeg(LIPA, 'expense_payment', 'EXP1', { accountId: 'cash__cashier', direction: 'out', amount: 15000 }),
      expenseDoc(LIPA, 'EXP1', {
        totalAmount: 15000,
        expenseEntryGroup: 'OPEX',
        category: 'Rent',
        payments: [{ amount: 15000, method: 'cash' }],
      }),
    ];
    const result = classifyGroups(docs, { asOf: '2026-12-31' });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.classification).toBe('balances_synthesized');
    expect(result.groups[0]!.imbalance).toBe('0.00');
  });

  it('a lone tender leg + the matching salesDay doc together balance', () => {
    const docs: LandedDocLike[] = [
      journalLeg(LIPA, 'sale', '2026-06-15', { accountId: 'cash__cashier', direction: 'in', amount: 50000 }),
      salesDayDoc(LIPA, '2026-06-15', {
        totalSales: 50000,
        dineInSales: 50000,
        takeOutSales: 0,
        cashPayments: 50000,
        totalDiscounts: 0,
        comps: 0,
      }),
    ];
    const result = classifyGroups(docs, { asOf: '2026-12-31' });
    expect(result.groups[0]!.classification).toBe('balances_synthesized');
  });
});

describe('invariant 11 — an unmappable category classifies ambiguous, with a reasonCode', () => {
  it('reuses convert.ts\'s OWN reasonCode (unmapped_expense_category) — never reinvented', () => {
    const docs: LandedDocLike[] = [
      journalLeg(LIPA, 'expense_payment', 'EXP2', { accountId: 'cash__cashier', direction: 'out', amount: 1000 }),
      expenseDoc(LIPA, 'EXP2', {
        totalAmount: 1000,
        expenseEntryGroup: 'OPEX',
        category: 'Not A Real Category',
        payments: [{ amount: 1000, method: 'cash' }],
      }),
    ];
    const result = classifyGroups(docs, { asOf: '2026-12-31' });
    expect(result.groups[0]!.classification).toBe('ambiguous');
    expect(result.groups[0]!.reasonCode).toBe('unmapped_expense_category');
  });
});

describe('invariant 12 — a group whose balance-sheet legs do not net classifies cannot_balance, with peso magnitude', () => {
  it('a "complete" sourceType (transfer) that leg-mapping.ts says always self-balances, but ours does not', () => {
    const docs: LandedDocLike[] = [
      journalLeg(LIPA, 'transfer', 'T2', { accountId: 'cash__cashier', direction: 'out', amount: 500, legKey: 'a' }),
      journalLeg(LIPA, 'transfer', 'T2', { accountId: 'cash__office', direction: 'in', amount: 300, legKey: 'b' }),
    ];
    const result = classifyGroups(docs, { asOf: '2026-12-31' });
    expect(result.groups[0]!.classification).toBe('cannot_balance');
    expect(result.groups[0]!.imbalance).toBe('200.00');
  });

  it('a synthesized expense whose amounts genuinely disagree with the raw legs', () => {
    const docs: LandedDocLike[] = [
      journalLeg(LIPA, 'expense_payment', 'EXP3', { accountId: 'cash__cashier', direction: 'out', amount: 9999 }),
      expenseDoc(LIPA, 'EXP3', {
        totalAmount: 15000, // disagrees with the leg's 9999
        expenseEntryGroup: 'OPEX',
        category: 'Rent',
        payments: [{ amount: 15000, method: 'cash' }],
      }),
    ];
    const result = classifyGroups(docs, { asOf: '2026-12-31' });
    expect(result.groups[0]!.classification).toBe('cannot_balance');
    expect(Number(result.groups[0]!.imbalance)).toBeCloseTo(5001, 2);
  });
});

describe('invariant 13 — classes are mutually exclusive; every group lands in exactly one', () => {
  it('a mixed batch of groups partitions cleanly with no group double-counted', () => {
    const docs: LandedDocLike[] = [
      // balances_as_is
      journalLeg(LIPA, 'transfer', 'G1', { accountId: 'cash__cashier', direction: 'out', amount: 100, legKey: 'a' }),
      journalLeg(LIPA, 'transfer', 'G1', { accountId: 'cash__office', direction: 'in', amount: 100, legKey: 'b' }),
      // balances_synthesized
      journalLeg(LIPA, 'expense_payment', 'G2', { accountId: 'cash__cashier', direction: 'out', amount: 500 }),
      expenseDoc(LIPA, 'G2', { totalAmount: 500, expenseEntryGroup: 'OPEX', category: 'Rent', payments: [{ amount: 500, method: 'cash' }] }),
      // ambiguous — no leg-mapping entry at all
      journalLeg(LIPA, 'commissary_dispatch', 'G3', { accountId: 'ar__CUST1', direction: 'in', amount: 700, customerId: 'CUST1' }),
      // cannot_balance
      journalLeg(LIPA, 'transfer', 'G4', { accountId: 'cash__cashier', direction: 'out', amount: 900, legKey: 'a' }),
      journalLeg(LIPA, 'transfer', 'G4', { accountId: 'cash__office', direction: 'in', amount: 400, legKey: 'b' }),
    ];
    const result = classifyGroups(docs, { asOf: '2026-12-31' });
    expect(result.groups).toHaveLength(4);
    const byClass = new Map<string, number>();
    for (const g of result.groups) byClass.set(g.classification, (byClass.get(g.classification) ?? 0) + 1);
    expect(byClass.get('balances_as_is')).toBe(1);
    expect(byClass.get('balances_synthesized')).toBe(1);
    expect(byClass.get('ambiguous')).toBe(1);
    expect(byClass.get('cannot_balance')).toBe(1);
    // Every group has exactly one classification field — trivially true by the type, but
    // also confirm the SUM of the four buckets equals the group count (T-112's lesson:
    // every input accounted for, nothing silently dropped or double-counted).
    const total = [...byClass.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(result.groups.length);
  });
});

describe('a real-data finding this task surfaced — a sourceType absent from leg-mapping.ts entirely', () => {
  it('a single-leg commissary_dispatch group (AR up, no revenue leg) classifies ambiguous, not a silent guess', () => {
    const docs: LandedDocLike[] = [
      journalLeg(LIPA, 'commissary_dispatch', 'CD1', { accountId: 'ar__CUST9', direction: 'in', amount: 2616.38, customerId: 'CUST9' }),
    ];
    const result = classifyGroups(docs, { asOf: '2026-12-31' });
    expect(result.groups[0]!.classification).toBe('ambiguous');
    expect(result.groups[0]!.reasonCode).toBe('unsupported_case_class');
  });
});

describe('a "sale" group whose sourceId is not a landed salesDay (the ar-charge/credit-sale collision T-113 already flagged)', () => {
  it('classifies ambiguous with missing_source_document, never guessed at', () => {
    const docs: LandedDocLike[] = [
      journalLeg(LIPA, 'sale', 'arTransactionIdNotADate', { accountId: 'ar__CUST5', direction: 'in', amount: 2010, customerId: 'CUST5' }),
    ];
    const result = classifyGroups(docs, { asOf: '2026-12-31' });
    expect(result.groups[0]!.classification).toBe('ambiguous');
    expect(result.groups[0]!.reasonCode).toBe('missing_source_document');
  });
});

describe('a group with an unresolvable account', () => {
  it('classifies ambiguous with unsupported_case_class, before ever calling adaptLegacyLegs', () => {
    const docs: LandedDocLike[] = [
      journalLeg(LIPA, 'transfer', 'G5', { accountId: 'totally__unknown', direction: 'in', amount: 100 }),
    ];
    const result = classifyGroups(docs, { asOf: '2026-12-31' });
    expect(result.groups[0]!.classification).toBe('ambiguous');
    expect(result.groups[0]!.reasonCode).toBe('unsupported_case_class');
  });
});

describe('a group with a non-positive amount leg', () => {
  it('classifies ambiguous with non_positive_amount', () => {
    const docs: LandedDocLike[] = [
      journalLeg(LIPA, 'transfer', 'G6', { accountId: 'cash__cashier', direction: 'in', amount: 0 }),
    ];
    const result = classifyGroups(docs, { asOf: '2026-12-31' });
    expect(result.groups[0]!.classification).toBe('ambiguous');
    expect(result.groups[0]!.reasonCode).toBe('non_positive_amount');
  });
});

describe('store scoping and asOf mirror balances.ts exactly', () => {
  it('an out-of-scope store leg never forms a group at all', () => {
    const docs: LandedDocLike[] = [journalLeg('XbkyEgZqunmj2wzhicNf', 'transfer', 'G7', {})];
    const result = classifyGroups(docs, { asOf: '2026-12-31' });
    expect(result.groups).toHaveLength(0);
  });

  it('a future-dated leg relative to asOf never forms a group', () => {
    const docs: LandedDocLike[] = [journalLeg(LIPA, 'transfer', 'G8', { businessDate: '2027-01-01' })];
    const result = classifyGroups(docs, { asOf: '2026-12-31' });
    expect(result.groups).toHaveLength(0);
  });

  it('the exclusion list is always present in the result', () => {
    const result = classifyGroups([], { asOf: '2026-12-31' });
    expect(result.excludedStores.length).toBeGreaterThan(0);
  });
});
