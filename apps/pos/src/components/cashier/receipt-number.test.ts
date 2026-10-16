/**
 * T-423 slice T - one receipt series per tablet, online and offline. Rulings 4, 5, 7, 8, 3(stored values); Acceptance 5, 6, 9, 11, 13.
 *
 * CONTRACT for the builder (S2) - behaviour of the EXISTING exports, no new signatures:
 *   completePaymentFromUnits(storeId, sessionId, user, payments, store, paymentMethods, expectedTotal?)   (components/cashier/firestore.ts)
 *   completePaymentOffline(...same...)                                                                     (components/cashier/offlinePayment.ts)
 * Both, when a payment is taken:
 *   1. call `reserveNext()` (lib/terminal/counter.ts) exactly ONCE, BEFORE and OUTSIDE the Firestore transaction callback (online) so a
 *      Firestore retry reuses the number; there is no other source of receipt numbers (no `counters/receipts`, no localStorage, no `OL`).
 *      With no terminal claim the payment is refused with counter.ts's TerminalNotClaimedError message and NOTHING is written.
 *   2. number = formatTerminalReceiptNumber(store.code, terminalNo, terminalSeq).
 *   3. the receipt doc keeps every v1 field and type, and adds `terminalNo` (number), `terminalSeq` (number), `deviceId` (string);
 *      `receiptSeq === terminalSeq`; `receiptNoFormatUsed === 'TERMINAL'`; `analyticsApplied === false`;
 *      `analytics.mop` keyed by payment-method NAME; every money value is `centavos / 100`.
 *   4. also writes `stores/{s}/receiptNumbers/{receiptNumber}` = { receiptId, terminalNo, terminalSeq, createdAt }.
 *      ONLINE: inside the transaction, as a read-then-set (the web SDK's Transaction has NO `create`): if the doc already exists the
 *      payment aborts with an Error and nothing else is written. OFFLINE: in the same batch, with `set`.
 *   5. ONLINE only: inside the transaction it reads `stores/{s}/terminals/{TT}`; a doc held by another deviceId, or released/missing
 *      (deviceId null), aborts the payment with an Error whose message mentions "terminal" and writes nothing.
 * Stored values (Ruling 1): a catalog price such as 99.999 is rounded (storedPesosToCentavos) and counted, never thrown at checkout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeFirestore, firebaseFirestoreModule, setActiveFake, type FakeFirestore,
} from '@/test-helpers/fakeFirestore';
import { createFakeIdb } from '@/test-helpers/fakeIdb';
import {
  STORE_ID, cashPayment, memoryLocalStorage, paymentMethods, seedSession, store, user, writtenReceipt,
} from '@/test-helpers/posFixtures';

vi.mock('firebase/firestore', async () => (await import('@/test-helpers/fakeFirestore')).firebaseFirestoreModule());
vi.mock('@/lib/firebase/client', () => ({
  db: { __fake: true },
  auth: { currentUser: { getIdToken: async () => 'test-token' } },
}));
vi.mock('@/context/auth-context', () => ({}));
vi.mock('@/components/cashier/activity-log', () => ({ writeActivityLog: vi.fn(async () => {}) }));
vi.mock('@/lib/server-profiles/activeLocalProfile', () => ({ getActiveLocalProfile: () => null }));
vi.mock('@/lib/printing/kitchenBackupPrint', () => ({ printKitchenTicketBackup: vi.fn() }));
vi.mock('@/lib/printing/kitchenBackupDeps', () => ({ makeKitchenBackupDeps: vi.fn(() => ({})) }));
vi.mock('@/lib/analytics/applyAnalyticsDeltaV2', () => ({ applyAnalyticsDeltaV2: vi.fn(async () => {}) }));
vi.mock('@/lib/analytics/applyReceiptDeltaServerFirst', () => ({ applyReceiptDeltaServerFirst: vi.fn(async () => {}) }));
vi.mock('@/lib/analytics/applyKdsTicketDelta', () => ({ applyKdsTicketDelta: vi.fn(async () => {}) }));
vi.mock('@/lib/analytics/applyKdsDeltaServerFirst', () => ({ applyKdsDeltaServerFirst: vi.fn(async () => {}) }));

import * as counter from '@/lib/terminal/counter';
import * as centavos from '@/lib/money/centavos';
import { completePaymentFromUnits } from '@/components/cashier/firestore';
import { completePaymentOffline } from '@/components/cashier/offlinePayment';

let fs: FakeFirestore;
let idb: ReturnType<typeof createFakeIdb>;

async function claimThisTablet(nextSeq = 5, deviceId = 'DEV-A') {
  await counter.saveTerminalClaim({ storeId: STORE_ID, terminalNo: 1, deviceId, nextSeq });
  fs.seed(`stores/${STORE_ID}/terminals/01`, { deviceId, claimedByUid: 'mgr', releaseEpoch: 0 });
}
const payOnline = (sessionId = 'sess1', amount = 600) =>
  completePaymentFromUnits(STORE_ID, sessionId, user, cashPayment(amount), store, paymentMethods, 598);
const payOffline = (sessionId = 'sess1', amount = 600) =>
  completePaymentOffline(STORE_ID, sessionId, user, cashPayment(amount), store, paymentMethods, 598);
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

beforeEach(() => {
  fs = createFakeFirestore();
  setActiveFake(fs);
  idb = createFakeIdb({ commitDelayMs: 5 });
  vi.stubGlobal('indexedDB', idb);
  vi.stubGlobal('localStorage', memoryLocalStorage());
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  centavos.resetNonCentavoCount();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('online payment: the terminal series (Acceptance 5)', () => {
  it('two payments on one tablet get n and n+1, formatted <CODE>-<TT>-<NNNNNN>, never from counters/receipts', async () => {
    await claimThisTablet(5);
    seedSession(fs, { sessionId: 'sess1' });
    seedSession(fs, { sessionId: 'sess2' });
    fs.seed(`stores/${STORE_ID}/counters/receipts`, { seq: 99 });
    await payOnline('sess1');
    await payOnline('sess2');
    const r1 = writtenReceipt(fs, 'sess1')!;
    const r2 = writtenReceipt(fs, 'sess2')!;
    expect(r1.receiptNumber).toBe('SHT-01-000005');
    expect(r2.receiptNumber).toBe('SHT-01-000006');
    expect(r1.receiptNumber).toMatch(/^[A-Z0-9]+-\d{2}-\d{6,}$/);
    expect(r1.receiptSeq).toBe(5);
    expect(r1.terminalSeq).toBe(5);
    expect(r1.terminalNo).toBe(1);
    expect(r1.deviceId).toBe('DEV-A');
    expect(r1.receiptNoFormatUsed).toBe('TERMINAL');
    expect(fs.get(`stores/${STORE_ID}/counters/receipts`)).toEqual({ seq: 99 }); // Ruling 8: v1's counter is untouched
    expect(idb.rows('terminal')[0].nextSeq).toBe(7);
  });

  it('writes the uniqueness-backstop doc stores/{s}/receiptNumbers/{number} (Ruling 7)', async () => {
    await claimThisTablet(5);
    seedSession(fs);
    await payOnline();
    const rn = fs.get(`stores/${STORE_ID}/receiptNumbers/SHT-01-000005`);
    expect(rn).toMatchObject({ receiptId: 'sess1', terminalNo: 1, terminalSeq: 5 });
    expect(rn?.createdAt).toBeTruthy();
  });

  it('a Firestore retry of the transaction reuses the reserved number instead of burning another (reserve is OUTSIDE the callback)', async () => {
    await claimThisTablet(5);
    seedSession(fs);
    fs.retryNextTransaction(1);
    await payOnline();
    expect(writtenReceipt(fs)!.receiptNumber).toBe('SHT-01-000005');
    expect(idb.rows('terminal')[0].nextSeq).toBe(6);
    expect(fs.list(`stores/${STORE_ID}/receiptNumbers`)).toHaveLength(1);
  });

  it('a payment that fails after the number was reserved skips the number, never reuses it', async () => {
    await claimThisTablet(5);
    seedSession(fs);
    await expect(payOnline('sess1', 100)).rejects.toThrow(/balance|not zero/i); // underpaid: refused
    expect(idb.rows('terminal')[0].nextSeq).toBeGreaterThanOrEqual(5);
    await payOnline('sess1', 600);
    const n = Number(writtenReceipt(fs)!.receiptNumber.slice(-6));
    expect(n).toBeGreaterThanOrEqual(5);
    expect(fs.has(`stores/${STORE_ID}/receiptNumbers/${writtenReceipt(fs)!.receiptNumber}`)).toBe(true);
  });

  it('with no terminal claim the payment is refused with the plain message and nothing is written', async () => {
    seedSession(fs);
    await expect(payOnline()).rejects.toThrow("Connect to the internet and set up this tablet's terminal number in Settings.");
    expect(fs.get(`stores/${STORE_ID}/sessions/sess1`)).toMatchObject({ status: 'active', isPaid: false });
    expect(fs.has(`stores/${STORE_ID}/receipts/sess1`)).toBe(false);
    expect(fs.commits).toHaveLength(0);
  });
});

describe('online payment: collision and released terminal (Acceptance 6, 13)', () => {
  it('a second create of the same receiptNumbers doc aborts the payment and leaves the session unpaid (kills: silent duplicate numbers)', async () => {
    await claimThisTablet(5);
    seedSession(fs);
    fs.seed(`stores/${STORE_ID}/receiptNumbers/SHT-01-000005`, { receiptId: 'someone-else', terminalNo: 1, terminalSeq: 5 });
    await expect(payOnline()).rejects.toThrow();
    expect(fs.get(`stores/${STORE_ID}/sessions/sess1`)).toMatchObject({ status: 'active', isPaid: false });
    expect(fs.has(`stores/${STORE_ID}/receipts/sess1`)).toBe(false);
    expect(fs.list(`stores/${STORE_ID}/sessions/sess1/payments`)).toHaveLength(0);
    expect(fs.get(`stores/${STORE_ID}/tables/t1`)).toMatchObject({ status: 'occupied', currentSessionId: 'sess1' });
    expect(fs.get(`stores/${STORE_ID}/receiptNumbers/SHT-01-000005`)).toMatchObject({ receiptId: 'someone-else' });
  });

  it('a tablet whose terminal now belongs to another device stops taking payment', async () => {
    await claimThisTablet(5, 'DEV-A');
    fs.seed(`stores/${STORE_ID}/terminals/01`, { deviceId: 'DEV-B', claimedByUid: 'mgr', releaseEpoch: 1 });
    seedSession(fs);
    await expect(payOnline()).rejects.toThrow(/terminal/i);
    expect(fs.has(`stores/${STORE_ID}/receipts/sess1`)).toBe(false);
    expect(fs.get(`stores/${STORE_ID}/sessions/sess1`)).toMatchObject({ isPaid: false });
  });

  it('a released terminal (deviceId null) also stops payment until the tablet claims again', async () => {
    await claimThisTablet(5, 'DEV-A');
    fs.seed(`stores/${STORE_ID}/terminals/01`, { deviceId: null, releasedAt: 1, releaseEpoch: 1 });
    seedSession(fs);
    await expect(payOnline()).rejects.toThrow(/terminal/i);
    expect(fs.has(`stores/${STORE_ID}/receipts/sess1`)).toBe(false);
  });
});

describe('the wire format does not change (Acceptance 9)', () => {
  const V1_TYPES: Record<string, string> = {
    id: 'string', storeId: 'string', sessionId: 'string', createdByUid: 'string', createdByUsername: 'string',
    sessionMode: 'string', tableId: 'string', tableNumber: 'string', customerName: 'string', total: 'number',
    totalPaid: 'number', change: 'number', status: 'string', receiptSeq: 'number', receiptNumber: 'string',
    receiptNoFormatUsed: 'string', createdAtClientMs: 'number', lines: 'array', customAdjustments: 'array',
    receiptId: 'string', loyaltyRedemptions: 'array', analytics: 'object', analyticsApplied: 'boolean', analyticsApplyId: 'string',
  };
  const kind = (v: unknown) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

  it('online receipt: every v1 field with its v1 type, plus the three additive fields; analyticsApplied false; mop keyed by method name', async () => {
    await claimThisTablet(5);
    seedSession(fs);
    await payOnline();
    const r = writtenReceipt(fs)!;
    for (const [field, type] of Object.entries(V1_TYPES)) expect(kind(r[field]), `field ${field}`).toBe(type);
    expect(r.billDiscount).toBeNull();
    expect(r.createdAt).toBeTruthy();
    expect(kind(r.terminalNo)).toBe('number');
    expect(kind(r.terminalSeq)).toBe('number');
    expect(kind(r.deviceId)).toBe('string');
    expect(r.analyticsApplied).toBe(false);
    expect(r.status).toBe('final');
    expect(r.total).toBe(598);
    expect(r.totalPaid).toBe(600);
    expect(r.change).toBe(2);
    expect(r.analytics.mop).toEqual({ Cash: 598 });
    expect(r.analytics.grandTotal).toBe(598);
    expect(r.analytics.v).toBe(2);
    for (const k of ['subtotal', 'discountsTotal', 'chargesTotal', 'taxAmount', 'vatableSales', 'vatExemptSales', 'totalPaid', 'change']) {
      expect(kind(r.analytics[k]), `analytics.${k}`).toBe('number');
    }
  });

  it('every money value on the receipt is an exact centavo (x*100 is an integer)', async () => {
    await claimThisTablet(5);
    seedSession(fs, { unitPrice: 33.33, qty: 3 });
    await completePaymentFromUnits(STORE_ID, 'sess1', user, cashPayment(150), store, paymentMethods);
    const r = writtenReceipt(fs)!;
    const money = [r.total, r.totalPaid, r.change, ...['subtotal', 'discountsTotal', 'chargesTotal', 'taxAmount', 'vatableSales', 'vatExemptSales', 'grandTotal', 'totalPaid', 'change'].map((k) => r.analytics[k]), ...Object.values(r.analytics.mop as Record<string, number>)];
    for (const x of money) expect(x === Math.round(x * 100) / 100, `${x}`).toBe(true);
  });

  it('the session is closed, the table freed and the receipt id is the session id, as before', async () => {
    await claimThisTablet(5);
    seedSession(fs);
    const id = await payOnline();
    expect(id).toBe('sess1');
    expect(fs.get(`stores/${STORE_ID}/sessions/sess1`)).toMatchObject({ status: 'closed', isPaid: true });
    expect(fs.get(`stores/${STORE_ID}/tables/t1`)).toMatchObject({ status: 'available', currentSessionId: null });
  });
});

describe('offline payment uses the same series (Acceptance 5, DEF-002, DEF-587)', () => {
  it('numbers the offline sale from reserveNext(): same format, no OL prefix, no daily reset, additive fields, number doc in the batch', async () => {
    await claimThisTablet(5);
    seedSession(fs);
    const res = await payOffline();
    await settle();
    expect(res.receiptNumber).toBe('SHT-01-000005');
    expect(res.receiptNumber).not.toMatch(/OL/);
    const r = writtenReceipt(fs)!;
    expect(r).toMatchObject({ receiptNumber: 'SHT-01-000005', receiptSeq: 5, terminalSeq: 5, terminalNo: 1, deviceId: 'DEV-A', receiptNoFormatUsed: 'TERMINAL', analyticsApplied: false });
    expect(r.offlineOrigin).toBe(true);
    expect(fs.get(`stores/${STORE_ID}/receiptNumbers/SHT-01-000005`)).toMatchObject({ receiptId: 'sess1', terminalNo: 1, terminalSeq: 5 });
    expect(r.analytics.mop).toEqual({ Cash: 598 });
    expect(idb.rows('terminal')[0].nextSeq).toBe(6);
  });

  it('an online sale followed by an offline sale continues the SAME series (one reserveNext, not two series)', async () => {
    await claimThisTablet(5);
    seedSession(fs, { sessionId: 'sess1' });
    seedSession(fs, { sessionId: 'sess2' });
    await payOnline('sess1');
    const off = await payOffline('sess2');
    await settle();
    expect(writtenReceipt(fs, 'sess1')!.receiptNumber).toBe('SHT-01-000005');
    expect(off.receiptNumber).toBe('SHT-01-000006');
  });

  it('does not use localStorage for numbering (works while every localStorage read of the old counter key would throw)', async () => {
    await claimThisTablet(5);
    seedSession(fs);
    const ls = memoryLocalStorage();
    const seen: string[] = [];
    vi.stubGlobal('localStorage', {
      ...ls,
      getItem: (k: string) => { seen.push(k); return ls.getItem(k); },
      setItem: (k: string, v: string) => { seen.push(k); ls.setItem(k, v); },
    });
    await payOffline();
    await settle();
    expect(seen).not.toContain('pos_offline_seq');
  });

  it('with no terminal claim the offline sale is refused with the plain message and nothing is written', async () => {
    seedSession(fs);
    await expect(payOffline()).rejects.toThrow("Connect to the internet and set up this tablet's terminal number in Settings.");
    await settle();
    expect(fs.commits).toHaveLength(0);
  });
});

describe('stored values are rounded and counted, never thrown at checkout (Acceptance 11)', () => {
  it('a catalog price of 99.999 completes the sale', async () => {
    await claimThisTablet(5);
    seedSession(fs, { unitPrice: 99.999, qty: 1 });
    const nonVat = { ...store, taxType: 'NON_VAT', taxRatePct: 0 };
    await expect(
      completePaymentFromUnits(STORE_ID, 'sess1', user, cashPayment(100), nonVat, paymentMethods),
    ).resolves.toBe('sess1');
    expect(writtenReceipt(fs)!.total).toBe(100);
    expect(centavos.getNonCentavoCount()).toBeGreaterThanOrEqual(1);
  });
});
