/**
 * T-424 slice T - POST /api/pos2/tender-corrections. Acceptance 7 (and the money half of 6: byMethod moves, totals do not).
 * Contract: header of `@/test-helpers/pos2`. A correction MOVES money between payment methods on the RECEIPT's day; it never edits the receipt (row 272).
 *
 * RED FOR THE RIGHT REASON: `@/server/pos2/tender-corrections` does not exist yet - each case fails on "Cannot find package".
 * The analytics expectations are checked two ways: direct numbers, and v1's REAL `voidPaymentConversionServer` (vendored fixture) run on the
 * produced conversion doc must restore the day/month/year/preset `payments` exactly - proof that a later v1 void reverses the right day.
 *
 * MUTANTS: M1 no till-shift check; M2 shift opened after the sale accepted; M3 amount above mop[from] accepted; M4 stacked corrections ignored;
 *   M5 inactive/same-name toMethod accepted; M6 reference not required; M7 the receipt doc is written; M8 dayId from "now" instead of the receipt;
 *   M9 totalGross/txCount moved; M10 no idempotency on requestId; M11 same requestId + new body accepted; M12 two concurrent full corrections both pass;
 *   M13 preset docs forgotten; M14 write before the PIN check.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE, MANAGER_PERSON, NOW, PIN_BAD, PIN_OK, SHIFT_OPENED, STORE, analyticsDocs, byMethodOf, canonicalAnalytics, createFakeFirestore, dayIdOf, json, makeDeps, post,
  seedSale, seedStaff, seedStore, T_SALE,
} from '@/test-helpers/pos2';
import type { FakeFirestore } from '@/test-helpers/fakeFirestore';
import { voidPaymentConversionServer } from '@/lib/__fixtures__/v1-analytics/applyPaymentConversionServer';
import { getApplicablePresets } from '@/lib/__fixtures__/v1-analytics/delta-core';

vi.mock('server-only', () => ({}));

let fs: FakeFirestore;
const DAY = dayIdOf(T_SALE);
const DAY_START = Date.parse('2026-10-14T00:00:00+08:00');
const R1 = '9d3e5f6a-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const R2 = 'a7c4e1b2-5d6f-4a8b-9c0d-1e2f3a4b5c6d';

const body = (over: Record<string, unknown> = {}) => ({
  storeId: STORE, receiptId: 'r1', fromMethod: 'Cash', toMethod: 'GCash', amount: 20050, reference: 'GC-778899', reason: 'customer paid by GCash',
  pin: PIN_OK, requestId: R1, deviceId: DEVICE, ...over,
});

async function correct(b: Record<string, unknown>, o: { token?: string; deps?: ReturnType<typeof makeDeps>; fs?: FakeFirestore } = {}) {
  const d = o.deps ?? makeDeps(o.fs ?? fs);
  const { handleTenderCorrection } = await import('@/server/pos2/tender-corrections');
  const res = await handleTenderCorrection(post('tender-corrections', b, o.token ?? 'tok-cashier'), d.deps as any);
  return { status: res.status, body: await json(res), calls: d.calls };
}
const conversions = (f: FakeFirestore = fs) => f.list(`stores/${STORE}/paymentConversions`);
const receiptText = (f: FakeFirestore = fs) => JSON.stringify(f.get(`stores/${STORE}/receipts/r1`));
// v1's increment leaves a 0 entry behind after a reversal (it never deletes a key), so zero-valued methods are dropped before comparing.
const payments = (f: FakeFirestore = fs) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(analyticsDocs(f))) {
    const p = JSON.parse(JSON.stringify(v.payments ?? {}));
    if (p.byMethod) for (const m of Object.keys(p.byMethod)) if (p.byMethod[m] === 0) delete p.byMethod[m];
    out[k] = p;
  }
  return JSON.stringify(out);
};
const refused = (r: { status: number; body: any }, why: string) => {
  expect(r.status, why).toBeGreaterThanOrEqual(400);
  expect(r.status, why).toBeLessThan(500);
  expect(r.body.ok, why).toBe(false);
};

beforeEach(async () => {
  fs = createFakeFirestore();
  seedStaff(fs);
  seedStore(fs);
  await seedSale(fs, { id: 'r1', lines: [{ id: 'l1', unit: 500, qty: 1 }], total: 500, mop: { Cash: 500 } });
});

describe('Acceptance 7 - a correction moves money between methods on the RECEIPT\'s day', () => {
  it('writes one v1-shaped paymentConversions doc plus the new fields; the receipt is byte-identical (M7, M8)', async () => {
    const receiptBefore = receiptText();
    const r = await correct(body());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, conversionId: R1, replayed: false });
    const doc = fs.get(`stores/${STORE}/paymentConversions/${R1}`)!;
    expect(doc).toMatchObject({
      storeId: STORE, dayId: DAY, dayStartMs: DAY_START, amount: 200.5, fromMethod: 'Cash', toMethod: 'GCash', status: 'active',
      createdAtClientMs: NOW, voidedAt: null, voidedBy: null, receiptId: 'r1', reference: 'GC-778899', approvedByPersonId: MANAGER_PERSON,
      source: 'pos2-correction',
    });
    expect(doc.createdBy).toMatchObject({ uid: 'cashier' });
    expect(doc.requestedBy).toMatchObject({ uid: 'cashier' });
    expect(typeof doc.requestedBy.name).toBe('string');
    expect(doc.createdAt).toBeTruthy();
    expect(doc.note ?? doc.reason, 'the reason is kept (v1 field `note`, or `reason`)').toBe('customer paid by GCash');
    expect(receiptText(), 'the receipt document is byte-identical (row 272)').toBe(receiptBefore);
    expect(JSON.stringify([...fs.docs.entries()]).includes(PIN_OK), 'no PIN stored').toBe(false);
  });

  it('dayId is the RECEIPT\'s day even though "now" is after midnight; byMethod moves on day, month, year and every preset; totals do not (M8, M9, M13)', async () => {
    const before = { gross: fs.get(`stores/${STORE}/analytics/${DAY}`)!.payments.totalGross, tx: fs.get(`stores/${STORE}/analytics/${DAY}`)!.payments.txCount };
    expect(dayIdOf(NOW)).not.toBe(DAY);
    const r = await correct(body());
    expect(r.status).toBe(200);
    expect(byMethodOf(fs, 'analytics', DAY)).toEqual({ Cash: 299.5, GCash: 200.5 });
    expect(byMethodOf(fs, 'analyticsMonths', DAY.slice(0, 6))).toEqual({ Cash: 299.5, GCash: 200.5 });
    expect(byMethodOf(fs, 'analyticsYears', DAY.slice(0, 4))).toEqual({ Cash: 299.5, GCash: 200.5 });
    const day = fs.get(`stores/${STORE}/analytics/${DAY}`)!;
    expect(day.payments.totalGross).toBe(before.gross);
    expect(day.payments.txCount).toBe(before.tx);
    expect(fs.has(`stores/${STORE}/analytics/${dayIdOf(NOW)}`), 'nothing lands on "today"').toBe(false);
    const presets = getApplicablePresets(new Date(DAY_START), new Date(NOW));
    expect(presets.length).toBeGreaterThan(0);
    for (const p of presets) {
      const d = fs.get(`stores/${STORE}/dashPresets/${p}`)!;
      expect(d.payments.byMethod, p).toEqual({ Cash: 299.5, GCash: 200.5 });
      expect(d.payments.totalGross, p).toBe(before.gross);
    }
  });

  it("v1's own void of the conversion restores every payments figure exactly (a later v1 void reverses the right day)", async () => {
    const before = payments();
    await correct(body());
    expect(payments()).not.toBe(before);
    const out = await voidPaymentConversionServer(fs.admin as any, STORE, R1, { uid: 'x', name: 'y' }, new Date(NOW));
    expect(out).toEqual({ skipped: false });
    expect(payments()).toBe(before);
  });

  it('reverse direction: GCash -> Cash of what was moved is allowed (net of corrections already made), and a Cash reference is not needed', async () => {
    await correct(body({ amount: 50000 }));
    const back = await correct(body({ fromMethod: 'GCash', toMethod: 'Cash', amount: 50000, reference: '', requestId: R2 }));
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(byMethodOf(fs, 'analytics', DAY)).toEqual({ Cash: 500, GCash: 0 });
  });
});

describe('Acceptance 7 - refusals (each leaves the receipt, the conversions and the analytics untouched)', () => {
  const untouched = async (fn: () => Promise<{ status: number; body: any }>, why: string) => {
    const receipt = receiptText();
    const analytics = canonicalAnalytics(fs);
    const r = await fn();
    refused(r, why);
    expect(conversions(), why).toHaveLength(0);
    expect(receiptText(), why).toBe(receipt);
    expect(canonicalAnalytics(fs), why).toBe(analytics);
  };

  it('no open ERP till shift for the store (M1)', async () => {
    await untouched(() => correct(body(), { deps: makeDeps(fs, { openTillShift: async () => null }) }), 'no shift');
  });

  it("a shift opened AFTER the sale's own clock is refused - an offline sale synced later (M2)", async () => {
    await untouched(() => correct(body(), { deps: makeDeps(fs, { openTillShift: async () => ({ openedAtMs: T_SALE + 1 }) }) }), 'shift opened after the sale');
    const ok = await correct(body(), { deps: makeDeps(fs, { openTillShift: async () => ({ openedAtMs: T_SALE }) }) });
    expect(ok.status, 'openedAt === the sale time is allowed (<=)').toBe(200);
  });

  it('above what the receipt took in that method (M3)', async () => {
    await untouched(() => correct(body({ amount: 50001 })), '1 centavo above mop[Cash]');
    expect((await correct(body({ amount: 50000, requestId: R2 }))).status, 'exactly mop[Cash] is fine').toBe(200);
  });

  it('from a method the receipt never used', async () => {
    await untouched(() => correct(body({ fromMethod: 'Card', toMethod: 'GCash' })), 'no Card on this receipt');
  });

  it('to an inactive method, an unknown method, or the same method in any letter case (M5)', async () => {
    await untouched(() => correct(body({ toMethod: 'Maya' })), 'inactive');
    await untouched(() => correct(body({ toMethod: 'Bitcoin' })), 'unknown');
    await untouched(() => correct(body({ toMethod: 'Cash', reference: '' })), 'same');
    await untouched(() => correct(body({ toMethod: 'cash', reference: '' })), 'same, other case');
  });

  it('without a reference for a reference tender (hasRef), blank or spaces (M6)', async () => {
    await untouched(() => correct(body({ reference: '' })), 'empty reference');
    await untouched(() => correct(body({ reference: '   ' })), 'spaces');
    const { reference: _r, ...none } = body();
    await untouched(() => correct(none), 'no reference field');
  });

  it('a receipt that is missing, a refund, or voided', async () => {
    fs.seed(`stores/${STORE}/receipts/rr`, { ...fs.get(`stores/${STORE}/receipts/r1`)!, id: 'rr', receiptId: 'rr', isRefund: true, parentReceiptId: 'r1' });
    fs.seed(`stores/${STORE}/receipts/rv`, { ...fs.get(`stores/${STORE}/receipts/r1`)!, id: 'rv', receiptId: 'rv', status: 'voided' });
    for (const id of ['rr', 'rv']) await untouched(() => correct(body({ receiptId: id })), id);
    const ghost = await correct(body({ receiptId: 'ghost' }));
    expect(ghost.status).toBe(404);
  });

  it('amount must be a positive whole number of centavos; requestId must be a uuid', async () => {
    for (const amount of [0, -100, 1.5, '20000', null, Number.NaN]) await untouched(() => correct(body({ amount })), `amount ${String(amount)}`);
    await untouched(() => correct(body({ requestId: 'not-a-uuid' })), 'requestId');
    const noReq = body();
    delete (noReq as any).requestId;
    await untouched(() => correct(noReq), 'no requestId');
  });

  it('a wrong PIN: 403, nothing written (M14)', async () => {
    const r = await correct(body({ pin: PIN_BAD }));
    expect(r.status).toBe(403);
    expect(r.body.ok).toBe(false);
    expect(fs.commits).toHaveLength(0);
    expect(conversions()).toHaveLength(0);
  });
});

describe('Acceptance 7 - stacked corrections and retries', () => {
  it('a second correction of the same full amount is refused; partials are summed inside the transaction (M4)', async () => {
    const first = await correct(body({ amount: 50000 }));
    expect(first.status).toBe(200);
    const second = await correct(body({ amount: 50000, requestId: R2 }));
    refused(second, 'same full amount again');
    const one = await correct(body({ amount: 1, requestId: R2 }));
    refused(one, 'even 1 centavo');
    expect(byMethodOf(fs, 'analytics', DAY).Cash, 'never negative').toBe(0);
    expect(conversions()).toHaveLength(1);
  });

  it('partial then partial: 300.00 then 200.01 is refused, 200.00 is accepted', async () => {
    expect((await correct(body({ amount: 30000 }))).status).toBe(200);
    refused(await correct(body({ amount: 20001, requestId: R2 })), '200.01 left only 200.00');
    expect((await correct(body({ amount: 20000, requestId: R2 }))).status).toBe(200);
    expect(byMethodOf(fs, 'analytics', DAY)).toEqual({ Cash: 0, GCash: 500 });
  });

  it('a retry with the same requestId and body returns the first doc and moves the analytics once (M10)', async () => {
    const a = await correct(body());
    const commits = fs.commits.length;
    const b = await correct(body({ pin: '777777' })); // PIN left out of the body hash
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ ok: true, conversionId: R1, replayed: true });
    expect(a.body.conversionId).toBe(b.body.conversionId);
    expect(conversions()).toHaveLength(1);
    expect(byMethodOf(fs, 'analytics', DAY)).toEqual({ Cash: 299.5, GCash: 200.5 });
    expect(fs.commits.length, 'a replay commits nothing').toBe(commits);
  });

  it('the same requestId with a different body is refused and changes nothing (M11)', async () => {
    await correct(body());
    const analytics = canonicalAnalytics(fs);
    refused(await correct(body({ amount: 100 })), 'different amount');
    refused(await correct(body({ toMethod: 'Card', reference: 'C-1' })), 'different method');
    expect(conversions()).toHaveLength(1);
    expect(canonicalAnalytics(fs)).toBe(analytics);
  });

  it('two concurrent corrections of the full amount: exactly one succeeds, no method goes negative (M12)', async () => {
    const [a, b] = await Promise.all([correct(body({ amount: 50000 })), correct(body({ amount: 50000, requestId: R2 }))]);
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
    expect(conversions()).toHaveLength(1);
    expect(byMethodOf(fs, 'analytics', DAY).Cash).toBe(0);
  });
});

void SHIFT_OPENED;
