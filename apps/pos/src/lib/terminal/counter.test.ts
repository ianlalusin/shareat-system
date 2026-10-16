/**
 * T-423 slice T - the per-tablet receipt counter. Ruling 4, Ruling 5, Acceptance 5 (resume, no daily reset), 8.
 *
 * CONTRACT for the builder (S2) - file `apps/pos/src/lib/terminal/counter.ts`, native IndexedDB, no dependency, no localStorage.
 * `indexedDB` is read LAZILY from `globalThis.indexedDB` at call time (never captured at import), so tests install a fake.
 * Exports exactly:
 *   MAX_TERMINAL_SEQ = 999_999
 *   interface TerminalRecord { storeId: string; terminalNo: number; deviceId: string; nextSeq: number }
 *   interface ReservedNumber { storeId: string; terminalNo: number; deviceId: string; terminalSeq: number }
 *   class TerminalNotClaimedError extends Error   - message: "Connect to the internet and set up this tablet's terminal number in Settings."
 *   normalizeStoreCode(code: string | null | undefined): string      - uppercase, everything outside A-Z0-9 removed ('' for nullish)
 *   formatTerminalReceiptNumber(storeCode: string, terminalNo: number, seq: number): string
 *                                                  - `${normalizeStoreCode(code)}-${TT}-${NNNNNN}`, TT 2 digits, NNNNNN 6 digits, zero padded.
 *                                                    THROWS if the normalised code is empty, terminalNo is not an integer 1..99, or seq is
 *                                                    not an integer 1..999999.
 *   saveTerminalClaim(rec: TerminalRecord): Promise<void>  - writes THE record (object store `terminal` holds exactly one row; a second
 *                                                    save replaces it). Resolves only after the IndexedDB transaction COMPLETED.
 *   readTerminal(): Promise<TerminalRecord | null>
 *   reserveNext(): Promise<ReservedNumber>         - in ONE readwrite transaction: read the record, hand out `nextSeq`, store `nextSeq + 1`;
 *                                                    resolves only after that transaction's `complete` event (so a crash can skip a number,
 *                                                    never reuse one). Rejects TerminalNotClaimedError when there is no record; rejects (and
 *                                                    changes nothing) when nextSeq > MAX_TERMINAL_SEQ or the transaction aborts.
 * The object store is named `terminal` (Ruling 5). Its key/keyPath is the builder's choice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIdb, type FakeIdbFactory } from '@/test-helpers/fakeIdb';
import * as counter from '@/lib/terminal/counter';

let idb: FakeIdbFactory;
beforeEach(() => {
  idb = createFakeIdb({ commitDelayMs: 25 });
  vi.stubGlobal('indexedDB', idb);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const claim = (nextSeq = 5, terminalNo = 1) =>
  counter.saveTerminalClaim({ storeId: 'S1', terminalNo, deviceId: 'DEV-A', nextSeq });

describe('formatTerminalReceiptNumber / normalizeStoreCode', () => {
  it('builds <STORECODE>-<TT>-<NNNNNN> and normalises the free-text store code', () => {
    expect(counter.formatTerminalReceiptNumber('SHT', 1, 7)).toBe('SHT-01-000007');
    expect(counter.formatTerminalReceiptNumber('sht-1 ', 12, 123456)).toBe('SHT1-12-123456');
    expect(counter.normalizeStoreCode(' sh-t 01 ')).toBe('SHT01');
    expect(counter.normalizeStoreCode('')).toBe('');
    expect(counter.normalizeStoreCode(null)).toBe('');
  });

  it('matches the receipt pattern from Acceptance 5', () => {
    expect(counter.formatTerminalReceiptNumber('SHT', 3, 999999)).toMatch(/^[A-Z0-9]+-\d{2}-\d{6,}$/);
  });

  it('refuses an empty store code, a bad terminal number and an out-of-range sequence', () => {
    expect(() => counter.formatTerminalReceiptNumber('', 1, 1)).toThrow();
    expect(() => counter.formatTerminalReceiptNumber('---', 1, 1)).toThrow();
    expect(() => counter.formatTerminalReceiptNumber('SHT', 0, 1)).toThrow();
    expect(() => counter.formatTerminalReceiptNumber('SHT', 100, 1)).toThrow();
    expect(() => counter.formatTerminalReceiptNumber('SHT', 1.5, 1)).toThrow();
    expect(() => counter.formatTerminalReceiptNumber('SHT', 1, 0)).toThrow();
    expect(() => counter.formatTerminalReceiptNumber('SHT', 1, 1_000_000)).toThrow();
  });

  it('lexical order equals numeric order (the claim query orders by document id)', () => {
    const seqs = [1, 2, 9, 10, 99, 100, 999, 1000, 99999, 100000, 999999];
    const nums = seqs.map((s) => counter.formatTerminalReceiptNumber('SHT', 1, s));
    expect([...nums].sort()).toEqual(nums);
  });
});

describe('reserveNext', () => {
  it('refuses with the plain message when this tablet has no terminal claim (Ruling 6)', async () => {
    await expect(counter.reserveNext()).rejects.toBeInstanceOf(counter.TerminalNotClaimedError);
    await expect(counter.reserveNext()).rejects.toThrow("Connect to the internet and set up this tablet's terminal number in Settings.");
  });

  it('two payments on one tablet get n and n+1 (Acceptance 5)', async () => {
    await claim(5);
    const a = await counter.reserveNext();
    const b = await counter.reserveNext();
    expect(a).toEqual({ storeId: 'S1', terminalNo: 1, deviceId: 'DEV-A', terminalSeq: 5 });
    expect(b.terminalSeq).toBe(6);
    expect((await counter.readTerminal())?.nextSeq).toBe(7);
  });

  it('resolves only after the transaction COMPLETED: the increment is already committed when the promise settles (kills: return on request.onsuccess)', async () => {
    await claim(5);
    await counter.reserveNext();
    expect(idb.rows('terminal')).toHaveLength(1);
    expect(idb.rows('terminal')[0].nextSeq).toBe(6);
  });

  it('five simultaneous reservations are distinct and gapless', async () => {
    await claim(10);
    const got = await Promise.all([1, 2, 3, 4, 5].map(() => counter.reserveNext()));
    const seqs = got.map((g) => g.terminalSeq).sort((x, y) => x - y);
    expect(seqs).toEqual([10, 11, 12, 13, 14]);
    expect(idb.rows('terminal')[0].nextSeq).toBe(15);
  });

  it('an aborted transaction rejects and hands out nothing (kills: number returned before commit)', async () => {
    await claim(5);
    idb.failNextTransaction();
    await expect(counter.reserveNext()).rejects.toThrow();
    expect(idb.rows('terminal')[0].nextSeq).toBe(5);
    expect((await counter.reserveNext()).terminalSeq).toBe(5); // the failed attempt consumed nothing visible
  });

  it('a "crash" after a reservation never reuses it: a fresh module instance over the same database continues after it', async () => {
    await claim(5);
    expect((await counter.reserveNext()).terminalSeq).toBe(5);
    vi.resetModules();
    const again = await import('@/lib/terminal/counter');
    expect((await again.reserveNext()).terminalSeq).toBe(6);
  });

  it('does not reset daily: the sequence continues across midnight and across days (kills: DEF-587)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T23:59:59+08:00'));
    await claim(1);
    expect((await counter.reserveNext()).terminalSeq).toBe(1);
    vi.setSystemTime(new Date('2026-10-17T00:00:01+08:00'));
    expect((await counter.reserveNext()).terminalSeq).toBe(2);
    vi.setSystemTime(new Date('2026-11-20T09:00:00+08:00'));
    expect((await counter.reserveNext()).terminalSeq).toBe(3);
  });

  it('never touches localStorage (row 276): it works while every localStorage access throws', async () => {
    vi.stubGlobal('localStorage', new Proxy({}, { get() { throw new Error('localStorage must not be used by the terminal counter'); } }));
    await claim(5);
    expect((await counter.reserveNext()).terminalSeq).toBe(5);
    expect(await counter.readTerminal()).toMatchObject({ nextSeq: 6 });
  });

  it('refuses past the 6-digit limit and changes nothing', async () => {
    await claim(999_998);
    expect((await counter.reserveNext()).terminalSeq).toBe(999_998);
    await claim(1_000_000);
    await expect(counter.reserveNext()).rejects.toThrow();
    expect(idb.rows('terminal')[0].nextSeq).toBe(1_000_000);
  });
});

describe('saveTerminalClaim / readTerminal', () => {
  it('keeps exactly one record; a later claim replaces the earlier one', async () => {
    expect(await counter.readTerminal()).toBeNull();
    await claim(5, 1);
    await claim(40, 2);
    expect(idb.rows('terminal')).toHaveLength(1);
    expect(await counter.readTerminal()).toEqual({ storeId: 'S1', terminalNo: 2, deviceId: 'DEV-A', nextSeq: 40 });
  });
});
