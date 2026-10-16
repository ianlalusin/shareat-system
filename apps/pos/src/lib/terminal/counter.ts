/**
 * T-423 S2 - the per-tablet receipt counter (Rulings 4 and 5).
 * One row in native IndexedDB (never localStorage, row 276): { storeId, terminalNo, deviceId, nextSeq }.
 * `reserveNext()` resolves only after its IndexedDB transaction COMPLETED, so a crash can skip a number but never reuse one.
 * `indexedDB` is read lazily at call time so tests can install a fake.
 */

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

const DB_NAME = 'shareat-pos-terminal';
const STORE = 'terminal';
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

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const factory: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!factory) {
      reject(new Error('This device cannot store the receipt counter (no IndexedDB).'));
      return;
    }
    const req = factory.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open the receipt counter.'));
  });
}

/**
 * Runs `work` inside ONE readwrite transaction and settles only after the transaction's `complete` (or `abort`) event.
 * `work` calls `done(value)` / `fail(error)` to choose the outcome; a `fail` leaves the stored data untouched by the caller.
 */
async function inTransaction<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, done: (v: T) => void, fail: (e: Error) => void) => void,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      let outcome: { ok: true; value: T } | { ok: false; error: Error } | null = null;
      const tx = db.transaction(STORE, mode);
      tx.oncomplete = () => {
        if (!outcome) reject(new Error('Receipt counter transaction ended without a result.'));
        else if (outcome.ok) resolve(outcome.value);
        else reject(outcome.error);
      };
      tx.onabort = () => reject(tx.error ?? new Error('Receipt counter transaction was aborted.'));
      tx.onerror = () => { /* the abort event that follows rejects */ };
      try {
        work(tx.objectStore(STORE), (value) => { outcome = { ok: true, value }; }, (error) => { outcome = { ok: false, error }; });
      } catch (e) {
        try { tx.abort(); } catch { /* already finished */ }
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
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

/**
 * Hands out `nextSeq` and stores `nextSeq + 1` in one readwrite transaction; resolves only after it completed.
 * Rejects TerminalNotClaimedError with no record, and (changing nothing) past MAX_TERMINAL_SEQ.
 */
export function reserveNext(): Promise<ReservedNumber> {
  return inTransaction<ReservedNumber>('readwrite', (store, done, fail) => {
    const req = store.get(ROW_KEY);
    req.onerror = () => fail(req.error ?? new Error('Could not read the receipt counter.'));
    req.onsuccess = () => {
      const rec = req.result as TerminalRecord | undefined;
      if (!rec) {
        fail(new TerminalNotClaimedError());
        return;
      }
      if (!Number.isInteger(rec.nextSeq) || rec.nextSeq < 1 || rec.nextSeq > MAX_TERMINAL_SEQ) {
        fail(new Error('This terminal has used all of its receipt numbers. Ask a manager to move this tablet to a new terminal number.'));
        return;
      }
      store.put({ ...rec, nextSeq: rec.nextSeq + 1 }, ROW_KEY);
      done({ storeId: rec.storeId, terminalNo: rec.terminalNo, deviceId: rec.deviceId, terminalSeq: rec.nextSeq });
    };
  });
}
