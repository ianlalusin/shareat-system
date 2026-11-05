/**
 * T-511 S3 (C) - tieGrabPayouts: the Grab control total, on the real redacted files.
 * `docs/tasks/511-settlement-upload-s3-spec.md` item 5; numbers from `docs/discovery/grab-foodpanda-settlement-files.md`.
 *
 * SHAPE ASSUMED (the spec says "per payout {...} plus unlistedSettlements" without naming the wrapper): the result is
 * `{ payouts: [...], unlistedSettlements: [...] }`. `payouts` are in any order (the files list the NEWEST payout first, so
 * "the first payout of the month" is found by its dated storeDay, never by index). `unlistedSettlements` may be a list of
 * settlements or of rows; the tests only read `.settlementId` from each entry.
 */
import { describe, expect, it } from 'vitest';
import { add, money, negate, subtract, type Money } from '@shareat/core/money';
import { readGrabTransactions } from '../../src/settlement-intake/grab-transactions';
import { readGrabTransfers } from '../../src/settlement-intake/grab-transfers';
import { tieGrabPayouts } from '../../src/settlement-intake/grab-payouts';
import { dayBefore, fixture, getCell, parseGrab, refusalOf, setCell, toCsv } from './t511-s3-helpers';

interface Payout {
  settlementId: string;
  storeDay: string;
  netTotal: Money;
  rowsTotal: Money | null;
  state: 'tied' | 'differs' | 'waiting_for_rows';
  difference: Money | null;
  rows: { kind: string; subcategory: string | null; total: Money | null; createdOn: { date: string } }[];
}

const STORES = {
  lipa: { tx: 'grab-lipa-oct-transactions.csv', tr: 'grab-lipa-oct-transfers.csv', unlisted: 'SPHD92NH3YXF' },
  malvar: { tx: 'grab-malvar-oct-transactions.csv', tr: 'grab-malvar-oct-transfers.csv', unlisted: 'SPHXDIDXRNAB' },
  banay: { tx: 'grab-banay-oct-transactions.csv', tr: 'grab-banay-oct-transfers.csv', unlisted: 'SPHVUFGNCID5' },
} as const;

const load = (tx: string, tr: string) => ({ tx: readGrabTransactions(fixture(tx)), tr: readGrabTransfers(fixture(tr)) });
const tie = (tx: string, tr: string) => {
  const f = load(tx, tr);
  return tieGrabPayouts(f.tx, f.tr) as { payouts: Payout[]; unlistedSettlements: { settlementId: string }[] };
};
const count = (ps: Payout[], state: string): number => ps.filter((p) => p.state === state).length;
const byDay = (ps: Payout[], day: string): Payout => ps.find((p) => p.storeDay === day) as Payout;

describe('tieGrabPayouts: each October store ties 30 of 31 payouts', () => {
  it.each(Object.entries(STORES))('%s: 31 payouts, 30 tied, 0 differ, and the earliest payout (1 Oct, store-day 30 Sep) waits for rows', (_name, s) => {
    const out = tie(s.tx, s.tr);
    expect(out.payouts).toHaveLength(31);
    expect(count(out.payouts, 'tied')).toBe(30);
    expect(count(out.payouts, 'differs')).toBe(0);
    expect(count(out.payouts, 'waiting_for_rows')).toBe(1);
    const first = byDay(out.payouts, '2026-09-30');
    expect(first.state).toBe('waiting_for_rows');
    expect(first.rows).toHaveLength(0);
  });

  it.each(Object.entries(STORES))('%s: every payout storeDay is its payout date minus one day, and a tied payout has difference 0.00', (_name, s) => {
    const f = load(s.tx, s.tr);
    const out = tieGrabPayouts(f.tx, f.tr) as { payouts: Payout[] };
    for (const t of f.tr.rows as { settlementId: string; payoutDate: { date: string }; netTotal: Money }[]) {
      const p = out.payouts.find((x) => x.settlementId === t.settlementId) as Payout;
      expect(p.storeDay).toBe(dayBefore(t.payoutDate.date));
      expect(p.netTotal).toBe(t.netTotal);
      if (p.state === 'tied') {
        expect(p.rowsTotal).toBe(p.netTotal);
        expect(p.difference).toBe('0.00');
      }
    }
  });

  it.each(Object.entries(STORES))('%s: the processing payout (31 Oct) ties too, its Completed rows add up to its Net Total', (_name, s) => {
    const out = tie(s.tx, s.tr);
    expect(byDay(out.payouts, '2026-10-30').state).toBe('tied');
  });

  it.each(Object.entries(STORES))('%s: the last day\'s orders (31 Oct) have no payout yet and are reported as an unlisted settlement', (_name, s) => {
    const out = tie(s.tx, s.tr);
    expect([...new Set(out.unlistedSettlements.map((u) => u.settlementId))]).toEqual([s.unlisted]);
  });

  it('a settlement that has no Transfers row is not a payout, and a payout with no rows is not a difference', () => {
    const out = tie(STORES.malvar.tx, STORES.malvar.tr);
    expect(out.payouts.some((p) => p.settlementId === STORES.malvar.unlisted)).toBe(false);
    expect(count(out.payouts, 'differs')).toBe(0);
  });
});

describe('tieGrabPayouts: the September file and the seam between months', () => {
  it('Banay 15-30 Sep alone: 16 payouts, 15 tied, the 15 Sep payout waits (its orders are in August), the 30 Sep orders are unlisted', () => {
    const out = tie('grab-banay-sep15-30-transactions.csv', 'grab-banay-sep15-30-transfers.csv');
    expect(out.payouts).toHaveLength(16);
    expect(count(out.payouts, 'tied')).toBe(15);
    expect(byDay(out.payouts, '2026-09-14').state).toBe('waiting_for_rows');
    expect([...new Set(out.unlistedSettlements.map((u) => u.settlementId))]).toEqual(['SPHGC4PVI2LY']);
  });

  it('Banay Sep + Oct together: 47 payouts, 46 tie, only the 15 Sep payout waits, and the 1 Oct payout (2,011.50) ties on the September rows', () => {
    const sepTx = readGrabTransactions(fixture('grab-banay-sep15-30-transactions.csv'));
    const octTx = readGrabTransactions(fixture('grab-banay-oct-transactions.csv'));
    const sepTr = readGrabTransfers(fixture('grab-banay-sep15-30-transfers.csv'));
    const octTr = readGrabTransfers(fixture('grab-banay-oct-transfers.csv'));
    const tx = { ...octTx, rows: [...sepTx.rows, ...octTx.rows], rowCount: sepTx.rowCount + octTx.rowCount, periodFrom: sepTx.periodFrom };
    const tr = { ...octTr, rows: [...sepTr.rows, ...octTr.rows] };
    const out = tieGrabPayouts(tx, tr) as { payouts: Payout[]; unlistedSettlements: { settlementId: string }[] };
    expect(out.payouts).toHaveLength(47);
    expect(count(out.payouts, 'tied')).toBe(46);
    expect(count(out.payouts, 'differs')).toBe(0);
    expect(count(out.payouts, 'waiting_for_rows')).toBe(1);
    expect(byDay(out.payouts, '2026-09-14').state).toBe('waiting_for_rows');
    const seam = byDay(out.payouts, '2026-09-30');
    expect(seam.state).toBe('tied');
    expect(seam.netTotal).toBe('2011.50');
    expect(seam.rowsTotal).toBe('2011.50');
    // Only the 31 Oct orders are still without a payout row.
    expect([...new Set(out.unlistedSettlements.map((u) => u.settlementId))]).toEqual(['SPHVUFGNCID5']);
  });
});

describe('tieGrabPayouts: Lipa and the loan disbursal', () => {
  const lipa = tie(STORES.lipa.tx, STORES.lipa.tr);

  it('the payout dated 13 Oct (store-day 12 Oct) is 154,473.51 and holds one Loan Disbursal of 150,000.00, so its sales part is 4,473.51', () => {
    const p = byDay(lipa.payouts, '2026-10-12');
    expect(p.netTotal).toBe('154473.51');
    expect(p.state).toBe('tied');
    const disbursals = p.rows.filter((r) => r.subcategory === 'Loan Disbursal');
    expect(disbursals).toHaveLength(1);
    expect(disbursals[0]?.kind).toBe('loan');
    expect(disbursals[0]?.total).toBe('150000.00');
    expect(subtract(p.netTotal, money('150000'))).toBe('4473.51');
    expect(p.rows).toHaveLength(21);
  });

  it('the payout dated 12 Oct (store-day 11 Oct) is 4,301.76 with no disbursal', () => {
    const p = byDay(lipa.payouts, '2026-10-11');
    expect(p.netTotal).toBe('4301.76');
    expect(p.rows.some((r) => r.subcategory === 'Loan Disbursal')).toBe(false);
  });

  it('the unlisted 31 Oct orders at Lipa include a loan deduction and add up to 4,561.34', () => {
    const f = load(STORES.lipa.tx, STORES.lipa.tr);
    const unlisted = (f.tx.rows as { settlementId: string | null; total: Money | null; subcategory: string | null }[]).filter((r) => r.settlementId === STORES.lipa.unlisted);
    expect(unlisted).toHaveLength(23);
    expect(unlisted.some((r) => r.subcategory === 'Loan Deduction')).toBe(true);
    expect(add(...unlisted.map((r) => r.total as Money))).toBe('4561.34');
  });
});

describe('tieGrabPayouts: refusals and a payout that differs', () => {
  it('files from different stores are GRAB_MIXED_STORES and the sentence prints no Store ID', async () => {
    const f = load(STORES.lipa.tx, STORES.malvar.tr);
    const r = await refusalOf(() => tieGrabPayouts(f.tx, f.tr));
    expect(r.code).toBe('GRAB_MIXED_STORES');
    expect(r.userMessage).not.toContain(f.tx.storeId);
    expect(r.userMessage).not.toContain(f.tr.storeId);
  });

  it('one changed Total makes exactly that payout "differs", and the difference is exactly the change (1.00)', () => {
    const g = parseGrab(fixture(STORES.malvar.tx));
    // The first Payment row of the 30 Oct payout (Settlement SPH6TEGUMVDI): raise its Total by exactly 1.00.
    const i = g.rows.findIndex((_, k) => getCell(g, k, 'Settlement ID') === 'SPH6TEGUMVDI');
    const original = money(getCell(g, i, 'Total'));
    setCell(g, i, 'Total', add(original, money('1')));
    const tx = readGrabTransactions(toCsv(g));
    const tr = readGrabTransfers(fixture(STORES.malvar.tr));
    const out = tieGrabPayouts(tx, tr) as { payouts: Payout[] };
    expect(count(out.payouts, 'differs')).toBe(1);
    expect(count(out.payouts, 'tied')).toBe(29);
    const p = byDay(out.payouts, '2026-10-29');
    expect(p.settlementId).toBe('SPH6TEGUMVDI');
    expect(p.state).toBe('differs');
    expect(p.netTotal).toBe('2820.00');
    expect(p.rowsTotal).toBe('2821.00');
    // CHOICE: the sign of `difference` is not pinned by the spec; its size is.
    expect(['1.00', '-1.00']).toContain(p.difference);
  });

  it('adding up uses exact decimals: a payout of many rows with cents ties with no rounding drift', () => {
    const out = tie(STORES.lipa.tx, STORES.lipa.tr);
    const big = out.payouts.reduce((a, p) => (p.rows.length > a.rows.length ? p : a));
    expect(big.state).toBe('tied');
    expect(add(...big.rows.map((r) => r.total as Money))).toBe(big.netTotal);
  });
});

describe('Grab company-wide daily loan deduction (summed here by store-day, in the test: production code does not do this)', () => {
  /** Store-day of a loan row = its payout's date minus 1 (by Settlement ID); rows with no payout row yet use their own Created On date. */
  function loanByStoreDay(): Map<string, Money> {
    const totals = new Map<string, Money[]>();
    for (const s of Object.values(STORES)) {
      const f = load(s.tx, s.tr);
      const storeDay = new Map((f.tr.rows as { settlementId: string; payoutDate: { date: string } }[]).map((t) => [t.settlementId, dayBefore(t.payoutDate.date)]));
      for (const r of f.tx.rows as { kind: string; subcategory: string | null; settlementId: string | null; total: Money | null; createdOn: { date: string } }[]) {
        if (r.kind !== 'loan' || r.subcategory !== 'Loan Deduction') continue;
        const day = (r.settlementId && storeDay.get(r.settlementId)) || r.createdOn.date;
        totals.set(day, [...(totals.get(day) ?? []), negate(r.total as Money)]);
      }
    }
    return new Map([...totals].map(([d, v]) => [d, add(...v)]));
  }

  it('591.24 on 1-12 Oct, 2,363.12 on 13-26 Oct, 2,363.11 on 27 Oct, 1,771.88 on 28-31 Oct', () => {
    const got = loanByStoreDay();
    const expected = new Map<string, string>();
    for (let d = 1; d <= 31; d++) {
      const day = `2026-10-${String(d).padStart(2, '0')}`;
      expected.set(day, d <= 12 ? '591.24' : d <= 26 ? '2363.12' : d === 27 ? '2363.11' : '1771.88');
    }
    expect(Object.fromEntries(got)).toEqual(Object.fromEntries(expected));
  });

  it('the payouts the tie reports carry the same loan rows by store-day (1 to 30 Oct; the 31 Oct orders have no payout row yet)', () => {
    const fromTie = new Map<string, Money[]>();
    for (const s of Object.values(STORES)) {
      for (const p of tie(s.tx, s.tr).payouts) {
        for (const r of p.rows) {
          if (r.subcategory === 'Loan Deduction') fromTie.set(p.storeDay, [...(fromTie.get(p.storeDay) ?? []), negate(r.total as Money)]);
        }
      }
    }
    const expected = loanByStoreDay();
    for (let d = 1; d <= 30; d++) {
      const day = `2026-10-${String(d).padStart(2, '0')}`;
      expect(add(...(fromTie.get(day) ?? []))).toBe(expected.get(day));
    }
  });
});
