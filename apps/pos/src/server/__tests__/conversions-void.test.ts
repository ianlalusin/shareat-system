/**
 * T-427 slice T - POST /api/pos2/conversions/void. Ruling 4, Acceptance 6.
 *
 * CONTRACT (module/route/body style as conversions.test.ts):
 *   module   @/server/pos2/conversions   export async function handleConversionVoid(req: Request, deps: Pos2Deps): Promise<Response>
 *   route    POST /api/pos2/conversions/void   body { storeId, deviceId, conversionId, requestId (uuid) }   roles admin|manager|cashier, no PIN
 *   200      { ok:true, conversionId, skipped:boolean }   skipped:true when the doc was already voided (a no-op, nothing moves)
 *   refused  409 (nothing written) when: source !== 'pos2-convert' (a 'pos2-correction' or a v1 doc without source), tillShiftOpenedAtMs !== the OPEN
 *            shift's openedAtMs (or missing), or no shift is open.   404 unknown id.   403/401 identity and role as the create route.
 *   writes   status 'voided', voidedAt, voidedBy {uid,name}, voidedVia 'pos2'; reverses with sign -1 on the DOC'S OWN dayId/dayStartMs
 *            (never today's day); no same-day rule.
 * RED: the module does not exist yet.   MUTANTS: M1 voids a pos2-correction; M2 voids a v1 doc; M3 voids a doc of an earlier shift; M4 reverses on
 *   "today"; M5 no voidedVia; M6 a second void reverses again; M7 a same-day rule blocks 11:50 PM -> 12:10 AM; M8 inexact reversal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE, SHIFT_OPENED, STORE, byMethodOf, canonicalAnalytics, createFakeFirestore, dayIdOf, json, makeDeps, post, seedSale, seedStaff, seedStore } from '@/test-helpers/pos2';
import type { FakeFirestore } from '@/test-helpers/fakeFirestore';

vi.mock('server-only', () => ({}));

let fs: FakeFirestore;
const T_1150PM = Date.parse('2026-10-14T23:50:00+08:00');
const T_1210AM = Date.parse('2026-10-15T00:10:00+08:00');
const NOON = Date.parse('2026-10-14T12:00:00+08:00');
const D14 = dayIdOf(NOON);
const D15 = dayIdOf(T_1210AM);
const R1 = '9d3e5f6a-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const V1 = 'c1d2e3f4-0a1b-4c2d-8e3f-4a5b6c7d8e9f';
const V2 = 'd2e3f4a5-1b2c-4d3e-9f4a-5b6c7d8e9f0a';

async function make(nowMs: number, over: Record<string, unknown> = {}, requestId = R1) {
  const { handleConversion } = await import('@/server/pos2/conversions');
  const d = makeDeps(fs, { nowMs: () => nowMs });
  const res = await handleConversion(post('conversions', { storeId: STORE, deviceId: DEVICE, requestId, direction: 'cash_in', walletMethod: 'GCash', amountCentavos: 50000, ...over }), d.deps as any);
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
}
async function voidIt(conversionId: string, o: { nowMs?: number; deps?: ReturnType<typeof makeDeps>; requestId?: string } = {}) {
  const d = o.deps ?? makeDeps(fs, { nowMs: () => o.nowMs ?? NOON });
  const { handleConversionVoid } = await import('@/server/pos2/conversions');
  const res = await handleConversionVoid(post('conversions/void', { storeId: STORE, deviceId: DEVICE, conversionId, requestId: o.requestId ?? V1 }), d.deps as any);
  return { status: res.status, body: await json(res) };
}
const seedDoc = (id: string, over: Record<string, unknown>) =>
  fs.seed(`stores/${STORE}/paymentConversions/${id}`, {
    storeId: STORE, dayId: D14, dayStartMs: Date.parse('2026-10-14T00:00:00+08:00'), amount: 100, fromMethod: 'GCash', toMethod: 'Cash', note: null, status: 'active',
    createdBy: { uid: 'cashier', name: 'Cora Cashier' }, createdAtClientMs: NOON, voidedAt: null, voidedBy: null, ...over,
  });
// v1's increment leaves 0 entries behind after a reversal; drop them before comparing.
const strip = (s: string) => s.replace(/,?"source":"(?:delta-server|payment-conversion)"/g, "").replace(/"(Cash|GCash)":0,?/g, '').replace(/,}/g, '}');

beforeEach(async () => {
  fs = createFakeFirestore();
  seedStaff(fs);
  seedStore(fs);
  await seedSale(fs, { id: 'r1', lines: [{ id: 'l1', unit: 1000, qty: 1 }], total: 1000, mop: { Cash: 500, GCash: 500 } }, { nowMs: NOON });
});

describe('Acceptance 6 - a valid void', () => {
  it('an unconfirmed failed void gives an honest retry message and leaves the original conversion active', async () => {
    await make(NOON);
    const before = canonicalAnalytics(fs);
    fs.failNextCommit(new Error('synthetic void commit failed'));
    const first = await voidIt(R1);
    expect(first.status).toBe(503);
    expect(first.body.error).toBe("We couldn't confirm whether this conversion was voided. Retry this same request or check today's conversions before trying another void.");
    expect(fs.get(`stores/${STORE}/paymentConversions/${R1}`)!.status).toBe('active');
    expect(canonicalAnalytics(fs)).toBe(before);
    expect((await voidIt(R1)).body).toMatchObject({ ok: true, skipped: false });
    expect(byMethodOf(fs, 'analytics', D14)).toEqual({ Cash: 500, GCash: 500 });
  });

  it('a void commit with a lost acknowledgment is recovered without reversing twice', async () => {
    await make(NOON);
    const d = makeDeps(fs, { nowMs: () => NOON });
    const run = d.deps.db.runTransaction;
    d.deps.db.runTransaction = async (fn) => { await run(fn); throw new Error('synthetic void acknowledgment lost'); };
    const first = await voidIt(R1, { deps: d });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, conversionId: R1, skipped: true });
    expect(byMethodOf(fs, 'analytics', D14)).toEqual({ Cash: 500, GCash: 500 });
    const before = canonicalAnalytics(fs);
    expect((await voidIt(R1)).body).toMatchObject({ ok: true, skipped: true });
    expect(canonicalAnalytics(fs)).toBe(before);
  });

  it('reverses exactly, marks the doc voided with voidedVia pos2 (M5, M8)', async () => {
    const before = canonicalAnalytics(fs);
    await make(NOON);
    expect(canonicalAnalytics(fs)).not.toBe(before);
    const r = await voidIt(R1);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ok: true, conversionId: R1, skipped: false });
    expect(byMethodOf(fs, 'analytics', D14)).toEqual({ Cash: 500, GCash: 500 });
    expect(strip(canonicalAnalytics(fs))).toBe(strip(before));
    expect(fs.get(`stores/${STORE}/paymentConversions/${R1}`)).toMatchObject({ status: 'voided', voidedVia: 'pos2', voidedBy: { uid: 'cashier' } });
    expect(fs.get(`stores/${STORE}/paymentConversions/${R1}`)!.voidedAt).toBeTruthy();
  });

  it('a second void is a no-op: skipped, nothing moves, no double reversal (M6)', async () => {
    await make(NOON);
    await voidIt(R1);
    const after = canonicalAnalytics(fs);
    const again = await voidIt(R1, { requestId: V2 });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, skipped: true });
    expect(canonicalAnalytics(fs)).toBe(after);
  });

  it('an 11:50 PM conversion voided at 12:10 AM in the SAME shift is allowed and reversed on its OWN day (M4, M7)', async () => {
    expect(D14).not.toBe(D15);
    await make(T_1150PM);
    expect(byMethodOf(fs, 'analytics', D14)).toEqual({ Cash: 1000, GCash: 0 });
    const r = await voidIt(R1, { nowMs: T_1210AM });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(byMethodOf(fs, 'analytics', D14)).toEqual({ Cash: 500, GCash: 500 });
    expect(fs.has(`stores/${STORE}/analytics/${D15}`), 'nothing lands on the new day').toBe(false);
  });
});

describe('Acceptance 6 - refusals leave everything untouched (M1, M2, M3)', () => {
  const refusedUntouched = async (id: string, deps?: ReturnType<typeof makeDeps>) => {
    const before = canonicalAnalytics(fs);
    const docBefore = JSON.stringify(fs.get(`stores/${STORE}/paymentConversions/${id}`));
    const commits = fs.commits.length;
    const r = await voidIt(id, { deps });
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(canonicalAnalytics(fs)).toBe(before);
    expect(JSON.stringify(fs.get(`stores/${STORE}/paymentConversions/${id}`))).toBe(docBefore);
    expect(fs.commits.length).toBe(commits);
  };

  it('a pos2-correction doc', async () => {
    seedDoc('corr', { source: 'pos2-correction', receiptId: 'r1', tillShiftOpenedAtMs: SHIFT_OPENED });
    await refusedUntouched('corr');
  });
  it('a v1 doc (no source)', async () => {
    seedDoc('old', {});
    await refusedUntouched('old');
  });
  it('a pos2-convert doc from an earlier shift', async () => {
    seedDoc('prev', { source: 'pos2-convert', tillShiftOpenedAtMs: SHIFT_OPENED - 86_400_000 });
    await refusedUntouched('prev');
  });
  it('a pos2-convert doc with no tillShiftOpenedAtMs', async () => {
    seedDoc('nosh', { source: 'pos2-convert' });
    await refusedUntouched('nosh');
  });
  it('no open till shift at all', async () => {
    await make(NOON);
    await refusedUntouched(R1, makeDeps(fs, { nowMs: () => NOON, openTillShift: async () => null }));
  });
  it('an unknown conversion id is 404', async () => {
    expect((await voidIt('nope')).status).toBe(404);
  });
  it('a waiter, a stranger and a missing token are refused', async () => {
    fs.seed('staff/waiter', { uid: 'waiter', status: 'active', role: 'waiter', assignedStoreIds: [STORE], displayName: 'W' });
    await make(NOON);
    const { handleConversionVoid } = await import('@/server/pos2/conversions');
    const d = makeDeps(fs, { nowMs: () => NOON });
    const b = { storeId: STORE, deviceId: DEVICE, conversionId: R1, requestId: V1 };
    expect((await handleConversionVoid(post('conversions/void', b, 'tok-waiter'), d.deps as any)).status).toBe(403);
    expect((await handleConversionVoid(post('conversions/void', b, 'tok-elsewhere'), d.deps as any)).status).toBe(403);
    expect((await handleConversionVoid(post('conversions/void', b, null), d.deps as any)).status).toBe(401);
    expect(fs.get(`stores/${STORE}/paymentConversions/${R1}`)!.status).toBe('active');
  });
});
