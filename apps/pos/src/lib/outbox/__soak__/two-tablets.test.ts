/**
 * T-425 slice T - the two-tablet soak harness (Ruling 10; Acceptance 15, 6, 7, 13). Runs in the normal `npm test -w @shareat/pos`.
 *
 * Script: two tablets (two fake IndexedDBs, two terminal claims, two Firestore clients of ONE fake server). 150 offline sales (A: 90, B: 60;
 * ~1,900 writes) over four 4-hour rounds on a controllable clock; connectivity flaps (a 2-minute reconnect with a reconcile pass) in rounds 1-3;
 * four X-slips per tablet; B's pending queue is DROPPED twice (round 3 heals at the flap, round 4 only at the final reconcile); a restart of the
 * offline-period state; in round 4 a table is re-seated on the server and one session is voided online before reconnect; a reconcile pass that
 * DIES mid-way and a fresh one that finishes.
 * Asserts: server receipts = ledger sales (count and ids); zero duplicate receipt numbers and zero duplicate receipt writes; every sale acknowledged
 * except the planted conflict (quarantined, server untouched); the re-seated table is not freed; X-slip totals = the period's sales.
 *
 * Uses ONLY the contracts fixed in ledger.test.ts, reconcile.test.ts, offlinePeriod.test.ts and xSlipFormatter.test.ts.
 *
 * NOTE (spec gap, reported): the planted conflict and the re-seat are placed on tablet B whose queue is dropped. A batch the Firestore SDK delivers by
 * itself is built from the same ops and is NOT guarded by reconcile's replay rules, so on tablet A it would overwrite a session voided meanwhile (DEF-018's
 * other half). The spec guards only the replay; this harness does not hide that.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIdb, type FakeIdbFactory } from '@/test-helpers/fakeIdb';
import { createFakeFirestore, type FakeClient, type FakeFirestore } from '@/test-helpers/fakeFirestore';
import { installFakeClock, type FakeClock } from '@/test-helpers/fakeClock';
import { LINES, STORE, fakeLocks, saleOps, seedServerSession } from '@/test-helpers/outbox';
import * as counter from '@/lib/terminal/counter';
import * as ledger from '@/lib/outbox/ledger';
import { computeLinesHash } from '@/lib/outbox/linesHash';
import * as reconcile from '@/lib/outbox/reconcile';
import * as period from '@/lib/outbox/offlinePeriod';
import { formatXSlip, summarizeXSlip, XSLIP_HEADER } from '@/lib/printing/xSlipFormatter';

const H = 3_600_000;
const M = 60_000;
const T0 = 1_800_000_000_000;

interface Tablet {
  name: string; deviceId: string; terminalNo: number; idb: FakeIdbFactory; client: FakeClient;
  period: period.OfflinePeriodState; sold: { sid: string; cents: number; at: number }[]; slips: { k: number; text: string; gross: number; expected: number }[];
}

let server: FakeFirestore;
let clock: FakeClock;
let A: Tablet;
let B: Tablet;
const locksFor = new Map<string, ReturnType<typeof fakeLocks>>();

beforeEach(() => {
  server = createFakeFirestore();
  clock = installFakeClock(T0);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); clock.uninstall(); });

const as = async <T>(t: Tablet, fn: () => Promise<T>): Promise<T> => { vi.stubGlobal('indexedDB', t.idb); return fn(); };

async function makeTablet(name: string, deviceId: string, terminalNo: number): Promise<Tablet> {
  const t: Tablet = {
    name, deviceId, terminalNo, idb: createFakeIdb({ commitDelayMs: 0 }), client: server.client(name),
    period: period.EMPTY_OFFLINE_PERIOD, sold: [], slips: [],
  };
  await as(t, () => counter.saveTerminalClaim({ storeId: STORE, terminalNo, deviceId, nextSeq: 1 }));
  locksFor.set(name, fakeLocks());
  return t;
}

const hash = computeLinesHash(LINES);
let sessionCounter = 0;

/** One offline sale: ledger first (number + ops, one transaction), THEN the batch built from the stored ops, committed local-first. */
async function sell(t: Tablet, o: { sid?: string } = {}) {
  const sid = o.sid ?? `s-${t.name}-${++sessionCounter}`;
  const tickets = [`${sid}-k1`, `${sid}-k2`, `${sid}-k3`];
  seedServerSession(server, sid, { tickets });
  const cents = 59800 + (sessionCounter % 7) * 500;
  const twoTenders = sessionCounter % 2 === 0;
  const tenders = twoTenders
    ? [{ method: 'Cash', centavos: cents - 10000, toCheck: false, reference: null }, { method: 'GCash', centavos: 10000, toCheck: true, reference: `GC-${sessionCounter}` }]
    : [{ method: 'Cash', centavos: cents, toCheck: false, reference: null }];
  const ev = await as(t, () => ledger.reserveOfflineEvent({
    kind: 'sale', storeCode: 'SHT', receiptId: sid, totalCentavos: cents, linesHash: hash, tenders, createdAtClientMs: Date.now(),
    buildOps: (n) => saleOps({
      sessionId: sid, receiptNumber: n.receiptNumber, terminalNo: t.terminalNo, terminalSeq: n.terminalSeq, deviceId: n.deviceId, tickets,
      totalPesos: cents / 100, tenders: tenders.map((x) => ({ method: x.method, pesos: x.centavos / 100, reference: x.reference ?? undefined })),
    }),
  }));
  const batch = t.client.writeBatch();
  ledger.applyOpsToBatch(batch as any, ev.ops!, {
    doc: (p) => server.doc(server.db, p), serverTimestamp: server.serverTimestamp, deleteField: server.deleteField, arrayRemove: server.arrayRemove,
  });
  void batch.commit().catch(() => { /* a refused or dropped batch is reconcile's business */ });
  t.sold.push({ sid, cents, at: Date.now() });
  return ev;
}

/** The period timer + X-slip printing for one reading. */
async function tick(t: Tablet, online: boolean) {
  const unsent = await as(t, () => ledger.unsentCount());
  const r = period.advanceOfflinePeriod(t.period, { nowMs: Date.now(), online, unsentCount: unsent });
  t.period = r.state;
  for (const k of r.slipsDue) {
    const events = await as(t, () => ledger.listEvents());
    const text = formatXSlip({ storeName: 'Shareat Test', terminalNo: t.terminalNo, periodStartMs: t.period.periodStartMs!, periodEndMs: Date.now(), events });
    const sum = summarizeXSlip(events, t.period.periodStartMs!, Date.now());
    const expected = t.sold.filter((s) => s.at <= Date.now()).reduce((a, s) => a + s.cents, 0);
    t.slips.push({ k, text, gross: sum.grossCentavos, expected });
    t.period = period.markSlipsPrinted(t.period, k);
  }
  await as(t, () => period.saveOfflinePeriod(t.period));
}

const depsFor = (t: Tablet, port?: any): reconcile.ReconcileDeps => ({
  port: port ?? (t.client.reconcilePort as any), isOnline: () => t.client.online, locks: locksFor.get(t.name)!, pendingWritesTimeoutMs: 50,
});
const passes = async (t: Tablet, n: number) => { for (let i = 0; i < n; i++) await as(t, () => reconcile.runReconcilePass(depsFor(t))); };

describe('two tablets, one day offline (Ruling 10; Acceptance 15)', () => {
  it('150 sales, flapping connectivity, 4 X-slips each, dropped queues, a kill mid-reconcile: every sale reaches the server exactly once', async () => {
    A = await makeTablet('A', 'DEV-A', 1);
    B = await makeTablet('B', 'DEV-B', 2);
    const tablets = [A, B];
    const aCount = [23, 23, 22, 22];
    const bCount = 15;
    let reseatSid = '';
    let conflictSid = '';

    for (const t of tablets) { t.client.goOffline(); await tick(t, false); }
    expect(A.period.periodStartMs).toBe(T0);

    for (let round = 0; round < 4; round++) {
      const last = round === 3;
      const plan: [Tablet, number][] = [[A, aCount[round]!], [B, bCount]];
      for (const [t, n] of plan) {
        for (let i = 0; i < n; i++) {
          const planted = last && t === B && (i === 3 || i === 9);
          const ev = await sell(t);
          if (planted && i === 3) reseatSid = ev.receiptId;
          if (planted && i === 9) conflictSid = ev.receiptId;
          clock.advance(6 * M);
        }
      }

      if (!last) {
        // flap: 2 minutes online with a reconcile pass, then down again. The period must NOT end and the 4-hour clock must not reset.
        if (round === 2) B.client.dropPending(); // the SDK loses B's queue; reconcile must heal it from ops
        for (const t of tablets) { t.client.goOnline(); await tick(t, true); }
        await Promise.resolve();
        for (const t of tablets) await passes(t, 3);
        clock.advance(2 * M);
        for (const t of tablets) await tick(t, true);
        for (const t of tablets) { t.client.goOffline(); await tick(t, false); }
        for (const t of tablets) expect(t.period.periodStartMs, `${t.name} period start (round ${round})`).toBe(T0);
      }

      clock.set(T0 + (round + 1) * 4 * H);
      for (const t of tablets) await tick(t, false);

      if (round === 1) {
        // restart of the app: the period and the slips already printed come back from IndexedDB
        for (const t of tablets) {
          const loaded = await as(t, () => period.loadOfflinePeriod());
          expect(loaded).toEqual(t.period);
          t.period = loaded;
        }
      }
    }

    // the offline period of 16 hours: 4 slips each, at 4:00, 8:00, 12:00, 16:00
    for (const t of tablets) {
      expect(t.slips.map((s) => s.k), t.name).toEqual([1, 2, 3, 4]);
      for (const s of t.slips) {
        expect(s.text).toContain(XSLIP_HEADER);
        expect(s.gross, `${t.name} slip ${s.k}: total equals the ledger's sales`).toBe(s.expected);
      }
    }
    expect(A.sold.length).toBe(90);
    expect(B.sold.length).toBe(60);

    // while still offline, B's queue is lost again (round 4) and two server-side changes happen before reconnect
    B.client.dropPending();
    const tableOf = (sid: string) => `stores/${STORE}/tables/t-${sid}`;
    server.seed(tableOf(reseatSid), { status: 'occupied', currentSessionId: 'someone-else' }); // table re-seated
    server.seed(`stores/${STORE}/sessions/${conflictSid}`, { ...server.get(`stores/${STORE}/sessions/${conflictSid}`)!, status: 'voided', voidedBy: 'online-manager' });
    const conflictSession = server.get(`stores/${STORE}/sessions/${conflictSid}`);
    expect(server.list(`stores/${STORE}/receipts`).length).toBeLessThan(150);

    // reconnect; B's first reconcile pass DIES after 5 replays (app killed), then a fresh pass finishes
    for (const t of tablets) t.client.goOnline();
    await passes(A, 1);
    let replays = 0;
    const dying = { ...B.client.reconcilePort, runTransaction: async (db: unknown, fn: any) => { if (replays >= 5) throw new Error('process killed'); replays++; return B.client.runTransaction(db, fn); } } as any;
    await as(B, () => reconcile.runReconcilePass(depsFor(B, dying)));
    const afterKill = server.list(`stores/${STORE}/receipts`).length;
    await passes(A, 3);
    await passes(B, 6);

    // ---- assertions -------------------------------------------------------------------------------------------------------------------------------
    const eventsA = await as(A, () => ledger.listEvents());
    const eventsB = await as(B, () => ledger.listEvents());
    const all = [...eventsA, ...eventsB].filter((e) => e.kind === 'sale');
    expect(all).toHaveLength(150);
    expect(new Set(all.map((e) => e.receiptNumber)).size).toBe(150);            // no duplicate numbers across the two tablets
    expect(eventsA.map((e) => e.terminalSeq)).toEqual(Array.from({ length: 90 }, (_, i) => i + 1));
    expect(eventsB.map((e) => e.terminalSeq)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));

    const quarantined = all.filter((e) => e.status === 'quarantined');
    expect(quarantined.map((e) => e.receiptId)).toEqual([conflictSid]);
    expect(quarantined[0]!.lastError).toBe('This table was changed on another tablet.');
    expect(all.filter((e) => e.status !== 'acknowledged' && e.status !== 'quarantined')).toEqual([]); // nothing unsent, stuck, rejected

    const serverReceipts = server.list(`stores/${STORE}/receipts`);
    const expectedIds = all.filter((e) => e.status === 'acknowledged').map((e) => e.receiptId).sort();
    expect(serverReceipts.map((r) => r.id).sort()).toEqual(expectedIds);          // receipts on the server = ledger sales (count and ids)
    expect(serverReceipts).toHaveLength(149);
    expect(afterKill).toBeLessThan(149);                                          // the killed pass really died part-way
    const numbers = server.list(`stores/${STORE}/receiptNumbers`).map((d) => d.id);
    expect(new Set(numbers).size).toBe(numbers.length);                           // zero duplicate receipt numbers
    expect(numbers.sort()).toEqual(all.filter((e) => e.status === 'acknowledged').map((e) => e.receiptNumber).sort());
    for (const e of all.filter((x) => x.status === 'acknowledged')) {
      expect(server.get(`stores/${STORE}/receipts/${e.receiptId}`)).toMatchObject({ receiptNumber: e.receiptNumber, total: e.totalCentavos / 100 });
    }

    // each receipt was written exactly once (SDK delivery or replay, never both)
    const writesPerReceipt = new Map<string, number>();
    for (const c of server.commits) for (const w of c.writes) if (/\/receipts\/[^/]+$/.test(w.path) && (w.op === 'set')) writesPerReceipt.set(w.path, (writesPerReceipt.get(w.path) ?? 0) + 1);
    expect([...writesPerReceipt.values()].every((n) => n === 1)).toBe(true);
    expect(writesPerReceipt.size).toBe(149);

    // planted conflict: server untouched, no receipt, no receipt number
    expect(server.get(`stores/${STORE}/sessions/${conflictSid}`)).toEqual(conflictSession);
    expect(server.has(`stores/${STORE}/receipts/${conflictSid}`)).toBe(false);
    const conflictNumber = quarantined[0]!.receiptNumber;
    expect(server.has(`stores/${STORE}/receiptNumbers/${conflictNumber}`)).toBe(false);
    // planted re-seat: the sale is on the server, the table belongs to its new session
    expect(server.has(`stores/${STORE}/receipts/${reseatSid}`)).toBe(true);
    expect(server.get(tableOf(reseatSid))).toEqual({ status: 'occupied', currentSessionId: 'someone-else' });

    // every other sale freed its table
    const freed = all.filter((e) => e.status === 'acknowledged' && e.receiptId !== reseatSid);
    for (const e of freed) expect(server.get(tableOf(e.receiptId)), e.receiptId).toMatchObject({ status: 'available', currentSessionId: null });

    // the write volume the spec calls for, from the ledger itself (~2,000)
    const writes = all.reduce((n, e) => n + (e.ops?.length ?? 0), 0);
    expect(writes).toBeGreaterThan(1500);

    // both periods end only after 10 online minutes with nothing unsent
    for (const t of tablets) {
      const unsent = await as(t, () => ledger.unsentCount());
      expect(unsent).toBe(0);
      clock.advance(11 * M);
      await tick(t, true); await tick(t, true);
      clock.advance(10 * M);
      await tick(t, true);
      expect(t.period, t.name).toEqual(period.EMPTY_OFFLINE_PERIOD);
    }
  }, 180_000);
});
