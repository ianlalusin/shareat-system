/**
 * T-425 slice T - deferred effects move to IndexedDB (Ruling 3, ✎R). Acceptance 8.
 *
 * CONTRACT for the builder (S2) - file `apps/pos/src/lib/outbox/effects-store.ts`, store `effects` (keyPath 'id') of the shared database.
 * Item shape = `QueuedPayment` of lib/offline/payment-queue.ts, unchanged (id, storeId, sessionId, receiptId, queuedAtMs, status
 * 'pending'|'syncing'|'failed', kind?, ctx, effects, errorMessage?). No localStorage except the one-time legacy read below. Exports exactly:
 *   LEGACY_QUEUE_KEY = 'offline_payment_queue'      CORRUPT_QUEUE_KEY = 'offline_payment_queue.corrupt'
 *   migrateLegacyQueue(storage?: Pick<Storage,'getItem'|'setItem'|'removeItem'>): Promise<{ moved: number; corrupt: boolean }>
 *        default storage = globalThis.localStorage. A non-empty valid array is copied into `effects` in ONE IndexedDB transaction, and only
 *        AFTER that transaction completed is LEGACY_QUEUE_KEY removed (a failed transaction rejects and leaves the key). A value that does not
 *        parse as an array is stored verbatim under CORRUPT_QUEUE_KEY, LEGACY_QUEUE_KEY is removed, and { moved: 0, corrupt: true } is returned
 *        (never silently dropped, never copied). An empty/absent key is { moved: 0, corrupt: false }.
 *   addEffectItem(item: Omit<QueuedPayment, 'id' | 'queuedAtMs' | 'status'>): Promise<QueuedPayment>   - status 'pending', new id, queuedAtMs = Date.now()
 *   listEffectItems(): Promise<QueuedPayment[]>            - ordered by queuedAtMs
 *   updateEffectItem(id: string, patch: Partial<QueuedPayment>): Promise<void>
 *   removeEffectItem(id: string): Promise<void>
 *   listRunnableEffectItems(): Promise<QueuedPayment[]>    - status 'pending' items whose receipt's ledger row (lib/outbox/ledger.ts, by receiptId) is
 *        `acknowledged`; an item with NO ledger row is runnable (legacy/migrated). An item whose row is unsent/quarantined/rejected/stuck/reserved is NOT.
 *   listFailedEffectItems(): Promise<QueuedPayment[]>      - status 'failed' (the manager list)
 *   retryFailedEffectItem(id: string): Promise<void>       - failed -> pending, errorMessage cleared
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIdb, type FakeIdbFactory } from '@/test-helpers/fakeIdb';
import { memoryLocalStorage } from '@/test-helpers/posFixtures';
import { STORE, saleOps } from '@/test-helpers/outbox';
import * as counter from '@/lib/terminal/counter';
import * as ledger from '@/lib/outbox/ledger';
import * as fx from '@/lib/outbox/effects-store';

let idb: FakeIdbFactory;
let ls: Storage;
beforeEach(() => {
  idb = createFakeIdb({ commitDelayMs: 0 });
  vi.stubGlobal('indexedDB', idb);
  ls = memoryLocalStorage();
  vi.stubGlobal('localStorage', ls);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const legacy = (n: number) => Array.from({ length: n }, (_, i) => ({
  id: `q${i + 1}`, storeId: STORE, sessionId: `s${i + 1}`, receiptId: `s${i + 1}`, queuedAtMs: 1000 + i, status: 'pending' as const,
  ctx: { pin: null, phone: null, amount: 598 }, effects: { analytics: 'pending', loyaltyFinalize: 'pending', loyaltyEarn: 'skip', pinFinalize: 'skip', loyaltyReverse: 'skip' },
}));
const newItem = (sid: string) => ({
  storeId: STORE, sessionId: sid, receiptId: sid, ctx: { amount: 100 },
  effects: { analytics: 'pending', loyaltyFinalize: 'skip', loyaltyEarn: 'skip', pinFinalize: 'skip', loyaltyReverse: 'skip' } as any,
});

describe('T-458 sale effect recovery', () => {
  it('concurrent retries keep one item and do not reset completed work or its original context', async () => {
    const ensure = (fx as typeof fx & { ensureSaleEffectItem: typeof fx.addEffectItem }).ensureSaleEffectItem;
    const [a, b] = await Promise.all([ensure(newItem('s1')), ensure(newItem('s1'))]);
    expect(a.id).toBe(b.id);
    await fx.updateEffectItem(a.id, { status: 'syncing', effects: { ...a.effects, analytics: 'done' } });
    const retry = await ensure({ ...newItem('s1'), ctx: { amount: 900 } });
    expect(retry).toMatchObject({ status: 'syncing', ctx: { amount: 100 }, effects: { analytics: 'done' } });
    expect(await fx.listEffectItems()).toHaveLength(1);
  });
});

describe('legacy localStorage queue migration (Acceptance 8)', () => {
  it('a queue of 3 items moves to IndexedDB in ONE transaction, same shapes and ids, and the key is removed', async () => {
    ls.setItem('offline_payment_queue', JSON.stringify(legacy(3)));
    const r = await fx.migrateLegacyQueue();
    expect(r).toEqual({ moved: 3, corrupt: false });
    expect(idb.commitCount()).toBeLessThanOrEqual(2); // 1 upgrade (database creation) + exactly 1 copy
    expect(ls.getItem('offline_payment_queue')).toBeNull();
    expect((await fx.listEffectItems()).map((i) => i.id)).toEqual(['q1', 'q2', 'q3']);
    expect(await fx.listEffectItems()).toEqual(legacy(3));
    expect(fx.LEGACY_QUEUE_KEY).toBe('offline_payment_queue');
  });

  it('copies in a single commit: exactly one readwrite transaction after the database exists', async () => {
    await fx.listEffectItems(); // creates the database
    const before = idb.commitCount();
    ls.setItem('offline_payment_queue', JSON.stringify(legacy(3)));
    await fx.migrateLegacyQueue();
    expect(idb.commitCount() - before).toBe(1);
  });

  it('if the IndexedDB transaction fails the key stays (nothing is lost) and the call rejects', async () => {
    await fx.listEffectItems();
    ls.setItem('offline_payment_queue', JSON.stringify(legacy(3)));
    idb.failNextTransaction();
    await expect(fx.migrateLegacyQueue()).rejects.toBeTruthy();
    expect(JSON.parse(ls.getItem('offline_payment_queue')!)).toHaveLength(3);
    expect(await fx.listEffectItems()).toEqual([]);
    expect(await fx.migrateLegacyQueue()).toEqual({ moved: 3, corrupt: false }); // the retry succeeds
  });

  it('a corrupt value is kept verbatim under `.corrupt`, reported, never copied, never dropped. Mutant: the old "parse error returns [] and the next write erases the queue"', async () => {
    ls.setItem('offline_payment_queue', '[{"id":"q1","storeId":');
    const r = await fx.migrateLegacyQueue();
    expect(r).toEqual({ moved: 0, corrupt: true });
    expect(ls.getItem('offline_payment_queue.corrupt')).toBe('[{"id":"q1","storeId":');
    expect(ls.getItem('offline_payment_queue')).toBeNull();
    expect(await fx.listEffectItems()).toEqual([]);
    expect(await fx.migrateLegacyQueue()).toEqual({ moved: 0, corrupt: false });
    expect(ls.getItem('offline_payment_queue.corrupt')).toBe('[{"id":"q1","storeId":'); // a second start does not erase it
    expect(fx.CORRUPT_QUEUE_KEY).toBe('offline_payment_queue.corrupt');
  });

  it('a JSON value that is not an array is also treated as corrupt', async () => {
    ls.setItem('offline_payment_queue', '{"not":"an array"}');
    expect(await fx.migrateLegacyQueue()).toEqual({ moved: 0, corrupt: true });
    expect(ls.getItem('offline_payment_queue.corrupt')).toBe('{"not":"an array"}');
  });

  it('nothing to migrate: { moved: 0, corrupt: false } and no key is created', async () => {
    expect(await fx.migrateLegacyQueue()).toEqual({ moved: 0, corrupt: false });
    ls.setItem('offline_payment_queue', '[]');
    expect(await fx.migrateLegacyQueue()).toEqual({ moved: 0, corrupt: false });
    expect(ls.getItem('offline_payment_queue.corrupt')).toBeNull();
  });

  it('accepts an injected storage (testable without a global)', async () => {
    const mine = memoryLocalStorage();
    mine.setItem('offline_payment_queue', JSON.stringify(legacy(1)));
    expect(await fx.migrateLegacyQueue(mine)).toEqual({ moved: 1, corrupt: false });
    expect(mine.getItem('offline_payment_queue')).toBeNull();
  });
});

describe('the store itself', () => {
  it('add / list / update / remove, newest last, nothing in localStorage', async () => {
    const a = await fx.addEffectItem(newItem('s1'));
    const b = await fx.addEffectItem(newItem('s2'));
    expect(a).toMatchObject({ status: 'pending', receiptId: 's1' });
    expect(a.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
    expect(typeof a.queuedAtMs).toBe('number');
    await fx.updateEffectItem(a.id, { status: 'syncing' });
    expect((await fx.listEffectItems()).find((i) => i.id === a.id)!.status).toBe('syncing');
    await fx.removeEffectItem(a.id);
    expect((await fx.listEffectItems()).map((i) => i.id)).toEqual([b.id]);
    expect(ls.length).toBe(0);
  });

  it('failed items are listed for the manager and Retry puts them back to pending', async () => {
    const a = await fx.addEffectItem(newItem('s1'));
    await fx.updateEffectItem(a.id, { status: 'failed', errorMessage: 'analytics refused' });
    expect((await fx.listFailedEffectItems()).map((i) => i.id)).toEqual([a.id]);
    await fx.retryFailedEffectItem(a.id);
    expect(await fx.listFailedEffectItems()).toEqual([]);
    const row = (await fx.listEffectItems())[0]!;
    expect(row.status).toBe('pending');
    expect(row.errorMessage).toBeUndefined();
  });
});

describe('a receipt\'s effects run only after its ledger row is acknowledged (Ruling 3 ✎R; Acceptance 8)', () => {
  it('apply-delta never runs before the receipt exists on the server', async () => {
    await counter.saveTerminalClaim({ storeId: STORE, terminalNo: 1, deviceId: 'DEV-A', nextSeq: 5 });
    const ev = await ledger.reserveOfflineEvent({
      kind: 'sale', storeCode: 'SHT', receiptId: 's1', totalCentavos: 59800, linesHash: 'h', tenders: [],
      buildOps: (n) => saleOps({ sessionId: 's1', receiptNumber: n.receiptNumber, terminalSeq: n.terminalSeq }),
    });
    await fx.addEffectItem(newItem('s1'));
    expect(await fx.listRunnableEffectItems()).toEqual([]); // unsent -> not yet
    for (const st of ['quarantined', 'rejected', 'stuck', 'reserved'] as const) {
      await ledger.patchEvent(ev.deviceId, ev.terminalSeq, { status: st });
      expect(await fx.listRunnableEffectItems(), st).toEqual([]);
    }
    await ledger.markAcknowledged(ev.deviceId, ev.terminalSeq);
    expect((await fx.listRunnableEffectItems()).map((i) => i.receiptId)).toEqual(['s1']);
  });

  it('an item with no ledger row (legacy/migrated) is runnable; a non-pending item is not', async () => {
    const a = await fx.addEffectItem(newItem('legacy-1'));
    const b = await fx.addEffectItem(newItem('legacy-2'));
    await fx.updateEffectItem(b.id, { status: 'failed' });
    expect((await fx.listRunnableEffectItems()).map((i) => i.id)).toEqual([a.id]);
  });
});
