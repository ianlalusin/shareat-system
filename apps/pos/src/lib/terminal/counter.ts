/**
 * T-423 S2 - the per-tablet receipt counter (Rulings 4 and 5).
 * One row in native IndexedDB (never localStorage, row 276): { storeId, terminalNo, deviceId, nextSeq }.
 * `reserveNext()` resolves only after its IndexedDB transaction COMPLETED, so a crash can skip a number but never reuse one.
 * `indexedDB` is read lazily at call time so tests can install a fake.
 */

import { STORE_TERMINAL, inTerminalTransaction } from './db';

export const MAX_TERMINAL_SEQ = 999_999;

export interface TerminalRecord {
  storeId: string;
  terminalNo: number;
  deviceId: string;
  nextSeq: number;
}

export interface ReservedNumber {
  storeId: string;
  terminalNo: number;
  deviceId: string;
  terminalSeq: number;
}

export const TERMINAL_NOT_CLAIMED_MESSAGE = "Connect to the internet and set up this tablet's terminal number in Settings.";

export class TerminalNotClaimedError extends Error {
  constructor() {
    super(TERMINAL_NOT_CLAIMED_MESSAGE);
    this.name = 'TerminalNotClaimedError';
  }
}

const ROW_KEY = 'current';

/** Uppercase, everything outside A-Z0-9 removed ('' for nullish). */
export function normalizeStoreCode(code: string | null | undefined): string {
  return String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** `<STORECODE>-<TT>-<NNNNNN>`; throws on an empty code, a bad terminal number or an out-of-range sequence. */
export function formatTerminalReceiptNumber(storeCode: string, terminalNo: number, seq: number): string {
  const code = normalizeStoreCode(storeCode);
  if (!code) throw new Error('This store has no code, so a receipt number cannot be made. Set the store code first.');
  if (!Number.isInteger(terminalNo) || terminalNo < 1 || terminalNo > 99) throw new Error(`Terminal number must be 1 to 99, got ${terminalNo}.`);
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_TERMINAL_SEQ) throw new Error(`Receipt sequence must be 1 to ${MAX_TERMINAL_SEQ}, got ${seq}.`);
  return `${code}-${String(terminalNo).padStart(2, '0')}-${String(seq).padStart(6, '0')}`;
}

/**
 * Runs `work` inside ONE transaction over the terminal store and settles only after the transaction's `complete` (or `abort`) event.
 * `work` calls `done(value)` / `fail(error)` to choose the outcome; a `fail` aborts, so the stored data is untouched.
 * The database is opened through the shared opener (T-425: the version and upgrade live in `db.ts`).
 */
function inTransaction<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, done: (v: T) => void, fail: (e: Error) => void) => void,
): Promise<T> {
  return inTerminalTransaction<T>(STORE_TERMINAL, mode, (tx, done, fail) => work(tx.objectStore(STORE_TERMINAL), done, fail));
}

/** Writes THE record (the store holds exactly one row). Resolves after the transaction completed. */
export function saveTerminalClaim(rec: TerminalRecord): Promise<void> {
  const row: TerminalRecord = { storeId: rec.storeId, terminalNo: rec.terminalNo, deviceId: rec.deviceId, nextSeq: rec.nextSeq };
  return inTransaction<void>('readwrite', (store, done) => {
    store.put(row, ROW_KEY);
    done(undefined);
  });
}

export function readTerminal(): Promise<TerminalRecord | null> {
  return inTransaction<TerminalRecord | null>('readonly', (store, done, fail) => {
    const req = store.get(ROW_KEY);
    req.onsuccess = () => done((req.result as TerminalRecord | undefined) ?? null);
    req.onerror = () => fail(req.error ?? new Error('Could not read the receipt counter.'));
  });
}

/** The counter row's key in the `terminal` store (the ledger reserves a number in the same transaction, T-425). */
export const TERMINAL_ROW_KEY = ROW_KEY;

/**
 * Pure: what reserving the next number does to the stored row. Throws TerminalNotClaimedError (no row) or the plain
 * "used all of its numbers" error, changing nothing. Shared by `reserveNext` and the ledger's one-transaction reservation.
 */
export function planReservation(rec: TerminalRecord | undefined): { next: TerminalRecord; reserved: ReservedNumber } {
  if (!rec) throw new TerminalNotClaimedError();
  if (!Number.isInteger(rec.nextSeq) || rec.nextSeq < 1 || rec.nextSeq > MAX_TERMINAL_SEQ) {
    throw new Error('This terminal has used all of its receipt numbers. Ask a manager to move this tablet to a new terminal number.');
  }
  return {
    next: { ...rec, nextSeq: rec.nextSeq + 1 },
    reserved: { storeId: rec.storeId, terminalNo: rec.terminalNo, deviceId: rec.deviceId, terminalSeq: rec.nextSeq },
  };
}

/**
 * Hands out `nextSeq` and stores `nextSeq + 1` in one readwrite transaction; resolves only after it completed.
 * Rejects TerminalNotClaimedError with no record, and (changing nothing) past MAX_TERMINAL_SEQ.
 */
export function reserveNext(): Promise<ReservedNumber> {
  return inTransaction<ReservedNumber>('readwrite', (store, done, fail) => {
    const req = store.get(ROW_KEY);
    req.onerror = () => fail(req.error ?? new Error('Could not read the receipt counter.'));
    req.onsuccess = () => {
      try {
        const plan = planReservation(req.result as TerminalRecord | undefined);
        store.put(plan.next, ROW_KEY);
        done(plan.reserved);
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)));
      }
    };
  });
}
