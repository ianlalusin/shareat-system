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
  META_PAIRING_ID,
  META_STORE,
  OUTBOX_STORE,
  openDeviceDb,
} from './db';
import {
  POS_PAIRING_MISMATCH,
  type DrainReport,
  type NewPosEvent,
  type PosEvent,
  type PosEventKind,
  type PosEventResult,
  type SendOutcome,
} from './types';

/** T-563: said when a till action is queued before the first snapshot told this tablet which pairing it is. */
export const NO_PAIRING_BOUND_MESSAGE = 'This tablet has no pairing on record yet. Connect it to the internet and open the POS once, then sell.';

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

      // T-563: the event is made under the pairing this tablet is bound to right now, read in the same transaction that numbers it.
      const pairingId = await asPromise<string | undefined>(meta.get(META_PAIRING_ID));
      if (typeof pairingId !== 'string' || pairingId === '') throw new Error(NO_PAIRING_BOUND_MESSAGE);

      const current = await asPromise<number | undefined>(meta.get(COUNTER_NEXT_SEQ));
      // `nextSeq` is the number to hand out next; absent means the queue has never been used.
      const seq = typeof current === 'number' ? current : 1;
      meta.put(seq + 1, COUNTER_NEXT_SEQ);

      const stored: PosEvent = {
        seq,
        pairingId,
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
 *
 * T-563: a batch holds events of ONE pairing (the one they were made under), the oldest pairing first. A server answer of 409
 * POS_PAIRING_MISMATCH holds that pairing's events for this drain (they stay in the outbox; the next drain asks again, which is how a pair-back
 * releases them) and the drain goes on to the next pairing. A row with no pairing (made before T-563) is never sent.
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
  const held = new Set<string>();
  const report = (stopped: DrainReport['stopped'], status?: number): DrainReport => ({
    stopped,
    ...(status === undefined ? {} : { status }),
    sent,
    removed,
    conflicts,
    stateVersion,
    heldOrigins: [...held],
  });

  for (;;) {
    const sendable = (await listPending(Number.MAX_SAFE_INTEGER)).filter((e) => typeof e.pairingId === 'string' && !held.has(e.pairingId));
    const first = sendable[0];
    if (!first) return report('empty');
    const origin = first.pairingId;
    const batch = sendable.filter((e) => e.pairingId === origin).slice(0, batchSize);

    let outcome: SendOutcome;
    try {
      outcome = await send(batch);
    } catch {
      return report('network');
    }

    if (outcome.kind === 'http') {
      if (outcome.status === 409 && outcome.code === POS_PAIRING_MISMATCH && origin !== undefined) {
        held.add(origin);
        continue;
      }
      return report('http', outcome.status);
    }
    if (outcome.kind === 'network') return report('network');

    stateVersion = outcome.stateVersion;
    const applied = await applyResults(outcome.results);
    sent += batch.length;
    removed += applied.removed.length;
    conflicts.push(...applied.conflicts);

    // A retry, or a short answer, means the server did not decide the rest of this batch: stop and
    // let the next drain pick them up. Continuing would resend events it never judged.
    if (applied.retryFrom !== null || outcome.results.length < batch.length) return report('retry');
  }
}
