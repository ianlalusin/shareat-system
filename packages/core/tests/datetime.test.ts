import { describe, expect, it } from 'vitest';
import { addDays, businessDayRange, parseBusinessDate, type BusinessDate } from '../src/datetime';

/**
 * T-370 S2 (DEF-494) — `parseBusinessDate` accepts only real proleptic-Gregorian dates in years
 * 1900-2999 (`docs/tasks/370-owner-cap-dates.md` §S2 legs C1-C2, and Amendment A2 for the range).
 * Pure unit legs, no DB.
 *
 * The semantic (day-out-of-range / year-out-of-range) refusal's message is
 * `Invalid business date: <value>` — no `JSON.stringify`, no "(expected YYYY-MM-DD)" parenthetical;
 * that parenthetical belongs only to the FORMAT branch (a string failing the `\d{4}-\d{2}-\d{2}`
 * shape check). `2026-00-15`, `2026-13-01` and `2026-01-00` MATCH that shape, so they take the
 * SEMANTIC branch, as do out-of-range years such as `0001-01-01` and `3000-01-01`.
 *
 * Range rationale (A2): below 1582 the zone offset is read from ICU's Julian parts, and near year
 * 9999 `addDays` rolls into expanded-year ISO. Pinning 1900-2999 keeps `addDays` and
 * `businessDayRange` (which builds on the private `zonedMidnightToUtc`) inside the span where they
 * are exact; D1/D2 pin their edges.
 */

const IMPOSSIBLE = ['2026-02-30', '2026-04-31', '2026-02-29', '2100-02-29', '0000-01-01', '0004-02-29', '0001-01-01', '1899-12-31', '3000-01-01'];

describe('C1 — impossible calendar dates and out-of-range years (0004, 0001, 1899, 3000) are refused', () => {
  it.each(IMPOSSIBLE)('%s throws "Invalid business date: <value>" — Mutant: delete the day-of-month check, or the year lower bound (0004/0001/1899 accepted) or upper bound (3000 accepted), red', (value) => {
    expect(() => parseBusinessDate(value), `expected parseBusinessDate(${value}) to throw`).toThrow(`Invalid business date: ${value}`);
  });
});

const REAL = ['1900-01-01', '2999-12-31', '2024-02-29', '2000-02-29', '2026-02-28', '2026-12-31', '2026-01-31', '2026-04-30', '2026-06-30'];

describe('C2 (control) — real calendar dates parse to themselves', () => {
  it.each(REAL)('%s parses unchanged — Mutant: leap rule missing the %%400 clause (2000-02-29 wrongly refused), a range check that is off by one at an edge (1900-01-01 / 2999-12-31 wrongly refused), or a 30-day month capped at 29 (2026-04-30/2026-06-30 wrongly refused)', (value) => {
    expect(parseBusinessDate(value)).toBe(value);
  });
});

describe('C2 extra data point — another %400 case, on the refused side', () => {
  it('1900-02-29 throws (1900 is divisible by 100 but not 400, so not a leap year) — Mutant: leap rule missing the %100 clause, red', () => {
    expect(() => parseBusinessDate('1900-02-29')).toThrow('Invalid business date: 1900-02-29');
  });
});

describe('Format-branch controls (green now and after — genuinely malformed shape, unchanged by this task)', () => {
  const FORMAT_BAD = ['2026-2-05', '2026-02-5', ' 2026-02-05', '2026-02-05 ', '2026-02-05\n', '26-02-05', '2026/02/05'];
  it.each(FORMAT_BAD)('%j is refused (a missing leading zero, whitespace, or the wrong shape entirely)', (value) => {
    expect(() => parseBusinessDate(value)).toThrow(/^Invalid business date:/);
  });

  it('a malformed-shape value gets the FORMAT branch\'s own message (JSON-quoted, with the "(expected YYYY-MM-DD)" hint)', () => {
    expect(() => parseBusinessDate('2026/02/05')).toThrow('Invalid business date: "2026/02/05" (expected YYYY-MM-DD)');
  });
});

describe('Semantic-branch controls (green now and after) — right shape, an out-of-calendar component', () => {
  const SEMANTIC_BAD = ['2026-00-15', '2026-13-01', '2026-01-00'];
  it.each(SEMANTIC_BAD)('%s is refused (month 0/13, or day 0 — these MATCH \\d{4}-\\d{2}-\\d{2}, so they take the semantic branch, not the format one)', (value) => {
    expect(() => parseBusinessDate(value)).toThrow(/^Invalid business date:/);
  });

  it('an impossible-but-well-formed value gets EXACTLY the SEMANTIC branch\'s message (no quotes, no hint) — Mutant: toThrow with a plain string is a substring match and would not catch a hint being ADDED to this branch; anchored to prove neither the quote nor the parenthetical is present', () => {
    expect(() => parseBusinessDate('2026-02-30')).toThrow(/^Invalid business date: 2026-02-30$/);
  });
});

describe('D1 — addDays at the edges of the accepted range', () => {
  it("addDays('1900-01-01', 1) === '1900-01-02' — Mutant: a year-1900 special case (e.g. Date.UTC two-digit mapping) or off-by-one at the lower edge, red", () => {
    expect(addDays('1900-01-01' as BusinessDate, 1)).toBe('1900-01-02');
  });

  it("addDays('2999-12-31', -1) === '2999-12-30' — Mutant: addDays adding days in the wrong direction, or breaking at the upper edge, red", () => {
    expect(addDays('2999-12-31' as BusinessDate, -1)).toBe('2999-12-30');
  });
});

describe('D2 — businessDayRange(...).start is the exact Manila-midnight instant (private zonedMidnightToUtc)', () => {
  it("businessDayRange('1900-03-01').start === '1900-02-28T16:00:00.000Z' — Mutant: a hardcoded or LMT (+08:04) offset, or a wrong-year construction, red", () => {
    expect(businessDayRange('1900-03-01' as BusinessDate).start.toISOString()).toBe('1900-02-28T16:00:00.000Z');
  });

  it("businessDayRange('2026-01-01').start === '2025-12-31T16:00:00.000Z' — Mutant: offset sign flipped (+8h instead of -8h), red", () => {
    expect(businessDayRange('2026-01-01' as BusinessDate).start.toISOString()).toBe('2025-12-31T16:00:00.000Z');
  });
});
