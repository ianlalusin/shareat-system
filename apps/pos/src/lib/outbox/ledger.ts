/**
 * T-425 S1 - the sale ledger (Ruling 1). Every number this tablet hands out is explained by one row here, in the SAME IndexedDB database as the
 * terminal counter (`events` store, key [deviceId, terminalSeq]). Never localStorage (bible row 276).
 *
 *  - An OFFLINE sale/void reserves its number AND appends its event (with the COMPLETE Firestore write list as plain data, `ops`) in ONE
 *    transaction: no sale outside the ledger, no unexplained gap. The Firestore batch is then BUILT FROM `ops` (`applyOpsToBatch`), so the stored
 *    copy and the real write cannot differ, and reconcile can replay the same writes if the SDK ever loses its queue.
 *  - An ONLINE sale reserves its number with a `reserved` event; success makes it `acknowledged`, a definite failure `skipped` (no money).
 *  - Unsent rows are never deleted; acknowledged and skipped rows are pruned after 7 days (they hold customer names and lines).
 */
import { TERMINAL_ROW_KEY, formatTerminalReceiptNumber, planReservation, type TerminalRecord } from '@/lib/terminal/counter';
import { STORE_EVENTS, STORE_META, STORE_TERMINAL, inTerminalTransaction } from '@/lib/terminal/db';

export type LedgerKind = 'sale' | 'void' | 'refund' | 'skipped';
export type LedgerStatus = 'reserved' | 'unsent' | 'acknowledged' | 'skipped' | 'quarantined' | 'rejected' | 'stuck';

export interface LedgerOp {
  op: 'set' | 'update' | 'delete';
  path: string;
  data?: Record<string, unknown>;
  merge?: boolean;
}

export interface LedgerTender {
  method: string;
  centavos: number;
  toCheck: boolean;
  reference: string | null;
}

export interface LedgerEvent {
  deviceId: string;
  storeId: string;
  terminalNo: number;
  terminalSeq: number;
  receiptId: string;
  receiptNumber: string;
  kind: LedgerKind;
  totalCentavos: number;
  linesHash: string;
  /** T-458: complete payment-input fingerprint, separate from reconcile's lines-only hash. */
  intentFingerprint?: string;
  tenders: LedgerTender[];
  createdAtClientMs: number;
  ops?: LedgerOp[];
  status: LedgerStatus;
  attempts: number;
  lastError: string | null;
}

export const SALE_NOT_SAVED_MESSAGE = 'This tablet could not save the sale. Do not continue; call the manager.';
export const MAX_ATTEMPTS = 10;
export const PRUNE_AFTER_MS = 7 * 24 * 3600 * 1000;

// ---- markers: how SDK sentinels and timestamps live in IndexedDB as plain JSON ---------------------------------------------------------------
export const SERVER_TIMESTAMP_MARKER = { __serverTimestamp__: true } as const;
export const deleteFieldMarker = () => ({ __deleteField__: true });
export const arrayRemoveMarker = (...v: unknown[]) => ({ __arrayRemove__: v });
const timestampMarker = (ms: number) => ({ __timestampMs__: ms });

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * Turns anything a builder read from the Firestore cache into plain JSON the ledger can store: `undefined` values are dropped (Firestore would
 * refuse them), a Timestamp or Date becomes `{__timestampMs__}`, and a value that is not plain data (an SDK sentinel, a DocumentReference) is
 * REFUSED rather than stored half-broken: builders must use the markers above for sentinels.
 */
export function encodeLedgerValue(v: unknown, at = 'data'): unknown {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`The ledger cannot store a non-finite number at ${at}.`);
    return v;
  }
  if (v === undefined) return undefined;
  if (v instanceof Date) return timestampMarker(v.getTime());
  if (typeof v === 'object' && typeof (v as { toMillis?: unknown }).toMillis === 'function' && 'seconds' in (v as object)) {
    return timestampMarker((v as { toMillis: () => number }).toMillis());
  }
  if (Array.isArray(v)) return v.map((x, i) => encodeLedgerValue(x, `${at}[${i}]`)).filter((x) => x !== undefined);
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const e = encodeLedgerValue(x, `${at}.${k}`);
      if (e !== undefined) out[k] = e;
    }
    return out;
  }
  throw new Error(`The ledger cannot store a ${Object.prototype.toString.call(v)} at ${at}; use a marker for Firestore sentinels.`);
}

function normalizeOps(ops: LedgerOp[]): LedgerOp[] {
  return ops.map((o, i) => {
    const out: LedgerOp = { op: o.op, path: o.path };
    if (o.data !== undefined) out.data = encodeLedgerValue(o.data, `ops[${i}].data`) as Record<string, unknown>;
    if (o.merge !== undefined) out.merge = o.merge;
    return out;
  });
}

export interface OpsSdk {
  doc(path: string): unknown;
  serverTimestamp(): unknown;
  deleteField(): unknown;
  arrayRemove(...v: unknown[]): unknown;
  /** Optional: how a `{__timestampMs__}` becomes a Firestore timestamp. Default: a Date (the SDK stores it as a timestamp). */
  timestampFromMillis?(ms: number): unknown;
}

function decodeValue(v: unknown, sdk: OpsSdk): unknown {
  if (Array.isArray(v)) return v.map((x) => decodeValue(x, sdk));
  if (!isPlainObject(v)) return v;
  if (v.__serverTimestamp__ === true) return sdk.serverTimestamp();
  if (v.__deleteField__ === true) return sdk.deleteField();
  if (Array.isArray(v.__arrayRemove__)) return sdk.arrayRemove(...(v.__arrayRemove__ as unknown[]).map((x) => decodeValue(x, sdk)));
  if (typeof v.__timestampMs__ === 'number') return sdk.timestampFromMillis ? sdk.timestampFromMillis(v.__timestampMs__) : new Date(v.__timestampMs__);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = decodeValue(x, sdk);
  return out;
}

/** The anything-with-set/update/delete a batch or a transaction offers. */
interface OpsWriter {
  set(ref: any, data: any, opts?: any): unknown;
  update(ref: any, data: any): unknown;
  delete(ref: any): unknown;
}

/** The ONE way a Firestore batch (or transaction) is built from stored ops: markers anywhere in `data` become the SDK's sentinels again. */
export function applyOpsToBatch(batch: OpsWriter, ops: LedgerOp[], sdk: OpsSdk): void {
  for (const o of ops) {
    const ref = sdk.doc(o.path);
    if (o.op === 'delete') batch.delete(ref);
    else if (o.op === 'update') batch.update(ref, decodeValue(o.data ?? {}, sdk));
    else if (o.merge) batch.set(ref, decodeValue(o.data ?? {}, sdk), { merge: true });
    else batch.set(ref, decodeValue(o.data ?? {}, sdk));
  }
}

// ---- reserving -------------------------------------------------------------------------------------------------------------------------------
interface ReserveBase {
  kind: 'sale' | 'void' | 'refund';
  storeCode: string;
  receiptId: string;
  totalCentavos: number;
  linesHash: string;
  tenders: LedgerTender[];
  createdAtClientMs?: number;
}
export interface ReserveOffline extends ReserveBase {
  /** SYNCHRONOUS; called inside the transaction. Returns the COMPLETE write list of the batch as plain data. */
  buildOps: (n: { receiptNumber: string; terminalNo: number; terminalSeq: number; deviceId: string }) => LedgerOp[];
}
export type ReserveOnline = ReserveBase;

/** A refusal that is NOT an IndexedDB failure (no claim, no store code, a builder bug): it passes through unchanged. */
class LogicFailure extends Error {
  constructor(readonly inner: Error) { super(inner.message); }
}

/** Must run inside the caller's counter+events transaction, with no awaits. */
function writeReservation(tx: IDBTransaction, a: ReserveBase, buildOps: ReserveOffline['buildOps'] | null,
  terminal: TerminalRecord | undefined, createdAtClientMs: number, intentFingerprint?: string): LedgerEvent {
  const plan = planReservation(terminal);
  const { terminalNo, terminalSeq, deviceId, storeId } = plan.reserved;
  const receiptNumber = formatTerminalReceiptNumber(a.storeCode, terminalNo, terminalSeq);
  const ev: LedgerEvent = {
    deviceId, storeId, terminalNo, terminalSeq, receiptId: a.receiptId, receiptNumber, kind: a.kind,
    totalCentavos: a.totalCentavos, linesHash: a.linesHash, tenders: a.tenders, createdAtClientMs,
    status: buildOps ? 'unsent' : 'reserved', attempts: 0, lastError: null,
    ...(intentFingerprint === undefined ? {} : { intentFingerprint }),
  };
  if (buildOps) ev.ops = normalizeOps(buildOps({ receiptNumber, terminalNo, terminalSeq, deviceId }));
  tx.objectStore(STORE_EVENTS).add(ev);
  tx.objectStore(STORE_TERMINAL).put(plan.next, TERMINAL_ROW_KEY);
  return ev;
}

async function reserve(a: ReserveBase, buildOps: ReserveOffline['buildOps'] | null): Promise<LedgerEvent> {
  const createdAtClientMs = a.createdAtClientMs ?? Date.now();
  try {
    return await inTerminalTransaction<LedgerEvent>([STORE_TERMINAL, STORE_EVENTS, STORE_META], 'readwrite', (tx, done, fail) => {
      const term = tx.objectStore(STORE_TERMINAL);
      const req = term.get(TERMINAL_ROW_KEY);
      req.onerror = () => fail(req.error ?? new Error('Could not read the receipt counter.'));
      req.onsuccess = () => {
        const terminal = req.result as TerminalRecord | undefined;
        const write = () => {
          // Nothing below awaits: IndexedDB closes a transaction at the first await.
          try { done(writeReservation(tx, a, buildOps, terminal, createdAtClientMs)); }
          catch (e) { fail(new LogicFailure(e instanceof Error ? e : new Error(String(e)))); }
        };
        if (a.kind === 'sale' && !buildOps && terminal) {
          const pointer = tx.objectStore(STORE_META).get(['sale-intent', terminal.storeId, a.receiptId]);
          pointer.onerror = () => fail(pointer.error ?? new Error('Could not read the saved payment intent.'));
          pointer.onsuccess = () => {
            if (pointer.result !== undefined) fail(new LogicFailure(new Error(PAYMENT_ATTEMPT_PENDING)));
            else write();
          };
        } else {
          write();
        }
      };
    });
  } catch (e) {
    if (e instanceof LogicFailure) throw e.inner;
    throw new Error(SALE_NOT_SAVED_MESSAGE);
  }
}

/** Offline sale or void: number + `unsent` event with its full write list in ONE transaction. Any storage failure -> SALE_NOT_SAVED_MESSAGE. */
export function reserveOfflineEvent(a: ReserveOffline): Promise<LedgerEvent> {
  const { buildOps, ...base } = a;
  return reserve(base, buildOps);
}

/** Online sale: number + a `reserved` event (no ops) in one transaction. */
export function reserveOnlineEvent(a: ReserveOnline): Promise<LedgerEvent> {
  return reserve(a, null);
}

export const PAYMENT_ATTEMPT_PENDING = 'This payment already has a saved attempt. Sync it before taking another payment.';
export const PAYMENT_INTENT_CHANGED = 'This payment differs from the sale already saved on this tablet. Sync it before taking another payment.';

export interface ReserveOfflineSaleIntent extends ReserveOffline {
  kind: 'sale';
  storeId: string;
  intentFingerprint: string;
}

/**
 * T-458: the receipt intent, complete event and counter commit together. Pointer reads serialize with
 * writes, including across tabs. A pointer outlives pruning as a small tombstone; it never means absence.
 * Old ledger rows are checked before creating the first pointer, never silently adopted as an equal sale.
 */
export async function reserveOfflineSaleIntent(a: ReserveOfflineSaleIntent): Promise<{ event: LedgerEvent; created: boolean }> {
  const createdAtClientMs = a.createdAtClientMs ?? Date.now();
  try {
    return await inTerminalTransaction([STORE_TERMINAL, STORE_EVENTS, STORE_META], 'readwrite', (tx, done, fail) => {
      const termReq = tx.objectStore(STORE_TERMINAL).get(TERMINAL_ROW_KEY);
      const refuse = (message: string) => fail(new LogicFailure(new Error(message)));
      const storageError = () => fail(new Error('Could not read the saved payment intent.'));
      termReq.onerror = storageError;
      termReq.onsuccess = () => {
        const terminal = termReq.result as TerminalRecord | undefined;
        if (terminal && terminal.storeId !== a.storeId) {
          refuse('This terminal belongs to another store. Set up this store before taking payment.');
          return;
        }
        const meta = tx.objectStore(STORE_META);
        const events = tx.objectStore(STORE_EVENTS);
        const intentKey = ['sale-intent', a.storeId, a.receiptId];
        const create = () => {
          try {
            const event = writeReservation(tx, a, a.buildOps, terminal, createdAtClientMs, a.intentFingerprint);
            meta.put([event.deviceId, event.terminalSeq], intentKey);
            done({ event, created: true });
          } catch (e) { fail(new LogicFailure(e instanceof Error ? e : new Error(String(e)))); }
        };
        const pointerReq = meta.get(intentKey);
        pointerReq.onerror = storageError;
        pointerReq.onsuccess = () => {
          if (pointerReq.result !== undefined) {
            const eventReq = events.get(pointerReq.result as IDBValidKey);
            eventReq.onerror = storageError;
            eventReq.onsuccess = () => {
              const event = eventReq.result as LedgerEvent | undefined;
              if (!event || event.storeId !== a.storeId || event.receiptId !== a.receiptId || event.kind !== 'sale') {
                refuse(PAYMENT_ATTEMPT_PENDING); return;
              }
              if (event.status === 'skipped') { create(); return; }
              if (!['unsent', 'acknowledged'].includes(event.status) || (event.status === 'unsent' && !event.ops?.length)) {
                refuse(PAYMENT_ATTEMPT_PENDING); return;
              }
              if (event.intentFingerprint !== a.intentFingerprint || event.totalCentavos !== a.totalCentavos ||
                event.linesHash !== a.linesHash || JSON.stringify(event.tenders) !== JSON.stringify(a.tenders)) {
                refuse(PAYMENT_INTENT_CHANGED); return;
              }
              done({ event, created: false });
            };
          } else {
            // Compatibility path runs once per new intent; no global migration or erasure of old history.
            const historyReq = events.getAll();
            historyReq.onerror = storageError;
            historyReq.onsuccess = () => {
              const history = historyReq.result as LedgerEvent[];
              if (history.some(e => e.storeId === a.storeId && e.receiptId === a.receiptId && e.kind === 'sale' && e.status !== 'skipped')) {
                refuse(PAYMENT_ATTEMPT_PENDING); return;
              }
              create();
            };
          }
        };
      };
    });
  } catch (e) {
    if (e instanceof LogicFailure) throw e.inner;
    throw new Error(SALE_NOT_SAVED_MESSAGE);
  }
}

// ---- reading and updating --------------------------------------------------------------------------------------------------------------------
const keyOf = (deviceId: string, terminalSeq: number) => [deviceId, terminalSeq];

function readAll(): Promise<LedgerEvent[]> {
  return inTerminalTransaction<LedgerEvent[]>(STORE_EVENTS, 'readonly', (tx, done, fail) => {
    const req = tx.objectStore(STORE_EVENTS).getAll();
    req.onsuccess = () => done((req.result as LedgerEvent[]) ?? []);
    req.onerror = () => fail(req.error ?? new Error('Could not read the sale ledger.'));
  });
}

const order = (a: LedgerEvent, b: LedgerEvent) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : a.terminalSeq - b.terminalSeq);

export function getEvent(deviceId: string, terminalSeq: number): Promise<LedgerEvent | null> {
  return inTerminalTransaction<LedgerEvent | null>(STORE_EVENTS, 'readonly', (tx, done, fail) => {
    const req = tx.objectStore(STORE_EVENTS).get(keyOf(deviceId, terminalSeq));
    req.onsuccess = () => done((req.result as LedgerEvent | undefined) ?? null);
    req.onerror = () => fail(req.error ?? new Error('Could not read the sale ledger.'));
  });
}

export async function listEvents(): Promise<LedgerEvent[]> {
  return (await readAll()).sort(order);
}

export async function listByStatus(...statuses: LedgerStatus[]): Promise<LedgerEvent[]> {
  return (await listEvents()).filter((e) => statuses.includes(e.status));
}

/** Rows still to send: `unsent` and `stuck` (any kind). */
export async function unsentCount(): Promise<number> {
  return (await readAll()).filter((e) => e.status === 'unsent' || e.status === 'stuck').length;
}

/** Centavos of SALES not yet proven on the server (`unsent` + `stuck`). */
export async function unsentTotalCentavos(): Promise<number> {
  return (await readAll()).filter((e) => e.kind === 'sale' && (e.status === 'unsent' || e.status === 'stuck')).reduce((n, e) => n + e.totalCentavos, 0);
}

/** Read-modify-write of one row in one transaction. `change` returns the new row, or null to leave it alone. Resolves with the stored row (or null). */
function update(deviceId: string, terminalSeq: number, change: (cur: LedgerEvent) => LedgerEvent | null): Promise<LedgerEvent | null> {
  return inTerminalTransaction<LedgerEvent | null>(STORE_EVENTS, 'readwrite', (tx, done, fail) => {
    const store = tx.objectStore(STORE_EVENTS);
    const req = store.get(keyOf(deviceId, terminalSeq));
    req.onerror = () => fail(req.error ?? new Error('Could not read the sale ledger.'));
    req.onsuccess = () => {
      const cur = req.result as LedgerEvent | undefined;
      if (!cur) { done(null); return; }
      const next = change(cur);
      if (!next) { done(cur); return; }
      store.put(next);
      done(next);
    };
  });
}

/** reserved | unsent | skipped -> acknowledged. (`skipped` is allowed: a transaction that really committed is proof, even if a reconcile pass
 *  raced it and wrote `skipped` while it was in flight.) Any other status is left alone. */
export async function markAcknowledged(deviceId: string, terminalSeq: number): Promise<void> {
  await update(deviceId, terminalSeq, (e) =>
    e.status === 'reserved' || e.status === 'unsent' || e.status === 'skipped' ? { ...e, status: 'acknowledged', lastError: null } : null);
}

/** reserved -> skipped (the online transaction failed for good: no money). Drops any ops and keeps the reason. */
export async function markSkipped(deviceId: string, terminalSeq: number, reason?: string): Promise<void> {
  await update(deviceId, terminalSeq, (e) => {
    if (e.status !== 'reserved') return null;
    const { ops: _ops, ...rest } = e;
    return { ...rest, status: 'skipped', lastError: reason ?? null };
  });
}

export async function patchEvent(deviceId: string, terminalSeq: number, patch: Partial<LedgerEvent>): Promise<LedgerEvent> {
  const row = await update(deviceId, terminalSeq, (e) => ({ ...e, ...patch, deviceId: e.deviceId, terminalSeq: e.terminalSeq }));
  if (!row) throw new Error(`No ledger row for terminal sequence ${terminalSeq}.`);
  return row;
}

/** stuck -> unsent with 0 attempts (the manager's Retry). */
export async function retryStuck(deviceId: string, terminalSeq: number): Promise<void> {
  await update(deviceId, terminalSeq, (e) => (e.status === 'stuck' ? { ...e, status: 'unsent', attempts: 0, lastError: null } : null));
}

/** Deletes acknowledged and skipped rows older than 7 days. Never touches unsent, stuck, quarantined, rejected or reserved rows. */
export function pruneLedger(nowMs: number): Promise<number> {
  return inTerminalTransaction<number>(STORE_EVENTS, 'readwrite', (tx, done, fail) => {
    const store = tx.objectStore(STORE_EVENTS);
    const req = store.getAll();
    req.onerror = () => fail(req.error ?? new Error('Could not read the sale ledger.'));
    req.onsuccess = () => {
      const old = ((req.result as LedgerEvent[]) ?? []).filter(
        (e) => (e.status === 'acknowledged' || e.status === 'skipped') && nowMs - e.createdAtClientMs > PRUNE_AFTER_MS,
      );
      for (const e of old) store.delete(keyOf(e.deviceId, e.terminalSeq));
      done(old.length);
    };
  });
}
