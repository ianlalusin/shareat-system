/**
 * T-511 S6a FIXES (audit item 2) - the preview and the record action read "is a loan docked?" the same way: a blank or zero amount is no loan leg.
 * Before: the form sends `loanAmount || '0'`, the preview built a leg from '0' and the domain refused it ("must be more than zero") while the record action
 * treated 0 as no loan. Now both call one helper.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasLoanAmount } from '../src/app/channel-settlements/loan-amount';

const actions = readFileSync(resolve(__dirname, '..', 'src', 'app', 'channel-settlements', 'actions.ts'), 'utf8');

describe('T-511 S6a fixes - one reading of a blank or zero loan amount', () => {
  it('blank, spaces, 0, 0.00 and -0 are no loan; a real amount and a typo go on to the domain [kills: a zero amount becoming a leg]', () => {
    for (const raw of ['', '   ', '0', '0.00', ' 0 ', '-0']) expect(hasLoanAmount(raw), JSON.stringify(raw)).toBe(false);
    for (const raw of ['591.24', '0.01', '-5', '1,771.88', 'abc']) expect(hasLoanAmount(raw), JSON.stringify(raw)).toBe(true);
  });

  it('both actions decide through the helper, and neither keeps its own test of the amount [kills: preview and record disagreeing again]', () => {
    expect((actions.match(/hasLoanAmount\(/g) ?? []).length, 'calls in actions.ts (preview + record)').toBe(2);
    expect(actions).toMatch(/hasLoanAmount\(req\.loanAmount\)/);
    expect(actions).toMatch(/hasLoanAmount\(loanAmount\)/);
    expect(actions).not.toMatch(/req\.loanId\s*&&\s*req\.loanAmount/);
    expect(actions).not.toMatch(/Number\(loanAmount\)\s*!==\s*0/);
  });
});
