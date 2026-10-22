/**
 * T-425 S1 - reconcile = SERVER PROOF (Ruling 2). The tablet never believes its own cache: a sale is `acknowledged` only when a read that
 * bypasses the cache (`getDocFromServer`) shows it on the server. The pass:
 *   - runs only ONLINE, and only in the tab holding the Web Lock `pos-reconcile` (other tabs skip);
 *   - resolves `reserved` rows (an online sale that crashed mid-way): server has the receipt -> acknowledged, absent -> skipped;
 *   - waits for the SDK's own queue (`waitForPendingWrites`, 20 s). A timeout is normal: NO replay that pass, because the SDK's queued write may
 *     still land and must not be raced;
 *   - per unsent row, in order: a thrown read is NEVER "absent" (attempts + 1; 10 -> stuck). Present -> compare receiptNumber, total and
 *     linesHash (refunds, tender corrections, analyticsApplied... are ignored): equal -> acknowledged, different -> quarantined (the server copy is
 *     never overwritten). Absent -> ONE guarded transaction replays the stored ops (all reads first; closed/voided session -> quarantined and
 *     nothing written; table freed only if it still points at this session; an `update` of a vanished doc is skipped). The row stays `unsent`
 *     until the NEXT pass proves it by the compare rule.
 * Only the real server state decides; the local Firestore cache is never read here.
 */
import { storedPesosToCentavos } from '@/lib/money/centavos';
import { computeLinesHash, legacyClockLinesHash } from '@/lib/outbox/linesHash';
import { isServerRefusal, messageOf } from '@/lib/outbox/refusal';
import {
  MAX_ATTEMPTS, applyOpsToBatch, listByStatus, markAcknowledged, markSkipped, patchEvent,
  type LedgerEvent, type LedgerOp, type OpsSdk,
} from '@/lib/outbox/ledger';

export const PENDING_WRITES_TIMEOUT_MS = 20_000;
export const CONFLICT_ANOTHER_TABLET = 'This table was changed on another tablet.';
const LOCK_NAME = 'pos-reconcile';

export interface ReconcilePort {
  db: unknown;
  doc(db: unknown, path: string): unknown;
  getDocFromServer(ref: unknown): Promise<{ exists(): boolean; data(): any }>;
  waitForPendingWrites(db: unknown): Promise<void>;
  runTransaction<T>(db: unknown, fn: (tx: any) => Promise<T>): Promise<T>;
  serverTimestamp(): unknown;
  deleteField(): unknown;
  arrayRemove(...v: unknown[]): unknown;
}

export interface ReconcileLocks {
  request(name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown | null) => Promise<unknown>): Promise<unknown>;
}

export interface ReconcileDeps {
  port: ReconcilePort;
  isOnline(): boolean;
  locks?: ReconcileLocks;
  pendingWritesTimeoutMs?: number;
}

export interface ReconcileResult {
  ran: boolean;
  skipped?: 'offline' | 'lock-held' | 'pending-writes-timeout' | 'nothing-to-do';
  acknowledged: number;
  quarantined: number;
  rejected: number;
  replayed: number;
  failed: number;
  stuck: number;
  skippedSeqs: number[];
}

const empty = (extra: Partial<ReconcileResult> = {}): ReconcileResult => ({
  ran: false, acknowledged: 0, quarantined: 0, rejected: 0, replayed: 0, failed: 0, stuck: 0, skippedSeqs: [], ...extra,
});


const receiptPath = (ev: LedgerEvent) => `stores/${ev.storeId}/receipts/${ev.receiptId}`;
const sessionPath = (ev: LedgerEvent) => `stores/${ev.storeId}/sessions/${ev.receiptId}`;
const TABLE_DOC = /^stores\/[^/]+\/tables\/[^/]+$/;
const TABLE_PROJECTION = /^stores\/[^/]+\/storeConfig\/current\/tables\/[^/]+$/;

function defaultLocks(): ReconcileLocks | undefined {
  const l = (globalThis as { navigator?: { locks?: ReconcileLocks } }).navigator?.locks;
  return l && typeof l.request === 'function' ? l : undefined;
}

/** One reconcile pass. Never throws: every failure is recorded on the row it belongs to. */
export async function runReconcilePass(deps: ReconcileDeps): Promise<ReconcileResult> {
  if (!deps.isOnline()) return empty({ skipped: 'offline' });
  const locks = deps.locks ?? defaultLocks();
  if (!locks) return doPass(deps);
  const out = (await locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => (lock ? doPass(deps) : empty({ skipped: 'lock-held' })))) as ReconcileResult;
  return out;
}

async function doPass(deps: ReconcileDeps): Promise<ReconcileResult> {
  const { port } = deps;
  const res = empty({ ran: true });
  const reserved = await listByStatus('reserved');
  const unsent = await listByStatus('unsent');
  if (reserved.length === 0 && unsent.length === 0) return empty({ skipped: 'nothing-to-do' });

  // 1. reserved rows (online sales that never reported back)
  for (const ev of reserved) {
    let snap;
    try {
      snap = await port.getDocFromServer(port.doc(port.db, receiptPath(ev)));
    } catch {
      continue; // cannot tell: stays reserved
    }
    if (snap.exists() && (snap.data() as { receiptNumber?: string } | undefined)?.receiptNumber === ev.receiptNumber) {
      await markAcknowledged(ev.deviceId, ev.terminalSeq);
      res.acknowledged += 1;
    } else {
      await markSkipped(ev.deviceId, ev.terminalSeq, 'The sale did not reach the server, so this number carries no money.');
      res.skippedSeqs.push(ev.terminalSeq);
    }
  }
  if (unsent.length === 0) return res;

  // 2. never race the SDK's own queued writes
  if (!(await pendingWritesResolved(port, deps.pendingWritesTimeoutMs ?? PENDING_WRITES_TIMEOUT_MS))) {
    return { ...res, skipped: 'pending-writes-timeout' };
  }

  // 3. each unsent row, in (deviceId, terminalSeq) order
  for (const ev of unsent) {
    await reconcileOne(ev, deps, res);
  }
  return res;
}

async function pendingWritesResolved(port: ReconcilePort, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const waited = port.waitForPendingWrites(port.db).then(() => true, () => false);
    const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    return await Promise.race([waited, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A failed attempt: attempts + 1, the reason kept; the 10th makes the row `stuck` (manager list, Retry). */
async function failAttempt(ev: LedgerEvent, error: unknown, res: ReconcileResult): Promise<void> {
  const attempts = ev.attempts + 1;
  const stuck = attempts >= MAX_ATTEMPTS;
  await patchEvent(ev.deviceId, ev.terminalSeq, { attempts, lastError: messageOf(error), status: stuck ? 'stuck' : 'unsent' });
  res.failed += 1;
  if (stuck) res.stuck += 1;
}

async function reconcileOne(ev: LedgerEvent, deps: ReconcileDeps, res: ReconcileResult): Promise<void> {
  const { port } = deps;
  const checkPath = ev.kind === 'void' ? sessionPath(ev) : receiptPath(ev);
  let snap;
  try {
    snap = await port.getDocFromServer(port.doc(port.db, checkPath));
  } catch (e) {
    await failAttempt(ev, e, res); // a thrown read is NEVER "absent"
    return;
  }

  if (ev.kind === 'void') {
    const status = snap.exists() ? (snap.data() as { status?: string }).status : undefined;
    if (status === 'voided') {
      await markAcknowledged(ev.deviceId, ev.terminalSeq);
      res.acknowledged += 1;
      return;
    }
    if (snap.exists() && status === 'closed') {
      await quarantine(ev, res);
      return;
    }
    if (!snap.exists()) {
      await quarantine(ev, res, 'The table session is not on the server, so the void cannot be applied.');
      return;
    }
  } else if (snap.exists()) {
    const data = (snap.data() ?? {}) as { receiptNumber?: string; total?: unknown; lines?: unknown[] };
    const same =
      data.receiptNumber === ev.receiptNumber &&
      storedPesosToCentavos(data.total) === ev.totalCentavos &&
      (computeLinesHash(Array.isArray(data.lines) ? data.lines : []) === ev.linesHash ||
        legacyClockLinesHash(Array.isArray(data.lines) ? data.lines : []) === ev.linesHash);
    if (same) {
      await markAcknowledged(ev.deviceId, ev.terminalSeq);
      res.acknowledged += 1;
    } else {
      await quarantine(ev, res, 'The server already has a different sale under this receipt.');
    }
    return;
  }

  await replay(ev, deps, res);
}

async function quarantine(ev: LedgerEvent, res: ReconcileResult, why: string = CONFLICT_ANOTHER_TABLET): Promise<void> {
  await patchEvent(ev.deviceId, ev.terminalSeq, { status: 'quarantined', lastError: why });
  res.quarantined += 1;
}

type ReplayOutcome = 'written' | 'already' | 'conflict';

/** Thrown INSIDE the transaction callback to end it without a commit (the SDK rolls back and rethrows): a stop is not a failure. */
class ReplayStop extends Error {
  constructor(readonly outcome: 'already' | 'conflict') { super(`replay stopped: ${outcome}`); }
}

/** The guarded replay: ONE transaction, every read before any write. */
async function replay(ev: LedgerEvent, deps: ReconcileDeps, res: ReconcileResult): Promise<void> {
  const { port } = deps;
  const ops = ev.ops ?? [];
  const sdk: OpsSdk = {
    doc: (p) => port.doc(port.db, p),
    serverTimestamp: () => port.serverTimestamp(),
    deleteField: () => port.deleteField(),
    arrayRemove: (...v) => port.arrayRemove(...v),
  };
  let outcome: ReplayOutcome;
  try {
    outcome = await port.runTransaction(port.db, async (tx): Promise<ReplayOutcome> => {
      // ---- reads ----
      const ownDoc = ev.kind === 'void' ? sessionPath(ev) : receiptPath(ev);
      const ownSnap = await tx.get(port.doc(port.db, ownDoc));
      const sessionSnap = ev.kind === 'void' ? ownSnap : await tx.get(port.doc(port.db, sessionPath(ev)));
      if (ev.kind === 'sale' && ownSnap.exists()) throw new ReplayStop('already'); // the SDK's own write landed first
      const session = sessionSnap.exists() ? (sessionSnap.data() as { status?: string }) : null;
      if (session && (session.status === 'closed' || session.status === 'voided')) {
        throw new ReplayStop(ev.kind === 'void' && session.status === 'voided' ? 'already' : 'conflict');
      }
      const targets = [...new Set(ops.filter((o) => o.op === 'update').map((o) => o.path))];
      const exists = new Map<string, boolean>();
      const tableData = new Map<string, { currentSessionId?: string }>();
      for (const p of targets) {
        if (p === sessionPath(ev)) { exists.set(p, sessionSnap.exists()); continue; }
        const s = await tx.get(port.doc(port.db, p));
        exists.set(p, s.exists());
        if (TABLE_DOC.test(p) && s.exists()) tableData.set(p, s.data() as { currentSessionId?: string });
      }
      // ---- decide which ops to write ----
      const keep: LedgerOp[] = [];
      for (const o of ops) {
        if (o.op === 'update' && exists.get(o.path) === false) continue; // the doc vanished: skip it, never reject the sale
        if (o.op === 'update' && TABLE_DOC.test(o.path)) {
          if (tableData.get(o.path)?.currentSessionId !== ev.receiptId) continue; // re-seated by another session: leave the table alone
        }
        if (o.op === 'update' && TABLE_PROJECTION.test(o.path)) {
          const tablePath = o.path.replace('/storeConfig/current/tables/', '/tables/');
          if (tableData.get(tablePath)?.currentSessionId !== ev.receiptId) continue; // the projection follows the table
        }
        keep.push(o);
      }
      // ---- writes ----
      applyOpsToBatch(tx, keep, sdk);
      return 'written';
    });
  } catch (e) {
    if (e instanceof ReplayStop) {
      if (e.outcome === 'conflict') await quarantine(ev, res);
      return; // 'already': the next pass proves it by the compare rule
    }
    if (isServerRefusal(e)) {
      await patchEvent(ev.deviceId, ev.terminalSeq, { status: 'rejected', lastError: messageOf(e) });
      res.rejected += 1;
    } else {
      await failAttempt(ev, e, res);
    }
    return;
  }
  if (outcome === 'written') res.replayed += 1;
}
