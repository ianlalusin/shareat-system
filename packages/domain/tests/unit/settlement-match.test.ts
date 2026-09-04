import { describe, expect, it } from 'vitest';
import { matchWastagesToSettlement, type SettleableOrderWastage } from '../../src/wastage/settlement-match';
import type { PostedSettlementSummary } from '../../src/channel-settlements';

/**
 * T-178 §4/§9 — the pure half of settlement matching.
 *
 * ⭐ **Pure by construction**: `matchWastagesToSettlement` takes no `Tx` at all, so it is
 * structurally impossible for it to write — invariant 9 ("the matcher is pure and never writes")
 * is proved by the function's own signature, not merely asserted by a test.
 */

function wastage(over: Partial<SettleableOrderWastage> & { wastageId: string }): SettleableOrderWastage {
  return {
    storeId: 'store-1',
    channel: 'Foodpanda',
    businessDate: '2026-09-01',
    amount: '250.00',
    orderRef: 'FP-1001',
    status: 'open',
    ...over,
  };
}

function settlement(over: Partial<PostedSettlementSummary> & { settlementId: string }): PostedSettlementSummary {
  return {
    storeId: 'store-1',
    channel: 'Foodpanda',
    businessDate: '2026-09-01',
    grossAmount: '8000.00',
    outstandingCleared: '8000.00',
    netDeposited: '6360.00',
    deductions: {
      commission: '1600.00',
      marketing: '0.00',
      platformFee: '0.00',
      vatOnFees: '0.00',
      withholdingTax: '40.00',
      penalty: '0.00',
    },
    variance: '0.00',
    settlementGain: '0.00',
    ...over,
  };
}

describe('matchWastagesToSettlement — proposes only, at channel-day granularity', () => {
  it('⭐ matches a wastage to a settlement sharing store + channel + business date', () => {
    const w = wastage({ wastageId: 'w1' });
    const s = settlement({ settlementId: 's1' });
    const candidates = matchWastagesToSettlement([w], [s]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ wastageId: 'w1', settlementId: 's1', storeId: 'store-1' });
    expect(candidates[0]!.rationale).toContain('gross');
  });

  it('channel name matching is case-insensitive — the settlement and the wastage need not agree on case', () => {
    const w = wastage({ wastageId: 'w1', channel: 'foodpanda' });
    const s = settlement({ settlementId: 's1', channel: 'Foodpanda' });
    expect(matchWastagesToSettlement([w], [s])).toHaveLength(1);
  });

  it('a different business date proposes nothing', () => {
    const w = wastage({ wastageId: 'w1', businessDate: '2026-09-02' });
    const s = settlement({ settlementId: 's1', businessDate: '2026-09-01' });
    expect(matchWastagesToSettlement([w], [s])).toHaveLength(0);
  });

  it('a different channel proposes nothing', () => {
    const w = wastage({ wastageId: 'w1', channel: 'Grab' });
    const s = settlement({ settlementId: 's1', channel: 'Foodpanda' });
    expect(matchWastagesToSettlement([w], [s])).toHaveLength(0);
  });

  it('a different store proposes nothing, even on the same channel-day — no cross-store leakage', () => {
    const w = wastage({ wastageId: 'w1', storeId: 'store-1' });
    const s = settlement({ settlementId: 's1', storeId: 'store-2' });
    expect(matchWastagesToSettlement([w], [s])).toHaveLength(0);
  });

  it('no posted settlement for that channel-day at all proposes nothing', () => {
    const w = wastage({ wastageId: 'w1' });
    expect(matchWastagesToSettlement([w], [])).toHaveLength(0);
  });

  it('⭐ several open wastages on the SAME settled channel-day each get their own candidate', () => {
    const w1 = wastage({ wastageId: 'w1', orderRef: 'FP-1001' });
    const w2 = wastage({ wastageId: 'w2', orderRef: 'FP-1002', amount: '90.00' });
    const s = settlement({ settlementId: 's1' });
    const candidates = matchWastagesToSettlement([w1, w2], [s]);
    expect(candidates.map((c) => c.wastageId).sort()).toEqual(['w1', 'w2']);
    expect(candidates.every((c) => c.settlementId === 's1')).toBe(true);
  });

  it('the rationale surfaces a shortfall already swept to expense, when the settlement carries one', () => {
    const w = wastage({ wastageId: 'w1' });
    const s = settlement({ settlementId: 's1', variance: '40.00' });
    const [candidate] = matchWastagesToSettlement([w], [s]);
    expect(candidate!.rationale).toContain('40.00');
    expect(candidate!.rationale).toContain('shortfall');
  });

  it('the rationale surfaces a recognised gain, when the settlement carries one', () => {
    const w = wastage({ wastageId: 'w1' });
    const s = settlement({ settlementId: 's1', variance: '0.00', settlementGain: '1000.00' });
    const [candidate] = matchWastagesToSettlement([w], [s]);
    expect(candidate!.rationale).toContain('gain was already recognised');
  });

  it('⛔ never returns a fourth field beyond what the disposing action needs — no accidental posting hook', () => {
    const w = wastage({ wastageId: 'w1' });
    const s = settlement({ settlementId: 's1' });
    const [candidate] = matchWastagesToSettlement([w], [s]);
    expect(Object.keys(candidate!).sort()).toEqual(
      ['amount', 'businessDate', 'channel', 'rationale', 'settlementId', 'storeId', 'wastageId'].sort(),
    );
  });
});
