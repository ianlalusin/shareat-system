import { describe, expect, it } from 'vitest';
import { basisWords } from '../src/app/items/price-to-stores';
import { sliceLabourSentence } from '../src/app/inventory/production/lib';

/** T-650 S1 - where a cost came from, said in words; and the one sentence on a slice record's labour. */
describe('T-650 S1 words', () => {
  it('names the production, its day and its store; a slab delivery; a last delivery', () => {
    expect(basisWords({ basisFrom: 'produced', basisProducedOn: '2026-11-27', basisStoreName: 'Lipa' })).toBe('last production (27 Nov, Lipa)');
    expect(basisWords({ basisFrom: 'linked' })).toBe('slab delivery');
    expect(basisWords({ basisFrom: 'own' })).toBe('last delivery');
  });

  it('labour: from the slicer rate with the arithmetic, as typed, or why it is 0', () => {
    const ok = { ok: true as const, pay: '84.00' as never, kg: '12.000' as never, rate: '7.00' };
    expect(sliceLabourSentence('84.00', 'draft', ok)).toBe('Labour: ₱84.00 from the slicer rate, 12.000 kg × ₱7.00');
    expect(sliceLabourSentence('10.00', 'posted', ok)).toBe('Labour: ₱10.00 as typed');
    expect(sliceLabourSentence('0.00', 'posted', { ok: false, reason: 'There is no slicer rate in force for Slice A.' })).toBe('Labour: ₱0.00. There is no slicer rate in force for Slice A.');
  });

  it('audit fix: without run_payroll the sentence gives the total and the source, never the per-kg slicer rate', () => {
    const hidden = { ok: true as const, pay: '84.00' as never, kg: '12.000' as never, rate: null, ratesHidden: true };
    const s = sliceLabourSentence('84.00', 'draft', hidden);
    expect(s).toBe('Labour: ₱84.00 (from the slicer rate)');
    expect(s).not.toMatch(/7.00|×/);
    expect(sliceLabourSentence('0.00', 'draft', hidden)).not.toMatch(/7.00|×/);
  });

  it('audit fix: no slicer named -> "No slicer named: labour not added."', () => {
    expect(sliceLabourSentence('0.00', 'draft', null)).toBe('No slicer named: labour not added.');
    expect(sliceLabourSentence('12.00', 'posted', null)).toBe('Labour: ₱12.00 as typed');
  });
});
