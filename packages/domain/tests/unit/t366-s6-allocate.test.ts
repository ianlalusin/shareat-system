import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { money } from '@shareat/core/money';
import { allocateFifo, type DayOwed } from '../../src/remittance/allocate';

/**
 * T-366 S6 (DEF-398, DEF-399) — `allocateFifo`'s arithmetic and the "record the residual on the
 * last date" rule (bible row 144). `docs/tasks/366-remittance-floats.md` §S6, legs A1-A5.
 *
 * ⛔ TESTER, not BUILDER. HEAD records the variance on the last day FIFO actually TOUCHED
 * (`lastTouched`), not the last day with `owed > 0` — the two agree whenever the handover reaches
 * or exceeds the final owed day (A2, A3), and disagree only at the boundary where it does not
 * (A1). A5 is the honest instrument for DEF-398: every `Number()` comparison here is exact at 2dp
 * (money strings, never floats), so there is no VALUE a mutant could pick to make a red leg — the
 * only provable claim is that the source no longer contains the bare-`Number()` idiom at all.
 */

const day = (salesDayId: string, businessDate: string, owed: string): DayOwed => ({ salesDayId, businessDate, owed: money(owed) });

describe('A1 — the boundary where "last touched" and "last owed" disagree', () => {
  it('[d1 owed 1000, d2 owed 500], handed over 1000: varianceDayId is d2, variance -500.00 — Mutant: varianceDayId stays lastTouched (d1), red at HEAD', () => {
    const days = [day('d1', '2026-01-01', '1000.00'), day('d2', '2026-01-02', '500.00')];
    const result = allocateFifo(days, money('1000.00'));
    expect(result.variance).toBe('-500.00');
    expect(result.varianceDayId, 'HEAD attributes the residual to the last day FIFO touched (d1), not the last day owed (d2)').toBe('d2');
    expect(result.allocations).toEqual([{ salesDayId: 'd1', amount: '1000.00' }]);
  });
});

describe('A2 — control: handed over past the boundary, touched and owed agree', () => {
  it('handed over 1200: d1 1000.00, d2 200.00, variance -300.00 on d2 — matches HEAD, the change is limited to the boundary', () => {
    const days = [day('d1', '2026-01-01', '1000.00'), day('d2', '2026-01-02', '500.00')];
    const result = allocateFifo(days, money('1200.00'));
    expect(result.allocations).toEqual([
      { salesDayId: 'd1', amount: '1000.00' },
      { salesDayId: 'd2', amount: '200.00' },
    ]);
    expect(result.variance).toBe('-300.00');
    expect(result.varianceDayId).toBe('d2');
  });
});

describe('A3 — an overage lands on the last owed day', () => {
  it('handed over 1600: variance +100.00 on d2', () => {
    const days = [day('d1', '2026-01-01', '1000.00'), day('d2', '2026-01-02', '500.00')];
    const result = allocateFifo(days, money('1600.00'));
    expect(result.variance).toBe('100.00');
    expect(result.varianceDayId).toBe('d2');
  });
});

describe('A4 — a zero-owed day between two owed days is skipped', () => {
  it('[d1 owed 500, d2 owed 0, d3 owed 300], handed over 900: d2 gets no allocation, variance +100.00 on d3', () => {
    const days = [day('d1', '2026-01-01', '500.00'), day('d2', '2026-01-02', '0.00'), day('d3', '2026-01-03', '300.00')];
    const result = allocateFifo(days, money('900.00'));
    expect(result.allocations).toEqual([
      { salesDayId: 'd1', amount: '500.00' },
      { salesDayId: 'd3', amount: '300.00' },
    ]);
    expect(result.allocations.some((a) => a.salesDayId === 'd2')).toBe(false);
    expect(result.variance).toBe('100.00');
    expect(result.varianceDayId, 'the last day with owed > 0, skipping the zero-owed d2').toBe('d3');
  });
});

describe('A5 — source ratchet: allocate.ts contains no bare Number()', () => {
  it('DEF-398 is exact-at-2dp; the honest proof is that the idiom is gone from the source, not a value a mutant could fail on — Mutant: any Number( reintroduced, red at HEAD', () => {
    const path = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'src', 'remittance', 'allocate.ts');
    const source = readFileSync(path, 'utf8');
    expect(source, 'today: allocate.ts still compares with bare Number() at :65,:66,:68,:75,:88').not.toMatch(/Number\(/);
  });
});

describe('A6 — an empty day list: pure overage, nowhere to attribute it', () => {
  it('allocateFifo([], 500.00): no allocations, variance +500.00, varianceDayId null — Mutant: the days.at(-1) fallback reaching past an empty array, red at HEAD', () => {
    const result = allocateFifo([], money('500.00'));
    expect(result.allocations).toEqual([]);
    expect(result.variance).toBe('500.00');
    expect(result.varianceDayId, 'no days at all — there is no last day to fall back to').toBeNull();
  });
});

describe('A7 — every day already settled (owed 0.00), but the handover is still positive', () => {
  it('[d1 owed 0, d2 owed 0], handed over 300.00: variance +300.00, varianceDayId falls back to the LAST day in list order (d2) — Mutant: dropping the days.at(-1) fallback (varianceDayId stays null), red at HEAD', () => {
    const days = [day('d1', '2026-01-01', '0.00'), day('d2', '2026-01-02', '0.00')];
    const result = allocateFifo(days, money('300.00'));
    expect(result.allocations).toEqual([]);
    expect(result.variance).toBe('300.00');
    expect(result.varianceDayId, 'nothing owed anywhere — lastOwedDayId stays null, so this is the days.at(-1) fallback, not the main rule').toBe('d2');
  });
});
