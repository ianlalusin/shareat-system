import { describe, expect, it } from 'vitest';
import { buildV1BridgePayload } from './v1-bridge-payload';

/**
 * T-627 - the December bridge carries the day's store charges as v1's `payments.chargesTotal` (v1 reads it; it is inside `totalGross`, as in v1).
 * `chargesTotal` is GROSS charges, the same convention as `discountsTotal` (not net of refunds). docs/tasks/627-pos-charges.md.
 */
const close = (o: { gross: string; charges?: string; cash: string }) => ({
  receiptCount: 2, grossTotal: o.gross, ...(o.charges !== undefined ? { chargesTotal: o.charges } : {}), discountTotal: '0.00', unliSales: '0.00', heads: 2, packageSessions: 0,
  tenders: [{ name: 'Cash', kind: 'cash' as const, v1Alias: null, amount: o.cash }],
});

describe('T-627 bridge chargesTotal', () => {
  it('is the Z charges (a number with two decimals), and totalGross still equals the methods', () => {
    const p = buildV1BridgePayload({ posStoreId: 'lipa-v1', businessDate: '2026-12-01', closes: [close({ gross: '1250.00', charges: '500.00', cash: '1250.00' })] });
    expect(p.data.payments.chargesTotal).toBe(500);
    expect(p.data.payments.totalGross).toBe(1250);
    expect(p.data.payments.byMethod).toEqual({ cash: 1250 });
  });

  it('adds the charges of two Zs of one date, to the centavo', () => {
    const p = buildV1BridgePayload({
      posStoreId: 'lipa-v1', businessDate: '2026-12-01',
      closes: [close({ gross: '850.00', charges: '350.33', cash: '850.00' }), close({ gross: '400.00', charges: '150.10', cash: '400.00' })],
    });
    expect(p.data.payments.chargesTotal).toBe(500.43);
  });

  it('no charges, or a Z that does not say: 0', () => {
    for (const c of [close({ gross: '250.00', cash: '250.00' }), close({ gross: '250.00', charges: '0.00', cash: '250.00' })]) {
      expect(buildV1BridgePayload({ posStoreId: 'lipa-v1', businessDate: '2026-12-01', closes: [c] }).data.payments.chargesTotal).toBe(0);
    }
  });
});
