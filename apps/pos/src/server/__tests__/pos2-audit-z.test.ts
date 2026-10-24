/**
 * T-471 slice T - the detector also lists Z gaps (a zNo missing in the sequence). docs/tasks/471 Acceptance; runbook section 8.
 *
 * CONTRACT: `apps/pos/scripts/pos2-audit-lib.mjs` exports `zGaps(zNos: string[]): string[]` (pure): the zNos ('Z-0001' style) missing between Z-0001 and the
 * highest one present, ascending, in the same style; unreadable entries are ignored; duplicates do not matter; no Zs -> no gaps.
 * And `pos2-audit.mjs` reads `zReadings` read-only and prints them (checked below as source text; there is no live run).
 * RED FOR THE RIGHT REASON: zGaps is not exported yet.
 * MUTANTS: M1 a gap at the start (Z-0001 missing) not listed; M2 only the first gap listed; M3 the audit script writes; M4 the script never reads zReadings.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain .mjs module without types
import { zGaps } from '../../../scripts/pos2-audit-lib.mjs';

describe('zGaps', () => {
  it('lists every missing number up to the highest', () => {
    expect(zGaps(['Z-0001', 'Z-0002', 'Z-0004', 'Z-0007'])).toEqual(['Z-0003', 'Z-0005', 'Z-0006']);
  });
  it('a missing first number counts', () => {
    expect(zGaps(['Z-0003'])).toEqual(['Z-0001', 'Z-0002']);
  });
  it('no gap, no Zs, one Z, duplicates, unreadable entries and order', () => {
    expect(zGaps([])).toEqual([]);
    expect(zGaps(['Z-0001'])).toEqual([]);
    expect(zGaps(['Z-0002', 'Z-0001', 'Z-0002', 'junk', 'Z-0003'])).toEqual([]);
    expect(zGaps(['Z-0004', 'Z-0001', 'garbage'])).toEqual(['Z-0002', 'Z-0003']);
  });
  it('numbers beyond four digits keep the style', () => {
    expect(zGaps(['Z-9999', 'Z-10001'])).toEqual([...Array.from({ length: 9998 }, (_, i) => `Z-${String(i + 1).padStart(4, '0')}`), 'Z-10000']);
  });
});

describe('audit script wiring (source text only)', () => {
  const source = readFileSync(new URL('../../../scripts/pos2-audit.mjs', import.meta.url), 'utf8');
  it('reads zReadings and prints the gaps', () => {
    expect(source).toMatch(/zReadings/);
    expect(source).toMatch(/zGaps/);
    expect(source).toMatch(/Z-reading numbers missing/i);
  });
});
