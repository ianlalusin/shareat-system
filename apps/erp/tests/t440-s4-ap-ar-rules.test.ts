/**
 * T-440 S4 (TESTER) - parity fixture for every S4 rule set (ap, customers, liabilities, loans, prepaid, trade). Spec:
 * docs/tasks/440-live-field-checks.md section 3, Audit A5 (non-money values never echo; Ian permits quoted money amounts), "one rule definition used
 * by client and server". Node, no database.
 *
 * The rule sets are IMPORTED, never copied. For each rule the table holds a passing value, failing values with the exact
 * sentence, and (for a required rule) the blank sentence. The test then proves, per rule:
 *   - checkField on the passing value is ok (and trimmed); on each failing value it returns EXACTLY the table's sentence;
 *   - the server half (assertFieldRules) throws a RefusalError whose userMessage === checkField(...).requirement (client === server);
 *   - the raw diagnostic is `<form>.<name>: <kind> check failed`, and no sentence or diagnostic contains the typed value.
 * Completeness: every rule of every set has a row and every row names a live rule.
 *
 * MUTANTS: a server check that re-words a sentence (userMessage !== requirement); an edited kept-verbatim sentence; `optional`
 * ignored (a blank optional field refused / a blank required field passed); a sentence interpolating the typed value; a
 * min/max off by one (the boundary pairs); a rule dropped from a set (completeness); `integer` dropped; a pattern loosened.
 */
import { describe, expect, it } from 'vitest';
import * as ap from '../../../packages/domain/src/field-rules/ap';
import * as customers from '../../../packages/domain/src/field-rules/customers';
import * as liabilities from '../../../packages/domain/src/field-rules/liabilities';
import * as loans from '../../../packages/domain/src/field-rules/loans';
import * as prepaid from '../../../packages/domain/src/field-rules/prepaid';
import * as trade from '../../../packages/domain/src/field-rules/trade';
import { checkField, rulesOf, type FieldRule, type FieldRuleSetLike } from '../../../packages/domain/src/field-rules/check';
import { assertFieldRules } from '../../../packages/domain/src/shared/field-rules-assert';
import { RefusalError } from '../../../packages/domain/src/shared/refusal';

type Row = {
  ok: string;
  stored?: string | null;
  bad: Array<[value: string, sentence: string]>;
  /** The sentence for a blank (required rules only). */
  blank?: string;
};

const BLANK = '   ';
const MONEY_BAD = (label: string): [string, string] => ['abc', `${label} — "abc" is not a valid amount. Use at most two decimal places.`];
const MONEY_BLANK = (label: string) => `${label} — can't be left blank. Enter an amount.`;
const REAL_DATE = (label: string): [string, string] => ['soon', `${label} must be a real date.`];

/** A required text rule that carries its own sentence: blank and whitespace both give it. */
const req = (sentence: string): Row => ({ ok: 'abc', bad: [[BLANK, sentence]], blank: sentence });
/** A required text rule with no sentence of its own: "<label> is required." */
const reqAuto = (label: string): Row => ({ ok: 'abc', bad: [], blank: `${label} is required.` });
/** A required text rule capped at `max` characters, with no sentence of its own. */
const reqMax = (label: string, max: number): Row => ({
  ok: 'abc',
  bad: [['x'.repeat(max + 1), `${label} must be at most ${max} characters.`]],
  blank: `${label} is required.`,
});
const date = (label: string): Row => ({ ok: '2026-10-01', bad: [REAL_DATE(label)], blank: `${label} is required.` });
const optDate = (label: string): Row => ({ ok: '2026-10-01', bad: [REAL_DATE(label)] });
/** A date rule that carries its own sentence: a bad value and a blank both give it. */
const dateReq = (sentence: string): Row => ({ ok: '2026-10-01', bad: [['soon', sentence]], blank: sentence });
/** money, min 0.01, with the sentence of its own */
const moneyPos = (sentence: string): Row => ({ ok: '10.5', stored: '10.50', bad: [MONEY_BAD(sentence.split(' must')[0] ?? sentence), ['0', sentence], ['-5', sentence]], blank: sentence });
/** money, min 0, no sentence of its own, required */
const money0 = (label: string): Row => ({
  ok: '0', stored: '0.00',
  bad: [MONEY_BAD(label), ['-1', `${label} must be an amount of 0 or more.`]],
  blank: MONEY_BLANK(label),
});
/** money, min 0, optional */
const optMoney0 = (label: string): Row => ({
  ok: '10.5', stored: '10.50',
  bad: [MONEY_BAD(label), ['-1', `${label} must be an amount of 0 or more.`]],
});

const ROWS: Record<string, Row> = {
  // ---- ap
  'ap.createSupplier.name': req('A supplier needs a name people will recognise.'),
  'ap.createSupplier.creditTermsDays': {
    ok: '30',
    blank: 'Days to pay is required.',
    bad: [['abc', 'Days to pay must be a whole number from 0 to 365.'], ['366', 'Days to pay must be a whole number from 0 to 365.'], ['-1', 'Days to pay must be a whole number from 0 to 365.'], ['1.5', 'Days to pay must be a whole number from 0 to 365.']],
  },
  'ap.recordInvoice.storeId': req('Choose a store.'),
  'ap.recordInvoice.supplierId': req('Choose a supplier.'),
  'ap.recordInvoice.totalAmount': moneyPos('The invoice total must be an amount greater than zero.'),
  'ap.recordInvoice.deliveryFee': optMoney0('The delivery fee'),
  'ap.recordInvoice.otherFees': optMoney0('The other fees'),
  'ap.recordInvoice.invoiceDate': date('The invoice date'),
  'ap.recordInvoice.dueDate': optDate('The due date'),
  'ap.recordInvoice.vatAmount': optMoney0('The VAT amount'),
  'ap.recordPayment.amount': moneyPos('The payment amount must be an amount greater than zero.'),
  'ap.recordPayment.source': req('Choose where the money comes from.'),
  'ap.recordPayment.businessDate': date('The payment date'),
  'ap.voidInvoice.reason': req('Say why this invoice is being voided.'),
  'ap.voidPayment.reason': req('Say why this payment is being voided.'),
  'ap.voidPayment.voidOn': { ok: '2026-10-01', bad: [['soon', 'Pick a valid date for the reversal.']] },
  'ap.recordExpenseForInvoice.categoryId': req('Choose a category.'),
  'ap.recordExpenseForInvoice.particulars': req('Particulars are required - say what the spend was for.'),
  // ---- customers
  'customers.createCustomer.name': req('A customer needs a name people will recognise.'),
  // T-398 S5c: customer credit terms mirror the supplier's days-to-pay rule exactly.
  'customers.createCustomer.creditTermsDays': {
    ok: '30',
    blank: 'Days to pay is required.',
    bad: [['abc', 'Days to pay must be a whole number from 0 to 365.'], ['366', 'Days to pay must be a whole number from 0 to 365.'], ['-1', 'Days to pay must be a whole number from 0 to 365.'], ['1.5', 'Days to pay must be a whole number from 0 to 365.']],
  },
  'customers.reconcileCustomer.asOf': dateReq('Say which date they were verified at zero.'),
  'customers.createPriceList.name': req('A price list needs a name.'),
  'customers.setPrice.itemId': req('Choose an item.'),
  'customers.setPrice.rate': { ...money0('The rate'), bad: [MONEY_BAD('The rate'), ['-1', 'A rate cannot be negative. A negative price is a discount.']] },
  'customers.recordCollection.amount': moneyPos('The amount collected must be an amount greater than zero.'),
  'customers.recordCollection.platformFee': optMoney0('The platform fee'),
  'customers.recordCollection.collectionDate': date('The collection date'),
  'customers.recordCollection.moneyAccountId': req('Choose the account the money went into.'),
  'customers.recordCollection.creditApplied': optMoney0('The store credit applied'),
  'customers.writeOffCharge.amount': moneyPos('The write-off amount must be an amount greater than zero.'),
  'customers.writeOffCharge.reason': req('Say why this debt is uncollectible — a write-off without a reason is a hole.'),
  'customers.voidCharge.reason': req('Say why this charge is being voided.'),
  'customers.voidCollection.reason': req('Say why this collection is being voided.'),
  // ---- liabilities
  'liabilities.createLiability.storeId': req('Choose a store.'),
  'liabilities.createLiability.name': req('Say what this obligation is.'),
  'liabilities.createLiability.dueOn': optDate('The due date'),
  'liabilities.chargeLiability.amount': moneyPos('The charge amount must be an amount greater than zero.'),
  'liabilities.chargeLiability.againstAccountCode': req('Choose what the charge was for.'),
  'liabilities.chargeLiability.on': date('The charge date'),
  'liabilities.payLiability.amount': moneyPos('The payment amount must be an amount greater than zero.'),
  'liabilities.payLiability.fromMoneyAccountId': req('Choose the account the payment comes from.'),
  'liabilities.payLiability.on': date('The payment date'),
  // ---- loans
  'loans.createLoan.name': reqMax('The loan name', 120),
  'loans.createLoan.lenderName': reqMax('The lender', 120),
  'loans.createLoan.storeId': req('Choose a store.'),
  'loans.createLoan.principalAmount': moneyPos('The amount agreed must be an amount greater than zero.'),
  'loans.createLoan.interestRate': {
    ok: '12.5',
    bad: ['abc', '1.23456', '.', '-1'].map((v): [string, string] => [v, 'The interest rate must be a number from 0 to 9999.9999 with up to four decimal places.']),
    blank: 'The interest rate is required.',
  },
  'loans.createLoan.ratePeriod': req('Say whether the interest rate is per month or per year.'),
  'loans.createLoan.termPeriods': {
    ok: '12',
    bad: ['abc', '0', '100000', '1.5'].map((v): [string, string] => [v, 'The number of payments must be a whole number from 1 to 99999.']),
    blank: 'The number of payments is required.',
  },
  'loans.createLoan.startDate': date('The start date'),
  'loans.disburseLoan.amount': moneyPos('The loan amount must be an amount greater than zero.'),
  'loans.disburseLoan.intoMoneyAccountId': req('Choose the account the money went into.'),
  'loans.disburseLoan.on': date('The draw date'),
  'loans.recordLoanPayment.amount': moneyPos('The payment amount must be an amount greater than zero.'),
  'loans.recordLoanPayment.fromMoneyAccountId': req('Choose the account the payment comes from.'),
  'loans.recordLoanPayment.on': date('The payment date'),
  'loans.reverseLoanEntry.reason': req('Say why this is being reversed.'),
  // ---- prepaid
  'prepaid.createPrepaidItem.name': reqMax('The name', 120),
  'prepaid.createPrepaidItem.storeId': req('Choose a store.'),
  'prepaid.createPrepaidItem.totalCost': moneyPos('The total cost must be an amount greater than zero.'),
  'prepaid.createPrepaidItem.coverageStartDate': date('The coverage start'),
  'prepaid.createPrepaidItem.coverageMonths': {
    ok: '12',
    bad: ['abc', '0', '121', '1.5'].map((v): [string, string] => [v, 'The coverage in months must be a whole number from 1 to 120.']),
    blank: 'The coverage in months is required.',
  },
  'prepaid.confirmPrepaidTerm.coverageStartDate': date('The coverage start'),
  'prepaid.confirmPrepaidTerm.coverageMonths': {
    ok: '12',
    bad: ['abc', '0', '121', '1.5'].map((v): [string, string] => [v, 'The coverage in months must be a whole number from 1 to 120.']),
    blank: 'The coverage in months is required.',
  },
  'prepaid.amortisePrepaidItem.asOfPeriod': {
    ok: '2026-10',
    bad: ['soon', '2026-13', '2026-00', '2026-9', '2026-10-01'].map((v): [string, string] => [v, 'The release month must be a month written like 2026-10.']),
    blank: 'The release month is required.',
  },
  'prepaid.reverseAmortisation.reason': req('Say why this month is being reversed.'),
  'prepaid.writeOffPrepaidItem.writtenOffOn': date('The write-off date'),
  'prepaid.writeOffPrepaidItem.reason': reqMax('The reason', 200),
  'prepaid.writeOffPrepaidItem.refundAmount': optMoney0('The refund amount'),
  // ---- trade
  'trade.createTradeOrder.storeId': req('Choose the selling store.'),
  'trade.createTradeOrder.customerId': req('Choose a customer.'),
  'trade.createTradeOrder.orderDate': date('The order date'),
  'trade.createTradeOrder.deliveryFee': optMoney0('The delivery fee'),
  'trade.createTradeOrder.otherFees': optMoney0('The other fees'),
  'trade.dispatchTradeOrder.payNowAmount': {
    ok: '10.5', stored: '10.50',
    bad: [MONEY_BAD('The amount paid now'), ['0', 'The amount paid now must be an amount of 0.01 or more.'], ['-5', 'The amount paid now must be an amount of 0.01 or more.']],
  },
  'trade.receiveTradeOrder.receivedOn': optDate('The received-on date'),
  'trade.voidTradeOrder.reason': req('Say why this order is being voided.'),
  'trade.recordCustomerReturn.quantity': {
    ok: '1.5',
    bad: ['abc', '0', '0.0', '1.2345', '-1'].map((v): [string, string] => [v, 'The quantity returned must be a quantity greater than zero with up to three decimal places.']),
    blank: 'The quantity returned is required.',
  },
  'trade.recordCustomerReturn.reason': reqAuto('The reason'),
  'trade.voidCustomerReturn.reason': req('Say why this return is being voided.'),
};

function setsOf(mod: Record<string, unknown>): FieldRuleSetLike[] {
  return Object.values(mod).filter(
    (v): v is FieldRuleSetLike => typeof v === 'object' && v !== null && typeof (v as { form?: unknown }).form === 'string',
  );
}
const FILES: Record<string, Record<string, unknown>> = { ap, customers, liabilities, loans, prepaid, trade };
const ALL_SETS = Object.values(FILES).flatMap(setsOf);
const keyOf = (set: FieldRuleSetLike, r: FieldRule) => `${set.form}.${r.name}`;
const ALL_RULES = ALL_SETS.flatMap((set) => rulesOf(set).map((r) => ({ set, rule: r, key: keyOf(set, r) })));

function goodInput(set: FieldRuleSetLike): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rulesOf(set)) out[r.name] = ROWS[keyOf(set, r)]?.ok ?? '';
  return out;
}
/** A short value ("0", "-1") can sit inside a sentence by accident; only a value of 3+ characters can be an echo. */
const echoes = (text: string, typed: string) => typed.trim().length >= 3 && text.includes(typed);
const ruleOf = (key: string): FieldRule => {
  const found = ALL_RULES.find((r) => r.key === key);
  if (!found) throw new Error(`no rule ${key}`);
  return found.rule;
};

describe('T-440 S4 payables and receivables: the table covers exactly the rules that exist', () => {
  it('every file holds sets', () => {
    for (const [name, mod] of Object.entries(FILES)) expect(setsOf(mod).length, name).toBeGreaterThan(0);
  });
  it('every rule of every S4 set has a row (mutant: a rule added without a fixture)', () => {
    expect(ALL_RULES.filter((r) => !ROWS[r.key]).map((r) => r.key)).toEqual([]);
  });
  it('every row names a live rule (mutant: a rule dropped from a set while its fixture stays)', () => {
    const live = new Set(ALL_RULES.map((r) => r.key));
    expect(Object.keys(ROWS).filter((k) => !live.has(k))).toEqual([]);
  });
  it('set forms are unique, so a row key is unambiguous', () => {
    const forms = ALL_SETS.map((s) => s.form);
    expect(new Set(forms).size).toBe(forms.length);
  });
  it('a required rule has a blank sentence in the table and an optional one does not (mutant: optional flipped)', () => {
    for (const { rule, key } of ALL_RULES) {
      const row = ROWS[key];
      if (!row) continue;
      expect(row.blank !== undefined, `${key} optional=${rule.optional === true}`).toBe(rule.optional !== true);
    }
  });
});

describe('T-440 S4 payables and receivables: client rule === server refusal, exact sentences, money-only input quoting', () => {
  for (const { set, rule: r, key } of ALL_RULES) {
    const row = ROWS[key];
    if (!row) continue;
    describe(key, () => {
      it('passes its good value (padded too) and stores the normalised form (mutant: value not trimmed / money not normalised)', () => {
        const want = row.stored === undefined ? row.ok : row.stored;
        expect(checkField(r, row.ok)).toEqual({ ok: true, value: want });
        expect(checkField(r, `  ${row.ok} `)).toEqual({ ok: true, value: want });
        expect(assertFieldRules(set, goodInput(set))[r.name]).toBe(want);
      });

      for (const [value, sentence] of row.bad) {
        it(`refuses ${JSON.stringify(value.length > 20 ? `${value.slice(0, 6)}... (${value.length} characters)` : value)} with the exact sentence, same on the server (mutant: re-worded / edited server sentence)`, () => {
          const c = checkField(r, value);
          expect(c.ok).toBe(false);
          if (c.ok) return;
          expect(c.requirement).toBe(sentence);
          let thrown: unknown;
          try {
            assertFieldRules(set, { ...goodInput(set), [r.name]: value });
          } catch (e) {
            thrown = e;
          }
          expect(thrown, 'the server must refuse').toBeInstanceOf(RefusalError);
          const err = thrown as RefusalError;
          expect(err.userMessage).toBe(c.requirement);
          expect(err.message).toBe(`${set.form}.${r.name}: ${r.kind} check failed`);
          for (const text of (r.kind === 'money' ? [c.progress, err.message] : [c.requirement, c.progress, err.message, err.userMessage])) {
            expect(echoes(text, value), 'a sentence must not contain the typed value').toBe(false);
          }
        });
      }

      if (r.optional) {
        it('a blank passes and is stored as null (mutant: optional ignored)', () => {
          expect(checkField(r, '')).toEqual({ ok: true, value: null });
          expect(checkField(r, BLANK)).toEqual({ ok: true, value: null });
          expect(assertFieldRules(set, { ...goodInput(set), [r.name]: '' })[r.name]).toBeNull();
        });
      } else {
        it('a blank (and spaces) is refused with the blank sentence, same on the server (mutant: optional ignored the other way)', () => {
          const want = row.blank;
          expect(want, `${key} needs a blank sentence in the table`).toBeTruthy();
          for (const blank of ['', BLANK]) {
            const c = checkField(r, blank);
            expect(c.ok).toBe(false);
            if (c.ok) return;
            expect(c.requirement).toBe(want);
            expect(c.progress).toBe('Required');
            let thrown: unknown;
            try {
              assertFieldRules(set, { ...goodInput(set), [r.name]: blank });
            } catch (e) {
              thrown = e;
            }
            expect(thrown).toBeInstanceOf(RefusalError);
            expect((thrown as RefusalError).userMessage).toBe(c.requirement);
          }
        });
      }
    });
  }
});

describe('T-440 S4 payables and receivables: boundaries and shape', () => {
  it('a positive amount accepts 0.01 and refuses 0.00 (mutant: min 0 for 0.01)', () => {
    for (const { key } of ALL_RULES) {
      if (!/\.(amount|totalAmount|totalCost|principalAmount)$/.test(key)) continue;
      expect(checkField(ruleOf(key), '0.01').ok, key).toBe(true);
      expect(checkField(ruleOf(key), '0.00').ok, key).toBe(false);
    }
    expect(checkField(ruleOf('trade.dispatchTradeOrder.payNowAmount'), '0.01').ok).toBe(true);
    expect(checkField(ruleOf('trade.dispatchTradeOrder.payNowAmount'), '0.00').ok).toBe(false);
  });
  it('a fee, rate or refund of 0 passes and a negative is refused (mutant: min 0.01 for 0)', () => {
    for (const k of ['ap.recordInvoice.deliveryFee', 'ap.recordInvoice.otherFees', 'ap.recordInvoice.vatAmount', 'customers.setPrice.rate', 'customers.recordCollection.platformFee', 'customers.recordCollection.creditApplied', 'prepaid.writeOffPrepaidItem.refundAmount', 'trade.createTradeOrder.deliveryFee', 'trade.createTradeOrder.otherFees']) {
      expect(checkField(ruleOf(k), '0').ok, `${k} 0`).toBe(true);
      expect(checkField(ruleOf(k), '-0.01').ok, `${k} -0.01`).toBe(false);
    }
  });
  it('days to pay accepts 0 and 365 and refuses 366 and a fraction (mutant: boundary off by one / integer dropped)', () => {
    const r = ruleOf('ap.createSupplier.creditTermsDays');
    expect(checkField(r, '0').ok).toBe(true);
    expect(checkField(r, '365').ok).toBe(true);
    expect(checkField(r, '366').ok).toBe(false);
    expect(checkField(r, '30.5').ok).toBe(false);
  });
  it('the number of payments accepts 1 and 99999 and refuses 0 and 100000 (mutant: boundary off by one)', () => {
    const r = ruleOf('loans.createLoan.termPeriods');
    expect(checkField(r, '1').ok).toBe(true);
    expect(checkField(r, '99999').ok).toBe(true);
    expect(checkField(r, '0').ok).toBe(false);
    expect(checkField(r, '100000').ok).toBe(false);
  });
  it('the coverage accepts 1 and 120 and refuses 0 and 121, on both prepaid forms (mutant: boundary off by one)', () => {
    for (const k of ['prepaid.createPrepaidItem.coverageMonths', 'prepaid.confirmPrepaidTerm.coverageMonths']) {
      const r = ruleOf(k);
      expect(checkField(r, '1').ok, k).toBe(true);
      expect(checkField(r, '120').ok, k).toBe(true);
      expect(checkField(r, '0').ok, k).toBe(false);
      expect(checkField(r, '121').ok, k).toBe(false);
    }
  });
  it('a name may be exactly its cap and no longer (mutant: max off by one)', () => {
    for (const [k, max] of [['loans.createLoan.name', 120], ['loans.createLoan.lenderName', 120], ['prepaid.createPrepaidItem.name', 120], ['prepaid.writeOffPrepaidItem.reason', 200]] as const) {
      expect(checkField(ruleOf(k), 'x'.repeat(max)).ok, k).toBe(true);
      expect(checkField(ruleOf(k), 'x'.repeat(max + 1)).ok, k).toBe(false);
    }
  });
  it('the interest rate keeps the shapes the domain always took: .5 and 1. and 12 pass, a lone dot and five decimals fail (mutant: pattern tightened or loosened)', () => {
    const r = ruleOf('loans.createLoan.interestRate');
    for (const v of ['.5', '1.', '12', '0', '9999.9999', '0.0001']) expect(checkField(r, v).ok, v).toBe(true);
    for (const v of ['.', '', '1.23456', '1,5', '1e3', '5%']) expect(checkField(r, v).ok, `[${v}]`).toBe(false);
  });
  it('the release month is YYYY-MM with a real month (mutant: month 13 or 00 accepted)', () => {
    const r = ruleOf('prepaid.amortisePrepaidItem.asOfPeriod');
    for (const v of ['2026-01', '2026-12']) expect(checkField(r, v).ok, v).toBe(true);
    for (const v of ['2026-00', '2026-13', '202-10', '2026/10']) expect(checkField(r, v).ok, v).toBe(false);
  });
  it('the return quantity: at most three decimals and never zero (mutant: zero allowed / fourth decimal allowed)', () => {
    const r = ruleOf('trade.recordCustomerReturn.quantity');
    for (const v of ['1', '0.001', '.5', '12.345']) expect(checkField(r, v).ok, v).toBe(true);
    for (const v of ['0', '0.000', '0.0', '1.2345', '-1']) expect(checkField(r, v).ok, v).toBe(false);
  });
  it('the payment-void reversal date is optional but must be a real date when typed (mutant: optional skips the date check)', () => {
    const r = ruleOf('ap.voidPayment.voidOn');
    expect(checkField(r, '')).toEqual({ ok: true, value: null });
    expect(checkField(r, '2026-02-30').ok).toBe(false);
    expect(checkField(r, '2026-10-01')).toEqual({ ok: true, value: '2026-10-01' });
  });
  it('the received-on date and the due date are optional and refuse 2026-02-30 when typed (mutant: shape-only date check)', () => {
    for (const k of ['trade.receiveTradeOrder.receivedOn', 'ap.recordInvoice.dueDate', 'liabilities.createLiability.dueOn']) {
      expect(checkField(ruleOf(k), '').ok, k).toBe(true);
      expect(checkField(ruleOf(k), '2026-02-30').ok, k).toBe(false);
    }
  });
});
