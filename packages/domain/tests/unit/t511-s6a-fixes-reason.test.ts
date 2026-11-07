/**
 * T-511 S6a FIXES (audit item 1) - ONE rule for a typed reason: zero-width text is blank, a control character is refused in plain words.
 * The rule lives in the shared field-rule check (`plainText`), so the settlement difference reason, the reject-day reason and the S5c business-rule reason
 * cannot drift. Pure; the database half is t511-s6a-fixes-settlement.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { checkAll, checkField } from '../../src/field-rules';
import { SETTLEMENT_DAY_REJECT_RULES, SETTLEMENT_DIFFERENCE_RULES } from '../../src/field-rules/channel-settlements';
import { SETTINGS_BUSINESS_RULE_RULES } from '../../src/field-rules/settings';

const REASON_RULES = [
  ['settlement difference', SETTLEMENT_DIFFERENCE_RULES.reason],
  ['reject day', SETTLEMENT_DAY_REJECT_RULES.reason],
  ['business rule', SETTINGS_BUSINESS_RULE_RULES.reason],
] as const;

describe('T-511 S6a fixes - the reason rules share one plain-text check', () => {
  for (const [name, rule] of REASON_RULES) {
    it(`${name}: a reason of only zero-width characters (U+200B..U+200D, U+2060, U+FEFF) is blank, not accepted [kills: an invisible reason posts]`, () => {
      for (const reason of ['​', '​‌‍', '⁠', '﻿', ' ​ ⁠\n']) {
        const c = checkField(rule, reason);
        expect(c.ok, JSON.stringify(reason)).toBe(false);
        if (!c.ok) expect(c.progress).toBe('Required');
      }
    });

    it(`${name}: zero-width characters are dropped from a real reason and never stored [kills: the raw text stored]`, () => {
      const c = checkField(rule, ' Fee​ changed⁠ ﻿');
      expect(c).toEqual({ ok: true, value: 'Fee changed' });
    });

    it(`${name}: NUL and other control characters are refused in plain words, a tab and line breaks are fine [kills: a NUL reaching Postgres 22021]`, () => {
      for (const reason of ['bad\u0000reason', 'bell\u0007here', 'esc\u001b[0m', 'del\u007f', 'c1\u0085x']) {
        const c = checkField(rule, reason);
        expect(c.ok, JSON.stringify(reason)).toBe(false);
        if (!c.ok) {
          expect(c.requirement).toMatch(/ordinary text/i);
          expect(c.requirement).not.toMatch(/postgres|22021|sql/i);
        }
      }
      expect(checkField(rule, 'Line one\n\ttwo\r\nthree')).toEqual({ ok: true, value: 'Line one\n\ttwo\r\nthree' });
    });
  }

  it('the settlement difference rule set refuses the same inputs through checkAll (the server half) [kills: a rule applied on the screen only]', () => {
    for (const reason of ['​', 'x\u0000y']) {
      expect(checkAll(SETTLEMENT_DIFFERENCE_RULES, { reason }).ok).toBe(false);
    }
    expect(checkAll(SETTLEMENT_DIFFERENCE_RULES, { reason: 'Platform re-sent the statement​' })).toEqual({ ok: true, values: { reason: 'Platform re-sent the statement' } });
  });

  it('other text rules keep their old behaviour: no plainText means no stripping [kills: the rule widened to every text field]', () => {
    // a rule without the flag still accepts a zero-width-only value as non-blank (unchanged: only the three reasons opt in)
    const unflagged = { name: 'x', label: 'The x', kind: 'text' as const };
    expect(checkField(unflagged, '​').ok).toBe(true);
  });
});
