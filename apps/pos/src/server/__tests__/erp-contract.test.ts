/**
 * T-424 slice T - Acceptance 6, the ERP contract. A refund and a tender correction must not break what the ERP reads (T-375).
 *
 * HOW: v1's REAL delta code (vendored fixtures, V1-COPY.md "Test fixtures") books the day's sales into an in-memory store; the REAL route
 * handlers then produce a refund and a correction; the resulting day document is turned into the `/api/external/sales` payload exactly as
 * POS v1's route does (mapping copied from POS e26d0c1 src/app/api/external/sales/route.ts) and fed to the ERP's own
 * `packages/domain/src/pos/v1-derive.ts` + `v1-methods.ts` (loaded by file path; apps/pos/vitest.config.mts aliases their three leaf imports).
 *   - day with sales S and one refund R: the day doc still yields X = sum(byMethod) - totalSales = R, `figures.refunds` = R, no method negative;
 *   - after a correction: sum(byMethod) and totalGross are unchanged, `v1-methods` accepts the day (no method goes negative), refunds stay 0.
 *
 * RED FOR THE RIGHT REASON: the route handlers do not exist yet (the baseline tests that only use v1's code and the ERP's code pass now: they prove
 * the harness is not vacuous).
 * MUTANTS: M1 the refund writes analytics.mop (X collapses to 0); M2 the refund is applied with a positive total; M3 a correction moves totalGross or
 *   txCount; M4 a correction moves more than mop[from] (a method goes negative and v1-methods refuses the day); M5 a refund recorded in byMethod.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  DEVICE, NOW, SAME_DAY, PIN_OK, STORE, T_SALE, createFakeFirestore, dayIdOf, json, makeDeps, post, seedSale, seedStaff, seedStore,
} from '@/test-helpers/pos2';
import type { FakeFirestore } from '@/test-helpers/fakeFirestore';

vi.mock('server-only', () => ({}));

const here = path.dirname(fileURLToPath(import.meta.url));
const domainFile = (name: string) => pathToFileURL(path.resolve(here, '../../../../../packages/domain/src/pos', name)).href;
interface Derive { deriveSalesDay: (payload: unknown, ctx: any) => any }
interface Methods { resolvePosV1Methods: (byMethod: Record<string, number>, tenders: any[]) => any }
const loadDerive = async () => (await import(/* @vite-ignore */ domainFile('v1-derive.ts'))) as Derive;
const loadMethods = async () => (await import(/* @vite-ignore */ domainFile('v1-methods.ts'))) as Methods;

const DAY = dayIdOf(T_SALE);
const TENDERS = [
  { id: 't-cash', kind: 'cash', moneyAccountId: null, posV1Alias: 'Cash', isActive: true },
  { id: 't-gcash', kind: 'wallet', moneyAccountId: 'acct-gcash', posV1Alias: 'GCash', isActive: true },
];
const CTX = { channelId: 'ch-1', taxType: 'vat_inclusive' as const, tenders: TENDERS, businessDate: '2026-10-14', storeName: 'Shareat Test' };

/** POS v1's /api/external/sales payload, from the day doc (mapping copied from the v1 route). */
function feedPayload(f: FakeFirestore) {
  const d = f.get(`stores/${STORE}/analytics/${DAY}`)!;
  const payments = d.payments ?? {};
  const sales = d.sales ?? {};
  const totalGross = payments.totalGross ?? 0;
  const dineInGross = Number(sales.dineInSalesGross ?? 0);
  const dineInSales = dineInGross > 0 ? dineInGross : Object.values(sales.packageSalesAmountByName ?? {}).reduce((s: number, v: any) => s + (Number(v) || 0), 0) + Number(sales.dineInAddonSalesAmount ?? 0);
  return {
    found: true, totalSales: totalGross, totalSessions: payments.txCount ?? 0, dineInSales, paymentsByMethod: payments.byMethod ?? {},
    discountsTotal: payments.discountsTotal ?? 0, chargesTotal: payments.chargesTotal ?? 0,
  };
}
const sumMethods = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);

async function dayWithSales() {
  const f = createFakeFirestore();
  seedStaff(f);
  seedStore(f);
  await seedSale(f, { id: 'r1', lines: [{ id: 'l1', unit: 100, qty: 3 }, { id: 'l2', unit: 50, qty: 2 }], total: 360, mop: { Cash: 360 } });
  await seedSale(f, { id: 'r2', lines: [{ id: 'l1', unit: 100, qty: 2 }], total: 200, mop: { Cash: 150, GCash: 50 }, receiptNumber: 'SHT-01-000002', createdAtClientMs: T_SALE + 3600_000 });
  return f;
}

describe('harness (no builder needed): the ERP accepts a day of sales booked by v1\'s code', () => {
  it('sales S = 560: refunds 0, cash 510, online 50', async () => {
    const f = await dayWithSales();
    const { deriveSalesDay } = await loadDerive();
    const out = deriveSalesDay(feedPayload(f), CTX);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(Number(out.figures.totalSales)).toBe(560);
    expect(Number(out.figures.refunds)).toBe(0);
    expect(Number(out.figures.cashCollected)).toBe(510);
    expect(Number(out.figures.onlineCollected)).toBe(50);
  });

  it('the guard has teeth: a negative method is refused by v1-methods, and the feed with it by v1-derive', async () => {
    const { resolvePosV1Methods } = await loadMethods();
    const { deriveSalesDay } = await loadDerive();
    expect(resolvePosV1Methods({ Cash: -1 }, TENDERS).ok).toBe(false);
    expect(deriveSalesDay({ ...feedPayload(await dayWithSales()), paymentsByMethod: { Cash: 600, GCash: -40 } }, CTX).ok).toBe(false);
  });
});

describe('Acceptance 6 - a refund keeps X = sum(byMethod) - totalSales = R', () => {
  it('after one refund of 90.00 the ERP derives refunds = 90.00, cash = cash methods - 90.00, nothing negative (M1, M2, M5)', async () => {
    const f = await dayWithSales();
    const d = makeDeps(f, { nowMs: () => SAME_DAY });
    const { handleRefund } = await import('@/server/pos2/refunds');
    const res = await handleRefund(
      post('refunds', { storeId: STORE, parentReceiptId: 'r1', lines: [{ lineId: 'l1', qty: 1 }], tenderMethodId: 'm-cash', reason: 'returned', terminalNo: 1, terminalSeq: 3, receiptNumber: 'SHT-01-000003', pin: PIN_OK, deviceId: DEVICE }),
      d.deps as any,
    );
    expect(res.status, JSON.stringify(await json(res.clone()))).toBe(200);
    const day = f.get(`stores/${STORE}/analytics/${DAY}`)!;
    expect(day.payments.byMethod, 'byMethod untouched by a refund').toEqual({ Cash: 510, GCash: 50 });
    expect(day.payments.totalGross).toBe(470);
    const payload = feedPayload(f);
    expect(sumMethods(payload.paymentsByMethod) - payload.totalSales, 'X = R').toBeCloseTo(90, 9);
    const { deriveSalesDay } = await loadDerive();
    const out = deriveSalesDay(payload, CTX);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(Number(out.figures.refunds)).toBe(90);
    expect(Number(out.figures.cashCollected)).toBe(420);
    expect(Number(out.figures.totalSales)).toBe(560);
  });

  it('three refunds of one receipt (360.00 in all) still derive exactly: refunds = their sum', async () => {
    const f = await dayWithSales();
    const { handleRefund } = await import('@/server/pos2/refunds');
    const lines = [[{ lineId: 'l1', qty: 3 }], [{ lineId: 'l2', qty: 1 }], [{ lineId: 'l2', qty: 1 }]];
    let seq = 3;
    for (const l of lines) {
      const d = makeDeps(f, { nowMs: () => SAME_DAY });
      const res = await handleRefund(
        post('refunds', { storeId: STORE, parentReceiptId: 'r1', lines: l, tenderMethodId: 'm-cash', reason: 'returned', terminalNo: 1, terminalSeq: seq, receiptNumber: `SHT-01-${String(seq).padStart(6, '0')}`, pin: PIN_OK, deviceId: DEVICE }),
        d.deps as any,
      );
      expect(res.status).toBe(200);
      seq++;
    }
    const { deriveSalesDay } = await loadDerive();
    const out = deriveSalesDay(feedPayload(f), CTX);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(Number(out.figures.refunds)).toBe(360);
    expect(Number(out.figures.cashCollected)).toBe(150);
  });
});

describe('Acceptance 6 - a correction leaves sum(byMethod) and totalGross alone and no method negative (M3, M4)', () => {
  const correct = async (f: FakeFirestore, over: Record<string, unknown>) => {
    const d = makeDeps(f);
    const { handleTenderCorrection } = await import('@/server/pos2/tender-corrections');
    const res = await handleTenderCorrection(
      post('tender-corrections', { storeId: STORE, receiptId: 'r1', fromMethod: 'Cash', toMethod: 'GCash', amount: 10000, reference: 'GC-1', reason: 'wrong tender', pin: PIN_OK, requestId: '9d3e5f6a-1b2c-4d3e-8f90-a1b2c3d4e5f6', deviceId: DEVICE, ...over }),
      d.deps as any,
    );
    return { status: res.status, body: await json(res) };
  };

  it('one correction of 100.00 Cash -> GCash: the totals are unchanged, the ERP accepts the day', async () => {
    const f = await dayWithSales();
    const before = feedPayload(f);
    const r = await correct(f, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = feedPayload(f);
    expect(after.paymentsByMethod).toEqual({ Cash: 410, GCash: 150 });
    expect(sumMethods(after.paymentsByMethod)).toBe(sumMethods(before.paymentsByMethod));
    expect(after.totalSales).toBe(before.totalSales);
    expect(after.totalSessions).toBe(before.totalSessions);
    const { deriveSalesDay } = await loadDerive();
    const { resolvePosV1Methods } = await loadMethods();
    expect(resolvePosV1Methods(after.paymentsByMethod, TENDERS).ok).toBe(true);
    const out = deriveSalesDay(after, CTX);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(Number(out.figures.refunds), 'a correction is not a refund').toBe(0);
    expect(Number(out.figures.cashCollected)).toBe(410);
    expect(Number(out.figures.onlineCollected)).toBe(150);
  });

  it('moving the whole receipt (360.00) leaves Cash at 150.00 on the day and still accepted; asking for more is refused', async () => {
    const f = await dayWithSales();
    expect((await correct(f, { amount: 36000 })).status).toBe(200);
    const { deriveSalesDay } = await loadDerive();
    const out = deriveSalesDay(feedPayload(f), CTX);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(Number(out.figures.cashCollected)).toBe(150);
    const more = await correct(f, { amount: 1, requestId: 'a7c4e1b2-5d6f-4a8b-9c0d-1e2f3a4b5c6d' });
    expect(more.status).toBeGreaterThanOrEqual(400);
    expect(deriveSalesDay(feedPayload(f), CTX).ok).toBe(true);
  });

  it('a refund and a correction on the same day together: still X = R and accepted', async () => {
    const f = await dayWithSales();
    expect((await correct(f, {})).status).toBe(200);
    const d = makeDeps(f, { nowMs: () => SAME_DAY });
    const { handleRefund } = await import('@/server/pos2/refunds');
    const res = await handleRefund(
      post('refunds', { storeId: STORE, parentReceiptId: 'r1', lines: [{ lineId: 'l1', qty: 1 }], tenderMethodId: 'm-cash', reason: 'returned', terminalNo: 1, terminalSeq: 3, receiptNumber: 'SHT-01-000003', pin: PIN_OK, deviceId: DEVICE }),
      d.deps as any,
    );
    expect(res.status).toBe(200);
    const { deriveSalesDay } = await loadDerive();
    const out = deriveSalesDay(feedPayload(f), CTX);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(Number(out.figures.refunds)).toBe(90);
    expect(Number(out.figures.cashCollected)).toBe(320);
    expect(Number(out.figures.onlineCollected)).toBe(150);
  });
});

void NOW;
