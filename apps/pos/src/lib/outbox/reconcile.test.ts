/**
 * T-425 slice T - reconcile = server proof (Ruling 2, ✎R/✎R2). Acceptance 3, 4, 5 (status discipline), 6, 7.
 *
 * CONTRACT for the builder (S1):
 * file `apps/pos/src/lib/outbox/linesHash.ts`
 *   computeLinesHash(lines: unknown[]): string   - SYNCHRONOUS, deterministic. Hashes a STABLE form: object keys sorted at every depth, `undefined`
 *        values removed, array order kept, every money amount converted to integer centavos with storedPesosToCentavos (so 299 and 299.0000001
 *        agree). The same function hashes the local copy and a copy read back from the server.
 * file `apps/pos/src/lib/outbox/reconcile.ts`
 *   PENDING_WRITES_TIMEOUT_MS = 20_000          CONFLICT_ANOTHER_TABLET = 'This table was changed on another tablet.'
 *   interface ReconcilePort { db: unknown; doc(db, path: string): unknown; getDocFromServer(ref): Promise<{ exists(): boolean; data(): any }>;
 *       waitForPendingWrites(db): Promise<void>; runTransaction<T>(db, fn: (tx) => Promise<T>): Promise<T>;
 *       serverTimestamp(): unknown; deleteField(): unknown; arrayRemove(...v: unknown[]): unknown }
 *   interface ReconcileDeps { port: ReconcilePort; isOnline(): boolean;
 *       locks?: { request(name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown | null) => Promise<unknown>): Promise<unknown> }  // default navigator.locks
 *       pendingWritesTimeoutMs?: number /* default PENDING_WRITES_TIMEOUT_MS *\/ }
 *   interface ReconcileResult { ran: boolean; skipped?: 'offline' | 'lock-held' | 'pending-writes-timeout' | 'nothing-to-do';
 *       acknowledged: number; quarantined: number; rejected: number; replayed: number; failed: number; stuck: number; skippedSeqs: number[] }
 *   runReconcilePass(deps: ReconcileDeps): Promise<ReconcileResult>
 * One pass (only online, only holding Web Lock 'pos-reconcile' via ifAvailable; otherwise skipped):
 *   1. reserved rows: server receipts/{receiptId} present -> acknowledged, absent -> skipped (a thrown read leaves them reserved).
 *   2. if there are unsent rows: await port.waitForPendingWrites(db) limited to pendingWritesTimeoutMs; if it does not RESOLVE -> NO replay
 *      this pass (skipped 'pending-writes-timeout', attempts unchanged), and no write of any kind.
 *   3. per unsent row in (deviceId, terminalSeq) order: getDocFromServer(receipts/{receiptId}). A thrown read is never "absent": the row stays
 *      unsent, attempts + 1, lastError set; at MAX_ATTEMPTS (10) -> 'stuck' (and stuck rows are no longer touched).
 *      present  -> compare receiptNumber, then total (centavos) and computeLinesHash(lines): equal -> acknowledged; different -> quarantined.
 *                  (refunds, tender corrections, analyticsApplied ... are ignored). A void row is acknowledged when the server session is 'voided'.
 *      absent   -> ONE port.runTransaction: all reads first (receipt, session, table, every doc an `update` op targets), then writes. Session
 *                  closed/voided -> quarantined with CONFLICT_ANOTHER_TABLET and nothing written; else write the ops (table docs only when the
 *                  server table's currentSessionId === receiptId; an `update` op on a missing doc is skipped, never a failure). The row stays
 *                  `unsent` until the NEXT pass proves it by the compare rule. A refusal with error code 'permission-denied' / 'invalid-argument'
 *                  / 'failed-precondition' makes the row `rejected` (never replayed); any other error counts as a failed attempt.
 * Only the real server state decides; local Firestore cache is never read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIdb, type FakeIdbFactory } from '@/test-helpers/fakeIdb';
import { createFakeFirestore, type FakeFirestore } from '@/test-helpers/fakeFirestore';
import { LINES, STORE, fakeLocks, saleOps, seedServerSession, voidOps } from '@/test-helpers/outbox';
import * as counter from '@/lib/terminal/counter';
import * as ledger from '@/lib/outbox/ledger';
import { computeLinesHash } from '@/lib/outbox/linesHash';
import * as reconcile from '@/lib/outbox/reconcile';
import { Timestamp } from 'firebase/firestore';

let idb: FakeIdbFactory;
let fs: FakeFirestore;
let client: ReturnType<FakeFirestore['client']>;
let locks: ReturnType<typeof fakeLocks>;

beforeEach(async () => {
  idb = createFakeIdb({ commitDelayMs: 0 });
  vi.stubGlobal('indexedDB', idb);
  fs = createFakeFirestore();
  client = fs.client('A');
  locks = fakeLocks();
  await counter.saveTerminalClaim({ storeId: STORE, terminalNo: 1, deviceId: 'DEV-A', nextSeq: 5 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const deps = (over: Partial<reconcile.ReconcileDeps> = {}): reconcile.ReconcileDeps => ({
  port: client.reconcilePort as any, isOnline: () => true, locks, pendingWritesTimeoutMs: 40, ...over,
});
const hash = computeLinesHash(LINES);

/** A sale recorded offline: server session seeded as open, ledger row unsent. */
async function sell(sid: string, o: { tickets?: string[]; total?: number } = {}) {
  seedServerSession(fs, sid, { tickets: o.tickets });
  return ledger.reserveOfflineEvent({
    kind: 'sale', storeCode: 'SHT', receiptId: sid, totalCentavos: o.total ?? 59800, linesHash: hash,
    tenders: [{ method: 'Cash', centavos: o.total ?? 59800, toCheck: false, reference: null }],
    buildOps: (n) => saleOps({ sessionId: sid, receiptNumber: n.receiptNumber, terminalSeq: n.terminalSeq, deviceId: n.deviceId, tickets: o.tickets }),
  });
}
/** What the SDK would eventually deliver: the event's ops applied to the server. */
async function deliver(ev: ledger.LedgerEvent) {
  const b = fs.writeBatch();
  ledger.applyOpsToBatch(b as any, ev.ops!, { doc: (p) => fs.doc(fs.db, p), serverTimestamp: fs.serverTimestamp, deleteField: fs.deleteField, arrayRemove: fs.arrayRemove });
  await b.commit();
}
const status = async (ev: ledger.LedgerEvent) => (await ledger.getEvent(ev.deviceId, ev.terminalSeq))!;
const commitsNow = () => fs.commits.length;
const receiptPath = (sid: string) => `stores/${STORE}/receipts/${sid}`;

describe('T-460 legacy clock representation retains financial comparison', () => {
  const stamp = Timestamp.fromMillis(1790000000123);
  const local = [{ ...LINES[0], createdAt: stamp, updatedAt: stamp },
    { id: 'old-marker-line', unitPrice: 0, qtyOrdered: 0, createdAt: { _methodName: 'serverTimestamp' } }];
  const flattened = () => JSON.parse(JSON.stringify(local));
  async function serverCopy(change?: (data: any) => void) {
    const ev = await sell('legacy');
    await ledger.patchEvent(ev.deviceId, ev.terminalSeq, { linesHash: computeLinesHash(local) });
    const data = { receiptNumber: ev.receiptNumber, total: 598, lines: flattened() };
    change?.(data);
    fs.seed(receiptPath('legacy'), data);
    return ev;
  }
  it('proves the original hash mismatch and acknowledges exact SDK clock maps without a server write', async () => {
    expect(computeLinesHash(flattened())).not.toBe(computeLinesHash(local));
    const ev = await serverCopy();
    const before = commitsNow();
    expect(await reconcile.runReconcilePass(deps())).toMatchObject({ acknowledged: 1, quarantined: 0, replayed: 0 });
    expect((await status(ev)).status).toBe('acknowledged');
    expect(commitsNow()).toBe(before);
  });
  it('keeps the normal real SDK timestamp comparison working without the compatibility path', async () => {
    const ev = await serverCopy();
    const port = { ...client.reconcilePort, getDocFromServer: async () => ({ exists: () => true,
      data: () => ({ receiptNumber: ev.receiptNumber, total: 598, lines: local }) }) };
    expect(await reconcile.runReconcilePass(deps({ port: port as any }))).toMatchObject({ acknowledged: 1, quarantined: 0 });
  });
  it.each(['qtyOrdered', 'unitPrice', 'discountQty', 'discountValue', 'discountType', 'itemId'])('still quarantines changed %s', async field => {
    const ev = await serverCopy(data => { data.lines[0][field] = field === 'itemId' || field === 'discountType' ? 'different-value' : 23; });
    expect(await reconcile.runReconcilePass(deps())).toMatchObject({ acknowledged: 0, quarantined: 1 });
    expect((await status(ev)).status).toBe('quarantined');
  });
  it.each(['receiptNumber', 'total'])('still quarantines changed %s', async field => {
    const ev = await serverCopy(data => { (data as any)[field] = field === 'total' ? 599 : 'OTHER-01-000005'; });
    expect(await reconcile.runReconcilePass(deps())).toMatchObject({ acknowledged: 0, quarantined: 1 });
    expect((await status(ev)).status).toBe('quarantined');
  });
  it.each([
    { seconds: 1790000000, nanoseconds: 123000000, extra: 'not-a-timestamp' },
    { seconds: 1790000000, nanoseconds: -1 },
    { seconds: 253402300800, nanoseconds: 0 },
    { seconds: '1790000000', nanoseconds: 123000000 },
    null,
  ])('does not discard an invalid/extra-key clock object: %j', async clock => {
    const ev = await serverCopy(data => { data.lines[0].createdAt = clock; });
    expect(await reconcile.runReconcilePass(deps())).toMatchObject({ acknowledged: 0, quarantined: 1 });
    expect((await status(ev)).status).toBe('quarantined');
  });
});

describe('linesHash (Acceptance 4)', () => {
  const local = [{ id: 'l1', type: 'package', itemName: 'Unli Pack', unitPrice: 299, qtyOrdered: 2, note: undefined }];
  it('a copy read back from the fake server (undefined dropped, keys reordered, amounts as stored) hashes the same as the local one', () => {
    const server = [{ qtyOrdered: 2, unitPrice: 299, itemName: 'Unli Pack', type: 'package', id: 'l1' }];
    expect(computeLinesHash(server)).toBe(computeLinesHash(local));
    expect(computeLinesHash([{ ...server[0], unitPrice: 299.0000001 }])).toBe(computeLinesHash(local));
  });
  it('a different quantity, price or line count is a different hash; hashing is deterministic', () => {
    expect(computeLinesHash([{ ...local[0], qtyOrdered: 3 }])).not.toBe(computeLinesHash(local));
    expect(computeLinesHash([{ ...local[0], unitPrice: 300 }])).not.toBe(computeLinesHash(local));
    expect(computeLinesHash([...local, ...local])).not.toBe(computeLinesHash(local));
    expect(computeLinesHash(local)).toBe(computeLinesHash(JSON.parse(JSON.stringify(local))));
    expect(typeof computeLinesHash(local)).toBe('string');
  });
});

describe('when a pass may run (Ruling 2; Acceptance 7)', () => {
  it('offline: nothing runs, nothing is read', async () => {
    await sell('s1');
    const read = vi.spyOn(client, 'getDocFromServer');
    const r = await reconcile.runReconcilePass(deps({ isOnline: () => false }));
    expect(r).toMatchObject({ ran: false, skipped: 'offline' });
    expect(read).not.toHaveBeenCalled();
  });

  it('another tab holds the Web Lock `pos-reconcile`: this pass is skipped without touching anything', async () => {
    await sell('s1');
    locks.held.add('pos-reconcile');
    const c0 = commitsNow();
    const r = await reconcile.runReconcilePass(deps());
    expect(r).toMatchObject({ ran: false, skipped: 'lock-held' });
    expect(commitsNow()).toBe(c0);
  });

  it('Acceptance 7: two triggers at once -> exactly one run, one replay, no duplicates', async () => {
    const ev = await sell('s1');
    const [a, b] = await Promise.all([reconcile.runReconcilePass(deps()), reconcile.runReconcilePass(deps())]);
    expect([a.ran, b.ran].filter(Boolean)).toHaveLength(1);
    expect([a.skipped, b.skipped]).toContain('lock-held');
    expect(fs.commits.filter((c) => c.writes.some((w) => w.path === receiptPath('s1')))).toHaveLength(1);
    expect(fs.has(receiptPath('s1'))).toBe(true);
    expect((await status(ev)).status).toBe('unsent'); // proof comes on the NEXT pass
  });

  it('with nothing unsent and nothing reserved the pass reports nothing-to-do and reads nothing', async () => {
    const read = vi.spyOn(client, 'getDocFromServer');
    expect(await reconcile.runReconcilePass(deps())).toMatchObject({ skipped: 'nothing-to-do', acknowledged: 0 });
    expect(read).not.toHaveBeenCalled();
    expect(reconcile.PENDING_WRITES_TIMEOUT_MS).toBe(20_000);
  });
});

describe('present on the server -> compare (Acceptance 4)', () => {
  it('equal receipt -> acknowledged, and the pass writes nothing', async () => {
    const ev = await sell('s1');
    await deliver(ev);
    const c0 = commitsNow();
    const r = await reconcile.runReconcilePass(deps());
    expect(r.acknowledged).toBe(1);
    expect(r.replayed).toBe(0);
    expect((await status(ev)).status).toBe('acknowledged');
    expect(commitsNow()).toBe(c0);
  });

  it('later changes are ignored (refund, tender correction, analyticsApplied): still acknowledged. Mutant: false quarantine', async () => {
    const ev = await sell('s1');
    await deliver(ev);
    const cur = fs.get(receiptPath('s1'))!;
    fs.seed(receiptPath('s1'), { ...cur, totalRefunded: 10_000, analyticsApplied: true, tenderCorrections: [{ from: 'Cash', to: 'GCash' }], analytics: { v: 2, mop: { GCash: 598 } } });
    await reconcile.runReconcilePass(deps());
    expect((await status(ev)).status).toBe('acknowledged');
  });

  it.each([
    ['receiptNumber', { receiptNumber: 'SHT-01-000099' }],
    ['total', { total: 599 }],
    ['lines', { lines: [{ ...LINES[0], qtyOrdered: 3 }] }],
  ])('a different %s on the server -> quarantined, server copy untouched. Mutant: missed conflict', async (_n, change) => {
    const ev = await sell('s1');
    await deliver(ev);
    fs.seed(receiptPath('s1'), { ...fs.get(receiptPath('s1'))!, ...change });
    const before = fs.get(receiptPath('s1'));
    const c0 = commitsNow();
    const r = await reconcile.runReconcilePass(deps());
    expect(r.quarantined).toBe(1);
    expect((await status(ev)).status).toBe('quarantined');
    expect(fs.get(receiptPath('s1'))).toEqual(before);
    expect(commitsNow()).toBe(c0);
    // never overwritten later either
    await reconcile.runReconcilePass(deps());
    expect((await status(ev)).status).toBe('quarantined');
  });
});

describe('absent on the server -> guarded replay (Acceptance 3, 6; DEF-018)', () => {
  it('writes the receipt, payments, tickets, receiptNumbers and frees the table; the NEXT pass acknowledges', async () => {
    const ev = await sell('s1', { tickets: ['tk1'] });
    const r1 = await reconcile.runReconcilePass(deps());
    expect(r1.replayed).toBe(1);
    expect(fs.get(receiptPath('s1'))).toMatchObject({ receiptNumber: ev.receiptNumber, total: 598, offlineOrigin: true });
    expect(fs.has(`stores/${STORE}/receiptNumbers/${ev.receiptNumber}`)).toBe(true);
    expect(fs.has(`stores/${STORE}/sessions/s1/payments/s1-p0`)).toBe(true);
    expect(fs.get(`stores/${STORE}/sessions/s1/kitchentickets/tk1`)).toMatchObject({ status: 'served' });
    expect(fs.get(`stores/${STORE}/sessions/s1`)).toMatchObject({ status: 'closed', isPaid: true });
    expect(fs.get(`stores/${STORE}/tables/t-s1`)).toMatchObject({ status: 'available', currentSessionId: null });
    expect(fs.has(`stores/${STORE}/activeSessions/s1`)).toBe(false);
    expect(fs.get(receiptPath('s1'))!.createdAt).toBeTruthy(); // server timestamp restored
    expect((await status(ev)).status).toBe('unsent');
    const r2 = await reconcile.runReconcilePass(deps());
    expect(r2.acknowledged).toBe(1);
    expect((await status(ev)).status).toBe('acknowledged');
  });

  it('the replay is ONE transaction (all or nothing)', async () => {
    await sell('s1');
    const c0 = commitsNow();
    await reconcile.runReconcilePass(deps());
    expect(fs.commits.slice(c0).filter((c) => c.kind === 'transaction')).toHaveLength(1);
    expect(fs.commits.slice(c0).filter((c) => c.kind === 'batch')).toHaveLength(0);
  });

  it('table re-seated on the server (session still open): receipt written, table and its projection NOT freed', async () => {
    const ev = await sell('s1');
    fs.seed(`stores/${STORE}/tables/t-s1`, { status: 'occupied', currentSessionId: 'other-session' });
    const projectionBefore = structuredClone(fs.get(`stores/${STORE}/storeConfig/current/tables/t-s1`));
    await reconcile.runReconcilePass(deps());
    expect(fs.has(receiptPath('s1'))).toBe(true);
    expect(fs.get(`stores/${STORE}/tables/t-s1`)).toEqual({ status: 'occupied', currentSessionId: 'other-session' });
    expect(fs.get(`stores/${STORE}/storeConfig/current/tables/t-s1`)).toEqual(projectionBefore);
    await reconcile.runReconcilePass(deps());
    expect((await status(ev)).status).toBe('acknowledged');
  });

  it.each(['voided', 'closed'])('session already %s on the server -> quarantined and NOTHING written (the table was changed on another tablet)', async (st) => {
    const ev = await sell('s1');
    fs.seed(`stores/${STORE}/sessions/s1`, { ...fs.get(`stores/${STORE}/sessions/s1`)!, status: st });
    const c0 = commitsNow();
    const docsBefore = new Map(fs.docs);
    const r = await reconcile.runReconcilePass(deps());
    expect(r.quarantined).toBe(1);
    expect(commitsNow()).toBe(c0);
    expect(fs.docs).toEqual(docsBefore);
    const row = await status(ev);
    expect(row.status).toBe('quarantined');
    expect(row.lastError).toBe('This table was changed on another tablet.');
    expect(reconcile.CONFLICT_ANOTHER_TABLET).toBe('This table was changed on another tablet.');
  });

  it('an `update` op on a ticket that no longer exists is skipped: the sale is still written and acknowledged, never rejected', async () => {
    const ev = await sell('s1', { tickets: ['tk1'] });
    fs.docs.delete(`stores/${STORE}/sessions/s1/kitchentickets/tk1`);
    await reconcile.runReconcilePass(deps());
    expect(fs.has(receiptPath('s1'))).toBe(true);
    expect(fs.has(`stores/${STORE}/sessions/s1/kitchentickets/tk1`)).toBe(false);
    await reconcile.runReconcilePass(deps());
    expect((await status(ev)).status).toBe('acknowledged');
  });

  it('a receipt that appears between the read and the transaction is not overwritten (the transaction re-reads it)', async () => {
    const ev = await sell('s1');
    fs.beforeNextTransaction(() => { fs.seed(receiptPath('s1'), { ...fs.get(receiptPath('s1')), receiptNumber: ev.receiptNumber, total: 598, lines: LINES, from: 'sdk' }); });
    // the SDK's own queued write landed first: only the first (absent) read happened before it
    await reconcile.runReconcilePass(deps());
    expect(fs.get(receiptPath('s1'))?.from).toBe('sdk');
    expect(fs.commits.filter((c) => c.kind === 'transaction' && c.writes.some((w) => w.path === receiptPath('s1')))).toHaveLength(0);
  });

  it('Acceptance 6: with the tablet\'s pending writes DROPPED (SDK lost its queue) every unsent sale still reaches the server from ops', async () => {
    client.goOffline();
    const evs = [await sell('s1'), await sell('s2'), await sell('s3', { tickets: ['tk1'] })];
    for (const e of evs) {
      const b = client.writeBatch();
      ledger.applyOpsToBatch(b as any, e.ops!, { doc: (p) => fs.doc(fs.db, p), serverTimestamp: fs.serverTimestamp, deleteField: fs.deleteField, arrayRemove: fs.arrayRemove });
      void b.commit().catch(() => {});
    }
    expect(client.pendingCount).toBe(3);
    client.dropPending();
    client.goOnline();
    expect(fs.has(receiptPath('s1'))).toBe(false); // really lost
    for (let i = 0; i < 3; i++) await reconcile.runReconcilePass(deps());
    for (const e of evs) {
      expect(fs.has(receiptPath(e.receiptId)), e.receiptId).toBe(true);
      expect((await status(e)).status).toBe('acknowledged');
    }
    const numbers = fs.list(`stores/${STORE}/receiptNumbers`).map((d) => d.id).sort();
    expect(numbers).toEqual(evs.map((e) => e.receiptNumber).sort());
  });

  it('the SDK delivers its own queue first: reconcile finds the receipt present and replays NOTHING (no race with the SDK)', async () => {
    client.goOffline();
    const ev = await sell('s1');
    const b = client.writeBatch();
    ledger.applyOpsToBatch(b as any, ev.ops!, { doc: (p) => fs.doc(fs.db, p), serverTimestamp: fs.serverTimestamp, deleteField: fs.deleteField, arrayRemove: fs.arrayRemove });
    void b.commit();
    client.goOnline();
    await Promise.resolve();
    const c0 = fs.commits.filter((c) => c.kind === 'transaction').length;
    await reconcile.runReconcilePass(deps());
    expect(fs.commits.filter((c) => c.kind === 'transaction').length).toBe(c0);
    expect((await status(ev)).status).toBe('acknowledged');
  });
});

describe('never racing the SDK / never treating a failed read as absent (Acceptance 3)', () => {
  it('waitForPendingWrites that does not resolve in time -> no replay, no write at all this pass, attempts unchanged', async () => {
    const ev = await sell('s1');
    const port = { ...client.reconcilePort, waitForPendingWrites: () => new Promise<void>(() => {}) } as any;
    const c0 = commitsNow();
    const r = await reconcile.runReconcilePass(deps({ port, pendingWritesTimeoutMs: 20 }));
    expect(r.skipped).toBe('pending-writes-timeout');
    expect(r.replayed).toBe(0);
    expect(commitsNow()).toBe(c0);
    expect(await status(ev)).toMatchObject({ status: 'unsent', attempts: 0 });
  });

  it('waits for pending writes BEFORE the first server read', async () => {
    await sell('s1');
    const order: string[] = [];
    const port = {
      ...client.reconcilePort,
      waitForPendingWrites: async () => { order.push('wait'); },
      getDocFromServer: async (ref: any) => { order.push('read'); return client.getDocFromServer(ref); },
    } as any;
    await reconcile.runReconcilePass(deps({ port }));
    expect(order[0]).toBe('wait');
    expect(order).toContain('read');
  });

  it('a thrown getDocFromServer is NEVER "absent": no write, the sale stays unsent, attempts + 1', async () => {
    const ev = await sell('s1');
    client.goOffline(); // isOnline() still says true (a stale probe): the read throws
    const c0 = commitsNow();
    const r = await reconcile.runReconcilePass(deps());
    expect(commitsNow()).toBe(c0);
    expect(fs.has(receiptPath('s1'))).toBe(false);
    expect(r.failed).toBe(1);
    expect(await status(ev)).toMatchObject({ status: 'unsent', attempts: 1 });
    expect((await status(ev)).lastError).toBeTruthy();
  });

  it('processes unsent sales in terminalSeq order', async () => {
    const a = await sell('s1');
    const b = await sell('s2');
    const c = await sell('s3');
    const seen: string[] = [];
    const port = { ...client.reconcilePort, getDocFromServer: async (ref: any) => { seen.push(ref.path); return client.getDocFromServer(ref); } } as any;
    await reconcile.runReconcilePass(deps({ port }));
    expect(seen).toEqual([receiptPath('s1'), receiptPath('s2'), receiptPath('s3')]);
    expect([a, b, c].map((e) => e.terminalSeq)).toEqual([5, 6, 7]);
  });
});

describe('status discipline (Acceptance 5)', () => {
  it.each(['permission-denied', 'invalid-argument', 'failed-precondition'])('a server refusal (%s) -> rejected, and a rejected sale is NEVER replayed again', async (code) => {
    const ev = await sell('s1');
    const runTransaction = vi.fn(async () => { throw Object.assign(new Error('Missing or insufficient permissions.'), { code }); });
    const port = { ...client.reconcilePort, runTransaction } as any;
    const r = await reconcile.runReconcilePass(deps({ port }));
    expect(r.rejected).toBe(1);
    expect(await status(ev)).toMatchObject({ status: 'rejected' });
    expect((await status(ev)).lastError).toContain('permission');
    await reconcile.runReconcilePass(deps({ port }));
    await reconcile.runReconcilePass(deps());
    expect(runTransaction).toHaveBeenCalledTimes(1);
    expect(fs.has(receiptPath('s1'))).toBe(false);
  });

  it('10 failed attempts -> stuck (kept for the manager list); a stuck row is no longer read; retryStuck re-arms it', async () => {
    const ev = await sell('s1');
    client.goOffline();
    for (let i = 0; i < 10; i++) await reconcile.runReconcilePass(deps());
    expect(await status(ev)).toMatchObject({ status: 'stuck', attempts: 10 });
    const read = vi.spyOn(client, 'getDocFromServer');
    await reconcile.runReconcilePass(deps());
    expect(read).not.toHaveBeenCalled();
    await ledger.retryStuck(ev.deviceId, ev.terminalSeq);
    client.goOnline();
    await reconcile.runReconcilePass(deps());
    await reconcile.runReconcilePass(deps());
    expect((await status(ev)).status).toBe('acknowledged');
  });

  it('a transient transaction error (unavailable) is a failed attempt, not a rejection', async () => {
    const ev = await sell('s1');
    const port = { ...client.reconcilePort, runTransaction: async () => { throw Object.assign(new Error('unavailable'), { code: 'unavailable' }); } } as any;
    await reconcile.runReconcilePass(deps({ port }));
    expect(await status(ev)).toMatchObject({ status: 'unsent', attempts: 1 });
  });

  it('`reserved` rows: server has the receipt -> acknowledged; absent -> skipped (the online transaction never committed)', async () => {
    seedServerSession(fs, 'o1');
    seedServerSession(fs, 'o2');
    const mk = (sid: string) => ledger.reserveOnlineEvent({ kind: 'sale', storeCode: 'SHT', receiptId: sid, totalCentavos: 59800, linesHash: hash, tenders: [] });
    const present = await mk('o1');
    const absent = await mk('o2');
    fs.seed(receiptPath('o1'), { receiptNumber: present.receiptNumber, total: 598, lines: LINES });
    const r = await reconcile.runReconcilePass(deps());
    expect((await status(present)).status).toBe('acknowledged');
    expect((await status(absent)).status).toBe('skipped');
    expect(r.skippedSeqs).toEqual([absent.terminalSeq]);
    expect(fs.has(receiptPath('o2'))).toBe(false); // never replayed
  });
});

describe('void events (Ruling 2, last bullet)', () => {
  const mkVoid = async (sid: string) => {
    seedServerSession(fs, sid);
    return ledger.reserveOfflineEvent({
      kind: 'void', storeCode: 'SHT', receiptId: sid, totalCentavos: 0, linesHash: 'n/a', tenders: [],
      buildOps: () => voidOps({ sessionId: sid }),
    });
  };
  it('acknowledged when the server session shows voided', async () => {
    const ev = await mkVoid('v1');
    fs.seed(`stores/${STORE}/sessions/v1`, { ...fs.get(`stores/${STORE}/sessions/v1`)!, status: 'voided' });
    await reconcile.runReconcilePass(deps());
    expect((await status(ev)).status).toBe('acknowledged');
  });
  it('replays the void when the session is still open, then acknowledges on the next pass', async () => {
    const ev = await mkVoid('v1');
    await reconcile.runReconcilePass(deps());
    expect(fs.get(`stores/${STORE}/sessions/v1`)).toMatchObject({ status: 'voided', voidedOffline: true });
    await reconcile.runReconcilePass(deps());
    expect((await status(ev)).status).toBe('acknowledged');
  });
  it('a session that was PAID (closed) on another tablet -> the void is quarantined and nothing is written', async () => {
    const ev = await mkVoid('v1');
    fs.seed(`stores/${STORE}/sessions/v1`, { ...fs.get(`stores/${STORE}/sessions/v1`)!, status: 'closed', isPaid: true });
    const c0 = commitsNow();
    await reconcile.runReconcilePass(deps());
    expect((await status(ev)).status).toBe('quarantined');
    expect(commitsNow()).toBe(c0);
  });
});

describe('kill and restart mid-reconcile (Acceptance 7)', () => {
  it('a pass that dies after the first replay, then a fresh pass: no duplicates, everything reaches the server once', async () => {
    const evs = [await sell('s1'), await sell('s2'), await sell('s3')];
    let replays = 0;
    const dying = {
      ...client.reconcilePort,
      runTransaction: async (db: unknown, fn: any) => {
        if (replays >= 1) throw new Error('process killed');
        replays++;
        return client.runTransaction(db, fn);
      },
    } as any;
    await reconcile.runReconcilePass(deps({ port: dying }));
    expect(fs.list(`stores/${STORE}/receipts`)).toHaveLength(1);
    for (let i = 0; i < 3; i++) await reconcile.runReconcilePass(deps()); // "restart"
    expect(fs.list(`stores/${STORE}/receipts`).map((d) => d.id).sort()).toEqual(['s1', 's2', 's3']);
    expect(fs.list(`stores/${STORE}/receiptNumbers`).map((d) => d.id).sort()).toEqual(evs.map((e) => e.receiptNumber).sort());
    for (const e of evs) expect((await status(e)).status).toBe('acknowledged');
  });
});

describe('T-470 refund rows (DEF-731): checked against the server receiptNumbers document', () => {
  const numberPath = (n: string) => `stores/${STORE}/receiptNumbers/${n}`;
  async function refund(parent = 'parent1') {
    return ledger.reserveOnlineEvent({
      kind: 'refund', storeCode: 'SHT', receiptId: parent, totalCentavos: 12500, linesHash: 'h-refund',
      tenders: [{ method: 'cash-1', centavos: 12500, toCheck: false, reference: null }],
    });
  }
  /** T-470 follow-up 3c: a refund row younger than 10 minutes may still be in flight; tests that expect a decision use an aged row. */
  async function aged(ev: ledger.LedgerEvent, ageMs = 11 * 60_000) {
    await ledger.patchEvent(ev.deviceId, ev.terminalSeq, { createdAtClientMs: Date.now() - ageMs });
  }

  /** A fake of POST /api/pos2/refund-numbers/release that answers like the server for a number nobody used. */
  const releaseOk = async (ev: ledger.LedgerEvent) => ({ state: 'released' as const, terminalSeq: ev.terminalSeq });

  it('number document exists with the SAME terminalSeq -> acknowledged', async () => {
    const ev = await refund();
    fs.seed(numberPath(ev.receiptNumber), { receiptId: 'refund-xyz', terminalNo: 1, terminalSeq: ev.terminalSeq });
    const r = await reconcile.runReconcilePass(deps());
    expect(r).toMatchObject({ acknowledged: 1, skippedSeqs: [] });
    expect((await status(ev)).status).toBe('acknowledged');
  });

  it('number document absent -> the server is asked to close it; released -> skipped with the plain reason (no money)', async () => {
    const ev = await refund();
    await aged(ev);
    const r = await reconcile.runReconcilePass(deps({ releaseRefundNumber: releaseOk }));
    expect(r.skippedSeqs).toEqual([ev.terminalSeq]);
    const row = await status(ev);
    expect(row.status).toBe('skipped');
    expect(row.lastError).toBe('The refund did not reach the server; its number was closed on the server, so it carries no money.');
  });

  it('absent number is skipped even when the PARENT receipt exists on the server (the parent is not proof of the refund)', async () => {
    const ev = await refund('parent1');
    await aged(ev);
    fs.seed(receiptPath('parent1'), { receiptNumber: ev.receiptNumber, total: 125, lines: [] });
    await reconcile.runReconcilePass(deps({ releaseRefundNumber: releaseOk }));
    const row = await status(ev);
    expect(row.status).toBe('skipped');
    expect(row.lastError).toBe('The refund did not reach the server; its number was closed on the server, so it carries no money.');
  });

  it('number document with a DIFFERENT terminalSeq -> stays reserved with lastError (a person decides), never auto-resolved', async () => {
    const ev = await refund();
    fs.seed(numberPath(ev.receiptNumber), { receiptId: 'other-refund', terminalNo: 1, terminalSeq: ev.terminalSeq + 100 });
    const r = await reconcile.runReconcilePass(deps());
    expect(r).toMatchObject({ acknowledged: 0, skippedSeqs: [] });
    const row = await status(ev);
    expect(row.status).toBe('reserved');
    expect(typeof row.lastError).toBe('string');
    expect(row.lastError).not.toBe('');
  });

  it('follow-up 3c: an absent number on a row younger than 10 minutes stays reserved (the request may still be in flight); at 10 minutes it is skipped', async () => {
    const young = await refund();
    await aged(young, 10 * 60_000 - 5_000);
    const r1 = await reconcile.runReconcilePass(deps());
    expect(r1.skippedSeqs).toEqual([]);
    expect((await status(young)).status).toBe('reserved');
    await aged(young, 10 * 60_000);
    const r2 = await reconcile.runReconcilePass(deps({ releaseRefundNumber: releaseOk }));
    expect(r2.skippedSeqs).toEqual([young.terminalSeq]);
    expect((await status(young)).status).toBe('skipped');
  });

  it('follow-up 3c: a young row whose number IS on the server is still acknowledged straight away', async () => {
    const ev = await refund();
    fs.seed(numberPath(ev.receiptNumber), { receiptId: 'refund-xyz', terminalNo: 1, terminalSeq: ev.terminalSeq });
    await reconcile.runReconcilePass(deps());
    expect((await status(ev)).status).toBe('acknowledged');
  });

  it('a thrown read leaves the refund row reserved (never "absent")', async () => {
    const ev = await refund();
    const port = { ...client.reconcilePort, getDocFromServer: async () => { throw new Error('unavailable'); } };
    await reconcile.runReconcilePass(deps({ port: port as any }));
    expect((await status(ev)).status).toBe('reserved');
  });

  it('refund rows are read at stores/{storeId}/receiptNumbers/{receiptNumber}, not receipts/{parent}', async () => {
    const ev = await refund('parent1');
    const paths: string[] = [];
    const port = { ...client.reconcilePort, doc: (db: unknown, p: string) => { paths.push(p); return client.reconcilePort.doc(db, p); } };
    await reconcile.runReconcilePass(deps({ port: port as any }));
    expect(paths).toEqual([numberPath(ev.receiptNumber)]);
  });

  describe('T-474 DEF-756: absence is not an outcome; only a number the server CLOSED is skipped', () => {
    const REASON = 'The refund did not reach the server; its number was closed on the server, so it carries no money.';
    it('absent + old, NO releaseRefundNumber dep -> stays reserved (never skipped on absence alone)', async () => {
      const ev = await refund();
      await aged(ev);
      const r = await reconcile.runReconcilePass(deps());
      expect(r.skippedSeqs).toEqual([]);
      expect((await status(ev)).status).toBe('reserved');
    });
    it('absent + young -> release is not even called', async () => {
      const ev = await refund();
      await aged(ev, 60_000);
      const release = vi.fn(releaseOk);
      await reconcile.runReconcilePass(deps({ releaseRefundNumber: release }));
      expect(release).not.toHaveBeenCalled();
      expect((await status(ev)).status).toBe('reserved');
    });
    it('absent + old: release says released with the row seq -> skipped', async () => {
      const ev = await refund();
      await aged(ev);
      const release = vi.fn(releaseOk);
      const r = await reconcile.runReconcilePass(deps({ releaseRefundNumber: release }));
      expect(release).toHaveBeenCalledTimes(1);
      expect(r.skippedSeqs).toEqual([ev.terminalSeq]);
      expect((await status(ev)).lastError).toBe(REASON);
    });
    it('absent + old: release says used (the refund committed meanwhile) -> acknowledged, NOT skipped', async () => {
      const ev = await refund();
      await aged(ev);
      const r = await reconcile.runReconcilePass(deps({ releaseRefundNumber: async (e) => ({ state: 'used', terminalSeq: e.terminalSeq }) }));
      expect(r.skippedSeqs).toEqual([]);
      expect(r.acknowledged).toBe(1);
      expect((await status(ev)).status).toBe('acknowledged');
    });
    it('absent + old: release answers another terminalSeq (released or used) -> stays reserved with lastError', async () => {
      for (const state of ['released', 'used'] as const) {
        const ev = await refund();
        await aged(ev);
        await reconcile.runReconcilePass(deps({ releaseRefundNumber: async (e) => ({ state, terminalSeq: e.terminalSeq + 100 }) }));
        const row = await status(ev);
        expect(row.status, state).toBe('reserved');
        expect(row.lastError, state).toBeTruthy();
        await ledger.patchEvent(ev.deviceId, ev.terminalSeq, { status: 'acknowledged' });
      }
    });
    it('absent + old: release throws -> stays reserved', async () => {
      const ev = await refund();
      await aged(ev);
      const r = await reconcile.runReconcilePass(deps({ releaseRefundNumber: async () => { throw new Error('503'); } }));
      expect(r.skippedSeqs).toEqual([]);
      expect((await status(ev)).status).toBe('reserved');
    });
    it('number doc present with released:true and the row seq -> skipped, never acknowledged', async () => {
      const ev = await refund();
      fs.seed(numberPath(ev.receiptNumber), { released: true, kind: 'refund-number-released', terminalNo: 1, terminalSeq: ev.terminalSeq });
      const r = await reconcile.runReconcilePass(deps());
      expect(r.acknowledged).toBe(0);
      expect(r.skippedSeqs).toEqual([ev.terminalSeq]);
      const row = await status(ev);
      expect(row.status).toBe('skipped');
      expect(row.lastError).toBe(REASON);
    });
  });
});
