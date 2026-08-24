import { describe, expect, it } from 'vitest';
import { money } from '@shareat/core/money';
import { crossCheck, filterAccountsDocs } from '../../src/audit/compare';
import type { AccountBalance, LandedDocLike, PartyBalance } from '../../src/audit/balances';

const LIPA = 'b9DzsnPbr1BUnY88lyT4';

function accountDoc(storeCode: string, v1AccountId: string, balance: number, extra: Record<string, unknown> = {}): LandedDocLike {
  return {
    docPath: `stores/${storeCode}/accounts/${v1AccountId}`,
    collectionPath: `stores/${storeCode}/accounts`,
    storeCode,
    payload: { id: v1AccountId, balance, storeId: storeCode, ...extra },
  };
}

function ourBalance(storeCode: string, accountCode: string, netBalance: string): AccountBalance {
  return { storeCode, accountCode, debitTotal: money('0'), creditTotal: money('0'), netBalance: money(netBalance), legCount: 1 };
}

function ourParty(
  storeCode: string,
  accountCode: string,
  partyType: 'supplier' | 'customer' | 'employee',
  partyId: string,
  netBalance: string,
): PartyBalance {
  return {
    storeCode,
    accountCode,
    partyType,
    partyId,
    debitTotal: money('0'),
    creditTotal: money('0'),
    netBalance: money(netBalance),
    legCount: 1,
  };
}

describe('filterAccountsDocs', () => {
  it('keeps only docs whose collectionPath ends in /accounts', () => {
    const docs: LandedDocLike[] = [
      accountDoc(LIPA, 'cash__cashier', 100),
      { docPath: 'stores/x/journal/j1', collectionPath: 'stores/x/journal', storeCode: 'x', payload: {} },
    ];
    expect(filterAccountsDocs(docs)).toHaveLength(1);
  });
});

describe('invariant 7 — agreement produces no finding; a seeded disagreement carries both figures', () => {
  it('an account where v1 and our reconstruction agree exactly is not a disagreement', () => {
    const docs: LandedDocLike[] = [accountDoc(LIPA, 'cash__cashier', 5000)];
    const result = crossCheck(docs, { balances: [ourBalance(LIPA, '1110', '5000.00')], partyBalances: [] });
    expect(result.disagreements).toHaveLength(0);
    const row = result.accountRows.find((r) => r.accountCode === '1110')!;
    expect(row.v1Balance).toBe('5000.00');
    expect(row.ourBalance).toBe('5000.00');
    expect(row.delta).toBe('0.00');
  });

  it('a seeded disagreement is reported with BOTH figures and the correct delta', () => {
    const docs: LandedDocLike[] = [accountDoc(LIPA, 'cash__cashier', 5000)];
    const result = crossCheck(docs, { balances: [ourBalance(LIPA, '1110', '4700.00')], partyBalances: [] });
    expect(result.disagreements).toHaveLength(1);
    const row = result.disagreements[0]!;
    expect(row.v1Balance).toBe('5000.00');
    expect(row.ourBalance).toBe('4700.00');
    expect(row.delta).toBe('300.00'); // v1 - ours
  });

  it('sorts disagreements largest delta first', () => {
    const docs: LandedDocLike[] = [
      accountDoc(LIPA, 'cash__cashier', 5000),
      accountDoc(LIPA, 'cash__office', 1000),
    ];
    const result = crossCheck(docs, {
      balances: [ourBalance(LIPA, '1110', '4990.00'), ourBalance(LIPA, '1130', '100.00')],
      partyBalances: [],
    });
    expect(result.disagreements).toHaveLength(2);
    expect(result.disagreements[0]!.accountCode).toBe('1130'); // delta 900, largest
    expect(result.disagreements[1]!.accountCode).toBe('1110'); // delta 10
  });
});

describe('invariant 8 — a one-sided comparison is reported, both directions', () => {
  it('v1 has a balance we have no legs for (v1_only)', () => {
    const docs: LandedDocLike[] = [accountDoc(LIPA, 'cash__cashier', 5000)];
    const result = crossCheck(docs, { balances: [], partyBalances: [] });
    const row = result.accountRows.find((r) => r.accountCode === '1110')!;
    expect(row.oneSided).toBe('v1_only');
    expect(row.v1Balance).toBe('5000.00');
    expect(row.ourBalance).toBeNull();
    expect(result.disagreements.some((d) => d.accountCode === '1110')).toBe(true);
  });

  it('we have a balance v1 has no account doc for (ours_only)', () => {
    const result = crossCheck([], { balances: [ourBalance(LIPA, '1110', '250.00')], partyBalances: [] });
    const row = result.accountRows.find((r) => r.accountCode === '1110')!;
    expect(row.oneSided).toBe('ours_only');
    expect(row.v1Balance).toBeNull();
    expect(row.ourBalance).toBe('250.00');
  });
});

describe('party-level cross-check for the four control accounts', () => {
  it('compares v1\'s per-entity accounts doc against our per-party breakdown, not the aggregate', () => {
    const docs: LandedDocLike[] = [accountDoc(LIPA, 'ap__SUP1', 1200)];
    const result = crossCheck(docs, { balances: [], partyBalances: [ourParty(LIPA, '2110', 'supplier', 'SUP1', '1200.00')] });
    expect(result.partyDisagreements).toHaveLength(0);
    const row = result.partyRows.find((r) => r.partyId === 'SUP1')!;
    expect(row.v1Balance).toBe('1200.00');
    expect(row.ourBalance).toBe('1200.00');
  });

  it('a per-supplier disagreement is caught even when the AGGREGATE happens to match', () => {
    // Two suppliers whose errors cancel out in aggregate — only the party-level check sees it.
    const docs: LandedDocLike[] = [accountDoc(LIPA, 'ap__SUP1', 1000), accountDoc(LIPA, 'ap__SUP2', 500)];
    const result = crossCheck(docs, {
      balances: [ourBalance(LIPA, '2110', '1500.00')], // aggregate matches (1000+500)
      partyBalances: [ourParty(LIPA, '2110', 'supplier', 'SUP1', '900.00'), ourParty(LIPA, '2110', 'supplier', 'SUP2', '600.00')],
    });
    expect(result.disagreements).toHaveLength(0); // aggregate agrees
    expect(result.partyDisagreements).toHaveLength(2); // but both suppliers are individually wrong
  });
});

describe('a v1 account with NO v2 destination at all is reported by name, not silently dropped', () => {
  it('the RETIRED income__wastage_writeoff_contra account (found in real data, T-114b)', () => {
    const docs: LandedDocLike[] = [accountDoc(LIPA, 'income__wastage_writeoff_contra', 300)];
    const result = crossCheck(docs, { balances: [], partyBalances: [] });
    expect(result.unmappedV1Accounts).toHaveLength(1);
    expect(result.unmappedV1Accounts[0]!.v1AccountId).toBe('income__wastage_writeoff_contra');
    expect(result.unmappedV1Accounts[0]!.v1Balance).toBe('300.00');
  });
});

describe('the exclusion list is always present', () => {
  it('is populated even with zero docs', () => {
    const result = crossCheck([], { balances: [], partyBalances: [] });
    expect(result.excludedStores.length).toBeGreaterThan(0);
  });
});
