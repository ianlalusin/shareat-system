/**
 * T-533 S1 - the sentence the confirm step shows before a store's POS mode changes. Plain words, the store's own name, the exact effect.
 */
import { describe, expect, it } from 'vitest';
import { niceDate, posModeConsequence } from '../src/app/admin/stores/pos-mode-text';

const NAME = 'SharEat Lipa';

describe('posModeConsequence', () => {
  it('live names the date and says the v1 day feed stops for the store', () => {
    expect(posModeConsequence({ mode: 'live', liveFrom: '2026-12-07', storeName: NAME, wasLive: false })).toContain(
      "From 7 Dec 2026, SharEat Lipa's sales days come from the new POS; the v1 day feed stops for SharEat Lipa.",
    );
  });
  it('live also says how long a roll-back stays possible', () => {
    expect(posModeConsequence({ mode: 'live', liveFrom: '2026-12-07', storeName: NAME, wasLive: false })).toContain('only until the first day is closed');
  });
  it('test says practice and that no sales day is booked', () => {
    expect(posModeConsequence({ mode: 'test', liveFrom: null, storeName: NAME, wasLive: false })).toContain('can sell on the new POS for practice; no sales day is booked.');
  });
  it('off says v1 keeps the days', () => {
    expect(posModeConsequence({ mode: 'off', liveFrom: null, storeName: NAME, wasLive: false })).toContain('Its sales days come from the v1 day feed.');
  });
  it('leaving live (test or off) adds the roll-back limit; a store that was not live does not', () => {
    for (const mode of ['test', 'off'] as const) {
      expect(posModeConsequence({ mode, liveFrom: null, storeName: NAME, wasLive: true })).toContain('only before the first day is closed');
      expect(posModeConsequence({ mode, liveFrom: null, storeName: NAME, wasLive: false })).not.toContain('rolls the store back');
    }
  });
  it('niceDate falls back to the raw text for a non-date', () => {
    expect(niceDate('2026-12-07')).toBe('7 Dec 2026');
    expect(niceDate('soon')).toBe('soon');
  });
});
