import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ names: ['Cash'], methodsFail: false, mop: {} as Record<string, number>, conversions: [] as Record<string, unknown>[], refunds: [] as Record<string, unknown>[], byMethod: {} as Record<string, number> }));
vi.mock('@/lib/firebase/client', () => ({ db: {} }));
vi.mock('firebase/firestore', async (importOriginal) => {
  const { Timestamp } = await importOriginal<typeof import('firebase/firestore')>();
  const readRows = async (path: string) => {
    const methods = path.endsWith('/storeModesOfPayment');
    if (methods && fixture.methodsFail) throw new Error('synthetic methods outage');
    const rows = methods ? fixture.names.map((name) => ({ name })) : path.endsWith('/paymentConversions') ? fixture.conversions : [{ status: 'final', analytics: { mop: fixture.mop } }, ...fixture.refunds];
    return { forEach: (visit: (row: { data(): unknown }) => void) => rows.forEach((data) => visit({ data: () => data })) };
  };
  return {
  Timestamp,
  collection: (_db: unknown, ...path: string[]) => path.join('/'),
  doc: (_db: unknown, ...path: string[]) => path.join('/'),
  getDocFromServer: async () => ({ exists: () => true, data: () => ({ payments: { byMethod: fixture.byMethod } }) }),
  where: (...args: unknown[]) => args,
  query: (path: string) => path,
  getDocs: readRows, getDocsFromServer: readRows,
}; });
import { computeCashSalesAndRefunds, computeHandoverCash } from './handover';

beforeEach(() => { fixture.names = ['Cash']; fixture.methodsFail = false; fixture.mop = {}; fixture.conversions = []; fixture.refunds = []; fixture.byMethod = {}; });

describe('DEF-704 physical cash identity', () => {
  it('a closing calculation refuses unavailable method identities rather than silently replacing fresh totals with zero', async () => {
    fixture.methodsFail = true;
    await expect(computeHandoverCash('S1', 1000, 2000)).rejects.toThrow('synthetic methods outage');
  });
  it('the real handover reader includes v1, correction and Convert cash movements, and the final negative-day notice', async () => {
    fixture.mop = { Cash: 5000, GCash: 1200 };
    const at = (over: Record<string, unknown>) => ({ status: 'active', fromMethod: 'GCash', toMethod: 'Cash', amount: 100, createdAtClientMs: 1500, ...over });
    fixture.conversions = [at({ amount: 1200, source: 'pos2-convert' }), at({ amount: 300, fromMethod: 'Cash', toMethod: 'GCash', source: 'pos2-convert' }),
      at({ amount: 150, source: 'pos2-correction' }), at({ amount: 100 }), at({ amount: 999, status: 'voided' }), at({ amount: 999, createdAtClientMs: 3000 })];
    fixture.byMethod = { Cash: 6150, GCash: -10 };
    expect(await computeHandoverCash('S1', 1000, 2000)).toEqual({ cashSales: 5000, convertNet: 1150, cashRefunds: 0, negativeMethodNames: ['GCash'] });
  });
  it('row 391: cash refunds in the window are summed (cash tender only; voided refunds and a GCash refund are not), and are not cash sales', async () => {
    fixture.mop = { Cash: 5000 };
    const rf = (over: Record<string, unknown>) => ({ isRefund: true, status: 'final', total: -1, refundTotalCentavos: 12_550, refundTender: { methodName: 'Cash' }, ...over });
    fixture.refunds = [rf({}), rf({ refundTotalCentavos: 1_000 }), rf({ refundTender: { methodName: 'GCash' } }), rf({ status: 'voided' }), rf({ refundTotalCentavos: undefined, total: -3.33 })];
    const r = await computeHandoverCash('S1', 1000, 2000);
    expect(r.cashRefunds).toBe(138.83);
    expect(r.cashSales).toBe(5000);
  });
  it('GCash and Maya sales do not increase expected physical drawer cash', async () => {
    fixture.mop = { Cash: 100, GCash: 500, Maya: 200 };
    expect((await computeCashSalesAndRefunds('S1', 1, 2)).cashSales).toBe(100);
  });
  it('a configured cash method is recognized even when its name has no cash word', async () => {
    fixture.names = ['Drawer']; fixture.mop = { Drawer: 50, GCash: 200 };
    expect((await computeCashSalesAndRefunds('S1', 1, 2)).cashSales).toBe(50);
  });
  it('the methods-outage fallback recognizes a cash word, never GCash', async () => {
    fixture.methodsFail = true; fixture.mop = { 'Till Cash': 100, GCash: 500 };
    expect((await computeCashSalesAndRefunds('S1', 1, 2)).cashSales).toBe(100);
  });
});
