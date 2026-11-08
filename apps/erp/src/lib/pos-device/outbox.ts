/**
 * T-530a — the tablet's **outbox**: the queue of till actions that still have to reach the server.
 *
 * Every write here resolves on the transaction's `complete` event, never on `request.onsuccess`:
 * a resolved promise must mean the row and its counter are on disk. That is why each write is one
 * `readwrite` transaction over the stores it touches — a counter and the row it numbers can never
 * commit apart.
 *
 * ⚠️ The outbox does **not** survive "clear site data" or an uninstall (design §5.4). Nothing here
 * talks to the network; `drain` is handed the caller's `send`.
 */
import {
  COUNTER_NEXT_SEQ,
  COUNTER_NEXT_TERMINAL_SEQ,
  META_STORE,
  OUTBOX_STORE,
  openDeviceDb,
} from './db';
import type {
  DrainReport,
  NewPosEvent,
  PosEvent,
  PosEventKind,
  PosEventResult,
  SendOutcome,
} from './types';

/** The server's protocol limit for one `POST /api/pos/events` batch. */
export const MAX_BATCH_SIZE = 100;

const EVENT_KINDS: readonly PosEventKind[] = [
  'stand.opened',
  'lines.added',
  'heads.set',
  'refill.requested',
  'line.cancelled',
  'discount.added',
  'discount.removed',
  'discount.applied_to_all',
  'session.voided',
  'sale.completed',
];

function asPromise<T>(request: IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error ?? new Error('The device store request failed.'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('The device store transaction was aborted.'));
    tx.onerror = () => reject(tx.error ?? new Error('The device store transaction failed.'));
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Refuses a malformed event **before** anything is written. The server would refuse it too, but a
 * bad row in the outbox would block the queue behind it, so it never gets in.
 */
function assertValidEvent(event: NewPosEvent): void {
  if (!EVENT_KINDS.includes(event.kind)) {
    throw new Error(`Unknown POS event kind: ${String(event.kind)}`);
  }
  if (typeof event.personId !== 'string' || event.personId.trim() === '') {
    throw new Error('A POS event needs a personId.');
  }
  if (typeof event.occurredAtDevice !== 'string' || Number.isNaN(Date.parse(event.occurredAtDevice))) {
    throw new Error('A POS event needs an ISO occurredAtDevice.');
  }
  if (!isPlainRecord(event.payload)) {
    throw new Error('A POS event payload must be a plain object.');
  }
  // Tenancy and pairing are the server's to attach, from the session — never from a device payload.
  if (Object.prototype.hasOwnProperty.call(event.payload, 'storeId')) {
    throw new Error('A POS event payload may not carry storeId.');
  }
  if (Object.prototype.hasOwnProperty.call(event.payload, 'pairingId')) {
    throw new Error('A POS event payload may not carry pairingId.');
  }
}

/**
 * Queues one event and resolves once it and its sequence number are on disk.
 *
 * Two racing calls never share a `seq`: the readwrite transaction that takes the counter is
 * serialised against the next one, so the second reads the value the first wrote.
 */
export async function enqueue(event: NewPosEvent): Promise<PosEvent> {
  assertValidEvent(event);

  const db = await openDeviceDb();
  try {
    const tx = db.transaction([META_STORE, OUTBOX_STORE], 'readwrite');
    const done = transactionDone(tx);
    try {
      const meta = tx.objectStore(META_STORE);
      const outbox = tx.objectStore(OUTBOX_STORE);

      const current = await asPromise<number | undefined>(meta.get(COUNTER_NEXT_SEQ));
      // `nextSeq` is the number to hand out next; absent means the queue has never been used.
      const seq = typeof current === 'number' ? current : 1;
      meta.put(seq + 1, COUNTER_NEXT_SEQ);

      const stored: PosEvent = {
        seq,
        kind: event.kind,
        personId: event.personId,
        occurredAtDevice: event.occurredAtDevice,
        payload: event.payload,
      };
      outbox.put(stored); // may throw synchronously (DataCloneError) after the counter write is queued

      await done;
      return stored;
    } catch (err) {
      // Roll back the queued counter write: otherwise it commits without its event and burns a seq.
      try {
        tx.abort();
      } catch {
        // already finished or aborted
      }
      await done.catch(() => undefined); // consume the abort rejection
      throw err;
    }
  } finally {
    db.close();
  }
}

/**
 * Takes the next receipt number. Never returns the same number twice, even across a reopen, because
 * the counter commits with the read in one transaction.
 */
export async function reserveTerminalSeq(): Promise<number> {
  const db = await openDeviceDb();
  try {
    const tx = db.transaction(META_STORE, 'readwrite');
    const done = transactionDone(tx);
    const meta = tx.objectStore(META_STORE);

    const current = await asPromise<number | undefined>(meta.get(COUNTER_NEXT_TERMINAL_SEQ));
    const next = typeof current === 'number' ? current : 1;
    meta.put(next + 1, COUNTER_NEXT_TERMINAL_SEQ);

    await done;
    return next;
  } finally {
    db.close();
  }
}

/**
 * Raises the two counters above what the server already has, so a reinstalled tablet cannot reuse a
 * number. It only ever raises: a server that is behind never pulls a device's counters back.
 */
export async function resumeAbove(server: { lastSeq: number; lastTerminalSeq: number }): Promise<void> {
  const db = await openDeviceDb();
  try {
    const tx = db.transaction(META_STORE, 'readwrite');
    const done = transactionDone(tx);
    const meta = tx.objectStore(META_STORE);

    const currentSeq = await asPromise<number | undefined>(meta.get(COUNTER_NEXT_SEQ));
    const currentTerminal = await asPromise<number | undefined>(meta.get(COUNTER_NEXT_TERMINAL_SEQ));

    const nextSeq = Math.max(typeof currentSeq === 'number' ? currentSeq : 1, server.lastSeq + 1);
    const nextTerminal = Math.max(
      typeof currentTerminal === 'number' ? currentTerminal : 1,
      server.lastTerminalSeq + 1,
    );
    meta.put(nextSeq, COUNTER_NEXT_SEQ);
    meta.put(nextTerminal, COUNTER_NEXT_TERMINAL_SEQ);

    await done;
  } finally {
    db.close();
  }
}

/** The next `limit` events, oldest first. */
export async function listPending(limit: number): Promise<PosEvent[]> {
  const db = await openDeviceDb();
  try {
    const tx = db.transaction(OUTBOX_STORE, 'readonly');
    const all = await asPromise<PosEvent[]>(tx.objectStore(OUTBOX_STORE).getAll());
    return all.sort((a, b) => a.seq - b.seq).slice(0, Math.max(0, limit));
  } finally {
    db.close();
  }
}

export async function countPending(): Promise<number> {
  const db = await openDeviceDb();
  try {
    const tx = db.transaction(OUTBOX_STORE, 'readonly');
    return await asPromise<number>(tx.objectStore(OUTBOX_STORE).count());
  } finally {
    db.close();
  }
}

/**
 * Applies the server's verdicts.
 *
 * - `applied`, `duplicate`, `conflict`, `quarantined` are finished: the row is deleted.
 * - `retry` is **kept** — the server has not decided, and dropping it would lose the sale.
 * - a seq the server did not mention is **kept** for the same reason.
 */
export async function applyResults(
  results: readonly PosEventResult[],
): Promise<{ removed: number[]; conflicts: PosEventResult[]; retryFrom: number | null }> {
  const removed: number[] = [];
  const conflicts: PosEventResult[] = [];
  let retryFrom: number | null = null;

  for (const result of results) {
    if (result.status === 'retry') {
      if (retryFrom === null) retryFrom = result.seq;
      continue;
    }
    removed.push(result.seq);
    if (result.status === 'conflict') conflicts.push(result);
  }

  if (removed.length > 0) {
    const db = await openDeviceDb();
    try {
      const tx = db.transaction(OUTBOX_STORE, 'readwrite');
      const done = transactionDone(tx);
      const outbox = tx.objectStore(OUTBOX_STORE);
      for (const seq of removed) outbox.delete(seq);
      await done;
    } finally {
      db.close();
    }
  }

  return { removed, conflicts, retryFrom };
}

/** A drain already running. A second call returns **this** promise instead of sending twice. */
let inFlight: Promise<DrainReport> | null = null;

/**
 * Sends pending events, oldest first, in batches of at most 100, until the queue is empty or the
 * server says stop. Every stop keeps whatever the server did not accept.
 */
export function drain(
  send: (events: PosEvent[]) => Promise<SendOutcome>,
  opts?: { batchSize?: number },
): Promise<DrainReport> {
  if (inFlight) return inFlight;
  const running = drainOnce(send, opts).finally(() => {
    inFlight = null;
  });
  inFlight = running;
  return running;
}

async function drainOnce(
  send: (events: PosEvent[]) => Promise<SendOutcome>,
  opts?: { batchSize?: number },
): Promise<DrainReport> {
  const requested = opts?.batchSize ?? MAX_BATCH_SIZE;
  const batchSize = Math.min(Math.max(1, Math.floor(requested)), MAX_BATCH_SIZE);

  let sent = 0;
  let removed = 0;
  let stateVersion: number | null = null;
  const conflicts: PosEventResult[] = [];

  for (;;) {
    const batch = await listPending(batchSize);
    if (batch.length === 0) {
      return { stopped: 'empty', sent, removed, conflicts, stateVersion };
    }

    let outcome: SendOutcome;
    try {
      outcome = await send(batch);
    } catch {
      return { stopped: 'network', sent, removed, conflicts, stateVersion };
    }

    if (outcome.kind === 'http') {
      return { stopped: 'http', status: outcome.status, sent, removed, conflicts, stateVersion };
    }
    if (outcome.kind === 'network') {
      return { stopped: 'network', sent, removed, conflicts, stateVersion };
    }

    stateVersion = outcome.stateVersion;
    const applied = await applyResults(outcome.results);
    sent += batch.length;
    removed += applied.removed.length;
    conflicts.push(...applied.conflicts);

    // A retry, or a short answer, means the server did not decide the rest of this batch: stop and
    // let the next drain pick them up. Continuing would resend events it never judged.
    if (applied.retryFrom !== null || outcome.results.length < batch.length) {
      return { stopped: 'retry', sent, removed, conflicts, stateVersion };
    }
  }
}
