/**
 * T-425 slice T - the sale ledger (Ruling 1, ✎R/✎R2). Acceptance 1, 2 (codec half), 5 (statuses), 12 (selling is never blocked).
 *
 * CONTRACT for the builder (S1) - file `apps/pos/src/lib/outbox/ledger.ts`, store `events` of the shared database (lib/terminal/db.ts),
 * keyPath ['deviceId', 'terminalSeq']. No localStorage. Exports exactly:
 *   type LedgerKind   = 'sale' | 'void' | 'skipped'
 *   type LedgerStatus = 'reserved' | 'unsent' | 'acknowledged' | 'skipped' | 'quarantined' | 'rejected' | 'stuck'
 *   interface LedgerOp     { op: 'set' | 'update' | 'delete'; path: string; data?: Record<string, unknown>; merge?: boolean }
 *   interface LedgerTender { method: string; centavos: number; toCheck: boolean; reference: string | null }
 *   interface LedgerEvent  { deviceId; storeId; terminalNo; terminalSeq; receiptId; receiptNumber; kind: LedgerKind; totalCentavos: number;
 *                            linesHash: string; tenders: LedgerTender[]; createdAtClientMs: number; ops?: LedgerOp[]; status: LedgerStatus;
 *                            attempts: number; lastError: string | null }
 *   SALE_NOT_SAVED_MESSAGE = 'This tablet could not save the sale. Do not continue; call the manager.'
 *   MAX_ATTEMPTS = 10            PRUNE_AFTER_MS = 7 * 24 * 3600 * 1000
 *   SERVER_TIMESTAMP_MARKER = { __serverTimestamp__: true };  deleteFieldMarker() = { __deleteField__: true };  arrayRemoveMarker(...v) = { __arrayRemove__: v }
 *   reserveOfflineEvent(a: { kind: 'sale' | 'void'; storeCode: string; receiptId: string; totalCentavos: number; linesHash: string;
 *                            tenders: LedgerTender[]; createdAtClientMs?: number;
 *                            buildOps: (n: { receiptNumber: string; terminalNo: number; terminalSeq: number; deviceId: string }) => LedgerOp[] }): Promise<LedgerEvent>
 *        - ONE readwrite transaction over `terminal` + `events`: reserve the number (as counter.reserveNext) and append the event with
 *          status 'unsent', attempts 0, lastError null, `ops = buildOps(number)`. buildOps is SYNCHRONOUS and called inside the transaction;
 *          nothing in the function awaits a foreign promise while the transaction is open. Resolves after the transaction COMPLETED.
 *          Any IndexedDB failure rejects with Error(SALE_NOT_SAVED_MESSAGE) and neither the counter nor the ledger changed.
 *          No claim -> TerminalNotClaimedError (counter.ts). A sale is NEVER refused because of the unsent total (Ruling 6: selling never stops).
 *   reserveOnlineEvent(a: same minus buildOps): Promise<LedgerEvent>   - number + a `reserved` event (no ops) in one transaction
 *   markAcknowledged(deviceId, terminalSeq): Promise<void>             - reserved|unsent -> acknowledged
 *   markSkipped(deviceId, terminalSeq, reason?: string): Promise<void> - reserved -> skipped (kind stays; lastError = reason; no ops kept)
 *   patchEvent(deviceId, terminalSeq, patch: Partial<LedgerEvent>): Promise<LedgerEvent>
 *   retryStuck(deviceId, terminalSeq): Promise<void>                   - stuck -> unsent, attempts 0, lastError null
 *   getEvent(deviceId, terminalSeq): Promise<LedgerEvent | null>
 *   listEvents(): Promise<LedgerEvent[]>        - ordered by (deviceId, terminalSeq)
 *   listByStatus(...s: LedgerStatus[]): Promise<LedgerEvent[]>
 *   unsentCount(): Promise<number>               - events with status 'unsent' or 'stuck'
 *   unsentTotalCentavos(): Promise<number>       - sum of totalCentavos over kind 'sale' events with status 'unsent' or 'stuck'
 *   pruneLedger(nowMs: number): Promise<number>  - deletes `acknowledged` and `skipped` rows older than PRUNE_AFTER_MS (by createdAtClientMs); returns how many. Never touches unsent/stuck/quarantined/rejected/reserved.
 *   applyOpsToBatch(batch: { set(ref, data, opts?), update(ref, data), delete(ref) }, ops: LedgerOp[],
 *                   sdk: { doc(path: string): unknown; serverTimestamp(): unknown; deleteField(): unknown; arrayRemove(...v: unknown[]): unknown }): void
 *        - the ONE way a batch is built from ops: markers anywhere in `data` (nested too) become sdk.serverTimestamp() / deleteField() / arrayRemove(...v).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIdb, type FakeIdbFactory } from '@/test-helpers/fakeIdb';
import { createFakeFirestore } from '@/test-helpers/fakeFirestore';
import { LINES, STORE, TS, saleOps, voidOps } from '@/test-helpers/outbox';
import * as counter from '@/lib/terminal/counter';
import * as ledger from '@/lib/outbox/ledger';

let idb: FakeIdbFactory;
beforeEach(() => {
  idb = createFakeIdb({ commitDelayMs: 0 }); // strict: a transaction auto-commits as soon as nothing is pending (catches awaits inside it)
  vi.stubGlobal('indexedDB', idb);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const claim = (nextSeq = 5) => counter.saveTerminalClaim({ storeId: STORE, terminalNo: 1, deviceId: 'DEV-A', nextSeq });
const tenders = [{ method: 'Cash', centavos: 59800, toCheck: false, reference: null }];
const base = (sid: string, extra: Record<string, unknown> = {}) => ({
  kind: 'sale' as const, storeCode: 'SHT', receiptId: sid, totalCentavos: 59800, linesHash: 'h-' + sid, tenders,
  buildOps: (n: { receiptNumber: string; terminalSeq: number; deviceId: string }) => saleOps({ sessionId: sid, receiptNumber: n.receiptNumber, terminalSeq: n.terminalSeq, deviceId: n.deviceId }),
  ...extra,
});

describe('reserveOfflineEvent (Acceptance 1)', () => {
  it('reserves the number and appends an `unsent` event with the COMPLETE write list, in ONE IndexedDB transaction', async () => {
    await claim(5);
    const before = idb.commitCount();
    const ev = await ledger.reserveOfflineEvent(base('sess1', { createdAtClientMs: 1_800_000_000_000 }));
    expect(idb.commitCount() - before).toBe(1); // number + event committed together
    expect(ev).toMatchObject({
      deviceId: 'DEV-A', storeId: STORE, terminalNo: 1, terminalSeq: 5, receiptId: 'sess1', receiptNumber: 'SHT-01-000005', kind: 'sale',
      totalCentavos: 59800, linesHash: 'h-sess1', status: 'unsent', attempts: 0, lastError: null, createdAtClientMs: 1_800_000_000_000,
    });
    expect(ev.tenders).toEqual(tenders);
    expect(ev.ops).toEqual(saleOps({ sessionId: 'sess1', receiptNumber: 'SHT-01-000005', terminalSeq: 5, deviceId: 'DEV-A' }));
    expect(idb.rows('terminal')[0].nextSeq).toBe(6);
    expect(idb.rows('events')).toHaveLength(1);
    expect(await ledger.getEvent('DEV-A', 5)).toEqual(ev);
  });

  it('Acceptance 1 (mutant: a sale outside the ledger / an unexplained gap): if the transaction fails, the sale is refused with the plain sentence and NOTHING changed', async () => {
    await claim(5);
    idb.failNextTransaction();
    const buildOps = vi.fn(base('sess1').buildOps);
    await expect(ledger.reserveOfflineEvent({ ...base('sess1'), buildOps })).rejects.toThrow('This tablet could not save the sale. Do not continue; call the manager.');
    expect(ledger.SALE_NOT_SAVED_MESSAGE).toBe('This tablet could not save the sale. Do not continue; call the manager.');
    expect(idb.rows('terminal')[0].nextSeq).toBe(5); // number NOT consumed
    expect(idb.rows('events')).toHaveLength(0);
    const next = await ledger.reserveOfflineEvent(base('sess1')); // and the very next sale gets the same number: no gap
    expect(next.terminalSeq).toBe(5);
  });

  it('refuses with the terminal-claim message (and writes nothing) when this tablet has no terminal', async () => {
    await expect(ledger.reserveOfflineEvent(base('sess1'))).rejects.toBeInstanceOf(counter.TerminalNotClaimedError);
    expect(idb.rows('events')).toHaveLength(0);
  });

  it('two sales in a row get n and n+1; two at once never share a number (transactions are serialised)', async () => {
    await claim(5);
    const [a, b, c] = await Promise.all([ledger.reserveOfflineEvent(base('s1')), ledger.reserveOfflineEvent(base('s2')), ledger.reserveOfflineEvent(base('s3'))]);
    expect([a, b, c].map((e) => e.terminalSeq).sort()).toEqual([5, 6, 7]);
    expect(new Set([a, b, c].map((e) => e.receiptNumber)).size).toBe(3);
  });

  it('the stored ops are plain JSON (a JSON round trip changes nothing) and carry the fixed payment ids and timestamp markers', async () => {
    await claim(5);
    const ev = await ledger.reserveOfflineEvent(base('sess1'));
    expect(JSON.parse(JSON.stringify(ev.ops))).toEqual(ev.ops);
    expect(ev.ops!.some((o) => o.path.endsWith('/payments/sess1-p0'))).toBe(true);
    expect(JSON.stringify(ev.ops)).toContain('"__serverTimestamp__":true');
  });

  it('a void is a ledger event too (kind void) and reserves a number (every number explained)', async () => {
    await claim(5);
    const ev = await ledger.reserveOfflineEvent({ ...base('sess9'), kind: 'void', totalCentavos: 0, buildOps: () => voidOps({ sessionId: 'sess9' }) });
    expect(ev).toMatchObject({ kind: 'void', status: 'unsent', terminalSeq: 5 });
    expect(ev.ops!.find((o) => o.path.endsWith('/sessions/sess9'))!.data).toMatchObject({ status: 'voided', voidedOffline: true });
  });

  it('selling is never blocked by the unsent total (Ruling 6): a sale at 60,000 pesos unsent still records', async () => {
    await claim(5);
    await ledger.reserveOfflineEvent({ ...base('big'), totalCentavos: 6_000_000 });
    const ev = await ledger.reserveOfflineEvent(base('after-big'));
    expect(ev.status).toBe('unsent');
    expect(await ledger.unsentTotalCentavos()).toBe(6_059_800);
  });
});

describe('reserveOnlineEvent / markAcknowledged / markSkipped (Acceptance 5)', () => {
  it('reserves the number with a `reserved` event (no ops) in one transaction; acknowledging moves it on', async () => {
    await claim(5);
    const before = idb.commitCount();
    const ev = await ledger.reserveOnlineEvent({ kind: 'sale', storeCode: 'SHT', receiptId: 'o1', totalCentavos: 100, linesHash: 'h', tenders });
    expect(idb.commitCount() - before).toBe(1);
    expect(ev).toMatchObject({ status: 'reserved', receiptNumber: 'SHT-01-000005', terminalSeq: 5 });
    expect(ev.ops).toBeUndefined();
    await ledger.markAcknowledged('DEV-A', 5);
    expect((await ledger.getEvent('DEV-A', 5))!.status).toBe('acknowledged');
  });

  it('a failed online transaction becomes `skipped` (no money), keeps the reason, and drops any ops', async () => {
    await claim(5);
    await ledger.reserveOnlineEvent({ kind: 'sale', storeCode: 'SHT', receiptId: 'o1', totalCentavos: 100, linesHash: 'h', tenders });
    await ledger.markSkipped('DEV-A', 5, 'Another device just changed this receipt.');
    const ev = (await ledger.getEvent('DEV-A', 5))!;
    expect(ev.status).toBe('skipped');
    expect(ev.lastError).toContain('Another device');
    expect(ev.ops).toBeUndefined();
    expect(await ledger.unsentCount()).toBe(0);
  });

  it('a `reserved` row (crash between reservation and the online transaction) is listed for reconcile and is not "unsent"', async () => {
    await claim(5);
    await ledger.reserveOnlineEvent({ kind: 'sale', storeCode: 'SHT', receiptId: 'o1', totalCentavos: 100, linesHash: 'h', tenders });
    expect((await ledger.listByStatus('reserved')).map((e) => e.terminalSeq)).toEqual([5]);
    expect(await ledger.unsentCount()).toBe(0);
  });
});

describe('queries and status discipline', () => {
  it('unsent total and count cover `unsent` and `stuck` sales only', async () => {
    await claim(1);
    const mk = async (sid: string, cents: number, status?: ledger.LedgerStatus) => {
      const ev = await ledger.reserveOfflineEvent({ ...base(sid), totalCentavos: cents });
      if (status) await ledger.patchEvent(ev.deviceId, ev.terminalSeq, { status });
    };
    await mk('a', 10_000);
    await mk('b', 20_000, 'stuck');
    await mk('c', 40_000, 'acknowledged');
    await mk('d', 80_000, 'quarantined');
    await mk('e', 160_000, 'rejected');
    expect(await ledger.unsentTotalCentavos()).toBe(30_000);
    expect(await ledger.unsentCount()).toBe(2);
    expect((await ledger.listEvents()).map((e) => e.terminalSeq)).toEqual([1, 2, 3, 4, 5]);
    expect((await ledger.listByStatus('quarantined', 'rejected')).map((e) => e.receiptId)).toEqual(['d', 'e']);
  });

  it('retryStuck puts a stuck sale back to unsent with 0 attempts', async () => {
    await claim(1);
    const ev = await ledger.reserveOfflineEvent(base('a'));
    await ledger.patchEvent('DEV-A', ev.terminalSeq, { status: 'stuck', attempts: ledger.MAX_ATTEMPTS, lastError: 'boom' });
    await ledger.retryStuck('DEV-A', ev.terminalSeq);
    expect(await ledger.getEvent('DEV-A', ev.terminalSeq)).toMatchObject({ status: 'unsent', attempts: 0, lastError: null });
    expect(ledger.MAX_ATTEMPTS).toBe(10);
  });

  it('pruneLedger removes acknowledged/skipped rows older than 7 days and NEVER an unsent, stuck, quarantined, rejected or reserved row', async () => {
    await claim(1);
    const now = 1_800_000_000_000;
    const old = now - 8 * 24 * 3600_000;
    const fresh = now - 6 * 24 * 3600_000;
    const add = async (sid: string, status: ledger.LedgerStatus, at: number) => {
      const ev = await ledger.reserveOfflineEvent({ ...base(sid), createdAtClientMs: at });
      await ledger.patchEvent(ev.deviceId, ev.terminalSeq, { status });
    };
    await add('ack-old', 'acknowledged', old);
    await add('skip-old', 'skipped', old);
    await add('ack-new', 'acknowledged', fresh);
    for (const s of ['unsent', 'stuck', 'quarantined', 'rejected', 'reserved'] as const) await add(`${s}-old`, s, old);
    expect(await ledger.pruneLedger(now)).toBe(2);
    expect((await ledger.listEvents()).map((e) => e.receiptId).sort()).toEqual(['ack-new', 'quarantined-old', 'rejected-old', 'reserved-old', 'stuck-old', 'unsent-old']);
    expect(ledger.PRUNE_AFTER_MS).toBe(7 * 24 * 3600 * 1000);
  });
});

describe('applyOpsToBatch (Acceptance 2: the batch is BUILT FROM ops)', () => {
  it('the batch equals the original write set field for field, with every marker turned back into its sentinel', async () => {
    const fs = createFakeFirestore();
    const ops = [
      ...saleOps({ sessionId: 's1', receiptNumber: 'SHT-01-000005', terminalSeq: 5, tickets: ['tk1'] }),
      ...voidOps({ sessionId: 's2', ticketId: 'tk2', stationId: 'st1' }),
      { op: 'set', path: `stores/${STORE}/misc/x`, data: { nested: { at: TS, keep: 1 } }, merge: true },
    ] as ledger.LedgerOp[];
    const batch = fs.writeBatch();
    ledger.applyOpsToBatch(batch as any, ops, {
      doc: (p) => fs.doc(fs.db, p), serverTimestamp: fs.serverTimestamp, deleteField: fs.deleteField, arrayRemove: fs.arrayRemove,
    });
    fs.seed(`stores/${STORE}/sessions/s1`, { status: 'active' });
    fs.seed(`stores/${STORE}/sessions/s1/kitchentickets/tk1`, { status: 'preparing' });
    fs.seed(`stores/${STORE}/tables/t-s1`, { status: 'occupied' });
    fs.seed(`stores/${STORE}/storeConfig/current/tables/t-s1`, { status: 'occupied' });
    fs.seed(`stores/${STORE}/sessions/s2`, { status: 'active' });
    fs.seed(`stores/${STORE}/sessions/s2/kitchentickets/tk2`, { status: 'preparing' });
    fs.seed(`stores/${STORE}/rtKdsTickets/st1`, { tickets: { tk2: { a: 1 } }, activeIds: ['tk2'] });
    fs.seed(`stores/${STORE}/tables/t-s2`, { status: 'occupied' });
    await batch.commit();
    const w = fs.commits.at(-1)!.writes;
    expect(w).toHaveLength(ops.length);
    ops.forEach((o, i) => {
      expect(w[i]!.op, o.path).toBe(o.op);
      expect(w[i]!.path).toBe(o.path);
    });
    const js = JSON.stringify(w);
    expect(js).not.toContain('__serverTimestamp__');
    expect(js).not.toContain('__deleteField__');
    expect(js).not.toContain('__arrayRemove__');
    const station = w.find((x) => x.path.endsWith('/rtKdsTickets/st1'))!;
    expect((station as any).data['tickets.tk2']).toEqual({ __s: 'deleteField' });
    expect((station as any).data.activeIds).toEqual({ __s: 'arrayRemove', v: ['tk2'] });
    expect((station as any).data['meta.updatedAt']).toEqual({ __s: 'serverTimestamp' });
    const receipt = w.find((x) => x.path === `stores/${STORE}/receipts/s1`)! as any;
    expect(receipt.data.createdAt).toEqual({ __s: 'serverTimestamp' });
    expect(receipt.data.lines).toEqual(LINES);
    expect(w.filter((x) => x.path.includes('/payments/')).map((x) => x.path.split('/').pop())).toEqual(['s1-p0']); // the FIXED id, never random
    const nested = w.find((x) => x.path.endsWith('/misc/x'))! as any;
    expect(nested.merge).toBe(true);
    expect(nested.data.nested.at).toEqual({ __s: 'serverTimestamp' });
    expect(nested.data.nested.keep).toBe(1);
    expect(ledger.SERVER_TIMESTAMP_MARKER).toEqual({ __serverTimestamp__: true });
    expect(ledger.deleteFieldMarker()).toEqual({ __deleteField__: true });
    expect(ledger.arrayRemoveMarker('a', 'b')).toEqual({ __arrayRemove__: ['a', 'b'] });
  });
});
