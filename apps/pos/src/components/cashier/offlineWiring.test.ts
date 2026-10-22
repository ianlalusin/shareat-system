/**
 * T-425 slice T - the offline sale and the offline void, wired to the ledger and the rules. Acceptance 1, 2 (ops fidelity), 8 (effects in IndexedDB), 11.
 *
 * CONTRACT for the builder (S1, S2, S4) - behaviour of the EXISTING exports (signatures unchanged):
 *   completePaymentOffline(storeId, sessionId, user, payments, store, paymentMethods, expectedTotal?)   (components/cashier/offlinePayment.ts)
 *   voidSessionOffline({ storeId, sessionId, reason, actor })                                            (components/cashier/offlineVoid.ts)
 * completePaymentOffline, in this order:
 *   1. reads (cache), totals, `assertOfflineSessionOwner(session, getBrowserDeviceId())`, `buildOfflineTenders(payments, paymentMethods)` - any refusal
 *      throws BEFORE a number is reserved: counter, ledger, Firestore and effects are untouched.
 *   2. builds the COMPLETE write list as ledger ops (payment doc ids FIXED as `<sessionId>-p<index>`; timestamps as markers), then
 *      `reserveOfflineEvent({kind:'sale', ...})` (number + event in ONE IndexedDB transaction). A failure there throws SALE_NOT_SAVED_MESSAGE and NOTHING
 *      reaches Firestore.
 *   3. only then builds the Firestore batch FROM the stored ops with `applyOpsToBatch` and `commitLocalFirst`s it. The receipt carries the additive
 *      `tendersToCheck: [{method, centavos, reference}]` (omitted or empty when every tender is cash).
 *   4. the deferred effects item goes to `lib/outbox/effects-store` (IndexedDB), not localStorage `offline_payment_queue`.
 * voidSessionOffline: `assertOfflineVoidAllowed(actor.role)` and `assertOfflineSessionOwner` first; the session update carries `voidedOffline: true`
 *   (plus the existing `offlineOrigin: true`); the batch is built from a `kind: 'void'` ledger event's ops the same way.
 * `getBrowserDeviceId()` (lib/offline/browserDevice.ts) is the device identity compared with `session.ownerTerminalId`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeFirestore, setActiveFake, type FakeFirestore } from '@/test-helpers/fakeFirestore';
import { createFakeIdb, type FakeIdbFactory } from '@/test-helpers/fakeIdb';
import { STORE_ID, memoryLocalStorage, seedSession, store, user } from '@/test-helpers/posFixtures';

vi.mock('firebase/firestore', async () => (await import('@/test-helpers/fakeFirestore')).firebaseFirestoreModule());
vi.mock('@/lib/firebase/client', () => ({ db: { __fake: true }, auth: { currentUser: { getIdToken: async () => 'test-token' } } }));
vi.mock('@/context/auth-context', () => ({}));
vi.mock('@/components/cashier/activity-log', () => ({ writeActivityLog: vi.fn(async () => {}) }));
vi.mock('@/lib/server-profiles/activeLocalProfile', () => ({ getActiveLocalProfile: () => null }));
vi.mock('@/lib/printing/kitchenBackupPrint', () => ({ printKitchenTicketBackup: vi.fn() }));
vi.mock('@/lib/printing/kitchenBackupDeps', () => ({ makeKitchenBackupDeps: vi.fn(() => ({})) }));
vi.mock('@/lib/analytics/applyAnalyticsDeltaV2', () => ({ applyAnalyticsDeltaV2: vi.fn(async () => {}) }));
vi.mock('@/lib/analytics/applyReceiptDeltaServerFirst', () => ({ applyReceiptDeltaServerFirst: vi.fn(async () => {}) }));
vi.mock('@/lib/analytics/applyKdsTicketDelta', () => ({ applyKdsTicketDelta: vi.fn(async () => {}) }));
vi.mock('@/lib/analytics/applyKdsDeltaServerFirst', () => ({ applyKdsDeltaServerFirst: vi.fn(async () => {}) }));
vi.mock('@/lib/offline/browserDevice', () => ({ getBrowserDeviceId: () => 'DEV-A' }));

import * as counter from '@/lib/terminal/counter';
import * as ledger from '@/lib/outbox/ledger';
import * as fx from '@/lib/outbox/effects-store';
import { completePaymentOffline } from '@/components/cashier/offlinePayment';
import { voidSessionOffline } from '@/components/cashier/offlineVoid';

let fs: FakeFirestore;
let idb: FakeIdbFactory;
let ls: Storage;

const mops: any[] = [
  { id: 'm-cash', name: 'Cash', type: 'cash' },
  { id: 'm-gcash', name: 'GCash', type: 'online', hasRef: true },
  { id: 'm-card', name: 'Visa', type: 'card' },
  { id: 'm-qr', name: 'QR Ph', type: 'online', gateway: 'paymongo_qrph' },
];
const cashier = { ...user, role: 'cashier' } as any;
const seed = (o: Parameters<typeof seedSession>[1] = {}, owner: string | null = 'DEV-A') => {
  const r = seedSession(fs, o);
  fs.seed(r.sessionPath, { ...fs.get(r.sessionPath), ...(owner ? { ownerTerminalId: owner } : {}), revision: 1 });
  return r;
};
const pay = (sessionId = 'sess1', payments: any[] = [{ id: 'p1', methodId: 'm-cash', amount: 600 }], u: any = cashier) =>
  completePaymentOffline(STORE_ID, sessionId, u, payments, store, mops, 598);
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const sessionPath = (id = 'sess1') => `stores/${STORE_ID}/sessions/${id}`;

beforeEach(async () => {
  fs = createFakeFirestore();
  setActiveFake(fs);
  idb = createFakeIdb({ commitDelayMs: 0 });
  vi.stubGlobal('indexedDB', idb);
  ls = memoryLocalStorage();
  vi.stubGlobal('localStorage', ls);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await counter.saveTerminalClaim({ storeId: STORE_ID, terminalNo: 1, deviceId: 'DEV-A', nextSeq: 5 });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('offline sale is ledger-first (Acceptance 1)', () => {
  it('T-458: uncached receipt/projection reads are unknown offline, not a reason to lose the new cash sale', async () => {
    seed();
    const read = fs.getDoc;
    vi.spyOn(fs, 'getDoc').mockImplementation(async ref => {
      if (ref.path.includes('/receipts/') || ref.path.includes('/activeSessions/')) {
        throw Object.assign(new Error('Failed to get document because the client is offline.'), { code: 'unavailable' });
      }
      return read(ref);
    });
    expect(await pay()).toEqual({ receiptId: 'sess1', receiptNumber: 'SHT-01-000005' });
    expect((await ledger.listEvents())).toHaveLength(1);
    expect(fs.get(`stores/${STORE_ID}/receipts/sess1`)).toMatchObject({ total: 598, receiptNumber: 'SHT-01-000005' });
    expect(idb.rows('terminal')[0].nextSeq).toBe(6);
  });

  it('T-458: a permission failure is not converted to a missing receipt', async () => {
    seed();
    const read = fs.getDoc;
    vi.spyOn(fs, 'getDoc').mockImplementation(async ref => {
      if (ref.path.includes('/receipts/')) throw Object.assign(new Error('permission denied'), { code: 'permission-denied' });
      return read(ref);
    });
    await expect(pay()).rejects.toThrow('permission denied');
    expect(fs.commits).toHaveLength(0);
    expect(idb.rows('events')).toHaveLength(0);
    expect(idb.rows('terminal')[0].nextSeq).toBe(5);
  });

  it('T-458: concurrent payment taps reuse the exact receipt, saved ops and one deferred effect', async () => {
    seed();
    const results = await Promise.all([pay(), pay()]);
    expect(results[0]).toEqual(results[1]);
    expect((await ledger.listEvents())).toHaveLength(1);
    expect(idb.rows('terminal')[0].nextSeq).toBe(6);
    expect(await fx.listEffectItems()).toHaveLength(1);
    expect(fs.commits[0]!.writes).toEqual(fs.commits[1]!.writes);
  });

  it('T-458: a saved event survives a lost SDK batch; retry replays stored ops without another number or effect', async () => {
    seed();
    fs.failNextCommit(Object.assign(new Error('offline queue lost'), { code: 'unavailable' }));
    const first = await pay();
    await settle();
    const original = (await ledger.listEvents())[0]!;
    expect(fs.get(`stores/${STORE_ID}/receipts/sess1`)).toBeUndefined();
    expect(await pay()).toEqual(first);
    expect(await ledger.listEvents()).toEqual([original]);
    expect(idb.rows('terminal')[0].nextSeq).toBe(6);
    expect(await fx.listEffectItems()).toHaveLength(1);
    expect(fs.get(`stores/${STORE_ID}/receipts/sess1`)).toMatchObject({ analyticsApplyId: original.ops!.find(o => o.path.includes('/receipts/'))!.data!.analyticsApplyId });
  });

  it('T-458: a different tender after a lost batch cannot replace the saved sale', async () => {
    seed();
    fs.failNextCommit(Object.assign(new Error('offline queue lost'), { code: 'unavailable' }));
    await pay();
    await settle();
    const events = await ledger.listEvents();
    await expect(pay('sess1', [{ id: 'p2', methodId: 'm-cash', amount: 700 }])).rejects.toThrow(ledger.PAYMENT_INTENT_CHANGED);
    expect(await ledger.listEvents()).toEqual(events);
    expect(idb.rows('terminal')[0].nextSeq).toBe(6);
    expect(fs.commits).toHaveLength(0);
  });

  it('T-458: reopening an already locally paid session repairs a lost effect marker without another write or number', async () => {
    seed();
    const first = await pay();
    const effects = await fx.listEffectItems();
    await fx.removeEffectItem(effects[0]!.id); // crash after the SDK batch, before the effects transaction
    expect(await pay()).toEqual(first);
    expect(await fx.listEffectItems()).toHaveLength(1);
    expect(fs.commits).toHaveLength(1);
    expect(idb.rows('terminal')[0].nextSeq).toBe(6);
  });

  it('writes ONE ledger event (unsent, complete ops) and then the Firestore batch', async () => {
    seed();
    const r = await pay();
    await settle();
    expect(r).toEqual({ receiptId: 'sess1', receiptNumber: 'SHT-01-000005' });
    const events = await ledger.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'sale', status: 'unsent', receiptId: 'sess1', receiptNumber: 'SHT-01-000005', totalCentavos: 59800, terminalSeq: 5 });
    expect(events[0]!.tenders).toEqual([{ method: 'Cash', centavos: 60000, toCheck: false, reference: null }]);
    expect(events[0]!.linesHash).toBeTruthy();
    expect(fs.get(`stores/${STORE_ID}/receipts/sess1`)).toMatchObject({ receiptNumber: 'SHT-01-000005', offlineOrigin: true });
    expect(idb.rows('terminal')[0].nextSeq).toBe(6);
  });

  it('if the IndexedDB transaction fails: refused with the plain sentence, NO Firestore write, number not consumed, no effects', async () => {
    seed();
    await ledger.listEvents(); // database exists
    idb.failNextTransaction();
    await expect(pay()).rejects.toThrow('This tablet could not save the sale. Do not continue; call the manager.');
    await settle();
    expect(fs.commits).toHaveLength(0);
    expect(fs.has(`stores/${STORE_ID}/receipts/sess1`)).toBe(false);
    expect(idb.rows('terminal')[0].nextSeq).toBe(5);
    expect(await ledger.listEvents()).toEqual([]);
    expect(await fx.listEffectItems()).toEqual([]);
    expect((await pay()).receiptNumber).toBe('SHT-01-000005'); // the next attempt reuses the number: no gap
  });
});

describe('ops fidelity (Acceptance 2)', () => {
  it('the batch built from the stored ops equals the write set Firestore received, field for field, with fixed payment ids', async () => {
    seed({ tickets: [{ id: 'tk1', status: 'preparing' }] });
    await pay('sess1', [{ id: 'x', methodId: 'm-cash', amount: 300 }, { id: 'y', methodId: 'm-gcash', amount: 300, reference: 'GC-1' }]);
    await settle();
    const real = fs.commits.at(-1)!;
    const ev = (await ledger.listEvents())[0]!;
    expect(real.writes).toHaveLength(ev.ops!.length);
    real.writes.forEach((w, i) => { expect([w.op, w.path], `write ${i}`).toEqual([ev.ops![i]!.op, ev.ops![i]!.path]); });
    // replay the ops onto an identical, untouched server and compare the recorded writes exactly (sentinels included)
    const twin = createFakeFirestore();
    seedSession(twin, { tickets: [{ id: 'tk1', status: 'preparing' }] });
    twin.seed(sessionPath(), { ...twin.get(sessionPath()), ownerTerminalId: 'DEV-A', revision: 1 });
    const b = twin.writeBatch();
    ledger.applyOpsToBatch(b as any, ev.ops!, { doc: (p) => twin.doc(twin.db, p), serverTimestamp: twin.serverTimestamp, deleteField: twin.deleteField, arrayRemove: twin.arrayRemove });
    await b.commit();
    expect(twin.commits.at(-1)!.writes).toEqual(real.writes);
    const paymentIds = real.writes.filter((w) => w.path.includes('/payments/')).map((w) => w.path.split('/').pop());
    expect(paymentIds).toEqual(['sess1-p0', 'sess1-p1']);
    expect(JSON.stringify(ev.ops)).not.toMatch(/"__s"/); // plain JSON markers, never SDK sentinels, in IndexedDB
  });

  it('a second sale after a retry writes the SAME payment doc ids (a replay cannot duplicate payments)', async () => {
    seed();
    await pay();
    const ev = (await ledger.listEvents())[0]!;
    const ids = ev.ops!.filter((o) => o.path.includes('/payments/')).map((o) => o.path);
    expect(ids).toEqual([`stores/${STORE_ID}/sessions/sess1/payments/sess1-p0`]);
  });
});

describe('offline tenders (Acceptance 11)', () => {
  it('GCash with a reference: saved toCheck:true, receipt has tendersToCheck', async () => {
    seed();
    await pay('sess1', [{ id: 'p1', methodId: 'm-gcash', amount: 598, reference: 'GC-777' }]);
    await settle();
    const rec = fs.get(`stores/${STORE_ID}/receipts/sess1`)!;
    expect(rec.tendersToCheck).toEqual([{ method: 'GCash', centavos: 59800, reference: 'GC-777' }]);
    expect((await ledger.listEvents())[0]!.tenders).toEqual([{ method: 'GCash', centavos: 59800, toCheck: true, reference: 'GC-777' }]);
  });

  it('an all-cash sale has no tendersToCheck entries', async () => {
    seed();
    await pay();
    await settle();
    expect(fs.get(`stores/${STORE_ID}/receipts/sess1`)!.tendersToCheck ?? []).toEqual([]);
  });

  it.each([
    ['GCash with no reference', [{ id: 'p1', methodId: 'm-gcash', amount: 598 }], /reference/i],
    ['a card', [{ id: 'p1', methodId: 'm-card', amount: 598 }], /Needs the internet/],
    ['QR Ph', [{ id: 'p1', methodId: 'm-qr', amount: 598, reference: 'pay_1' }], /Needs the internet/],
  ])('%s is refused BEFORE a number is reserved: nothing in the counter, ledger, Firestore or effects', async (_n, payments, msg) => {
    seed();
    await expect(pay('sess1', payments as any)).rejects.toThrow(msg);
    await settle();
    expect(idb.rows('terminal')[0].nextSeq).toBe(5);
    expect(await ledger.listEvents()).toEqual([]);
    expect(fs.commits).toHaveLength(0);
    expect(await fx.listEffectItems()).toEqual([]);
  });
});

describe('one tablet bills a table (Acceptance 11)', () => {
  it('paying a table owned by another device offline is refused with the sentence, nothing written', async () => {
    seed({}, 'DEV-B');
    await expect(pay()).rejects.toThrow('This table was opened on another tablet. Pay it there, or wait for the internet.');
    expect(await ledger.listEvents()).toEqual([]);
    expect(fs.commits).toHaveLength(0);
    expect(idb.rows('terminal')[0].nextSeq).toBe(5);
  });
  it('a session with no ownerTerminalId (opened by v1) is refused offline too', async () => {
    seed({}, null);
    await expect(pay()).rejects.toThrow(/another tablet/);
    expect(await ledger.listEvents()).toEqual([]);
  });
});

describe('deferred effects live in IndexedDB (Acceptance 8)', () => {
  it('the sale queues its effects in the effects store, never in localStorage, and they wait for the ledger row to be acknowledged', async () => {
    seed();
    await pay();
    await settle();
    expect(ls.getItem('offline_payment_queue')).toBeNull();
    const items = await fx.listEffectItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ receiptId: 'sess1', status: 'pending' });
    expect(items[0]!.effects.analytics).toBe('pending');
    expect(await fx.listRunnableEffectItems()).toEqual([]);
    await ledger.markAcknowledged('DEV-A', 5);
    expect((await fx.listRunnableEffectItems()).map((i) => i.receiptId)).toEqual(['sess1']);
  });
});

describe('offline unpaid-table void (bible row 356; Acceptance 11)', () => {
  const voidIt = (role: string, sessionId = 'sess1') => voidSessionOffline({ storeId: STORE_ID, sessionId, reason: 'Walked out', actor: { ...user, role } as any });

  it.each(['cashier', 'server', 'kitchen'])('a %s is refused: nothing written, no ledger event, session untouched', async (role) => {
    seed();
    await expect(voidIt(role)).rejects.toThrow('Only a manager or admin can void a table while offline.');
    await settle();
    expect(fs.get(sessionPath())!.status).toBe('active');
    expect(await ledger.listEvents()).toEqual([]);
    expect(fs.commits).toHaveLength(0);
    expect(idb.rows('terminal')[0].nextSeq).toBe(5);
  });

  it.each(['manager', 'admin'])('a %s may void: session voided with voidedOffline:true, and a void event is in the ledger', async (role) => {
    seed();
    await voidIt(role);
    await settle();
    expect(fs.get(sessionPath())).toMatchObject({ status: 'voided', voidedOffline: true, offlineOrigin: true });
    const events = await ledger.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'void', status: 'unsent', receiptId: 'sess1' });
    const sessionOp = events[0]!.ops!.find((o) => o.path === sessionPath())!;
    expect(sessionOp.data).toMatchObject({ status: 'voided', voidedOffline: true });
  });

  it('a table owned by another device is refused even for a manager', async () => {
    seed({}, 'DEV-B');
    await expect(voidIt('manager')).rejects.toThrow('This table was opened on another tablet. Pay it there, or wait for the internet.');
    expect(fs.get(sessionPath())!.status).toBe('active');
    expect(await ledger.listEvents()).toEqual([]);
  });
});
