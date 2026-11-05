/**
 * T-511 S5b FIXER (2026-11-05) - audit findings P2-1 (tolerance only on a final loan's own deduction), P2-2 (the day-by-day replay was quadratic) and
 * P3-10 (a file that takes more than a final loan still owes gets its own sentence). The expected answers are worked by hand, never read from the code.
 *
 * ALLOCATION NOTE for P2-1: a final loan's own deduction may be one centavo short (Grab shortens a last payment). That centavo is looked for ON THE FINAL LOAN:
 * when the files fall one centavo short, the final loan is the one filled one centavo less, never an ordinary loan.
 */
import { describe, expect, it } from 'vitest';
import { fromCentavos, money, toCentavos } from '@shareat/core/money';
import { checkLoanDay, loanCheckFromContext, type LoanCheckContext, type LoanCheckResult } from '../../src/settlement-intake/loan-check';

const LIPA = { storeId: '10000000-0000-4000-8000-00000000a001', storeName: 'Lipa' };
const MALVAR = { storeId: '10000000-0000-4000-8000-00000000a002', storeName: 'Malvar' };
const BANAY = { storeId: '10000000-0000-4000-8000-00000000a003', storeName: 'Banay-banay' };
const A_ID = '20000000-0000-4000-8000-00000000b001';
const B_ID = '20000000-0000-4000-8000-00000000b002';
const all = new Set([LIPA.storeId, MALVAR.storeId, BANAY.storeId]);

const loan = (id: string, over: Record<string, unknown> = {}) => ({
  loanId: id, name: `Loan ${id.slice(-1)}`, ownerStoreId: LIPA.storeId, ownerStoreName: 'Lipa', startDate: '2026-05-11',
  repaymentAmount: money('1000.00'), outstandingBefore: money('50000.00'), ...over,
});
const row = (key: string, store: { storeId: string }, amount: string, loanId: string | null = null) => ({ key, storeId: store.storeId, amount: money(amount), loanId });
const day = (over: Record<string, unknown>) => ({ salesDate: '2026-10-14', loans: [], rows: [], storesNeedingFile: [], storesWithFile: all, ...over }) as never;

/** every row's pieces add up to the row: an allocation never invents or loses a centavo */
const rowTotalsHold = (r: LoanCheckResult, rows: { key: string; amount: string }[]) => {
  for (const x of rows) {
    const got = r.allocations.filter((a) => a.rowKey === x.key).reduce((t, a) => t + toCentavos(a.amount), 0n);
    expect(got, x.key).toBe(toCentavos(money(x.amount)));
  }
};

describe('P2-1 the 0.01 tolerance belongs to a final loan alone', () => {
  // loan A: ordinary, 1,000.00 a day. loan B: on its last payment, 500.00 left (repayment 600.00)
  const loans = () => [loan(A_ID, { startDate: '2026-05-11' }), loan(B_ID, { startDate: '2026-06-01', repaymentAmount: money('600.00'), outstandingBefore: money('500.00') })];

  it('a centavo short on the ORDINARY loan is a mismatch even though another loan is final: the final loan took all of its own amount (pinned) [kills: tolerance applied to the whole day]', () => {
    const r = checkLoanDay(day({ loans: loans(), rows: [row('a', LIPA, '999.99'), row('b', LIPA, '500.00', B_ID)] }));
    expect(r.status).toBe('mismatch');
    expect(r.blocking).toBe(true);
    expect(r.byLoan.find((l) => l.loanId === A_ID)).toMatchObject({ allocated: '999.99', expected: '1000.00', final: false });
  });

  it('the other way round (A pinned exact, B pinned one centavo short): the FINAL loan is short, which is allowed: ok [kills: tolerance refused to the loan that owns it]', () => {
    const r = checkLoanDay(day({ loans: loans(), rows: [row('a', LIPA, '1000.00', A_ID), row('b', LIPA, '499.99', B_ID)] }));
    expect(r.status).toBe('ok');
    expect(r.byLoan.find((l) => l.loanId === B_ID)).toMatchObject({ allocated: '499.99', expected: '500.00', final: true });
  });

  it('un-pinned rows 999.99 + 500.00: the missing centavo is the final loan\'s (A 1,000.00, B 499.99): ok, and every row still adds up [kills: the centavo left on the ordinary loan]', () => {
    const rows = [row('a', LIPA, '999.99'), row('b', LIPA, '500.00')];
    const r = checkLoanDay(day({ loans: loans(), rows }));
    expect(r.status).toBe('ok');
    expect(r.byLoan.map((l) => [l.loanId, l.allocated])).toEqual([[A_ID, '1000.00'], [B_ID, '499.99']]);
    rowTotalsHold(r, [{ key: 'a', amount: '999.99' }, { key: 'b', amount: '500.00' }]);
  });

  it('two centavos short is a mismatch on a final day [kills: tolerance wider than 0.01]', () => {
    const r = checkLoanDay(day({ loans: loans(), rows: [row('a', LIPA, '999.98'), row('b', LIPA, '500.00')] }));
    expect(r.total).toBe('1499.98');
    expect(r.status).toBe('mismatch');
  });

  it('the final loan YOUNGER than the ordinary one and the files one centavo short: ok; two short: mismatch, and the ordinary loan is never the short one', () => {
    const young = [loan(A_ID, { startDate: '2026-05-11' }), loan(B_ID, { startDate: '2026-09-01', repaymentAmount: money('600.00'), outstandingBefore: money('500.00') })];
    expect(checkLoanDay(day({ loans: young, rows: [row('a', LIPA, '1499.99')] })).status).toBe('ok');
    const two = checkLoanDay(day({ loans: young, rows: [row('a', LIPA, '1499.98')] }));
    expect(two.status).toBe('mismatch');
    expect(two.byLoan.find((l) => l.loanId === A_ID)).toMatchObject({ allocated: '1000.00' });
  });

  it('a final loan that takes MORE than it owes is a mismatch (surplus never allowed) [kills: surplus swallowed by the tolerance]', () => {
    const r = checkLoanDay(day({ loans: loans(), rows: [row('a', LIPA, '1000.00', A_ID), row('b', LIPA, '500.01', B_ID)] }));
    expect(r.status).toBe('mismatch');
  });

  it('27 Oct, the October case: 2,363.11 against 2,363.12 passes only because the first loan is on its last payment; rows add up; the first loan carries the missing centavo [kills: October broken by the per-loan rule]', () => {
    const l1 = loan(A_ID, { startDate: '2026-05-11', repaymentAmount: money('591.24'), outstandingBefore: money('591.24') });
    const l2 = loan(B_ID, { startDate: '2026-10-12', repaymentAmount: money('1771.88'), outstandingBefore: money('140000.00') });
    const rows = [row('a', LIPA, '1235.02'), row('b', LIPA, '591.23'), row('c', MALVAR, '536.86')];
    const r = checkLoanDay(day({ salesDate: '2026-10-27', loans: [l1, l2], rows }));
    expect(r.status).toBe('ok');
    expect(r.byLoan.map((l) => [l.loanId, l.allocated, l.expected, l.final])).toEqual([[A_ID, '591.23', '591.24', true], [B_ID, '1771.88', '1771.88', false]]);
    expect(r.sentence).toBe('Grab loan check, all stores together: 2,363.11 matches (last payment, rounded by Grab)');
    rowTotalsHold(r, rows.map((x) => ({ key: x.key, amount: x.amount })));
    // one centavo of principal more is not final any more: the same files fail
    const past = checkLoanDay(day({ salesDate: '2026-10-27', loans: [loan(A_ID, { repaymentAmount: money('591.24'), outstandingBefore: money('591.26') }), l2], rows }));
    expect(past.status).toBe('mismatch');
  });

  it('a final day whose files take exactly what is expected is unchanged: no sliver lines, the allocation is the plain oldest-first one [kills: needless split lines on an exact day]', () => {
    const l1 = loan(A_ID, { startDate: '2026-05-11', repaymentAmount: money('591.24'), outstandingBefore: money('591.24') });
    const l2 = loan(B_ID, { startDate: '2026-10-12', repaymentAmount: money('1771.88'), outstandingBefore: money('140000.00') });
    const r = checkLoanDay(day({ salesDate: '2026-10-27', loans: [l1, l2], rows: [row('a', LIPA, '591.24'), row('b', LIPA, '1771.88')] }));
    expect(r.status).toBe('ok');
    expect(r.allocations).toEqual([{ rowKey: 'a', loanId: A_ID, amount: '591.24' }, { rowKey: 'b', loanId: B_ID, amount: '1771.88' }]);
  });
});

describe('P3-10 a file that takes more than a final loan still owes', () => {
  it('one centavo more than the last payment owes: blocks, in words about the loan owing less, not "No matching loan recorded" [kills: the misleading sentence]', () => {
    const l1 = loan(A_ID, { repaymentAmount: money('591.24'), outstandingBefore: money('591.24') });
    const r = checkLoanDay(day({ salesDate: '2026-10-27', loans: [l1], rows: [row('a', LIPA, '591.25')] }));
    expect(r.blocking).toBe(true);
    expect(r.sentence).not.toMatch(/No matching loan/i);
    expect(r.sentence).toMatch(/0\.01 more than the loan still owes/);
  });

  it('with no loan recorded at all the old sentence stays [kills: the new sentence used for a missing loan]', () => {
    const r = checkLoanDay(day({ rows: [row('a', LIPA, '591.24')] }));
    expect(r.sentence).toMatch(/No matching loan recorded for 591\.24/);
  });
});

/* ------------------------------------------------------------------ P2-2 */

/** The pre-fix per-day replay, kept here as the oracle: every earlier day is re-worked for each date asked. */
function replayOracle(ctx: LoanCheckContext, salesDate: string, needing: { storeIds: readonly { storeId: string; storeName: string }[]; withFile: ReadonlySet<string> }): LoanCheckResult {
  const toRow = (r: LoanCheckContext['rows'][number]) => ({ key: r.key, storeId: r.storeId, amount: r.amount, loanId: r.loanId });
  const openOn = (pending: ReadonlyMap<string, bigint>) =>
    ctx.loans.map((l) => {
      const left = toCentavos(ctx.outstanding.get(l.id)!) - (pending.get(l.id) ?? 0n);
      return {
        loanId: l.id, name: l.name, ownerStoreId: l.storeId, ownerStoreName: ctx.storeNames.get(l.storeId) ?? 'a store', startDate: l.startDate,
        repaymentAmount: l.repaymentAmount === null ? null : money(l.repaymentAmount), outstandingBefore: fromCentavos(left < 0n ? 0n : left),
      };
    });
  const pending = new Map<string, bigint>();
  const earlier = [...new Set(ctx.rows.filter((r) => r.salesDate.localeCompare(salesDate) < 0).map((r) => r.salesDate))].sort();
  for (const d of earlier) {
    const rows = ctx.rows.filter((r) => r.salesDate === d);
    const r = checkLoanDay({ salesDate: d, loans: openOn(pending), rows: rows.map(toRow), storesNeedingFile: [], storesWithFile: new Set() });
    const pendingKeys = new Set(rows.filter((x) => x.reviewState === 'pending').map((x) => x.key));
    for (const a of r.allocations) if (pendingKeys.has(a.rowKey)) pending.set(a.loanId, (pending.get(a.loanId) ?? 0n) + toCentavos(a.amount));
  }
  const rows = ctx.rows.filter((r) => r.salesDate === salesDate).map(toRow);
  return checkLoanDay({ salesDate, loans: openOn(pending), rows, storesNeedingFile: needing.storeIds, storesWithFile: needing.withFile });
}

const iso = (n: number): string => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);
const cents = (n: bigint): string => `${n / 100n}.${String(n % 100n).padStart(2, '0')}`;

/** A world of `days` days, 3 stores, 3 loans (one with no repayment amount), mixed booked / pending / rejected rows, a few admin pins and odd amounts. */
function world(days: number): LoanCheckContext {
  const loans = [
    { id: A_ID, name: 'Loan A', storeId: LIPA.storeId, startDate: '2025-12-01', repaymentAmount: '591.24' },
    { id: B_ID, name: 'Loan B', storeId: MALVAR.storeId, startDate: '2026-01-10', repaymentAmount: '1771.88' },
    { id: '20000000-0000-4000-8000-00000000b003', name: 'Loan C', storeId: BANAY.storeId, startDate: '2026-03-01', repaymentAmount: null },
  ];
  const outstanding = new Map([[A_ID, money('9000.00')], [B_ID, money('90000.00')], [loans[2]!.id, money('5000.00')]]);
  const rows: LoanCheckContext['rows'] = [];
  const states = ['pending', 'pending', 'booked', 'rejected', 'pending'] as const;
  for (let d = 0; d < days; d++) {
    for (const [si, store] of [LIPA, MALVAR, BANAY].entries()) {
      if ((d + si) % 7 === 3) continue; // a store with no file that day
      const base = 59124n + BigInt(((d * 37 + si * 11) % 9) * 13);
      rows.push({
        key: `r-${d}-${si}-a`, dayLineId: `l-${d}-${si}`, storeId: store.storeId, salesDate: iso(d), reviewState: states[(d + si) % states.length]!,
        amount: money(cents(base / (BigInt(si) + 1n))), loanId: d % 11 === 5 && si === 1 ? A_ID : null,
      });
      if (d % 4 === 0) rows.push({ key: `r-${d}-${si}-b`, dayLineId: `l-${d}-${si}`, storeId: store.storeId, salesDate: iso(d), reviewState: states[(d + si) % states.length]!, amount: money(cents(17713n + BigInt(d))), loanId: null });
    }
  }
  return {
    orgId: 'o', throughDate: iso(days), loans: loans as never, outstanding,
    storeNames: new Map([LIPA, MALVAR, BANAY].map((s) => [s.storeId, s.storeName])), rows, answers: new Map(),
  };
}

describe('P2-2 the loan check works the days forward once', () => {
  const needing = { storeIds: [LIPA, MALVAR], withFile: new Set([LIPA.storeId]) };

  it('gives the same answer as the old per-day replay on every date of a 60-day, three-store, three-loan world (booked, rejected, pinned and empty days included) [kills: a forward pass that drifts from the replay]', () => {
    const ctx = world(60);
    for (let d = 0; d <= 60; d++) {
      expect(loanCheckFromContext(ctx, iso(d), needing), iso(d)).toEqual(replayOracle(world(60), iso(d), needing));
    }
  });

  it('asking out of date order, or the same date twice, changes nothing [kills: a cursor that only moves forward]', () => {
    const ctx = world(40);
    for (const d of [30, 5, 39, 5, 0, 22, 40]) expect(loanCheckFromContext(ctx, iso(d), needing), iso(d)).toEqual(replayOracle(world(40), iso(d), needing));
  });

  it('a 365-day list asks for every day in well under the time the replay took (about 6 s on this world, 44 s on a real one, before the fix) [kills: quadratic work]', () => {
    const ctx = world(365);
    const t0 = performance.now();
    let seen = 0;
    for (let d = 0; d <= 365; d++) seen += loanCheckFromContext(ctx, iso(d), needing).allocations.length;
    const ms = performance.now() - t0;
    expect(seen).toBeGreaterThan(0);
    expect(ms).toBeLessThan(2000);
  });
});
