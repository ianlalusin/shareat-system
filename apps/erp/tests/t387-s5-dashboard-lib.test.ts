import { describe, expect, it } from 'vitest';
import { previousRange } from '../src/app/dashboard/lib';

/**
 * T-387 S5 - `previousRange(from, to)` in `apps/erp/src/app/dashboard/lib.ts`.
 * PINNED: both args and the result are inclusive 'YYYY-MM-DD' business dates; the result is `{ from, to }`
 * with the SAME DAY COUNT as the input, ending the day before `from`. The count is by DAYS, so calendar-month
 * length is irrelevant: a full March (31 days) maps to the 31 days before March 1. Pure UTC date arithmetic.
 * Reversed or malformed input throws.
 */
describe('previousRange', () => {
  it('1-day range -> the day before', () => {
    expect(previousRange('2026-10-11', '2026-10-11')).toEqual({ from: '2026-10-10', to: '2026-10-10' });
  });
  it('7-day range -> the 7 days before', () => {
    expect(previousRange('2026-10-05', '2026-10-11')).toEqual({ from: '2026-09-28', to: '2026-10-04' });
  });
  it('month boundary, by day count: 2026-03-01..2026-03-31 (31 days) -> 2026-01-29..2026-02-28', () => {
    expect(previousRange('2026-03-01', '2026-03-31')).toEqual({ from: '2026-01-29', to: '2026-02-28' });
  });
  it('month-to-date into a shorter month: 2026-03-01..2026-03-10 (10 days) -> 2026-02-19..2026-02-28', () => {
    expect(previousRange('2026-03-01', '2026-03-10')).toEqual({ from: '2026-02-19', to: '2026-02-28' });
  });
  it('year boundary: 2026-01-01..2026-01-07 -> 2025-12-25..2025-12-31', () => {
    expect(previousRange('2026-01-01', '2026-01-07')).toEqual({ from: '2025-12-25', to: '2025-12-31' });
  });
  it('year boundary, 1 day: 2026-01-01 -> 2025-12-31', () => {
    expect(previousRange('2026-01-01', '2026-01-01')).toEqual({ from: '2025-12-31', to: '2025-12-31' });
  });
  it('leap day inside the previous range: 2024-03-01..2024-03-03 -> 2024-02-27..2024-02-29', () => {
    expect(previousRange('2024-03-01', '2024-03-03')).toEqual({ from: '2024-02-27', to: '2024-02-29' });
  });
  it('leap day inside the current range: 2024-02-28..2024-03-01 (3 days) -> 2024-02-25..2024-02-27', () => {
    expect(previousRange('2024-02-28', '2024-03-01')).toEqual({ from: '2024-02-25', to: '2024-02-27' });
  });
  it('non-leap February is 28 days: 2025-02-01..2025-02-28 -> 2025-01-04..2025-01-31', () => {
    expect(previousRange('2025-02-01', '2025-02-28')).toEqual({ from: '2025-01-04', to: '2025-01-31' });
  });
  it('30 days keeps its count: 2026-10-01..2026-10-30 -> 2026-09-01..2026-09-30', () => {
    expect(previousRange('2026-10-01', '2026-10-30')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });
  it('a reversed range (from after to) throws rather than returning a nonsense window', () => {
    expect(() => previousRange('2026-10-11', '2026-10-10')).toThrow();
  });
  it('a malformed or impossible date throws', () => {
    expect(() => previousRange('2026-13-01', '2026-13-02')).toThrow();
    expect(() => previousRange('yesterday', '2026-10-01')).toThrow();
    expect(() => previousRange('2026-02-30', '2026-03-01')).toThrow();
  });
});
