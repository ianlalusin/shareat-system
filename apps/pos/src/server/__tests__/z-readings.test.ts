/**
 * T-471 slice T - POST /api/pos2/z-readings (close the day) and GET /api/pos2/x-reading. docs/tasks/471-pos-day-close-z-reading.md Rulings 1-6.
 *
 * CONTRACT THE BUILDER MATCHES:
 *   module   @/server/pos2/z-readings   export async function handleZReading(req: Request, deps: Pos2Deps): Promise<Response>      (POST)
 *                                        export async function handleXReading(req: Request, deps: Pos2Deps): Promise<Response>      (GET ?storeId=)
 *   routes   @/app/api/pos2/z-readings/route (POST) and @/app/api/pos2/x-reading/route (GET), same 503 behaviour as the other pos2 routes.
 *   Z body   { storeId, deviceId (uuid), requestId (uuid), pin, unsentCount (integer: the tablet's "Unsent sales") }. Identity as T-424 (token -> staff doc -> store;
 *            the store is the verified one). Roles admin | manager | cashier, else 403. Order: identity, role, 400s (requestId, unsentCount not a whole number >= 0),
 *            unsentCount > 0 -> 409 'Send the unsent sales first.' (before the PIN and before any write), then the manager PIN (requireManagerApproval), then the record.
 *   Z write  ONE new document stores/{s}/zReadings/{zNo} (zNo 'Z-0001' style, next = highest zSeq + 1, NEVER reused) holding: storeId, zNo, zSeq, fromMs, toMs (= deps.nowMs()),
 *            spansTwoDates, fromDate, toDate, printedAtMs (= toMs), reading (the computeZReading result, integer CENTAVOS), requestId, requestHash, printedBy {uid,name,role},
 *            approvedByPersonId, source 'pos2-z', createdAt. Plus the replay slot stores/{s}/pos2Slots/zreq__{requestId} = { zNo, requestHash }. Nothing else is written:
 *            no receipt, no analytics, no PIN anywhere.
 *   Z reads  window = zWindow({ lastZToMs: last Z's toMs, nowMs }); receipts / conversions / handovers from Firestore; late = arrived after the last Z's printedAtMs.
 *   Z 200    { ok:true, zNo, replayed:boolean, window:{fromMs,toMs,spansTwoDates,fromDate,toDate}, reading, printedBy:{uid,name,role}, approvedByPersonId }
 *   replay   same requestId + same body (storeId, deviceId) -> 200 replayed:true with the STORED figures (never recomputed), no new document; same requestId + a
 *            different body -> 409 'That request id was already used for a different day close.'
 *   X        GET with Authorization Bearer and ?storeId=; no PIN; roles as above; 200 { ok:true, window, reading, lastZ: { zNo, toMs } | null } for [last Z toMs, now); writes NOTHING.
 *
 * RED FOR THE RIGHT REASON: @/server/pos2/z-readings does not exist yet - every case fails on the missing module.
 * MUTANTS: M1 store taken from the body past identity; M2 no PIN; M3 PIN persisted; M4 Z allowed with unsent > 0; M5 requestId replay writes a second Z; M6 replay recomputes;
 *   M7 zNo reused / reset; M8 next window not from the last Z; M9 X writes a document; M10 Z touches receipts or analytics; M11 body hash differs but replay accepted;
 *   M12 late receipt dropped; M13 wrong role allowed; M14 sales after the Z held back (Z locks the till).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE, MANAGER_PERSON, OTHER_STORE, PIN_BAD, PIN_OK, STORE, canonicalAnalytics, createFakeFirestore, json, makeDeps, seedSale, seedStaff, seedStore, storedAnywhere } from '@/test-helpers/pos2';
import { FakeTimestamp, type FakeFirestore } from '@/test-helpers/fakeFirestore';

vi.mock('server-only', () => ({}));

let fs: FakeFirestore;
const at = (s: string) => Date.parse(`${s}+08:00`);
const NOW1 = at('2026-10-15T01:00:00'); // closing at 1 a.m.
const NOW2 = at('2026-10-16T00:30:00');
const FIRST_FROM = at('2026-10-14T04:00:00');
const R1 = '9d3e5f6a-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const R2 = 'a7c4e1b2-5d6f-4a8b-9c0d-1e2f3a4b5c6d';
const R3 = 'b8d5f2c3-6e7a-4b9c-8d1e-2f3a4b5c6d7e';
const zPath = (no: string) => `stores/${STORE}/zReadings/${no}`;
const zDocs = () => fs.list(`stores/${STORE}/zReadings`);

const zbody = (over: Record<string, unknown> = {}) => ({ storeId: STORE, deviceId: DEVICE, requestId: R1, pin: PIN_OK, unsentCount: 0, ...over });
function req(body: unknown, token: string | null = 'tok-manager'): Request {
  return new Request('http://pos2.test/api/pos2/z-readings', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
}
async function closeDay(body: Record<string, unknown>, o: { token?: string | null; nowMs?: number; deps?: ReturnType<typeof makeDeps> } = {}) {
  const d = o.deps ?? makeDeps(fs, { nowMs: () => o.nowMs ?? NOW1 });
  const { handleZReading } = await import('@/server/pos2/z-readings');
  const res = await handleZReading(req(body, o.token === undefined ? 'tok-manager' : o.token), d.deps as any);
  return { status: res.status, body: await json(res), calls: d.calls };
}
async function xRead(qs: string, o: { token?: string | null; nowMs?: number } = {}) {
  const d = makeDeps(fs, { nowMs: () => o.nowMs ?? NOW1 });
  const { handleXReading } = await import('@/server/pos2/z-readings');
  const token = o.token === undefined ? 'tok-cashier' : o.token;
  const res = await handleXReading(new Request(`http://pos2.test/api/pos2/x-reading${qs}`, { method: 'GET', headers: token ? { authorization: `Bearer ${token}` } : {} }), d.deps as any);
  return { status: res.status, body: await json(res), calls: d.calls };
}
const refused = (r: { status: number; body: any }, why: string) => {
  expect(r.status, why).toBeGreaterThanOrEqual(400);
  expect(r.status, why).toBeLessThan(500);
  expect(r.body.ok, why).toBe(false);
};
const sale = (id: string, pesos: number, ms: number, extra: Record<string, unknown> = {}) =>
  seedSale(fs, { id, lines: [{ id: `l-${id}`, unit: pesos, qty: 1 }], total: pesos, mop: { Cash: pesos }, createdAtClientMs: ms, receiptNumber: `SHT-01-${id}`, extra });

beforeEach(async () => {
  fs = createFakeFirestore();
  seedStaff(fs);
  seedStore(fs);
  fs.seed('staff/kitchen', { uid: 'kitchen', status: 'active', role: 'kitchen', assignedStoreIds: [STORE], displayName: 'Kim Kitchen' });
  await sale('a1', 500, at('2026-10-14T10:00:00'));
  await sale('a2', 250.5, at('2026-10-14T19:30:00'));
});

describe('Ruling 3 - who may close the day, and the manager PIN', () => {
  it('a cashier presses it, a manager approves with the PIN: Z-0001 is written with the figures', async () => {
    const r = await closeDay(zbody(), { token: 'tok-cashier' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, zNo: 'Z-0001', replayed: false, approvedByPersonId: MANAGER_PERSON, printedBy: { uid: 'cashier', name: 'Cora Cashier', role: 'cashier' } });
    expect(r.body.window).toEqual({ fromMs: FIRST_FROM, toMs: NOW1, spansTwoDates: false, fromDate: '2026-10-14', toDate: '2026-10-15' });
    expect(r.body.reading.receiptCount).toBe(2);
    expect(r.body.reading.totals.saleCentavos).toBe(75_050);
    expect(r.calls.approve).toEqual([{ posStoreId: STORE, deviceId: DEVICE, pin: PIN_OK }]);
    const doc = fs.get(zPath('Z-0001'))!;
    expect(doc).toMatchObject({ storeId: STORE, zNo: 'Z-0001', zSeq: 1, fromMs: FIRST_FROM, toMs: NOW1, printedAtMs: NOW1, spansTwoDates: false, requestId: R1, source: 'pos2-z', approvedByPersonId: MANAGER_PERSON });
    expect(doc.reading.totals.saleCentavos).toBe(75_050);
  });
  it('a wrong PIN or a missing PIN writes nothing', async () => {
    const commits = fs.commits.length;
    refused(await closeDay(zbody({ pin: PIN_BAD })), 'wrong pin');
    refused(await closeDay(zbody({ pin: '' })), 'blank pin');
    const noPin: Record<string, unknown> = zbody(); delete noPin.pin;
    refused(await closeDay(noPin), 'no pin');
    expect(zDocs()).toHaveLength(0);
    expect(fs.commits.length).toBe(commits);
  });
  it('the PIN is never stored', async () => {
    await closeDay(zbody());
    expect(storedAnywhere(fs, PIN_OK)).toBe(false);
  });
  it('a bad tablet id is a 400, not a PIN check', async () => {
    const r = await closeDay(zbody({ deviceId: 'not-a-uuid' }));
    expect(r.status).toBe(400);
    expect(r.calls.approve).toHaveLength(0);
  });
  it('only admin, manager and cashier; the store is the verified one', async () => {
    refused(await closeDay(zbody(), { token: 'tok-kitchen' }), 'kitchen role');
    refused(await closeDay(zbody(), { token: null }), 'no token');
    refused(await closeDay(zbody(), { token: 'tok-elsewhere' }), 'manager of another store');
    refused(await closeDay(zbody(), { token: 'tok-inactive' }), 'inactive');
    refused(await closeDay(zbody({ storeId: OTHER_STORE }), { token: 'tok-manager' }), 'body names a store the caller has no access to');
    expect(zDocs()).toHaveLength(0);
    expect(fs.list(`stores/${OTHER_STORE}/zReadings`)).toHaveLength(0);
    expect((await closeDay(zbody(), { token: 'tok-admin' })).status).toBe(200);
  });
});

describe('Ruling 5 - refused while the tablet still has unsent sales', () => {
  it('unsentCount above zero: 409 with the plain sentence, no PIN asked, nothing written', async () => {
    const commits = fs.commits.length;
    const r = await closeDay(zbody({ unsentCount: 2 }));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Send the unsent sales first.');
    expect(r.calls.approve).toHaveLength(0);
    expect(zDocs()).toHaveLength(0);
    expect(fs.commits.length).toBe(commits);
  });
  it('a missing or non-integer unsentCount is a 400 (the tablet must say)', async () => {
    for (const bad of [undefined, -1, 1.5, '0', null]) {
      const b: Record<string, unknown> = zbody({ unsentCount: bad }); if (bad === undefined) delete b.unsentCount;
      const r = await closeDay(b);
      expect(r.status, String(bad)).toBe(400);
    }
    expect(zDocs()).toHaveLength(0);
  });
  it('a missing request id is a 400', async () => {
    expect((await closeDay(zbody({ requestId: 'nope' }))).status).toBe(400);
  });
});

describe('Ruling 4 - the Z is the server\'s record: one new document, nothing else touched', () => {
  it('writes only the Z document and its replay slot; receipts and analytics are byte-identical', async () => {
    const analytics = canonicalAnalytics(fs);
    const receipts = JSON.stringify(fs.list(`stores/${STORE}/receipts`));
    await closeDay(zbody());
    expect(canonicalAnalytics(fs)).toBe(analytics);
    expect(JSON.stringify(fs.list(`stores/${STORE}/receipts`))).toBe(receipts);
    const paths = fs.commits.flatMap((c) => c.writes.map((w) => w.path)).sort();
    expect(paths).toEqual([zPath('Z-0001'), `stores/${STORE}/pos2Slots/zreq__${R1}`].sort());
  });
  it('is idempotent by request id: a retry returns the same Z, with the stored figures, and writes nothing', async () => {
    const first = await closeDay(zbody());
    await sale('a3', 999, at('2026-10-14T21:00:00')); // a sale in the closed window that arrives now must not rewrite the printed Z
    const commits = fs.commits.length;
    const again = await closeDay(zbody(), { nowMs: NOW1 + 60_000 });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ zNo: 'Z-0001', replayed: true });
    expect(again.body.reading).toEqual(first.body.reading);
    expect(again.body.window).toEqual(first.body.window);
    expect(zDocs()).toHaveLength(1);
    expect(fs.commits.length).toBe(commits);
  });
  it('the same request id with a different body is refused and nothing is written', async () => {
    await closeDay(zbody());
    const commits = fs.commits.length;
    const other = await closeDay(zbody({ deviceId: '4a3b8c1e-8d5a-4b7e-9c11-0a1b2c3d4e5f' }));
    expect(other.status).toBe(409);
    expect(other.body.error).toBe('That request id was already used for a different day close.');
    expect(fs.commits.length).toBe(commits);
  });
  it('the PIN is not part of the body hash: a retry with a different (valid) PIN is the same request', async () => {
    await closeDay(zbody());
    const again = await closeDay(zbody({ pin: PIN_OK }));
    expect(again.body.replayed).toBe(true);
  });
});

describe('Ruling 1 - Z to Z; Ruling 2 - selling goes on', () => {
  it('the second Z starts where the first ended and does not count the first day again', async () => {
    await closeDay(zbody());
    await sale('b1', 100, at('2026-10-15T12:00:00')); // next business day's sale
    const z2 = await closeDay(zbody({ requestId: R2 }), { nowMs: NOW2 });
    expect(z2.body).toMatchObject({ zNo: 'Z-0002', replayed: false });
    expect(z2.body.window).toMatchObject({ fromMs: NOW1, toMs: NOW2, spansTwoDates: false });
    expect(z2.body.reading.receiptCount).toBe(1);
    expect(z2.body.reading.totals.saleCentavos).toBe(10_000);
  });
  it('a sale rung right after the Z (the till is not locked) belongs to the next day', async () => {
    await closeDay(zbody());
    await sale('b2', 70, NOW1 + 1_000);
    const x = await xRead('?storeId=S1', { nowMs: NOW1 + 3_600_000 });
    expect(x.body.reading.receiptCount).toBe(1);
    expect(x.body.reading.totals.saleCentavos).toBe(7_000);
  });
  it('a forgotten Z: the next one covers both days and says it spans two dates', async () => {
    await closeDay(zbody());
    const z2 = await closeDay(zbody({ requestId: R2 }), { nowMs: NOW1 + 49 * 3_600_000 });
    expect(z2.body.window.spansTwoDates).toBe(true);
    expect(fs.get(zPath('Z-0002'))!.spansTwoDates).toBe(true);
  });
  it('zNo is the highest number + 1 and is never reused, even if an older one is missing', async () => {
    fs.seed(zPath('Z-0009'), { zNo: 'Z-0009', zSeq: 9, storeId: STORE, fromMs: FIRST_FROM, toMs: NOW1 - 1, printedAtMs: NOW1 - 1, reading: {} });
    const r = await closeDay(zbody());
    expect(r.body.zNo).toBe('Z-0010');
    expect(r.body.window.fromMs).toBe(NOW1 - 1);
  });
  it('a receipt rung before the last Z but arrived after it is counted on the next Z and listed by number', async () => {
    await closeDay(zbody());
    await sale('late1', 40, at('2026-10-14T23:50:00'), { createdAt: FakeTimestamp.fromMillis(NOW1 + 120_000) });
    const z2 = await closeDay(zbody({ requestId: R2 }), { nowMs: NOW2 });
    expect(z2.body.reading.lateReceiptNumbers).toEqual(['SHT-01-late1']);
    expect(z2.body.reading.totals.saleCentavos).toBe(4_000);
    const z3 = await closeDay(zbody({ requestId: R3 }), { nowMs: NOW2 + 3_600_000 });
    expect(z3.body.reading.lateReceiptNumbers).toEqual([]);
    expect(z3.body.reading.receiptCount).toBe(0);
  });
  it('a receipt committed between the clock read and the transaction of a Z is counted on ONE Z, not two', async () => {
    // Sold just before Z1's moment, but it reached the server a moment AFTER that moment while Z1 was still reading: Z1 counts it (sold inside its window).
    await sale('race1', 70, NOW1 - 1000, { createdAt: FakeTimestamp.fromMillis(NOW1 + 500) });
    const z1 = await closeDay(zbody());
    expect(z1.body.reading.receiptCount).toBe(3);
    expect(fs.get(zPath('Z-0001'))!.receiptIds).toContain('race1');
    const z2 = await closeDay(zbody({ requestId: R2 }), { nowMs: NOW2 });
    expect(z2.body.reading.receiptCount).toBe(0);
    expect(z2.body.reading.lateReceiptNumbers).toEqual([]);
    expect(z2.body.reading.totals.saleCentavos).toBe(0);
  });
  it('a genuinely late receipt is counted once on the next Z, and its id is stored there', async () => {
    await closeDay(zbody());
    await sale('late2', 40, at('2026-10-14T23:50:00'), { createdAt: FakeTimestamp.fromMillis(NOW1 + 120_000) });
    const z2 = await closeDay(zbody({ requestId: R2 }), { nowMs: NOW2 });
    expect(z2.body.reading.receiptCount).toBe(1);
    expect(z2.body.reading.lateReceiptNumbers).toEqual(['SHT-01-late2']);
    expect(fs.get(zPath('Z-0002'))!.receiptIds).toEqual(['late2']);
  });
  it('a receipt counted late on Z2 is not counted again on Z3 even if it arrived after Z2 started', async () => {
    await closeDay(zbody());
    // Sold before Z1, arrived at NOW2 + 1 ms: after Z2's clock read, before Z2 read the data. Z2 counts it late; Z3 must not.
    await sale('late3', 40, at('2026-10-14T23:50:00'), { createdAt: FakeTimestamp.fromMillis(NOW2 + 1) });
    const z2 = await closeDay(zbody({ requestId: R2 }), { nowMs: NOW2 });
    expect(z2.body.reading.lateReceiptNumbers).toEqual(['SHT-01-late3']);
    const z3 = await closeDay(zbody({ requestId: R3 }), { nowMs: NOW2 + 3_600_000 });
    expect(z3.body.reading.receiptCount).toBe(0);
    expect(z3.body.reading.lateReceiptNumbers).toEqual([]);
    expect(z3.body.reading.totals.saleCentavos).toBe(0);
  });
  it('Convert, refunds and voids are in the figures', async () => {
    fs.seed(`stores/${STORE}/paymentConversions/c1`, { status: 'active', fromMethod: 'GCash', toMethod: 'Cash', amount: 200, createdAtClientMs: at('2026-10-14T12:00:00') });
    fs.seed(`stores/${STORE}/receipts/rf1`, { id: 'rf1', isRefund: true, status: 'final', receiptNumber: 'SHT-01-RF1', createdAtClientMs: at('2026-10-14T13:00:00'), createdAt: FakeTimestamp.fromMillis(at('2026-10-14T13:00:00')), total: -100, refundTotalCentavos: 10_000, refundTender: { methodId: 'm-cash', methodName: 'Cash' } });
    await sale('v1', 80, at('2026-10-14T14:00:00'), { status: 'voided' });
    const r = await closeDay(zbody());
    expect(r.body.reading.convertNetCashCentavos).toBe(20_000);
    expect(r.body.reading.refunds).toEqual({ count: 1, centavos: 10_000 });
    expect(r.body.reading.voids.count).toBe(1);
    expect(r.body.reading.receiptCount).toBe(2);
  });
});

describe('X-reading - the same figures any time, closes nothing', () => {
  it('needs a token and a store but no PIN; a cashier may read it', async () => {
    const r = await xRead('?storeId=S1');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.calls.approve).toHaveLength(0);
    expect(r.body.window).toEqual({ fromMs: FIRST_FROM, toMs: NOW1, spansTwoDates: false, fromDate: '2026-10-14', toDate: '2026-10-15' });
    expect(r.body.reading.totals.saleCentavos).toBe(75_050);
    expect(r.body.lastZ).toBeNull();
    refused(await xRead('?storeId=S1', { token: null }), 'no token');
    refused(await xRead('?storeId=S2'), 'a store the caller has no access to');
    refused(await xRead(''), 'no store');
    refused(await xRead('?storeId=S1', { token: 'tok-kitchen' }), 'kitchen');
  });
  it('writes nothing, ever, and matches what the Z then records', async () => {
    const commits = fs.commits.length;
    const x = await xRead('?storeId=S1');
    expect(fs.commits.length).toBe(commits);
    expect(zDocs()).toHaveLength(0);
    expect(fs.list(`stores/${STORE}/pos2Slots`)).toHaveLength(0);
    const z = await closeDay(zbody());
    expect(z.body.reading).toEqual(x.body.reading);
  });
  it('after a Z it reads from that Z', async () => {
    await closeDay(zbody());
    const x = await xRead('?storeId=S1', { nowMs: NOW1 + 600_000 });
    expect(x.body.window.fromMs).toBe(NOW1);
    expect(x.body.reading.receiptCount).toBe(0);
    expect(x.body.lastZ).toEqual({ zNo: 'Z-0001', toMs: NOW1 });
  });
});

describe('T-474 DEF-757 - a Z may never end before the previous Z ended', () => {
  const seedZ = (toMs: number) => fs.seed(zPath('Z-0010'), { zNo: 'Z-0010', zSeq: 10, storeId: STORE, fromMs: FIRST_FROM, toMs, printedAtMs: toMs, reading: {}, receiptIds: [] });
  it('the latest Z ends AFTER this request\'s clock -> 409, no Z document and no slot written', async () => {
    seedZ(NOW1 + 60_000);
    const commits = fs.commits.length;
    const r = await closeDay(zbody(), { nowMs: NOW1 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Another tablet just closed the day. Check the last Z number and try again.');
    expect(zDocs().map((d) => d.id)).toEqual(['Z-0010']);
    expect(fs.get(`stores/${STORE}/pos2Slots/zreq__${R1}`)).toBeUndefined();
    expect(fs.commits.length).toBe(commits);
  });
  it('the latest Z ends at exactly this request\'s clock -> 409 (an empty window is also refused)', async () => {
    seedZ(NOW1);
    const r = await closeDay(zbody(), { nowMs: NOW1 });
    expect(r.status).toBe(409);
    expect(zDocs()).toHaveLength(1);
  });
  it('a later clock still closes normally (Z-0011 from the previous end)', async () => {
    seedZ(NOW1 - 1);
    const r = await closeDay(zbody(), { nowMs: NOW1 });
    expect(r.status).toBe(200);
    expect(r.body.zNo).toBe('Z-0011');
  });
});

describe('T-474 DEF-758 - a receipt that arrives more than 7 days late reaches the next Z', () => {
  const DAY8 = 8 * 24 * 3_600_000;
  it('sold 8 days before the last Z, uploaded after it: counted and listed late on the next Z, once', async () => {
    await closeDay(zbody());
    await sale('old8', 33, NOW1 - DAY8, { createdAt: FakeTimestamp.fromMillis(NOW1 + 120_000) });
    const z2 = await closeDay(zbody({ requestId: R2 }), { nowMs: NOW2 });
    expect(z2.body.reading.lateReceiptNumbers).toEqual(['SHT-01-old8']);
    expect(z2.body.reading.totals.saleCentavos).toBe(3_300);
    expect(fs.get(zPath('Z-0002'))!.receiptIds).toEqual(['old8']);
    const z3 = await closeDay(zbody({ requestId: R3 }), { nowMs: NOW2 + 3_600_000 });
    expect(z3.body.reading.lateReceiptNumbers).toEqual([]);
    expect(z3.body.reading.receiptCount).toBe(0);
  });
  it('the X-reading lists the same very late receipt', async () => {
    await closeDay(zbody());
    await sale('old9', 12, NOW1 - 30 * 24 * 3_600_000, { createdAt: FakeTimestamp.fromMillis(NOW1 + 5_000) });
    const x = await xRead('?storeId=S1', { nowMs: NOW1 + 600_000 });
    expect(x.body.reading.lateReceiptNumbers).toEqual(['SHT-01-old9']);
  });
  it('a receipt counted late on Z2 that arrived after Z2\'s clock is not counted again on Z3', async () => {
    await closeDay(zbody());
    await sale('late8', 40, NOW1 - DAY8, { createdAt: FakeTimestamp.fromMillis(NOW2 + 1) });
    const z2 = await closeDay(zbody({ requestId: R2 }), { nowMs: NOW2 });
    expect(z2.body.reading.lateReceiptNumbers).toEqual(['SHT-01-late8']);
    const z3 = await closeDay(zbody({ requestId: R3 }), { nowMs: NOW2 + 3_600_000 });
    expect(z3.body.reading.receiptCount).toBe(0);
    expect(z3.body.reading.lateReceiptNumbers).toEqual([]);
  });
  it('a receipt sold before the last Z that arrived BEFORE that Z printed is not late', async () => {
    await closeDay(zbody());
    await sale('early', 40, at('2026-10-14T23:00:00'), { createdAt: FakeTimestamp.fromMillis(NOW1 - 60_000) });
    const z2 = await closeDay(zbody({ requestId: R2 }), { nowMs: NOW2 });
    expect(z2.body.reading.receiptCount).toBe(0);
    expect(z2.body.reading.lateReceiptNumbers).toEqual([]);
  });
});
