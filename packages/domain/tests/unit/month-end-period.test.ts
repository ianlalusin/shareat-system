import { describe, expect, it } from 'vitest';
import { isValidPeriod } from '../../src/scheduler';

// DEF-856: `month-end --period=2026-13` used to post depreciation into January 2027.
describe('isValidPeriod', () => {
  it('accepts a real YYYY-MM', () => {
    for (const p of ['2026-01', '2026-09', '2026-12']) expect(isValidPeriod(p)).toBe(true);
  });

  it('refuses a month that does not exist, or a malformed value', () => {
    for (const p of ['2026-13', '2026-00', '2026-1', '26-01', '2026-01-15', '', ' 2026-01'])
      expect(isValidPeriod(p)).toBe(false);
  });
});
