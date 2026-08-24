import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STORE_IDS,
  EXCLUDED_STORES,
  OPERATING_STORES,
  filterJournalDocs,
  parseJournalLeg,
  reconstructBalances,
  resolveV1Account,
  type LandedDocLike,
} from '../../src/audit/balances';
import { adaptLegacyLegs } from '../../../domain/src/ledger/legacy-adapter';

const LIPA = 'b9DzsnPbr1BUnY88lyT4';
const MALVAR = 'dZUyvX4q824JBSVDAfE9';
const TEST_STORE = 'XbkyEgZqunmj2wzhicNf';

let seq = 0;

function leg(storeCode: string, overrides: Record<string, unknown> = {}): LandedDocLike {
  seq += 1;
  const sourceType = (overrides.sourceType as string) ?? 'expense_payment';
  const sourceId = (overrides.sourceId as string) ?? `src-${seq}`;
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

describe('resolveV1Account — the v1 accountId -> v2 code crosswalk', () => {
  it('resolves a FIXED legacyCode 1:1', () => {
    expect(resolveV1Account('cash__cashier')?.code).toBe('1110');
    expect(resolveV1Account('expense__salary')?.code).toBe('6100');
  });

  it('resolves a per-entity PREFIX to its control account', () => {
    expect(resolveV1Account('ap__SUP123')?.code).toBe('2110');
    expect(resolveV1Account('ar__CUST456')?.code).toBe('1210');
    expect(resolveV1Account('staff_advance__STAFF1')?.code).toBe('1230');
    expect(resolveV1Account('staff_reimbursable__STAFF2')?.code).toBe('2130');
  });

  it('prefers the MORE SPECIFIC prefix over a generic one it is a substring of', () => {
    // asset__due_from_X is a substring match for the generic asset__ prefix too — the
    // more specific due-from rule must win (this file's PREFIX_RULES ordering).
    expect(resolveV1Account('asset__due_from_STOREKEY')?.code).toBe('1250');
    expect(resolveV1Account('asset__AST001')?.code).toBe('1510');
    expect(resolveV1Account('ar__channel_abc123')?.code).toBe('1220');
    expect(resolveV1Account('ar__CUST1')?.code).toBe('1210');
    expect(resolveV1Account('liability__due_to_STOREKEY')?.code).toBe('2150');
    expect(resolveV1Account('liability__salaries_payable')?.code).toBe('2300'); // fixed, not a prefix hit
  });

  it('returns null for a genuinely unmapped accountId — never a guess', () => {
    expect(resolveV1Account('totally__unknown_thing')).toBeNull();
  });
});

describe('filterJournalDocs', () => {
  it('keeps only docs whose collectionPath ends in /journal', () => {
    const docs: LandedDocLike[] = [
      leg(LIPA),
      { docPath: 'stores/x/expenses/e1', collectionPath: 'stores/x/expenses', storeCode: 'x', payload: {} },
    ];
    expect(filterJournalDocs(docs)).toHaveLength(1);
  });
});

describe('invariant 1 — a known set of legs reconstructs to a known balance, per account and per store', () => {
  it('sums debit/credit correctly and keeps stores separate', () => {
    const docs: LandedDocLike[] = [
      leg(LIPA, { accountId: 'cash__cashier', direction: 'in', amount: 500 }),
      leg(LIPA, { accountId: 'cash__cashier', direction: 'out', amount: 200 }),
      leg(MALVAR, { accountId: 'cash__cashier', direction: 'in', amount: 9999 }),
    ];
    const result = reconstructBalances(docs, { asOf: '2026-12-31' });

    const lipaCash = result.balances.find((b) => b.storeCode === LIPA && b.accountCode === '1110');
    expect(lipaCash).toBeTruthy();
    expect(lipaCash!.debitTotal).toBe('500.00');
    expect(lipaCash!.creditTotal).toBe('200.00');
    expect(lipaCash!.netBalance).toBe('300.00'); // 1110 is debit-normal
    expect(lipaCash!.legCount).toBe(2);

    const malvarCash = result.balances.find((b) => b.storeCode === MALVAR && b.accountCode === '1110');
    expect(malvarCash!.debitTotal).toBe('9999.00');
    expect(result.legsIncluded).toBe(3);
  });

  it('a credit-normal account nets the other direction', () => {
    const docs: LandedDocLike[] = [
      leg(LIPA, { accountId: 'ap__SUP1', direction: 'in', amount: 1000, supplierId: 'SUP1' }),
      leg(LIPA, { accountId: 'ap__SUP1', direction: 'out', amount: 400, supplierId: 'SUP1' }),
    ];
    const result = reconstructBalances(docs, { asOf: '2026-12-31' });
    const ap = result.balances.find((b) => b.accountCode === '2110');
    expect(ap!.netBalance).toBe('600.00'); // 2110 is credit-normal: credit(1000) - debit(400)
  });
});

describe('invariant 2 — polarity comes from adaptLegacyLegs, never re-derived locally', () => {
  it('the reconstructed net exactly matches summing adaptLegacyLegs() called directly on each leg', () => {
    const rawLegs = [
      leg(LIPA, { accountId: 'liability__salaries_payable', direction: 'in', amount: 700 }),
      leg(LIPA, { accountId: 'liability__salaries_payable', direction: 'out', amount: 250 }),
      leg(LIPA, { accountId: 'expense__salary', direction: 'in', amount: 700 }),
    ];
    const result = reconstructBalances(rawLegs, { asOf: '2026-12-31' });

    for (const code of ['2300', '6100']) {
      const ours = result.balances.find((b) => b.accountCode === code)!;
      const matchingRaw = rawLegs.filter((d) => resolveV1Account((d.payload as Record<string, unknown>).accountId as string)?.code === code);
      let debit = 0;
      let credit = 0;
      for (const d of matchingRaw) {
        const p = d.payload as Record<string, unknown>;
        const resolved = resolveV1Account(p.accountId as string)!;
        const direct = adaptLegacyLegs(
          [{ accountId: p.accountId as string, direction: p.direction as 'in' | 'out', amount: p.amount as number }],
          () => resolved,
        );
        expect(direct.ok).toBe(true);
        if (!direct.ok) throw new Error('unreachable');
        debit += Number(direct.lines[0]!.debit);
        credit += Number(direct.lines[0]!.credit);
      }
      expect(Number(ours.debitTotal)).toBeCloseTo(debit, 2);
      expect(Number(ours.creditTotal)).toBeCloseTo(credit, 2);
    }
  });
});

describe('invariant 3 — per-party breakdown sums exactly to its control-account total', () => {
  it('holds for AP across multiple suppliers', () => {
    const docs: LandedDocLike[] = [
      leg(LIPA, { accountId: 'ap__SUP1', direction: 'in', amount: 1000, supplierId: 'SUP1' }),
      leg(LIPA, { accountId: 'ap__SUP2', direction: 'in', amount: 500, supplierId: 'SUP2' }),
      leg(LIPA, { accountId: 'ap__SUP1', direction: 'out', amount: 300, supplierId: 'SUP1' }),
    ];
    const result = reconstructBalances(docs, { asOf: '2026-12-31' });
    const control = result.balances.find((b) => b.accountCode === '2110')!;
    const parties = result.partyBalances.filter((p) => p.accountCode === '2110');

    const partySum = parties.reduce((s, p) => s + Number(p.netBalance), 0);
    expect(partySum).toBeCloseTo(Number(control.netBalance), 2);

    const partyDebit = parties.reduce((s, p) => s + Number(p.debitTotal), 0);
    const partyCredit = parties.reduce((s, p) => s + Number(p.creditTotal), 0);
    expect(partyDebit).toBeCloseTo(Number(control.debitTotal), 2);
    expect(partyCredit).toBeCloseTo(Number(control.creditTotal), 2);
  });

  it('holds even when a leg has NO party field at all (falls back to the account-id-encoded party, still counted)', () => {
    const docs: LandedDocLike[] = [
      leg(LIPA, { accountId: 'ar__CUSTX', direction: 'in', amount: 250, customerId: null }),
    ];
    const result = reconstructBalances(docs, { asOf: '2026-12-31' });
    const control = result.balances.find((b) => b.accountCode === '1210')!;
    const parties = result.partyBalances.filter((p) => p.accountCode === '1210');
    const partySum = parties.reduce((s, p) => s + Number(p.netBalance), 0);
    expect(partySum).toBeCloseTo(Number(control.netBalance), 2);
    expect(parties[0]!.partyId).toBe('CUSTX'); // fell back to the id-encoded party
    expect(result.findings.some((f) => f.type === 'missing_party_field')).toBe(true);
  });
});

describe('invariant 4 — leg supplierId disagreeing with the accountId-encoded party emits a finding', () => {
  it('uses the LEG field as authoritative and reports the disagreement', () => {
    const docs: LandedDocLike[] = [
      leg(LIPA, { accountId: 'ap__SUP-ENCODED', direction: 'in', amount: 100, supplierId: 'SUP-REAL' }),
    ];
    const result = reconstructBalances(docs, { asOf: '2026-12-31' });
    const parties = result.partyBalances.filter((p) => p.accountCode === '2110');
    expect(parties).toHaveLength(1);
    expect(parties[0]!.partyId).toBe('SUP-REAL'); // the leg's field wins
    const finding = result.findings.find((f) => f.type === 'party_id_mismatch');
    expect(finding).toBeTruthy();
    expect(finding!.message).toMatch(/SUP-REAL/);
    expect(finding!.message).toMatch(/SUP-ENCODED/);
  });

  it('no finding when the leg field and the encoded party agree', () => {
    const docs: LandedDocLike[] = [
      leg(LIPA, { accountId: 'ap__SUP1', direction: 'in', amount: 100, supplierId: 'SUP1' }),
    ];
    const result = reconstructBalances(docs, { asOf: '2026-12-31' });
    expect(result.findings.some((f) => f.type === 'party_id_mismatch')).toBe(false);
  });
});

describe('invariant 5 — a leg with no businessDate is reported, never silently dropped', () => {
  it('excludes it from the balance but records a finding naming the doc', () => {
    const docs: LandedDocLike[] = [
      leg(LIPA, { accountId: 'cash__cashier', direction: 'in', amount: 100, businessDate: null }),
    ];
    const result = reconstructBalances(docs, { asOf: '2026-12-31' });
    expect(result.legsIncluded).toBe(0);
    expect(result.balances).toHaveLength(0);
    const finding = result.findings.find((f) => f.type === 'missing_business_date');
    expect(finding).toBeTruthy();
    expect(finding!.docPath).toBe(docs[0]!.docPath);
  });
});

describe('invariant 6 — asOf excludes later legs; the boundary date is INCLUSIVE', () => {
  it('a leg dated exactly asOf is included; a leg dated the next day is excluded (no finding, normal exclusion)', () => {
    const docs: LandedDocLike[] = [
      leg(LIPA, { accountId: 'cash__cashier', direction: 'in', amount: 100, businessDate: '2026-06-30' }),
      leg(LIPA, { accountId: 'cash__cashier', direction: 'in', amount: 5000, businessDate: '2026-07-01' }),
    ];
    const result = reconstructBalances(docs, { asOf: '2026-06-30' });
    const cash = result.balances.find((b) => b.accountCode === '1110')!;
    expect(cash.debitTotal).toBe('100.00'); // the future leg (5000) never enters the sum
    expect(result.legsIncluded).toBe(1);
    expect(result.legsExcludedFutureDated).toBe(1);
  });
});

describe('invariant 18 (balances.ts side) — store exclusion is scoped, and always printed', () => {
  it('defaults to the four operating stores; a test-store leg contributes nothing', () => {
    const docs: LandedDocLike[] = [
      leg(LIPA, { accountId: 'cash__cashier', direction: 'in', amount: 100 }),
      leg(TEST_STORE, { accountId: 'cash__cashier', direction: 'in', amount: 999999 }),
    ];
    const result = reconstructBalances(docs, { asOf: '2026-12-31' });
    expect(result.includedStoreCodes).toEqual(DEFAULT_STORE_IDS);
    expect(result.balances.some((b) => b.storeCode === TEST_STORE)).toBe(false);
    const cash = result.balances.find((b) => b.accountCode === '1110')!;
    expect(cash.debitTotal).toBe('100.00'); // the test store's 999999 never shows up
  });

  it('the exclusion list is ALWAYS present in the result, regardless of whether any excluded-store docs exist', () => {
    const result = reconstructBalances([], { asOf: '2026-12-31' });
    const excludedCodes = result.excludedStores.map((s) => s.code).sort();
    expect(excludedCodes).toEqual(Object.keys(EXCLUDED_STORES).sort());
  });

  it('OPERATING_STORES names all four real stores (docs/STORE-ROSTER.md)', () => {
    expect(Object.keys(OPERATING_STORES).sort()).toEqual(
      [LIPA, MALVAR, 'eVYKj6wABdakk8RgEotW', 'iGOW7q2pZbeHWV832UNh'].sort(),
    );
  });
});

describe('parseJournalLeg', () => {
  it('returns null (never throws) for a payload missing required fields', () => {
    const doc: LandedDocLike = {
      docPath: 'stores/x/journal/bad',
      collectionPath: 'stores/x/journal',
      storeCode: 'x',
      payload: { direction: 'in' }, // missing accountId, amount, sourceType, sourceId
    };
    expect(parseJournalLeg(doc)).toBeNull();
  });
});

describe('an unresolvable account is reported, not silently dropped or guessed', () => {
  it('emits an unresolvable_account finding and excludes the leg from balances', () => {
    const docs: LandedDocLike[] = [leg(LIPA, { accountId: 'nope__whatever', direction: 'in', amount: 100 })];
    const result = reconstructBalances(docs, { asOf: '2026-12-31' });
    expect(result.balances).toHaveLength(0);
    expect(result.findings.some((f) => f.type === 'unresolvable_account' && f.accountId === 'nope__whatever')).toBe(true);
  });
});
