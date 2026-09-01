import { describe, expect, it } from 'vitest';
import { parseIntList } from '../src/app/settings/attendance/lib';

/**
 * T-201. The one piece of new parsing logic in the settings screen — everything else is either
 * `supersedeConfig` (already tested) or a straight pass-through. `allowedShiftStartHours` and
 * `payoutDays` are both comma-typed by a person, so this is the only place a stray space or a
 * repeated value gets cleaned up before it reaches the DB's own CHECK.
 */
describe('parseIntList', () => {
  it('splits on commas and parses each as an integer', () => {
    expect(parseIntList('9,10,11,14')).toEqual([9, 10, 11, 14]);
  });

  it('trims whitespace around each entry', () => {
    expect(parseIntList('9, 10,  11')).toEqual([9, 10, 11]);
  });

  it('sorts ascending regardless of input order', () => {
    expect(parseIntList('14,9,11')).toEqual([9, 11, 14]);
  });

  it('de-duplicates', () => {
    expect(parseIntList('9,9,10')).toEqual([9, 10]);
  });

  it('drops empty entries from trailing/doubled commas', () => {
    expect(parseIntList('9,,10,')).toEqual([9, 10]);
  });

  it('drops non-numeric tokens rather than throwing — the DB CHECK is the real gate', () => {
    expect(parseIntList('9,abc,10')).toEqual([9, 10]);
  });

  it('returns an empty array for a blank string', () => {
    expect(parseIntList('')).toEqual([]);
    expect(parseIntList('   ')).toEqual([]);
  });
});
