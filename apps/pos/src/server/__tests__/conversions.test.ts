/**
 * T-427 slice T - POST /api/pos2/conversions (Convert: GCash cash-in / cash-out). docs/tasks/427-pos-v2-convert-cash-in-out.md Rulings 1-3, Acceptance 1-5.
 *
 * CONTRACT THE BUILDER MATCHES (fixed by this header; the void half is in conversions-void.test.ts):
 *   module   @/server/pos2/conversions   export async function handleConversion(req: Request, deps: Pos2Deps): Promise<Response>
 *   route    POST /api/pos2/conversions  (@/app/api/pos2/conversions/route.ts, same 503 behaviour as the other pos2 routes)
 *   body     { storeId, deviceId, requestId (uuid), direction: 'cash_in'|'cash_out', walletMethod: <storeModesOfPayment NAME>, amountCentavos (integer), note? }
 *            NO pin. Identity as T-424 (token -> staff doc -> store); roles admin|manager|cashier, else 403. `createdBy` is the CALLER, never a body field.
 *   200      { ok:true, conversionId (= requestId), replayed:boolean, warning?:string }   `warning` only when the `from` method is below zero after the write
 *   writes   stores/{s}/paymentConversions/{requestId}: v1 shape (storeId, dayId, dayStartMs, amount PESOS, fromMethod, toMethod, note, status 'active',
 *            createdBy {uid,name,role}, createdAt, createdAtClientMs = deps.nowMs(), voidedAt null, voidedBy null) + source 'pos2-convert', direction,
 *            amountCentavos, requestHash, tillShiftOpenedAtMs (= openTillShift().openedAtMs), warnedNegativeAtWrite:true only when warned.
 *            cash_in  => fromMethod = wallet, toMethod = cash method   (customer gives cash: shop's cash UP, GCash DOWN)
 *            cash_out => fromMethod = cash method, toMethod = wallet
 *            cash method = the store's ACTIVE type 'cash' storeModesOfPayment with the lowest sortOrder (its stored name).
 *            byMethod moved by blind increments on day/month/year/presets exactly as v1 (totalGross, txCount untouched).
 *   sentences (exact):
 *     NO_SHIFT   'Open the till shift in ERP before recording a cash-in or cash-out.'          (409, before any write)
 *     TOO_LARGE  'That amount is too large for one conversion. Split it or check the number.'  (4xx)
 *     WARNING    "Recorded. Today's <Wallet> total is below zero for now; the office will check this day if it stays that way."
 *   statuses 400 bad body, 401, 403, 409 business refusal (request id reused for a different body, no shift, method rules).
 *
 * RED FOR THE RIGHT REASON: @/server/pos2/conversions does not exist yet - every case fails on the missing module.
 * MUTANTS: M1 direction reversed (v1's comment bug); M2 totalGross/txCount moved; M3 doubled or lost move; M4 same requestId + new body accepted;
 *   M5 no shift gate; M6 cap missing/off by one; M7 cash accepted as wallet; M8 createdBy from body; M9 cash method picked by doc order;
 *   M10 negative day refused instead of recorded; M11 replay without the warning; M12 replay check ignores source; M13 pin demanded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE, PIN_OK, SHIFT_OPENED, STORE, byMethodOf, canonicalAnalytics, createFakeFirestore, dayIdOf, json, makeDeps, post, seedSale, seedStaff, seedStore } from '@/test-helpers/pos2';
import type { FakeFirestore } from '@/test-helpers/fakeFirestore';
import { createPaymentConversionServer, voidPaymentConversionServer } from '@/lib/__fixtures__/v1-analytics/applyPaymentConversionServer';

vi.mock('server-only', () => ({}));

let fs: FakeFirestore;
const NOON = Date.parse('2026-10-14T12:00:00+08:00');
const DAY = dayIdOf(NOON);
const R1 = '9d3e5f6a-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const R2 = 'a7c4e1b2-5d6f-4a8b-9c0d-1e2f3a4b5c6d';
const NO_SHIFT = 'Open the till shift in ERP before recording a cash-in or cash-out.';
const TOO_LARGE = 'That amount is too large for one conversion. Split it or check the number.';
const WARNING = "Recorded. Today's GCash total is below zero for now; the office will check this day if it stays that way.";
const ADVISORY_PENDING = "Recorded. The payment totals could not be checked just now; the office must check this day's payment methods.";

const body = (over: Record<string, unknown> = {}) => ({ storeId: STORE, deviceId: DEVICE, requestId: R1, direction: 'cash_in', walletMethod: 'GCash', amountCentavos: 50000, note: 'Maria', ...over });

async function convert(b: Record<string, unknown>, o: { token?: string | null; deps?: ReturnType<typeof makeDeps> } = {}) {
  const d = o.deps ?? makeDeps(fs, { nowMs: () => NOON });
  const { handleConversion } = await import('@/server/pos2/conversions');
  const res = await handleConversion(post('conversions', b, o.token === undefined ? 'tok-cashier' : o.token), d.deps as any);
  return { status: res.status, body: await json(res), calls: d.calls };
}
const convs = (f: FakeFirestore = fs) => f.list(`stores/${STORE}/paymentConversions`);
const refused = (r: { status: number; body: any }, why: string) => {
  expect(r.status, why).toBeGreaterThanOrEqual(400);
  expect(r.status, why).toBeLessThan(500);
  expect(r.body.ok, why).toBe(false);
};
const untouched = async (fn: () => Promise<{ status: number; body: any }>, why: string) => {
  const before = canonicalAnalytics(fs);
  const commits = fs.commits.length;
  refused(await fn(), why);
  expect(convs(), why).toHaveLength(0);
  expect(canonicalAnalytics(fs), why).toBe(before);
  expect(fs.commits.length, why).toBe(commits);
};

beforeEach(async () => {
  fs = createFakeFirestore();
  seedStaff(fs);
  fs.seed('staff/waiter', { uid: 'waiter', status: 'active', role: 'waiter', assignedStoreIds: [STORE], displayName: 'Wally Waiter' });
  seedStore(fs);
  // Today's sales: Cash 1000 and GCash 800, so a cash-in of up to 800 keeps GCash non-negative.
  await seedSale(fs, { id: 'r1', lines: [{ id: 'l1', unit: 1000, qty: 1 }], total: 1000, mop: { Cash: 1000 } }, { nowMs: NOON });
  await seedSale(fs, { id: 'r2', lines: [{ id: 'l1', unit: 800, qty: 1 }], total: 800, mop: { GCash: 800 } }, { nowMs: NOON });
});

describe('Acceptance 1 - direction and the figures', () => {
  it('cash-in 500 GCash: from GCash to Cash, GCash -500 / Cash +500 on day, month, year, presets; totals unchanged (M1, M2)', async () => {
    const day = fs.get(`stores/${STORE}/analytics/${DAY}`)!;
    const gross = day.payments.totalGross;
    const tx = day.payments.txCount;
    const r = await convert(body());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ok: true, conversionId: R1, replayed: false });
    expect(r.body.warning).toBeUndefined();
    const doc = fs.get(`stores/${STORE}/paymentConversions/${R1}`)!;
    expect(doc).toMatchObject({
      storeId: STORE, dayId: DAY, dayStartMs: Date.parse('2026-10-14T00:00:00+08:00'), amount: 500, fromMethod: 'GCash', toMethod: 'Cash', note: 'Maria',
      status: 'active', createdAtClientMs: NOON, voidedAt: null, voidedBy: null, source: 'pos2-convert', direction: 'cash_in', amountCentavos: 50000,
      tillShiftOpenedAtMs: SHIFT_OPENED,
    });
    expect(typeof doc.requestHash).toBe('string');
    expect(doc.createdAt).toBeTruthy();
    expect(byMethodOf(fs, 'analytics', DAY)).toEqual({ Cash: 1500, GCash: 300 });
    expect(byMethodOf(fs, 'analyticsMonths', DAY.slice(0, 6))).toEqual({ Cash: 1500, GCash: 300 });
    expect(byMethodOf(fs, 'analyticsYears', DAY.slice(0, 4))).toEqual({ Cash: 1500, GCash: 300 });
    const after = fs.get(`stores/${STORE}/analytics/${DAY}`)!;
    expect(after.payments.totalGross).toBe(gross);
    expect(after.payments.txCount).toBe(tx);
    const presets = fs.list(`stores/${STORE}/dashPresets`);
    expect(presets.length).toBeGreaterThan(0);
    for (const p of presets) expect(p.data.payments.byMethod, p.id).toEqual({ Cash: 1500, GCash: 300 });
  });

  it('cash-out 200 GCash: from Cash to GCash, Cash -200 / GCash +200 (M1)', async () => {
    const r = await convert(body({ direction: 'cash_out', amountCentavos: 20000 }));
    expect(r.status).toBe(200);
    expect(fs.get(`stores/${STORE}/paymentConversions/${R1}`)).toMatchObject({ fromMethod: 'Cash', toMethod: 'GCash', direction: 'cash_out', amount: 200 });
    expect(byMethodOf(fs, 'analytics', DAY)).toEqual({ Cash: 800, GCash: 1000 });
  });

  it("analytics are identical to v1's real createPaymentConversionServer; v1's void of our doc restores them", async () => {
    const twin = createFakeFirestore();
    seedStaff(twin);
    seedStore(twin);
    await seedSale(twin, { id: 'r1', lines: [{ id: 'l1', unit: 1000, qty: 1 }], total: 1000, mop: { Cash: 1000 } }, { nowMs: NOON });
    await seedSale(twin, { id: 'r2', lines: [{ id: 'l1', unit: 800, qty: 1 }], total: 800, mop: { GCash: 800 } }, { nowMs: NOON });
    await createPaymentConversionServer(twin.admin as any, STORE, { amount: 500, fromMethod: 'GCash', toMethod: 'Cash', note: 'Maria' }, { uid: 'cashier', name: 'Cora Cashier' }, new Date(NOON));
    const before = canonicalAnalytics(fs);
    await convert(body());
    expect(canonicalAnalytics(fs)).toBe(canonicalAnalytics(twin));
    const out = await voidPaymentConversionServer(fs.admin as any, STORE, R1, { uid: 'x', name: 'y' }, new Date(NOON));
    expect(out).toEqual({ skipped: false });
    const strip = (s: string) => s.replace(/,?"source":"(?:delta-server|payment-conversion)"/g, "").replace(/"(Cash|GCash)":0,?/g, '');
    expect(strip(canonicalAnalytics(fs))).toBe(strip(before));
  });

  it('createdBy is the signed-in caller, never a body name (M8); no PIN is asked or stored (M13)', async () => {
    const d = makeDeps(fs, { nowMs: () => NOON });
    const r = await convert(body({ createdBy: { uid: 'evil', name: 'Evil Eve', role: 'admin' }, requestedBy: 'Evil Eve', pin: PIN_OK }), { deps: d });
    expect(r.status).toBe(200);
    const doc = fs.get(`stores/${STORE}/paymentConversions/${R1}`)!;
    expect(doc.createdBy).toMatchObject({ uid: 'cashier', name: 'Cora Cashier', role: 'cashier' });
    expect(JSON.stringify(doc)).not.toContain('Evil');
    expect(d.calls.approve, 'no manager PIN is requested').toHaveLength(0);
    expect(JSON.stringify([...fs.docs.entries()]).includes(PIN_OK)).toBe(false);
  });

  it('the cash method is the ACTIVE cash method with the lowest sortOrder, whatever the document order (M9)', async () => {
    fs.seed(`stores/${STORE}/storeModesOfPayment/z-first`, { id: 'z-first', name: 'Till Cash', type: 'cash', sortOrder: 0, isActive: true, hasRef: false, isArchived: false });
    fs.seed(`stores/${STORE}/storeModesOfPayment/a-off`, { id: 'a-off', name: 'Old Cash', type: 'cash', sortOrder: -1, isActive: false, hasRef: false, isArchived: false });
    const r = await convert(body());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(fs.get(`stores/${STORE}/paymentConversions/${R1}`)!.toMethod).toBe('Till Cash');
    expect(byMethodOf(fs, 'analytics', DAY)['Till Cash']).toBe(500);
  });
});

describe('Acceptance 2 - two tabs, idempotency', () => {
  it('two tabs, two requestIds, transactions truly overlapping (beforeNextTransaction fires as tab A starts): both recorded, moved by the SUM (M3)', async () => {
    let tabB: Promise<{ status: number; body: any }> | undefined;
    fs.beforeNextTransaction(() => {
      tabB = convert(body({ requestId: R2, amountCentavos: 30000, note: 'tab B' }));
    });
    const a = await convert(body({ amountCentavos: 20000, note: 'tab A' }));
    expect(tabB, "the hook ran, so tab B started inside tab A's window").toBeDefined();
    const b = await tabB!;
    expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([200, 200]);
    expect(convs()).toHaveLength(2);
    expect(byMethodOf(fs, 'analytics', DAY)).toEqual({ Cash: 1500, GCash: 300 });
    expect(byMethodOf(fs, 'analyticsMonths', DAY.slice(0, 6))).toEqual({ Cash: 1500, GCash: 300 });
    const transactions = fs.commits.filter((c) => c.kind === 'transaction');
    // Two money transactions plus one advisory-only outcome for each request.
    expect(transactions).toHaveLength(4);
    expect(transactions.filter((c) => c.writes.some((w) => w.op === 'create' && w.path.includes('/paymentConversions/')))).toHaveLength(2);
    expect(transactions.filter((c) => c.writes.every((w) => w.op === 'update' && w.path.includes('/paymentConversions/')))).toHaveLength(2);
  });

  it('the SAME requestId from two overlapping tabs: one document, one move, no server error (M3)', async () => {
    let tabB: Promise<{ status: number; body: any }> | undefined;
    fs.beforeNextTransaction(() => {
      tabB = convert(body());
    });
    const a = await convert(body());
    const b = await tabB!;
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(a.status).toBeLessThan(500);
    expect(b.status).toBeLessThan(500);
    expect(convs()).toHaveLength(1);
    expect(byMethodOf(fs, 'analytics', DAY)).toEqual({ Cash: 1500, GCash: 300 });
  });

  it('a retry of a finished request returns the same doc and moves nothing again; a different body on that id is 409 (M3, M4)', async () => {
    await convert(body());
    const analytics = canonicalAnalytics(fs);
    const again = await convert(body());
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, conversionId: R1, replayed: true });
    expect(canonicalAnalytics(fs)).toBe(analytics);
    expect(convs()).toHaveLength(1);
    for (const change of [{ amountCentavos: 60000 }, { direction: 'cash_out' }, { walletMethod: 'Card' }]) {
      const r = await convert(body(change));
      expect(r.status, JSON.stringify(change)).toBe(409);
      expect(r.body.ok).toBe(false);
    }
    expect(canonicalAnalytics(fs)).toBe(analytics);
  });

  it('a request id that belongs to a tender CORRECTION is not a replay (M12)', async () => {
    fs.seed(`stores/${STORE}/paymentConversions/${R1}`, { storeId: STORE, source: 'pos2-correction', status: 'active', requestHash: 'x', amount: 1, fromMethod: 'Cash', toMethod: 'GCash' });
    const before = canonicalAnalytics(fs);
    const r = await convert(body());
    expect(r.status).toBe(409);
    expect(canonicalAnalytics(fs)).toBe(before);
  });
});

describe('Acceptance 3 - the till shift gate', () => {
  it('no open ERP till shift: refused with its own sentence, before any write (M5)', async () => {
    await untouched(async () => {
      const r = await convert(body(), { deps: makeDeps(fs, { nowMs: () => NOON, openTillShift: async () => null }) });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe(NO_SHIFT);
      return r;
    }, 'no shift');
  });
});

describe('Acceptance 4 - amounts and methods', () => {
  it('exactly 50,000 pesos is allowed; one centavo more is refused with the sentence (M6)', async () => {
    await seedSale(fs, { id: 'big', lines: [{ id: 'l1', unit: 60000, qty: 1 }], total: 60000, mop: { GCash: 60000 } }, { nowMs: NOON });
    const ok = await convert(body({ amountCentavos: 5_000_000 }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const before = canonicalAnalytics(fs);
    const over = await convert(body({ requestId: R2, amountCentavos: 5_000_001 }));
    refused(over, 'over cap');
    expect(over.body.error).toBe(TOO_LARGE);
    expect(canonicalAnalytics(fs)).toBe(before);
    expect(convs()).toHaveLength(1);
  });

  it.each([0, -100, 12.5, '500', null])('amount %j is refused with nothing written', async (amountCentavos) => {
    await untouched(() => convert(body({ amountCentavos })), String(amountCentavos));
  });

  it.each([
    ['Cash as the wallet (M7)', { walletMethod: 'Cash' }],
    ['an inactive wallet', { walletMethod: 'Maya' }],
    ['an unknown wallet', { walletMethod: 'PayPal' }],
    ['a missing wallet', { walletMethod: '' }],
    ['a bad direction', { direction: 'sideways' }],
    ['a non-uuid request id', { requestId: 'abc' }],
  ])('%s is refused with nothing written', async (name, over) => {
    await untouched(() => convert(body(over)), name);
  });

  it('a store with no active cash method is refused', async () => {
    fs.seed(`stores/${STORE}/storeModesOfPayment/m-cash`, { id: 'm-cash', name: 'Cash', type: 'cash', sortOrder: 1, isActive: false, hasRef: false, isArchived: false });
    await untouched(() => convert(body()), 'no cash method');
  });

  it('identity and roles: no token 401, bad token 401, unknown/other-store/inactive/waiter 403; admin and manager allowed', async () => {
    expect((await convert(body(), { token: null })).status).toBe(401);
    expect((await convert(body(), { token: 'bad' })).status).toBe(401);
    for (const t of ['tok-nobody', 'tok-elsewhere', 'tok-inactive', 'tok-waiter']) {
      const r = await convert(body(), { token: t });
      expect(r.status, t).toBe(403);
    }
    expect(convs()).toHaveLength(0);
    expect((await convert(body(), { token: 'tok-manager' })).status).toBe(200);
    expect((await convert(body({ requestId: R2 }), { token: 'tok-admin' })).status).toBe(200);
    expect(convs()).toHaveLength(2);
  });
});

describe('Acceptance 5 - a negative day is recorded, flagged, never refused', () => {
  it('an advisory outage that also blocks the confirmation read still reports the known committed conversion', async () => {
    const d = makeDeps(fs, { nowMs: () => NOON });
    const doc = d.deps.db.doc;
    d.deps.db.doc = (path: string) => {
      const ref = doc(path);
      const get = ref.get;
      let reads = 0;
      ref.get = async () => {
        if (path === `stores/${STORE}/analytics/${DAY}` ||
            (path === `stores/${STORE}/paymentConversions/${R1}` && ++reads > 1)) throw new Error('synthetic read outage');
        return get();
      };
      return ref;
    };
    const first = await convert(body({ amountCentavos: 100000 }), { deps: d });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, warning: ADVISORY_PENDING });
    expect(convs()).toHaveLength(1);
    expect(byMethodOf(fs, 'analytics', DAY)).toEqual({ Cash: 2000, GCash: -200 });
  });

  it('a failed primary commit writes nothing and gives an honest unconfirmed response, never Recorded', async () => {
    const before = canonicalAnalytics(fs);
    fs.failNextCommit(new Error('synthetic primary commit failed'));
    const result = await convert(body());
    expect(result.status).toBe(503);
    expect(result.body.ok).toBe(false);
    expect(result.body.error).toBe("We couldn't confirm whether this conversion was recorded. Retry this same request or check today's conversions before entering it again.");
    expect(convs()).toHaveLength(0);
    expect(canonicalAnalytics(fs)).toBe(before);
  });

  it('a primary commit with a lost acknowledgment is recovered by request id; replay never moves money again', async () => {
    const d = makeDeps(fs, { nowMs: () => NOON });
    const run = d.deps.db.runTransaction;
    d.deps.db.runTransaction = async (fn) => { await run(fn); throw new Error('synthetic primary acknowledgment lost'); };
    const first = await convert(body({ amountCentavos: 100000 }), { deps: d });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, conversionId: R1, replayed: true, warning: ADVISORY_PENDING });
    expect(byMethodOf(fs, 'analytics', DAY)).toEqual({ Cash: 2000, GCash: -200 });
    const before = canonicalAnalytics(fs);
    const again = await convert(body({ amountCentavos: 100000 }));
    expect(again.body).toMatchObject({ ok: true, replayed: true, warning: ADVISORY_PENDING });
    expect(canonicalAnalytics(fs)).toBe(before);
    expect(convs()).toHaveLength(1);
  });

  it('a committed advisory write whose acknowledgment fails is recovered from the conversion, preserving its exact warning', async () => {
    const d = makeDeps(fs, { nowMs: () => NOON });
    const run = d.deps.db.runTransaction;
    let calls = 0;
    d.deps.db.runTransaction = async (fn) => {
      const result = await run(fn);
      if (++calls === 2) throw new Error('synthetic advisory acknowledgment lost');
      return result;
    };
    const first = await convert(body({ amountCentavos: 100000 }), { deps: d });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, warning: WARNING });
    const before = canonicalAnalytics(fs);
    const again = await convert(body({ amountCentavos: 100000 }));
    expect(again.body).toMatchObject({ ok: true, replayed: true, warning: WARNING });
    expect(canonicalAnalytics(fs)).toBe(before);
    expect(convs()).toHaveLength(1);
  });

  it.each(['read', 'flag-write'] as const)('an advisory %s failure after commit still says Recorded, and replay never moves money again', async (failure) => {
    const d = makeDeps(fs, { nowMs: () => NOON });
    const originalDoc = d.deps.db.doc;
    d.deps.db.doc = (path: string) => {
      const ref = originalDoc(path);
      if (path === `stores/${STORE}/analytics/${DAY}`) {
        const originalGet = ref.get;
        ref.get = async () => {
          if (failure === 'read') throw new Error('synthetic advisory read failed');
          const snap = await originalGet();
          fs.failNextCommit(new Error('synthetic advisory write failed'));
          return snap;
        };
      }
      return ref;
    };
    const first = await convert(body({ amountCentavos: 100000 }), { deps: d });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, conversionId: R1, replayed: false, warning: ADVISORY_PENDING });
    expect(first.body.error).toBeUndefined();
    expect(convs()).toHaveLength(1);
    expect(byMethodOf(fs, 'analytics', DAY)).toEqual({ Cash: 2000, GCash: -200 });
    expect(fs.get(`stores/${STORE}/paymentConversions/${R1}`)!.advisoryPending).toBe(true);
    const beforeReplay = canonicalAnalytics(fs);
    const commits = fs.commits.length;
    const again = await convert(body({ amountCentavos: 100000 }));
    expect(again.body).toMatchObject({ ok: true, conversionId: R1, replayed: true, warning: ADVISORY_PENDING });
    expect(canonicalAnalytics(fs)).toBe(beforeReplay);
    expect(fs.commits.length).toBe(commits);
  });

  it("a cash-in larger than the day's GCash: 200, the exact warning, warnedNegativeAtWrite true, the money moved (M10)", async () => {
    const r = await convert(body({ amountCentavos: 100000 })); // 1000 against 800 of GCash sales -> -200
    expect(r.status).toBe(200);
    expect(r.body.warning).toBe(WARNING);
    expect(fs.get(`stores/${STORE}/paymentConversions/${R1}`)!.warnedNegativeAtWrite).toBe(true);
    expect(byMethodOf(fs, 'analytics', DAY)).toEqual({ Cash: 2000, GCash: -200 });
  });

  it('a replay of that request returns the SAME warning (M11); a request that stays non-negative has no warning and no flag', async () => {
    await convert(body({ amountCentavos: 100000 }));
    const again = await convert(body({ amountCentavos: 100000 }));
    expect(again.body).toMatchObject({ ok: true, replayed: true, warning: WARNING });
    const fine = await convert(body({ requestId: R2, direction: 'cash_out', amountCentavos: 100 }));
    expect(fine.body.warning).toBeUndefined();
    expect(fs.get(`stores/${STORE}/paymentConversions/${R2}`)!.warnedNegativeAtWrite).toBeFalsy();
  });
});
