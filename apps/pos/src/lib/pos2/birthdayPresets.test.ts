/**
 * T-455 S6b (TESTER) - the three decline presets (S6a ruling 6: they live in the POS screen; the domain takes any 1..80 trimmed text).
 * Assumption A4 (see lib/birthday/player.test.ts header): the exact wording below; a ruling may change the words, not the three-and-valid rule.
 * RED: `./birthdayPresets` does not exist.  CONTRACT: export const BIRTHDAY_DECLINE_PRESETS: readonly string[] (length 3).
 */
import { describe, expect, it } from 'vitest';
import { BIRTHDAY_DECLINE_PRESETS } from './birthdayPresets';

describe('birthday decline presets', () => {
  it('are exactly three, distinct, trimmed, and each fits the domain limit of 1..80 characters', () => {
    expect(BIRTHDAY_DECLINE_PRESETS).toHaveLength(3);
    expect(new Set(BIRTHDAY_DECLINE_PRESETS).size).toBe(3);
    for (const p of BIRTHDAY_DECLINE_PRESETS) {
      expect(p).toBe(p.trim());
      expect(p.length).toBeGreaterThanOrEqual(1);
      expect(p.length).toBeLessThanOrEqual(80);
    }
  });
  it('use the assumed wording [A4]', () => {
    expect([...BIRTHDAY_DECLINE_PRESETS]).toEqual(['Too busy right now', 'Not available today', 'We cannot play it at this time']);
  });
});
