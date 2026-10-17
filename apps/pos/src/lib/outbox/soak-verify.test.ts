/**
 * T-425 slice T - the soak verifier's pure core (Ruling 10; Acceptance 15: "labels a planted skipped number `skipped` and a removed receipt `MISSING`").
 *
 * CONTRACT for the builder (S6) - file `apps/pos/scripts/pos2-soak-verify.mjs` (READ-ONLY against Firestore: no set/update/delete/commit/batch; the CLI
 * lists a terminal's server receipt numbers and the tablet's ledger-skipped numbers it is given). Besides its CLI `main`, it EXPORTS, with no side effect
 * on import (the CLI runs only when the file is the entry point):
 *   classifyTerminalReceipts(i: { receiptNumbers: string[]; skippedSeqs: number[] }):
 *       { first: number | null; last: number | null; present: number; gaps: { terminalSeq: number; label: 'skipped' | 'MISSING' }[]; duplicates: string[] }
 *     - `receiptNumbers` are `<CODE>-<TT>-<NNNNNN>` strings of ONE terminal; the sequence is the trailing number.
 *     - range = lowest to highest sequence seen among receiptNumbers and skippedSeqs (first/last are the lowest/highest PRESENT receipt sequences).
 *     - every sequence in the range with no receipt is a gap: label 'skipped' when it is in skippedSeqs (a `skipped` ledger event exists), else 'MISSING'.
 *     - duplicates = the receipt-number strings that appear more than once (sorted, each listed once).
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const script = path.resolve(__dirname, '..', '..', '..', 'scripts', 'pos2-soak-verify.mjs');
const load = async () => (await import(/* @vite-ignore */ pathToFileURL(script).href)) as { classifyTerminalReceipts: (i: any) => any };
const n = (seq: number) => `SHT-01-${String(seq).padStart(6, '0')}`;

describe('pos2-soak-verify classifyTerminalReceipts (Acceptance 15)', () => {
  it('the script exists', () => { expect(existsSync(script)).toBe(true); });

  it('no gaps and no duplicates for a clean run', async () => {
    const { classifyTerminalReceipts } = await load();
    expect(classifyTerminalReceipts({ receiptNumbers: [1, 2, 3, 4].map(n), skippedSeqs: [] })).toEqual({ first: 1, last: 4, present: 4, gaps: [], duplicates: [] });
  });

  it('labels a planted skipped number `skipped` and a removed receipt `MISSING`', async () => {
    const { classifyTerminalReceipts } = await load();
    const r = classifyTerminalReceipts({ receiptNumbers: [5, 6, 8, 10, 11].map(n), skippedSeqs: [7] });
    expect(r.gaps).toEqual([{ terminalSeq: 7, label: 'skipped' }, { terminalSeq: 9, label: 'MISSING' }]);
    expect(r.first).toBe(5);
    expect(r.last).toBe(11);
    expect(r.present).toBe(5);
  });

  it('reports a duplicate receipt number once, and orders gaps by sequence regardless of input order', async () => {
    const { classifyTerminalReceipts } = await load();
    const r = classifyTerminalReceipts({ receiptNumbers: [n(9), n(2), n(2), n(5), n(5), n(5), n(1)], skippedSeqs: [4, 3] });
    expect(r.duplicates).toEqual([n(2), n(5)]);
    expect(r.gaps).toEqual([{ terminalSeq: 3, label: 'skipped' }, { terminalSeq: 4, label: 'skipped' }, ...[6, 7, 8].map((s) => ({ terminalSeq: s, label: 'MISSING' }))]);
  });

  it('a skipped number beyond the last receipt still extends the range (the tail is explained, not MISSING)', async () => {
    const { classifyTerminalReceipts } = await load();
    const r = classifyTerminalReceipts({ receiptNumbers: [n(1), n(2)], skippedSeqs: [4] });
    expect(r.gaps).toEqual([{ terminalSeq: 3, label: 'MISSING' }, { terminalSeq: 4, label: 'skipped' }]);
  });

  it('an empty terminal is not an error', async () => {
    const { classifyTerminalReceipts } = await load();
    expect(classifyTerminalReceipts({ receiptNumbers: [], skippedSeqs: [] })).toEqual({ first: null, last: null, present: 0, gaps: [], duplicates: [] });
  });
});
