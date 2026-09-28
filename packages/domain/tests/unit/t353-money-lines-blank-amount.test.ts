/**
 * T-353 (DEF-484) — `docs/tasks/353-def-484-money-lines-errors-before-input.md`, R5, legs D1-D5.
 *
 * A fresh `/expenses/new` shows `"" is not a valid amount. Use at most two decimal places.` under
 * "Paid 1" before anyone has typed anything, because a BLANK amount was sent to the same sentence
 * as a MALFORMED one. A blank required field should ask for the value, not quote it back as
 * malformed. This file proves `validateMoneyLines` alone, with no DOM and no component — it is the
 * same function the server action re-runs (`expenses/actions.ts`), so a fix proven here is proven
 * on both sides of the boundary at once (RULES rule 7).
 *
 * `D3` and `D5` are guards: the malformed-value sentence and the above-zero sentence must stay
 * byte-identical. Only the blank case gets new wording.
 */
import { describe, expect, it } from 'vitest';
import {
  accountAsSource,
  validateMoneyLines,
  type MoneyAccountOption,
  type MoneyLine,
} from '../../src/shared/money-lines';

const cashierAccount: MoneyAccountOption = {
  id: 'acct-cashier-1',
  name: 'Front cashier',
  storeId: 'store-lipa',
  custodian: 'cashier',
  instrument: 'cash',
  glAccountCode: '1110',
  balance: '5000.00',
  overdraftLimit: '0.00',
  floatTarget: null,
};

const cashLine = (over: Partial<MoneyLine> = {}): MoneyLine => ({
  method: 'cash',
  amount: '1000.00',
  moneyAccountId: cashierAccount.id,
  ...over,
});

function validate(lines: MoneyLine[]) {
  return validateMoneyLines({
    direction: 'out',
    lines,
    sources: [accountAsSource(cashierAccount)],
  });
}

describe('D1 — a blank amount asks for a value, not "malformed"', () => {
  it(
    'wanted: the amount issue reads "Enter an amount." — was red today: ' +
      '`"" is not a valid amount. Use at most two decimal places.`',
    () => {
      const issues = validate([cashLine({ amount: '' })]);
      const amountIssue = issues.find((i) => i.field === 'amount');
      expect(amountIssue, 'expected an amount issue on the blank line').toBeTruthy();
      expect(amountIssue!.message).toBe('Enter an amount.');
    },
  );
});

describe('D2 — whitespace-only counts as blank, not malformed', () => {
  it(
    'wanted: "Enter an amount." for amount "   " — was red today: ' +
      '`"   " is not a valid amount. Use at most two decimal places.`',
    () => {
      const issues = validate([cashLine({ amount: '   ' })]);
      const amountIssue = issues.find((i) => i.field === 'amount');
      expect(amountIssue, 'expected an amount issue on the whitespace-only line').toBeTruthy();
      expect(amountIssue!.message).toBe('Enter an amount.');
    },
  );
});

describe('D3 — guard: a genuinely malformed amount keeps the byte-identical sentence', () => {
  it('wanted (unchanged): `"1,5" is not a valid amount. Use at most two decimal places.`', () => {
    const issues = validate([cashLine({ amount: '1,5' })]);
    const amountIssue = issues.find((i) => i.field === 'amount');
    expect(amountIssue, 'expected an amount issue on the malformed line').toBeTruthy();
    expect(amountIssue!.message).toBe('"1,5" is not a valid amount. Use at most two decimal places.');
  });
});

describe('D4 — a blank amount with no source still yields exactly two issues', () => {
  it(
    'wanted: exactly the amount issue ("Enter an amount.") and the moneyAccountId issue — ' +
      'red today only on the amount message; the count itself is a guard',
    () => {
      const issues = validate([cashLine({ amount: '', moneyAccountId: null })]);
      expect(issues).toHaveLength(2);

      const amountIssue = issues.find((i) => i.field === 'amount');
      const sourceIssue = issues.find((i) => i.field === 'moneyAccountId');
      expect(amountIssue, 'expected the amount issue').toBeTruthy();
      expect(sourceIssue, 'expected the moneyAccountId issue').toBeTruthy();
      expect(amountIssue!.message).toBe('Enter an amount.');
      expect(sourceIssue!.message).toBe(
        'Choose where the money came from — every peso has to leave somewhere nameable.',
      );
    },
  );
});

describe('D5 — guard: zero is not blank, and keeps its own sentence', () => {
  it('wanted (unchanged): "An amount has to be above zero." for amount "0.00"', () => {
    const issues = validate([cashLine({ amount: '0.00' })]);
    const amountIssue = issues.find((i) => i.field === 'amount');
    expect(amountIssue, 'expected an amount issue on the zero-amount line').toBeTruthy();
    expect(amountIssue!.message).toBe('An amount has to be above zero.');
  });
});
