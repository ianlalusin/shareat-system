import { describe, expect, it } from 'vitest';
import { fifoOwnerOutstanding, monthlyOwnerFifoDeltas } from '../src/repo/owners';

/**
 * T-370 S1 (DEF-108) — `fifoOwnerOutstanding`, the pure FIFO helper `drawnInWindow` will call.
 * `docs/tasks/370-owner-cap-dates.md` §S1, legs U1-U4 (unit mirrors of O3-O6, plus a reversal of
 * the reclass itself). Pure unit, no DB.
 *
 * ⛔ TESTER, not BUILDER. `fifoOwnerOutstanding` does not exist yet — every leg below fails today
 * on "no matching export" (the right reason for a wholly new symbol; same precedent as T-348 S1's
 * PageDescription reds).
 *
 * R2's taxonomy, as literal line shapes:
 * - `charge(entryId, sourceId, amount, on)` — a debit line, `reversalOf: null`. Owner-origin for
 *   owner O iff `sourceId === O`.
 * - `poolCredit(entryId, sourceId, amount, on)` — a credit line, `reversalOf: null`. Joins the
 *   pool, applied to charges oldest-first regardless of origin.
 * - `reversalCredit(entryId, sourceId, amount, on, reversalOf)` — a credit line naming the ORIGINAL
 *   charge entry it reverses. Reduces ONLY that entry's own remaining charge, never the pool.
 */

interface FifoLine {
  entryId: string;
  reversalOf: string | null;
  sourceId: string | null;
  debit: string;
  credit: string;
  entryDate: string;
  createdAt: string;
  lineId: string;
}

let n = 0;
function charge(entryId: string, sourceId: string, amount: string, on: string): FifoLine {
  return { entryId, reversalOf: null, sourceId, debit: amount, credit: '0.00', entryDate: on, createdAt: `${on}T00:00:00Z`, lineId: `l${++n}` };
}
function poolCredit(entryId: string, sourceId: string | null, amount: string, on: string): FifoLine {
  return { entryId, reversalOf: null, sourceId, debit: '0.00', credit: amount, entryDate: on, createdAt: `${on}T00:00:00Z`, lineId: `l${++n}` };
}
function reversalCredit(entryId: string, sourceId: string | null, amount: string, on: string, reversalOf: string): FifoLine {
  return { entryId, reversalOf, sourceId, debit: '0.00', credit: amount, entryDate: on, createdAt: `${on}T00:00:00Z`, lineId: `l${++n}` };
}

describe('U1 (mirrors O3) — the older owner-origin charge is consumed first', () => {
  it('owner 1000 (01-10) older than staff 600 (01-15); pool credit 1000 -> owner 0.00 — Mutant: staff-first, red', () => {
    const lines: FifoLine[] = [
      charge('e1', 'owner-1', '1000.00', '2026-01-10'),
      charge('e2', 'staff-1', '600.00', '2026-01-15'),
      poolCredit('e3', 'payslip-1', '1000.00', '2026-02-05'),
    ];
    expect(fifoOwnerOutstanding(lines, 'owner-1')).toBe('0.00');
  });
});

describe('U2 (mirrors O4) — the older non-owner charge is consumed first', () => {
  it('staff 600 (01-05) older than owner 1000 (01-10); pool credit 1000 -> owner 600.00 — Mutant: owner-first, red', () => {
    const lines: FifoLine[] = [
      charge('e1', 'staff-1', '600.00', '2026-01-05'),
      charge('e2', 'owner-1', '1000.00', '2026-01-10'),
      poolCredit('e3', 'payslip-1', '1000.00', '2026-02-05'),
    ];
    expect(fifoOwnerOutstanding(lines, 'owner-1')).toBe('600.00');
  });
});

describe('U3 (mirrors O5) — a partial recovery leaves the remainder', () => {
  it('owner 2000; pool credit 500 -> owner 1500.00 — Mutant: all-or-nothing, red', () => {
    const lines: FifoLine[] = [charge('e1', 'owner-1', '2000.00', '2026-01-10'), poolCredit('e2', 'payslip-1', '500.00', '2026-02-05')];
    expect(fifoOwnerOutstanding(lines, 'owner-1')).toBe('1500.00');
  });
});

describe('U4 (mirrors O6) — two owners share one person\'s pool, each sees only its own remainder', () => {
  it('ownerA 1000 (01-10), ownerB 700 (01-12); pool credit 1200 -> A 0.00, B 500.00 — Mutant: whole-balance-per-owner, red', () => {
    const lines: FifoLine[] = [
      charge('eA', 'ownerA', '1000.00', '2026-01-10'),
      charge('eB', 'ownerB', '700.00', '2026-01-12'),
      poolCredit('eR', 'payslip-1', '1200.00', '2026-02-05'),
    ];
    expect(fifoOwnerOutstanding(lines, 'ownerA')).toBe('0.00');
    expect(fifoOwnerOutstanding(lines, 'ownerB')).toBe('500.00');
  });

  it('a reversal of the reclass itself clears it without touching an OLDER staff charge — Mutant: the reversal credit joins the general pool instead of targeting its own entry, red', () => {
    // e0 (staff, 01-01) is OLDER than e1 (owner, 01-10). If the reversal credit on e1 wrongly
    // joined the general FIFO pool instead of targeting e1 specifically, it would apply
    // oldest-first and drain e0 (not owner-origin, so invisible to this assertion either way) then
    // only partially reach e1 — leaving owner-1 at 400.00, not 0.00.
    const lines: FifoLine[] = [
      charge('e0', 'staff-1', '600.00', '2026-01-01'),
      charge('e1', 'owner-1', '1000.00', '2026-01-10'),
      reversalCredit('e2', 'owner-1', '1000.00', '2026-01-11', 'e1'),
    ];
    expect(fifoOwnerOutstanding(lines, 'owner-1')).toBe('0.00');
  });
});

/**
 * A reversal of a reversal (re-reversal) is legitimate — `reverse-entry.ts` invariant 9 — and is
 * reachable via `reverseOwnerEntry`. Each leg below carries a chain A <- B <- C: C undoes B, so A
 * stands again. A helper that only counts one hop (a reversal is applied as-is, its own reversal
 * ignored) mis-states the cap.
 */
function debitReversal(entryId: string, sourceId: string | null, amount: string, on: string, reversalOf: string): FifoLine {
  return { entryId, reversalOf, sourceId, debit: amount, credit: '0.00', entryDate: on, createdAt: `${on}T00:00:00Z`, lineId: `l${++n}` };
}

describe('U5-U9 — a reversal of a reversal restores the charge', () => {
  it('U5: charge A 50,000; B reverses A; C reverses B -> 50000.00 — Mutant: one-hop only (C ignored, B still cancels A), red', () => {
    const lines: FifoLine[] = [
      charge('A', 'owner-1', '50000.00', '2026-01-10'),
      reversalCredit('B', 'owner-1', '50000.00', '2026-01-11', 'A'),
      debitReversal('C', 'owner-1', '50000.00', '2026-01-12', 'B'),
    ];
    expect(fifoOwnerOutstanding(lines, 'owner-1')).toBe('50000.00');
  });

  it('U6: as U5, then a pool credit recovers 20,000 after C -> 30000.00 — Mutant: one-hop only, red', () => {
    const lines: FifoLine[] = [
      charge('A', 'owner-1', '50000.00', '2026-01-10'),
      reversalCredit('B', 'owner-1', '50000.00', '2026-01-11', 'A'),
      debitReversal('C', 'owner-1', '50000.00', '2026-01-12', 'B'),
      poolCredit('P', 'payslip-1', '20000.00', '2026-02-05'),
    ];
    expect(fifoOwnerOutstanding(lines, 'owner-1')).toBe('30000.00');
  });

  it('U7 (control): charge reversed once -> 0.00 — Mutant: reversal ignored, red', () => {
    const lines: FifoLine[] = [
      charge('A', 'owner-1', '50000.00', '2026-01-10'),
      reversalCredit('B', 'owner-1', '50000.00', '2026-01-11', 'A'),
    ];
    expect(fifoOwnerOutstanding(lines, 'owner-1')).toBe('0.00');
  });

  it('U8 (control): charge alone -> 50000.00 — Mutant: charge dropped, red', () => {
    expect(fifoOwnerOutstanding([charge('A', 'owner-1', '50000.00', '2026-01-10')], 'owner-1')).toBe('50000.00');
  });

  it('U9: triple reversal (D reverses C) -> 0.00 — Mutant: fixed two-hop depth, red', () => {
    const lines: FifoLine[] = [
      charge('A', 'owner-1', '50000.00', '2026-01-10'),
      reversalCredit('B', 'owner-1', '50000.00', '2026-01-11', 'A'),
      debitReversal('C', 'owner-1', '50000.00', '2026-01-12', 'B'),
      reversalCredit('D', 'owner-1', '50000.00', '2026-01-13', 'C'),
    ];
    expect(fifoOwnerOutstanding(lines, 'owner-1')).toBe('0.00');
  });
});

describe('U10-U11 — a voided payroll recovery (reversal of a POOL CREDIT) and its re-reversal', () => {
  it('U10 (control): charge 50,000; recovery P 20,000; V voids P -> 50000.00 — Mutant: void ignored (cap stays freed), red', () => {
    const lines: FifoLine[] = [
      charge('A', 'owner-1', '50000.00', '2026-01-10'),
      poolCredit('P', 'payslip-1', '20000.00', '2026-02-05'),
      debitReversal('V', 'payslip-1', '20000.00', '2026-02-06', 'P'),
    ];
    expect(fifoOwnerOutstanding(lines, 'owner-1')).toBe('50000.00');
  });

  it('U11: as U10, then W reverses V (the void is undone, the recovery stands again) -> 30000.00 — Mutant: one-hop only (W ignored, P stays cancelled), red', () => {
    const lines: FifoLine[] = [
      charge('A', 'owner-1', '50000.00', '2026-01-10'),
      poolCredit('P', 'payslip-1', '20000.00', '2026-02-05'),
      debitReversal('V', 'payslip-1', '20000.00', '2026-02-06', 'P'),
      reversalCredit('W', 'payslip-1', '20000.00', '2026-02-07', 'V'),
    ];
    expect(fifoOwnerOutstanding(lines, 'owner-1')).toBe('30000.00');
  });
});

/**
 * Order-independence of `monthlyOwnerFifoDeltas` (auditor follow-up, 2026-09-30): the caller's SQL
 * promises no order, so the function sorts internally. Mutant: drop the internal sort -> the shuffle
 * legs go red.
 */
const SINCE = '2026-03-01';

const byKey = (a: FifoLine, b: FifoLine): number =>
  a.entryDate.localeCompare(b.entryDate) || a.createdAt.localeCompare(b.createdAt) || a.lineId.localeCompare(b.lineId);

const cents = (s: string): bigint => BigInt(Math.round(Number(s) * 100));

/** Independent reference: the pre-optimisation per-line recompute over growing prefixes. */
function referenceDeltas(lines: readonly FifoLine[], ownerId: string, since: string): { lineId: string; delta: bigint }[] {
  const sorted = [...lines].sort(byKey);
  let prefix = sorted.filter((l) => l.entryDate < since);
  let prev = cents(fifoOwnerOutstanding(prefix, ownerId));
  const out: { lineId: string; delta: bigint }[] = [];
  for (const l of sorted.filter((x) => x.entryDate >= since)) {
    prefix = [...prefix, l];
    const next = cents(fifoOwnerOutstanding(prefix, ownerId));
    out.push({ lineId: l.lineId, delta: next - prev });
    prev = next;
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(arr: readonly T[], rnd: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const fmt = (c: number): string => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
const project = (ev: { lineId: string; delta: bigint }[]): string => ev.map((e) => `${e.lineId}:${e.delta}`).join('|');

function randomLedger(rnd: () => number): FifoLine[] {
  const count = 4 + Math.floor(rnd() * 13); // 4..16 lines
  const dates = ['2026-01-10', '2026-02-03', '2026-02-27', '2026-03-01', '2026-03-01', '2026-03-09', '2026-03-20'];
  const sources = ['owner-1', 'owner-1', 'owner-2', 'staff-1'];
  const lines: FifoLine[] = [];
  for (let i = 0; i < count; i++) {
    const on = dates[Math.floor(rnd() * dates.length)]!;
    const hh = String(Math.floor(rnd() * 3)).padStart(2, '0'); // few distinct times -> real ties
    const amount = fmt(100 + Math.floor(rnd() * 200000));
    const isCharge = rnd() < 0.55;
    lines.push({
      entryId: `E${i}`,
      reversalOf: null,
      sourceId: isCharge ? sources[Math.floor(rnd() * sources.length)]! : 'payslip-1',
      debit: isCharge ? amount : '0.00',
      credit: isCharge ? '0.00' : amount,
      entryDate: on,
      createdAt: `${on}T${hh}:00:00Z`,
      lineId: `L${String(i).padStart(4, '0')}`,
    });
  }
  return lines;
}

describe('S1 SHUFFLE — monthlyOwnerFifoDeltas is order-independent and agrees with the per-line recompute', () => {
  it('200 seeded reversal-free ledgers: sorted == 3 shuffles == reference — Mutant: drop the internal sort, red', () => {
    const rnd = mulberry32(370_108);
    let shuffleLegs = 0;
    let nonZero = 0;
    for (let k = 0; k < 200; k++) {
      const ledger = randomLedger(rnd);
      const sorted = [...ledger].sort(byKey);
      const base = monthlyOwnerFifoDeltas(sorted, 'owner-1', SINCE);
      const expected = referenceDeltas(ledger, 'owner-1', SINCE);
      expect(project(base), `ledger ${k} vs reference`).toBe(project(expected));
      const sumBase = base.reduce((s, e) => s + e.delta, 0n);
      expect(sumBase, `ledger ${k} sum`).toBe(expected.reduce((s, e) => s + e.delta, 0n));
      if (sumBase !== 0n) nonZero++;
      for (let s = 0; s < 3; s++) {
        const got = monthlyOwnerFifoDeltas(shuffled(ledger, rnd), 'owner-1', SINCE);
        expect(project(got), `ledger ${k} shuffle ${s}`).toBe(project(base));
        shuffleLegs++;
      }
    }
    expect(shuffleLegs).toBe(600);
    expect(nonZero).toBeGreaterThan(20); // the generator is not vacuous
  });

  it('hand leg 1: the same small ledger in reverse order yields the same deltas', () => {
    const lines: FifoLine[] = [
      charge('e1', 'owner-1', '1000.00', '2026-02-10'),
      charge('e2', 'owner-1', '500.00', '2026-03-02'),
      poolCredit('e3', 'payslip-1', '1200.00', '2026-03-05'),
    ];
    const fwd = monthlyOwnerFifoDeltas(lines, 'owner-1', SINCE);
    const rev = monthlyOwnerFifoDeltas([...lines].reverse(), 'owner-1', SINCE);
    expect(fwd.map((e) => e.delta)).toEqual([50000n, -120000n]);
    expect(rev).toEqual(fwd);
  });

  it('hand leg 2: same-day tie is broken by createdAt, then lineId', () => {
    const mk = (id: string, kind: 'c' | 'p', createdAt: string): FifoLine => ({
      entryId: id,
      reversalOf: null,
      sourceId: kind === 'c' ? 'owner-1' : 'payslip-1',
      debit: kind === 'c' ? '100.00' : '0.00',
      credit: kind === 'p' ? '100.00' : '0.00',
      entryDate: '2026-03-05',
      createdAt,
      lineId: id,
    });
    // Same createdAt: lineId decides. Charge 'a' first -> +100 then -100.
    const chargeFirst = monthlyOwnerFifoDeltas([mk('b', 'p', '2026-03-05T09:00:00Z'), mk('a', 'c', '2026-03-05T09:00:00Z')], 'owner-1', SINCE);
    expect(chargeFirst.map((e) => [e.lineId, e.delta])).toEqual([['a', 10000n], ['b', -10000n]]);
    // Credit 'a' first -> it idles, the charge is fully covered: 0 then 0.
    const creditFirst = monthlyOwnerFifoDeltas([mk('b', 'c', '2026-03-05T09:00:00Z'), mk('a', 'p', '2026-03-05T09:00:00Z')], 'owner-1', SINCE);
    expect(creditFirst.map((e) => [e.lineId, e.delta])).toEqual([['a', 0n], ['b', 0n]]);
    // createdAt outranks lineId: charge has the LATER lineId but the EARLIER createdAt -> charge first.
    const byCreated = monthlyOwnerFifoDeltas([mk('a', 'p', '2026-03-05T10:00:00Z'), mk('b', 'c', '2026-03-05T08:00:00Z')], 'owner-1', SINCE);
    expect(byCreated.map((e) => [e.lineId, e.delta])).toEqual([['b', 10000n], ['a', -10000n]]);
  });
});
