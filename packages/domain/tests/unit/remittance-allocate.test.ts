import { describe, expect, it } from 'vitest';
import { money } from '@shareat/core/money';
import { allocateFifo, type DayOwed } from '../../src/remittance/allocate';

/**
 * T-143 §4 — FIFO allocation. Bible row 144.
 *
 * ⭐ The claim under test is that **"record the shortage on the last date" is not a separate rule
 * but a consequence of paying oldest-first**. If that is true, no test here needs to mention the
 * last date as a special case — the arithmetic puts it there on its own.
 */
describe('allocateFifo', () => {
  const days = (...owed: number[]): DayOwed[] =>
    owed.map((n, i) => ({
      salesDayId: `day-${i + 1}`,
      businessDate: `2026-01-0${i + 1}`,
      owed: money(n.toFixed(2)),
    }));

  it("⭐ Ian's worked example: five days at ₱10,000, ₱46,000 handed over", () => {
    const r = allocateFifo(days(10000, 10000, 10000, 10000, 10000), money('46000.00'));

    expect(r.allocations).toEqual([
      { salesDayId: 'day-1', amount: '10000.00' },
      { salesDayId: 'day-2', amount: '10000.00' },
      { salesDayId: 'day-3', amount: '10000.00' },
      { salesDayId: 'day-4', amount: '10000.00' },
      { salesDayId: 'day-5', amount: '6000.00' }, // ⭐ the partial lands here by arithmetic
    ]);
    expect(r.variance).toBe('-4000.00');
    expect(r.varianceDayId).toBe('day-5');
  });

  it('an exact handover leaves no variance and no day to attribute', () => {
    const r = allocateFifo(days(10000, 10000), money('20000.00'));
    expect(r.allocations).toHaveLength(2);
    expect(r.variance).toBe('0.00');
    // ⚠️ Null on purpose: a zero variance is not a variance, and a row saying so would make the
    // open-items list meaningless.
    expect(r.varianceDayId).toBeNull();
  });

  it('an overage settles every day in full and sits positive on the last', () => {
    const r = allocateFifo(days(10000, 10000), money('21000.00'));
    expect(r.allocations.map((a) => a.amount)).toEqual(['10000.00', '10000.00']);
    expect(r.variance).toBe('1000.00');
    expect(r.varianceDayId).toBe('day-2');
  });

  it('⚠️ never allocates more than a day is owed — the excess is variance, not a bigger day', () => {
    const r = allocateFifo(days(500), money('900.00'));
    expect(r.allocations).toEqual([{ salesDayId: 'day-1', amount: '500.00' }]);
    expect(r.variance).toBe('400.00');
  });

  it('⭐ is ADDITIVE: a day already settled is skipped, not re-paid (row 146)', () => {
    // Day 1 was covered by an earlier batch, so it now owes nothing. Daily remittance is not
    // replaced by batching — a day may be settled by one handover or by three.
    const r = allocateFifo(days(0, 10000, 10000), money('15000.00'));
    expect(r.allocations).toEqual([
      { salesDayId: 'day-2', amount: '10000.00' },
      { salesDayId: 'day-3', amount: '5000.00' },
    ]);
    expect(r.variance).toBe('-5000.00');
    expect(r.varianceDayId).toBe('day-3');
  });

  it('a handover that covers nothing still reports the shortfall', () => {
    const r = allocateFifo(days(10000), money('0.00'));
    expect(r.allocations).toEqual([]);
    expect(r.variance).toBe('-10000.00');
    // Nothing was touched, so the residual falls to the only day in scope.
    expect(r.varianceDayId).toBe('day-1');
  });

  it('no days at all: the whole handover is an overage with nowhere to sit', () => {
    const r = allocateFifo([], money('500.00'));
    expect(r.allocations).toEqual([]);
    expect(r.variance).toBe('500.00');
    // ⛔ The caller must decide, rather than have a day invented here.
    expect(r.varianceDayId).toBeNull();
  });

  it('centavos survive: an odd handover splits without losing a cent', () => {
    const r = allocateFifo(days(1000.33, 1000.33), money('1500.50'));
    const total = r.allocations.reduce((s, a) => s + Number(a.amount), 0);
    expect(total.toFixed(2)).toBe('1500.50');
    expect(r.variance).toBe('-500.16');
  });
});
