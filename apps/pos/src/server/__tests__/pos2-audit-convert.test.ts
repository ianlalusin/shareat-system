/**
 * T-427 slice T - pos2-audit.mjs changes (Ruling 3 and 7, Acceptance 5).
 *
 * CONTRACT: the audit's decision logic moves into a PURE ES module apps/pos/scripts/pos2-audit-lib.mjs (no firebase, no I/O); pos2-audit.mjs imports it.
 *   classifyConversion(c: { source?: string; status?: string; voidedVia?: string }): string[]
 *       tags: 'foreign'            source is neither 'pos2-correction' nor 'pos2-convert'   (made by v1)
 *             'voidedCorrection'   source 'pos2-correction' and status 'voided'              (existing check 4)
 *             'voidedByV1'         source 'pos2-convert' and status 'voided' and voidedVia !== 'pos2'   (voided from v1's dashboard)
 *       a 'pos2-convert' doc is POS v2's own (not 'foreign'); an active one, or one voided with voidedVia 'pos2', has no tags.
 *   negativeDays(days: { dayId: string; byMethod: Record<string, number> }[], conversions: { id; dayId; source?; status?; fromMethod; toMethod; amount }[]):
 *       { dayId: string; methods: { name: string; total: number }[]; conversionIds: string[] }[]
 *       one entry per day whose FINAL byMethod has a method strictly below zero (what v1-methods.ts:72 refuses), sorted by dayId; methods sorted by name;
 *       conversionIds = ids of the conversions on that day (all sources, any status), sorted. A day lifted above zero by later sales is NOT listed.
 *
 * Path: these tests import it relative to this file. RED: the module does not exist yet.
 * MUTANTS: M1 'pos2-convert' listed as foreign; M2 v1-dashboard voids unnoticed; M3 negativity judged from the warnedNegativeAtWrite flag instead of final totals;
 *   M4 -0.01 or 0 treated wrongly; M5 a recovered day still listed.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain .mjs module without types
import { classifyConversion, negativeDays } from '../../../scripts/pos2-audit-lib.mjs';

describe('classifyConversion', () => {
  it('pos2-convert is POS v2\'s own: active or voided via pos2 -> no tags (M1)', () => {
    expect(classifyConversion({ source: 'pos2-convert', status: 'active' })).toEqual([]);
    expect(classifyConversion({ source: 'pos2-convert', status: 'voided', voidedVia: 'pos2' })).toEqual([]);
  });
  it('a pos2-convert voided without voidedVia pos2 was voided from v1\'s dashboard (M2)', () => {
    expect(classifyConversion({ source: 'pos2-convert', status: 'voided' })).toEqual(['voidedByV1']);
    expect(classifyConversion({ source: 'pos2-convert', status: 'voided', voidedVia: 'v1' })).toEqual(['voidedByV1']);
  });
  it('v1 docs are foreign; a voided correction keeps its own tag', () => {
    expect(classifyConversion({ status: 'active' })).toEqual(['foreign']);
    expect(classifyConversion({ source: 'pos2-correction', status: 'voided' })).toEqual(['voidedCorrection']);
    expect(classifyConversion({ source: 'pos2-correction', status: 'active' })).toEqual([]);
  });
});

describe('negativeDays - from FINAL day totals', () => {
  const conv = (id: string, dayId: string, over: Record<string, unknown> = {}) => ({ id, dayId, source: 'pos2-convert', status: 'active', fromMethod: 'GCash', toMethod: 'Cash', amount: 500, ...over });

  it('lists a day whose final GCash is below zero with its conversions; sorted (M3)', () => {
    const out = negativeDays(
      [{ dayId: '20261015', byMethod: { Cash: 10, GCash: -0.01 } }, { dayId: '20261014', byMethod: { Cash: 1500, GCash: -200, Maya: -5 } }],
      [conv('c2', '20261014'), conv('c1', '20261014', { source: 'pos2-correction' }), conv('c3', '20261015'), conv('other', '20261013')],
    );
    expect(out).toEqual([
      { dayId: '20261014', methods: [{ name: 'GCash', total: -200 }, { name: 'Maya', total: -5 }], conversionIds: ['c1', 'c2'] },
      { dayId: '20261015', methods: [{ name: 'GCash', total: -0.01 }], conversionIds: ['c3'] },
    ]);
  });

  it('drops the day once later sales lift GCash above zero, whatever the conversions say (M5); zero is not negative (M4)', () => {
    const conversions = [conv('c1', '20261014', { warnedNegativeAtWrite: true })];
    expect(negativeDays([{ dayId: '20261014', byMethod: { Cash: 1500, GCash: 300 } }], conversions)).toEqual([]);
    expect(negativeDays([{ dayId: '20261014', byMethod: { Cash: 1500, GCash: 0 } }], conversions)).toEqual([]);
  });

  it('a negative day with no conversion is still listed (the conversions list is empty, not the day)', () => {
    expect(negativeDays([{ dayId: '20261014', byMethod: { GCash: -1 } }], [])).toEqual([{ dayId: '20261014', methods: [{ name: 'GCash', total: -1 }], conversionIds: [] }]);
  });
});
