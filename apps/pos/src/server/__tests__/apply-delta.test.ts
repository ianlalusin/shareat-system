/**
 * T-424 slice T - POST /api/pos2/analytics/apply-delta, the PORT of v1's analytics delta (Ruling 10a, slice S10). Acceptance 12.
 * Contract: header of `@/test-helpers/pos2`.
 *
 * PARITY: for a corpus of receipts the port and v1's REAL delta code (vendored fixtures, V1-COPY.md "Test fixtures") are run on two separate
 * in-memory stores; the day, month, year and preset docs must be BYTE-IDENTICAL (canonical JSON, the server timestamp removed). The corpus has
 * payment, void (with retained cash), refund, offline, discounted, VAT-exempt, multi-method, package-dine-in and midnight-crossing receipts.
 * The preset windows come from `deps.nowMs()` (v1 used the server's new Date()): a port using the real clock fails here.
 *
 * RED FOR THE RIGHT REASON: `@/server/pos2/apply-delta` does not exist yet.
 * MUTANTS: M1 a rounding / key mapping drift (e.g. no safeKey); M2 a family dropped (itemAdj, guests, peak); M3 void not reversing the retained cash;
 *   M4 preset windows from the real clock; M5 payment applied twice (no analyticsApplied gate); M6 void applied when nothing was applied;
 *   M7 void twice; M8 refund treated as a sale.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NOW, STORE, T_SALE, analyticsDocs, canonicalAnalytics, createFakeFirestore, json, makeDeps, post, receiptDoc, seedStaff, seedStore, type ReceiptSpec,
} from '@/test-helpers/pos2';
import type { FakeFirestore } from '@/test-helpers/fakeFirestore';
import { applyAnalyticsDeltaServer } from '@/lib/__fixtures__/v1-analytics/applyAnalyticsDeltaServer';

vi.mock('server-only', () => ({}));

type Op = 'payment' | 'refund' | 'void';
interface Scenario { name: string; spec: ReceiptSpec; steps: Op[]; voidPatch?: Record<string, unknown> }

const DAY_BEFORE = T_SALE - 24 * 3600 * 1000;
const SCENARIOS: Scenario[] = [
  { name: 'plain cash sale', spec: { id: 'a1', total: 250, lines: [{ id: 'l1', unit: 125, qty: 2, name: 'Pork BBQ' }] }, steps: ['payment'] },
  {
    name: 'package dine-in with guests, addons and a table',
    spec: {
      id: 'a2', total: 1500, lines: [{ id: 'l1', unit: 399, qty: 3, type: 'package', name: 'Unli Pack' }, { id: 'l2', unit: 100, qty: 3, name: 'Sisig' }],
      extra: { sessionMode: 'package_dinein', tableId: 't1', tableNumber: '1', analytics: { v: 2, subtotal: 1497, discountsTotal: 0, chargesTotal: 3, taxAmount: 160.39, grandTotal: 1500, totalPaid: 1500, change: 0, mop: { Cash: 1000, GCash: 500 }, guestCountSnapshot: { packageName: 'Unli Pack', finalGuestCount: 4, billedPackageCovers: 3, discrepancy: 1, computedAtClientMs: T_SALE, rule: 'MAX' } } },
    },
    steps: ['payment'],
  },
  { name: 'offline-synced sale (rung earlier in the day)', spec: { id: 'a3', total: 180.5, receiptNumber: 'SHT-01-000007', createdAtClientMs: T_SALE - 5 * 3600 * 1000, lines: [{ id: 'l1', unit: 90.25, qty: 2 }], extra: { offline: true } }, steps: ['payment'] },
  {
    name: 'discounted sale (line percent discount, bill discount in the analytics)',
    spec: { id: 'a4', total: 331.2, lines: [{ id: 'l1', unit: 120, qty: 3 }].map((l) => ({ ...l })), extra: { lines: [{ id: 'l1', type: 'addon', itemId: 'i1', itemName: 'Ribs', category: 'Grill', unitPrice: 120, qtyOrdered: 3, discountType: 'percent', discountValue: 10, discountQty: 2, freeQty: 0, voidedQty: 0 }], analytics: { v: 2, subtotal: 360, discountsTotal: 28.8, chargesTotal: 0, taxAmount: 35.5, grandTotal: 331.2, totalPaid: 331.2, change: 0, mop: { Cash: 331.2 } } } },
    steps: ['payment'],
  },
  {
    name: 'VAT-exempt sale paid by GCash',
    spec: { id: 'a5', total: 142.86, lines: [{ id: 'l1', unit: 160, qty: 1 }], mop: { GCash: 142.86 }, extra: { analytics: { v: 2, subtotal: 142.86, discountsTotal: 28.57, chargesTotal: 0, taxAmount: 0, vatExemptSales: 142.86, vatableSales: 0, grandTotal: 142.86, totalPaid: 142.86, change: 0, mop: { GCash: 142.86 } } } },
    steps: ['payment'],
  },
  { name: 'several methods incl. a name with a dot', spec: { id: 'a6', total: 300, lines: [{ id: 'l1', unit: 100, qty: 3 }], mop: { Cash: 100, 'G.Cash': 150.5, Card: 49.5 } }, steps: ['payment'] },
  {
    name: 'session that started the evening before and paid after midnight',
    spec: { id: 'a7', total: 800, lines: [{ id: 'l1', unit: 400, qty: 2, type: 'package', name: 'Unli Pack' }], extra: { sessionMode: 'package_dinein', analytics: { v: 2, subtotal: 800, discountsTotal: 0, chargesTotal: 0, taxAmount: 85.71, grandTotal: 800, totalPaid: 800, change: 0, mop: { Cash: 800 }, sessionStartedAtClientMs: DAY_BEFORE, guestCountSnapshot: { packageName: 'Unli Pack', finalGuestCount: 2, billedPackageCovers: 2, discrepancy: 0, computedAtClientMs: T_SALE, rule: 'MAX' } } } },
    steps: ['payment'],
  },
  {
    name: 'refund receipt (positive-qty clones, negative total, no mop)',
    spec: { id: 'a8', total: -90, lines: [{ id: 'l1', unit: 100, qty: 1 }], extra: { isRefund: true, parentReceiptId: 'a1', analytics: undefined } },
    steps: ['refund'],
  },
  { name: 'sale then voided with retained cash', spec: { id: 'a9', total: 400, lines: [{ id: 'l1', unit: 200, qty: 2 }] }, steps: ['payment', 'void'], voidPatch: { status: 'voided', voidCashRetained: 125.5, voidCashRefunded: 274.5 } },
  { name: 'sale then voided, all cash refunded', spec: { id: 'b1', total: 99, lines: [{ id: 'l1', unit: 99, qty: 1 }] }, steps: ['payment', 'void'], voidPatch: { status: 'voided', voidCashRetained: 0 } },
];

function fresh(): FakeFirestore {
  const f = createFakeFirestore();
  seedStaff(f);
  seedStore(f);
  return f;
}
const rpath = (id: string) => `stores/${STORE}/receipts/${id}`;
const seedReceipt = (f: FakeFirestore, spec: ReceiptSpec) => {
  const d: Record<string, unknown> = receiptDoc(spec);
  if (spec.extra && 'analytics' in spec.extra && spec.extra.analytics === undefined) delete d.analytics;
  f.seed(rpath(spec.id), d);
};

async function viaPort(f: FakeFirestore, id: string, op: Op) {
  const { deps } = makeDeps(f);
  const { handleApplyDelta } = await import('@/server/pos2/apply-delta');
  const res = await handleApplyDelta(post('analytics/apply-delta', { storeId: STORE, receiptId: id, op }), deps as any);
  return { status: res.status, body: await json(res) };
}
/** v1's /api/analytics/apply-delta, op payment|refund|void, with only the delta call (the rest of its route is not under parity). */
async function viaV1(f: FakeFirestore, id: string, op: Op) {
  const receipt = { id, ...f.get(rpath(id))! } as any;
  await f.admin.runTransaction(async (tx) => {
    if (op === 'void') {
      const asOriginal = { ...receipt, isVoided: false, status: receipt.status === 'voided' ? 'final' : receipt.status };
      const retained = Number(receipt.voidCashRetained || 0);
      applyAnalyticsDeltaServer(f.admin as any, STORE, asOriginal, null, tx as any, new Date(NOW), retained > 0 ? { 'payments.voidCashRetainedTotal': retained } : undefined);
    } else {
      applyAnalyticsDeltaServer(f.admin as any, STORE, null, receipt, tx as any, new Date(NOW));
    }
  });
}

describe('Acceptance 12 - the port is byte-identical to v1\'s delta code over the corpus', () => {
  it.each(SCENARIOS)('$name', async (sc) => {
    const A = fresh();
    const B = fresh();
    seedReceipt(A, sc.spec);
    seedReceipt(B, sc.spec);
    for (const op of sc.steps) {
      if (op === 'void') {
        for (const f of [A, B]) f.seed(rpath(sc.spec.id), { ...f.get(rpath(sc.spec.id))!, ...sc.voidPatch });
      }
      const r = await viaPort(A, sc.spec.id, op);
      expect(r.status, `${op}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(r.body).toMatchObject({ ok: true, applied: true, skipped: false, op });
      await viaV1(B, sc.spec.id, op);
    }
    const docsA = Object.keys(analyticsDocs(A));
    expect(docsA.length, 'the corpus actually produced day, month, year and preset docs').toBeGreaterThanOrEqual(4);
    expect(docsA.some((d) => d.startsWith('dashPresets/')), 'and at least one preset').toBe(true);
    expect(canonicalAnalytics(A)).toBe(canonicalAnalytics(B));
  });

  it('a whole day of mixed receipts applied in order by both is still identical, and the receipts carry the idempotency flags', async () => {
    const A = fresh();
    const B = fresh();
    for (const sc of SCENARIOS.filter((s) => s.steps.length === 1)) {
      seedReceipt(A, sc.spec);
      seedReceipt(B, sc.spec);
      await viaPort(A, sc.spec.id, sc.steps[0]!);
      await viaV1(B, sc.spec.id, sc.steps[0]!);
      expect(A.get(rpath(sc.spec.id))).toMatchObject({ analyticsApplied: true });
    }
    expect(canonicalAnalytics(A)).toBe(canonicalAnalytics(B));
  });
});

describe('Acceptance 12 - idempotency and edge ops (same flags as v1)', () => {
  let f: FakeFirestore;
  beforeEach(() => {
    f = fresh();
    seedReceipt(f, SCENARIOS[0]!.spec);
  });

  it('payment twice: the second is skipped and moves nothing (M5)', async () => {
    const a = await viaPort(f, 'a1', 'payment');
    const snap = canonicalAnalytics(f);
    const b = await viaPort(f, 'a1', 'payment');
    expect(a.body).toMatchObject({ ok: true, applied: true, skipped: false });
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ ok: true, applied: false, skipped: true, op: 'payment' });
    expect(canonicalAnalytics(f)).toBe(snap);
    expect(f.get(rpath('a1'))).toMatchObject({ analyticsApplied: true });
  });

  it('void after payment reverses it once; a second void is skipped (M7)', async () => {
    await viaPort(f, 'a1', 'payment');
    f.seed(rpath('a1'), { ...f.get(rpath('a1'))!, status: 'voided', voidCashRetained: 0 });
    const v1 = await viaPort(f, 'a1', 'void');
    expect(v1.body).toMatchObject({ ok: true, applied: true, skipped: false, op: 'void' });
    expect(f.get(rpath('a1'))).toMatchObject({ analyticsReversed: true });
    const day = Object.entries(analyticsDocs(f)).find(([k]) => k.startsWith('analytics/'))![1];
    expect(day.payments.totalGross).toBe(0);
    expect(day.payments.txCount).toBe(0);
    const snap = canonicalAnalytics(f);
    const v2 = await viaPort(f, 'a1', 'void');
    expect(v2.body).toMatchObject({ ok: true, applied: false, skipped: true });
    expect(canonicalAnalytics(f)).toBe(snap);
  });

  it('void of a receipt whose sale was never applied reverses nothing and marks it reversed (M6)', async () => {
    f.seed(rpath('a1'), { ...f.get(rpath('a1'))!, status: 'voided' });
    const r = await viaPort(f, 'a1', 'void');
    expect(r.body).toMatchObject({ ok: true, skipped: true });
    expect(Object.keys(analyticsDocs(f))).toHaveLength(0);
    expect(f.get(rpath('a1'))).toMatchObject({ analyticsReversed: true });
  });

  it('an op the port does not carry is 501 with v1\'s sentence; a missing receipt is 404; a bad body is 400', async () => {
    const edit = await viaPort(f, 'a1', 'edit' as Op);
    expect(edit.status).toBe(501);
    expect(edit.body).toMatchObject({ ok: false, op: 'edit' });
    expect((await viaPort(f, 'ghost', 'payment')).status).toBe(404);
    const { deps } = makeDeps(f);
    const { handleApplyDelta } = await import('@/server/pos2/apply-delta');
    const res = await handleApplyDelta(post('analytics/apply-delta', { storeId: STORE, op: 'payment' }), deps as any);
    expect(res.status).toBe(400);
  });
});
