import { describe, expect, it } from 'vitest';
import { checkField } from '../field-rules';
import { PAYROLL_STATUTORY_RATE_RULES } from '../field-rules/payroll';
import { normaliseEmployerNo } from './employer-no';

describe('T-500 employer number: the usual printed format is accepted, stored digits-only', () => {
  it('strips dashes and spaces', () => {
    expect(normaliseEmployerNo('03-1234567-8')).toBe('0312345678');
    expect(normaliseEmployerNo(' 03 1234567 8 ')).toBe('0312345678');
    expect(normaliseEmployerNo('0312345678')).toBe('0312345678');
    expect(normaliseEmployerNo('')).toBe('');
  });
  it('does not hide letters or other junk (still refused by the digits check)', () => {
    expect(normaliseEmployerNo('03-ABC-45')).toBe('03ABC45');
    expect(normaliseEmployerNo('03.123')).toBe('03.123');
  });
});

describe('T-500 contribution rates are decimals: 5 is refused in words that say how to enter 5%', () => {
  const says = (rule: 'eeRate' | 'erRate' | 'lowEeRate', v: string) => checkField(PAYROLL_STATUTORY_RATE_RULES[rule], v);
  it.each(['eeRate', 'erRate', 'lowEeRate'] as const)('%s: 5 and 1.5 refused naming "enter 0.05 for 5%%"; 0.05, 0 and 1 accepted', (k) => {
    for (const bad of ['5', '1.5']) {
      const r = says(k, bad);
      expect(r.ok, `${k} ${bad}`).toBe(false);
      if (!r.ok) expect(r.requirement).toContain('enter 0.05 for 5%');
    }
    for (const good of ['0.05', '0', '1']) expect(says(k, good).ok, `${k} ${good}`).toBe(true);
  });
});
