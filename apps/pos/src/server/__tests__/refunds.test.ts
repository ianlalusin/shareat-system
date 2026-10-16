/**
 * T-424 slice T - POST /api/pos2/refunds. Acceptance 5 (refund), 10 (route half of the B1 mutant). Contract: header of `@/test-helpers/pos2`.
 *
 * RED FOR THE RIGHT REASON: `@/server/pos2/refunds` does not exist yet - each case fails on "Cannot find package '@/server/pos2/refunds'".
 * Expected amounts come from an independent oracle in this file (`unitShare`) built on the T-423 `allocate`, not from the route.
 *
 * MUTANTS: M1 refund at list price (ignore the bill discount); M2 refunded qty read from the client-writable parent counters;
 *   M3 no idempotency on receiptNumber; M4 pin in the body hash; M5 per-unit rounding without the remainder on the last unit;
 *   M6 accept a non-cash tender; M7 reuse the parent's number / "RF-" number; M8 refund analytics skipped or mop written on the refund;
 *   M9 two concurrent refunds both pass; M10 approval consulted from the Firestore claim doc; M11 write before the PIN is checked;
 *   M12 createdAtClientMs taken from the client; M13 PIN persisted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE, MANAGER_PERSON, NOW, PIN_BAD, PIN_OK, STORE, analyticsDocs, byMethodOf, createFakeFirestore, dayIdOf, json, makeDeps, post, seedRefundRecord, seedSale,
  seedStaff, seedStore, storedAnywhere, T_SALE, type LineSpec,
} from '@/test-helpers/pos2';
import type { FakeFirestore } from '@/test-helpers/fakeFirestore';
import { allocate } from '@/lib/money/centavos';

vi.mock('server-only', () => ({}));

let fs: FakeFirestore;
const DAY = dayIdOf(T_SALE);

const baseBody = (over: Record<string, unknown> = {}) => ({
  storeId: STORE, parentReceiptId: 'r1', lines: [{ lineId: 'l1', qty: 1 }], tenderMethodId: 'm-cash', reason: 'customer returned it',
  terminalNo: 1, terminalSeq: 2, receiptNumber: 'SHT-01-000002', pin: PIN_OK, deviceId: DEVICE, ...over,
});

async function refund(body: Record<string, unknown>, o: { token?: string; fs?: FakeFirestore; deps?: ReturnType<typeof makeDeps> } = {}) {
  const target = o.fs ?? fs;
  const d = o.deps ?? makeDeps(target);
  const { handleRefund } = await import('@/server/pos2/refunds');
  const res = await handleRefund(post('refunds', body, o.token ?? 'tok-cashier'), d.deps as any);
  return { status: res.status, body: await json(res), calls: d.calls };
}
const refundDocs = (f: FakeFirestore = fs) => f.list(`stores/${STORE}/receipts`).filter((d) => d.data.isRefund === true);
const parent = (f: FakeFirestore = fs) => f.get(`stores/${STORE}/receipts/r1`)!;

/** Oracle: the paid amount of one line is allocate(total, nets)[i]; units take equal shares, the LAST unit takes the remainder. */
function unitShare(totalPesos: number, lines: LineSpec[], lineId: string, alreadyRefunded: number, n: number): number {
  const nets = lines.map((l) => Math.max(0, l.qty - (l.free ?? 0) - (l.voided ?? 0)) * Math.round(l.unit * 100));
  const shares = allocate(Math.round(totalPesos * 100), nets);
  const i = lines.findIndex((l) => l.id === lineId);
  const q = lines[i]!.qty - (lines[i]!.free ?? 0) - (lines[i]!.voided ?? 0);
  const base = Math.floor(shares[i]! / q);
  return n * base + (alreadyRefunded + n === q ? shares[i]! - q * base : 0);
}

const DISCOUNTED: LineSpec[] = [{ id: 'l1', unit: 100, qty: 3 }, { id: 'l2', unit: 50, qty: 2 }]; // list 400, paid 360 (10% bill discount)

beforeEach(async () => {
  fs = createFakeFirestore();
  seedStaff(fs);
  seedStore(fs);
  await seedSale(fs, { id: 'r1', lines: DISCOUNTED, total: 360 });
});

describe('Acceptance 5 - a refund in v1 shape, paid-amount based, approved, analytics applied', () => {
  it('refunds one unit at its PAID share (10% bill discount => 90.00, not 100.00) and writes the v1-shaped refund (M1, M8, M12, M13)', async () => {
    const r = await refund(baseBody({ createdAtClientMs: 1, total: -9999 }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, refundTotalCentavos: 9000, replayed: false, receiptNumber: 'SHT-01-000002' });
    const doc = fs.get(`stores/${STORE}/receipts/${r.body.refundReceiptId}`)!;
    expect(doc).toMatchObject({
      isRefund: true, parentReceiptId: 'r1', status: 'final', total: -90, receiptNumber: 'SHT-01-000002', terminalNo: 1, terminalSeq: 2, receiptSeq: 2,
      refundTender: { methodId: 'm-cash', methodName: 'Cash' }, refundTotalCentavos: 9000, approvedByPersonId: MANAGER_PERSON, analyticsApplied: true,
    });
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]).toMatchObject({ id: 'l1', qtyOrdered: 1 });
    expect(doc.createdAtClientMs, 'the server clock, not the client').toBe(NOW);
    expect(doc.analytics?.mop, 'a refund carries NO analytics.mop (the ERP derives X = sum byMethod - totalSales)').toBeUndefined();
    expect(fs.get(`stores/${STORE}/receiptNumbers/SHT-01-000002`)).toMatchObject({ receiptId: r.body.refundReceiptId, terminalNo: 1, terminalSeq: 2 });
    expect(parent()).toMatchObject({ refundedQtys: { l1: 1 }, totalRefunded: 90, refundCount: 1 });
    expect(r.calls.approve).toEqual([{ posStoreId: STORE, deviceId: DEVICE, pin: PIN_OK }]);
    expect(storedAnywhere(fs, PIN_OK), 'the PIN is never persisted').toBe(false);
  });

  it('applies the refund analytics in the same transaction: totalGross falls by R, txCount +1, byMethod untouched, refundCount/refundTotal set', async () => {
    const before = fs.get(`stores/${STORE}/analytics/${DAY}`)!;
    expect(before.payments.totalGross).toBe(360);
    const r = await refund(baseBody());
    expect(r.status).toBe(200);
    const day = fs.get(`stores/${STORE}/analytics/${DAY}`)!;
    expect(day.payments.totalGross).toBe(270);
    expect(day.payments.txCount).toBe(2);
    expect(day.payments.byMethod).toEqual({ Cash: 360 });
    expect(day.items).toMatchObject({ refundCount: 1, refundTotal: 90 });
    expect(fs.commits.at(-1)!.kind, 'one transaction wrote the refund AND the analytics').toBe('transaction');
    const last = fs.commits.at(-1)!;
    const paths = last.writes.map((w) => w.path);
    expect(paths.some((p) => p === `stores/${STORE}/analytics/${DAY}`)).toBe(true);
    expect(paths.some((p) => p === `stores/${STORE}/receipts/${r.body.refundReceiptId}`)).toBe(true);
  });

  it('three partial refunds sum EXACTLY to the receipt total for each tax type (M5)', async () => {
    const cases: { name: string; total: number }[] = [
      { name: 'VAT inclusive', total: 109.99 },
      { name: 'VAT exclusive (12% added on top)', total: 123.19 },
      { name: 'non-VAT', total: 109.99 },
      { name: 'senior/PWD VAT-exempt 20%', total: 78.56 },
    ];
    for (const c of cases) {
      const f = createFakeFirestore();
      seedStaff(f);
      seedStore(f);
      const lines: LineSpec[] = [{ id: 'l1', unit: 33.33, qty: 3 }, { id: 'l2', unit: 10, qty: 1 }];
      await seedSale(f, { id: 'r1', lines, total: c.total });
      const asks = [
        { lines: [{ lineId: 'l1', qty: 1 }], seq: 2, expected: unitShare(c.total, lines, 'l1', 0, 1) },
        { lines: [{ lineId: 'l1', qty: 1 }], seq: 3, expected: unitShare(c.total, lines, 'l1', 1, 1) },
        { lines: [{ lineId: 'l1', qty: 1 }, { lineId: 'l2', qty: 1 }], seq: 4, expected: unitShare(c.total, lines, 'l1', 2, 1) + unitShare(c.total, lines, 'l2', 0, 1) },
      ];
      let sum = 0;
      for (const a of asks) {
        const r = await refund(baseBody({ lines: a.lines, terminalSeq: a.seq, receiptNumber: `SHT-01-${String(a.seq).padStart(6, '0')}` }), { fs: f });
        expect(r.status, `${c.name} refund #${a.seq - 1}: ${JSON.stringify(r.body)}`).toBe(200);
        expect(r.body.refundTotalCentavos, `${c.name} #${a.seq - 1}`).toBe(a.expected);
        sum += r.body.refundTotalCentavos;
      }
      expect(sum, `${c.name}: all refunds of one receipt equal its total`).toBe(Math.round(c.total * 100));
      const over = await refund(baseBody({ lines: [{ lineId: 'l2', qty: 1 }], terminalSeq: 5, receiptNumber: 'SHT-01-000005' }), { fs: f });
      expect(over.status, `${c.name}: nothing is left to refund`).toBeGreaterThanOrEqual(400);
    }
  });

  it('voided and free units are not refundable and are not part of the paid share', async () => {
    const f = createFakeFirestore();
    seedStaff(f);
    seedStore(f);
    const lines: LineSpec[] = [{ id: 'l1', unit: 100, qty: 3, voided: 1 }, { id: 'l2', unit: 50, qty: 2, free: 1 }];
    await seedSale(f, { id: 'r1', lines, total: 225 }); // nets 200 + 50, 10% bill discount
    const ok = await refund(baseBody({ lines: [{ lineId: 'l1', qty: 2 }] }), { fs: f });
    expect(ok.status).toBe(200);
    expect(ok.body.refundTotalCentavos).toBe(unitShare(225, lines, 'l1', 0, 2));
    const tooMany = await refund(baseBody({ lines: [{ lineId: 'l2', qty: 2 }], terminalSeq: 3, receiptNumber: 'SHT-01-000003' }), { fs: f });
    expect(tooMany.status, 'l2 has 2 ordered, 1 free: only 1 refundable').toBeGreaterThanOrEqual(400);
  });

  it('the second partial refund gets its OWN terminal number - never the parent\'s, never "RF-..." (DEF-001) (M7)', async () => {
    const a = await refund(baseBody());
    const b = await refund(baseBody({ terminalSeq: 3, receiptNumber: 'SHT-01-000003', lines: [{ lineId: 'l2', qty: 1 }] }));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const nums = refundDocs().map((d) => d.data.receiptNumber).sort();
    expect(nums).toEqual(['SHT-01-000002', 'SHT-01-000003']);
    for (const n of nums) expect(n).not.toMatch(/^RF-/);
    expect(parent().receiptNumber).toBe('SHT-01-000001');
    const reuse = await refund(baseBody({ terminalSeq: 1, receiptNumber: 'SHT-01-000001' }));
    expect(reuse.status, "the parent's own number cannot be used again").toBeGreaterThanOrEqual(400);
    expect(refundDocs()).toHaveLength(2);
  });
});

describe('Acceptance 5 - idempotent on receiptNumber (a timed-out retry never pays twice)', () => {
  it('the same request again returns the same refund, writes nothing new, and the analytics move once (M3)', async () => {
    const a = await refund(baseBody());
    const commitsAfterFirst = fs.commits.length;
    const b = await refund(baseBody());
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ ok: true, replayed: true, refundReceiptId: a.body.refundReceiptId, refundTotalCentavos: 9000 });
    expect(refundDocs()).toHaveLength(1);
    expect(parent()).toMatchObject({ refundedQtys: { l1: 1 }, refundCount: 1, totalRefunded: 90 });
    expect(fs.get(`stores/${STORE}/analytics/${DAY}`)!.payments.totalGross).toBe(270);
    expect(fs.commits.length, 'a replay commits nothing').toBe(commitsAfterFirst);
  });

  it('a retry with a different PIN typed is still the same request (the body hash leaves out the PIN) (M4)', async () => {
    const a = await refund(baseBody());
    const mgr2 = makeDeps(fs, {
      approveManagerPin: async () => ({ ok: true, approverPersonId: 'person-mgr-2' }),
    });
    const b = await refund(baseBody({ pin: '777777' }), { deps: mgr2 });
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ replayed: true, refundReceiptId: a.body.refundReceiptId });
    expect(refundDocs()).toHaveLength(1);
  });

  it('a different body on the same receiptNumber is refused and changes nothing', async () => {
    await refund(baseBody());
    const commits = fs.commits.length;
    const other = await refund(baseBody({ lines: [{ lineId: 'l1', qty: 2 }] }));
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect(other.status).toBeLessThan(500);
    expect(other.body.ok).toBe(false);
    expect(refundDocs()).toHaveLength(1);
    expect(fs.commits.length).toBe(commits);
    expect(parent()).toMatchObject({ refundedQtys: { l1: 1 }, refundCount: 1 });
  });
});

describe('Acceptance 5 - refusals', () => {
  it('a non-cash tender is refused (E-wallet refunds come later) (M6)', async () => {
    for (const id of ['m-gcash', 'm-card', 'no-such-method', 'm-maya']) {
      const r = await refund(baseBody({ tenderMethodId: id }));
      expect(r.status, id).toBeGreaterThanOrEqual(400);
      expect(r.status, id).toBeLessThan(500);
      expect(r.body.ok).toBe(false);
    }
    expect((await refund(baseBody({ tenderMethodId: 'm-gcash' }))).body.error).toMatch(/cash/i);
    expect(refundDocs()).toHaveLength(0);
    expect(fs.commits).toHaveLength(0);
  });

  it("a client-zeroed refundedQtys on the parent does not allow a second full refund (the route COUNTS the existing refunds) (M2)", async () => {
    seedRefundRecord(fs, 'prev1', 'r1', [{ id: 'l1', qty: 3, unit: 100 }], 270);
    fs.seed(`stores/${STORE}/receipts/r1`, { ...parent(), refundedQtys: {}, totalRefunded: 0, refundCount: 0 });
    const r = await refund(baseBody({ lines: [{ lineId: 'l1', qty: 1 }] }));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(refundDocs()).toHaveLength(1); // only the seeded one
    // and a line that was only part-refunded still has its remainder
    const f2 = createFakeFirestore();
    seedStaff(f2);
    seedStore(f2);
    await seedSale(f2, { id: 'r1', lines: DISCOUNTED, total: 360 });
    seedRefundRecord(f2, 'prev1', 'r1', [{ id: 'l1', qty: 2, unit: 100 }], 180);
    f2.seed(`stores/${STORE}/receipts/r1`, { ...f2.get(`stores/${STORE}/receipts/r1`)!, refundedQtys: { l1: 0 } });
    const one = await refund(baseBody({ lines: [{ lineId: 'l1', qty: 1 }] }), { fs: f2 });
    expect(one.status).toBe(200);
    const two = await refund(baseBody({ lines: [{ lineId: 'l1', qty: 1 }], terminalSeq: 3, receiptNumber: 'SHT-01-000003' }), { fs: f2 });
    expect(two.status, 'l1 has 3 ordered; 2 + 1 refunded already').toBeGreaterThanOrEqual(400);
  });

  it('over-refund, unknown line, bad quantities, empty lines, blank reason, bad receipt number: all refused with nothing written', async () => {
    const bads: [string, Record<string, unknown>][] = [
      ['qty above ordered', { lines: [{ lineId: 'l1', qty: 4 }] }],
      ['unknown line', { lines: [{ lineId: 'nope', qty: 1 }] }],
      ['qty 0', { lines: [{ lineId: 'l1', qty: 0 }] }],
      ['qty negative', { lines: [{ lineId: 'l1', qty: -1 }] }],
      ['qty fractional', { lines: [{ lineId: 'l1', qty: 1.5 }] }],
      ['qty not a number', { lines: [{ lineId: 'l1', qty: '1' }] }],
      ['no lines', { lines: [] }],
      ['blank reason', { reason: '   ' }],
      ['receipt number not a terminal number', { receiptNumber: 'RF-SHT-01-000001' }],
    ];
    for (const [name, over] of bads) {
      const r = await refund(baseBody(over));
      expect(r.status, name).toBeGreaterThanOrEqual(400);
      expect(r.status, name).toBeLessThan(500);
      expect(r.body.ok, name).toBe(false);
    }
    expect(fs.commits, 'no refusal wrote anything').toHaveLength(0);
  });

  it('the parent must be a final, non-refund receipt of this store', async () => {
    fs.seed(`stores/${STORE}/receipts/rv`, { ...parent(), id: 'rv', receiptId: 'rv', status: 'voided' });
    fs.seed(`stores/${STORE}/receipts/rr`, { ...parent(), id: 'rr', receiptId: 'rr', isRefund: true, parentReceiptId: 'r1' });
    for (const id of ['rv', 'rr']) {
      const r = await refund(baseBody({ parentReceiptId: id }));
      expect(r.status, id).toBeGreaterThanOrEqual(400);
      expect(r.body.ok).toBe(false);
    }
    const missing = await refund(baseBody({ parentReceiptId: 'ghost' }));
    expect(missing.status).toBe(404);
    expect(fs.commits).toHaveLength(0);
  });

  it('a wrong or missing manager PIN: 403 with the approval message, and NOTHING is written (M11)', async () => {
    const wrong = await refund(baseBody({ pin: PIN_BAD }));
    expect(wrong.status).toBe(403);
    expect(wrong.body).toMatchObject({ ok: false, error: 'That PIN cannot approve this. Ask a store manager.' });
    const { pin: _p, ...noPin } = baseBody();
    const missing = await refund(noPin);
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(missing.status).toBeLessThan(500);
    expect(fs.commits).toHaveLength(0);
    expect(refundDocs()).toHaveLength(0);
  });

  it('even a manager signed in on the tablet still needs the PIN (the approver is recorded)', async () => {
    const { pin: _p, ...noPin } = baseBody();
    const r = await refund(noPin, { token: 'tok-manager' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(fs.commits).toHaveLength(0);
  });
});

describe('Acceptance 5 - concurrency', () => {
  it('two concurrent refunds of the last unit: exactly one succeeds (M9)', async () => {
    const f = createFakeFirestore();
    seedStaff(f);
    seedStore(f);
    await seedSale(f, { id: 'r1', lines: [{ id: 'l1', unit: 100, qty: 1 }], total: 100 });
    const [a, b] = await Promise.all([
      refund(baseBody({ terminalSeq: 2, receiptNumber: 'SHT-01-000002' }), { fs: f }),
      refund(baseBody({ terminalSeq: 3, receiptNumber: 'SHT-01-000003' }), { fs: f }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);
    expect(refundDocs(f)).toHaveLength(1);
    expect(f.get(`stores/${STORE}/analytics/${DAY}`)!.payments.totalGross, 'the refund was applied once').toBe(0);
  });

  it('the same receipt number from two tablets at once creates one refund (the number doc is created, not set)', async () => {
    const f = createFakeFirestore();
    seedStaff(f);
    seedStore(f);
    await seedSale(f, { id: 'r1', lines: [{ id: 'l1', unit: 100, qty: 2 }], total: 200 });
    const [a, b] = await Promise.all([
      refund(baseBody({ lines: [{ lineId: 'l1', qty: 1 }] }), { fs: f }),
      refund(baseBody({ lines: [{ lineId: 'l1', qty: 2 }] }), { fs: f }),
    ]);
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
    expect(refundDocs(f)).toHaveLength(1);
  });
});

describe('Acceptance 10 (route half) - a forged claim doc or deviceId cannot change the store checked or the bucket charged (M10)', () => {
  it('the approval port gets exactly { posStoreId: the request store, deviceId: the request device, pin }; the Firestore claim doc is not read for it', async () => {
    fs.seed(`stores/${STORE}/terminals/01`, { deviceId: '11111111-2222-4333-8444-555555555555', claimedByUid: 'evil', erpStoreId: 'other-store', terminalPersonId: 'evil-person', storeId: 'S9' });
    const reads: string[] = [];
    const real = fs.admin.doc;
    const d = makeDeps(fs);
    (d.deps.db as any) = { ...fs.admin, doc: (p: string) => { reads.push(p); return real(p); } };
    const r = await refund(baseBody(), { deps: d });
    expect(r.status).toBe(200);
    expect(r.calls.approve).toHaveLength(1);
    expect(Object.keys(r.calls.approve[0]!).sort()).toEqual(['deviceId', 'pin', 'posStoreId']);
    expect(r.calls.approve[0]).toEqual({ posStoreId: STORE, deviceId: DEVICE, pin: PIN_OK });
    expect(reads.filter((p) => p.includes('/terminals/')), 'the claim doc is display only').toEqual([]);
  });
});

void analyticsDocs;
void byMethodOf;
