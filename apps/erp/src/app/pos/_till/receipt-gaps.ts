/**
 * T-601 S2 - the receipt numbers missing from a list: per till, every number between that till's lowest and highest that is not present.
 * Pure. ⚠️ A gap is a finding to write down, not proof of a lost sale: a number can be spent by a save that failed (`_payment/logic.ts`), so the screen
 * says "write these down" and never "a sale is missing".
 */
export function missingSeqs(rows: readonly { terminalNo: number; terminalSeq: number }[]): { terminalNo: number; seq: number }[] {
  const byTill = new Map<number, Set<number>>();
  for (const r of rows) {
    const seen = byTill.get(r.terminalNo) ?? new Set<number>();
    seen.add(r.terminalSeq);
    byTill.set(r.terminalNo, seen);
  }
  const missing: { terminalNo: number; seq: number }[] = [];
  for (const [terminalNo, seen] of [...byTill].sort((a, b) => a[0] - b[0])) {
    const seqs = [...seen];
    const lo = Math.min(...seqs);
    const hi = Math.max(...seqs);
    for (let seq = lo + 1; seq < hi; seq += 1) if (!seen.has(seq)) missing.push({ terminalNo, seq });
  }
  return missing;
}
