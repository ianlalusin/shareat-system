/**
 * T-440 S6 (TESTER) - parity fixture for every S6 "money" rule set: cash-requests, channel-settlements, expenses, money-accounts,
 * money-transfers, remittance, sales-days, service-charge, statutory-discounts, till, budgets, fixed-assets. Node, no database.
 * Spec: docs/tasks/440-live-field-checks.md section 3, Audit A5 (non-money values never echo; Ian permits quoted money amounts), the "one rule
 * definition used by client and server" ruling.
 *
 * The rule sets are IMPORTED (never copied). For each rule the table holds a failing value with the exact sentence (and the blank
 * sentence for a required rule). The test then proves, per rule:
 *   - checkField on a passing value is ok; on each failing value it returns EXACTLY the sentence in the table;
 *   - the server half (assertFieldRules) throws a RefusalError whose userMessage === checkField(...).requirement (client === server);
 *   - the raw diagnostic is `<form>.<name>: <kind> check failed`, and neither it nor any sentence / progress line contains the typed value.
 * Completeness: every rule of every set in the twelve files has a row, and every row names a live rule.
 *
 * MUTANTS: a server check that re-words a sentence (userMessage !== requirement); an edited kept-verbatim sentence (`requires`);
 * `optional` ignored either way; a sentence interpolating the typed value; a min/max off by one (the boundary pairs); a rule dropped
 * from a set (completeness); notAfterToday ignored on an acquisition / disposal date.
 */
import { describe, expect, it } from 'vitest';
import * as cashRequests from '../../../packages/domain/src/field-rules/cash-requests';
import * as channelSettlements from '../../../packages/domain/src/field-rules/channel-settlements';
import * as expenses from '../../../packages/domain/src/field-rules/expenses';
import * as moneyAccounts from '../../../packages/domain/src/field-rules/money-accounts';
import * as moneyTransfers from '../../../packages/domain/src/field-rules/money-transfers';
import * as remittance from '../../../packages/domain/src/field-rules/remittance';
import * as salesDays from '../../../packages/domain/src/field-rules/sales-days';
import * as serviceCharge from '../../../packages/domain/src/field-rules/service-charge';
import * as statutoryDiscounts from '../../../packages/domain/src/field-rules/statutory-discounts';
import * as till from '../../../packages/domain/src/field-rules/till';
import * as budgets from '../../../packages/domain/src/field-rules/budgets';
import * as fixedAssets from '../../../packages/domain/src/field-rules/fixed-assets';
import { checkField, rulesOf, type FieldRule, type FieldRuleSetLike } from '../../../packages/domain/src/field-rules/check';
import { assertFieldRules } from '../../../packages/domain/src/shared/field-rules-assert';
import { RefusalError } from '../../../packages/domain/src/shared/refusal';

type Row = {
  /** A passing value (default by kind). */
  ok?: string;
  stored?: string | null;
  /** Failing values with the exact sentence each must give. */
  bad: Array<[value: string, sentence: string]>;
  /** The sentence for a blank (required, non-money rules). Default `${label} is required.` */
  blank?: string;
};

const DASH = '—';
/** A required text rule whose sentence is kept verbatim: a blank and a spaces-only value both give it. */
const R = (sentence: string): Row => ({ bad: [['  ', sentence]], blank: sentence });
/** An optional text rule with a length cap. */
const TX = (label: string, max: number): Row => ({ bad: [['x'.repeat(max + 1), `${label} must be at most ${max} characters.`]] });
/** A money rule with a floor. */
const M = (label: string, min: string): Row => ({
  bad: [
    ['-7', `${label} must be an amount of ${min} or more.`],
    ...(min === '0.01' ? ([['0', `${label} must be an amount of ${min} or more.`]] as Array<[string, string]>) : []),
  ],
});
/** A money rule with no floor: only a non-amount fails (parseMoneyInput's own sentence, with the figure replaced by "that"). */
const MF = (label: string): Row => ({ bad: [['12x', `${label} ${DASH} "12x" is not a valid amount. Use at most two decimal places.`]] });
/** A date rule. */
const D = (label: string): Row => ({ bad: [['soon', `${label} must be a real date.`]] });
/** A date that may not be in the future. */
const DF = (label: string): Row => ({ bad: [['soon', `${label} must be a real date.`], ['2999-01-01', `${label} can't be after today.`]] });
/** A name capped at `max`: blank and too-long both give the one kept sentence. */
const NAME = (sentence: string, max: number): Row => ({ bad: [['  ', sentence], ['x'.repeat(max + 1), sentence]], blank: sentence });
const LIFE = 'The useful life must be a whole number from 1 to 1200.';

const ROWS: Record<string, Row> = {
  // ---- cash-requests ----
  'cash-requests.create.storeId': R('Choose a store.'),
  'cash-requests.create.requestedFor': R('Say who is holding the money.'),
  'cash-requests.create.purpose': R('Say what the money is for.'),
  'cash-requests.create.amount': M('The amount requested', '0.01'),
  'cash-requests.create.on': D('The date'),
  'cash-requests.approve.amount': M('The approved amount', '0.01'),
  'cash-requests.refuse.reason': R('A refusal needs a reason.'),
  'cash-requests.release.amount': M('The amount released', '0.01'),
  'cash-requests.release.fromMoneyAccountId': R('Choose the account the cash comes from.'),
  'cash-requests.release.on': D('The date'),
  'cash-requests.settle.returnedAmount': MF('The returned amount'),
  'cash-requests.settle.shortAmount': MF('The short amount'),
  'cash-requests.settle.on': D('The date'),

  // ---- channel-settlements ----
  'channel-settlements.record.grossAmount': MF('The gross settled'),
  'channel-settlements.record.netDeposited': MF('The net deposited'),
  'channel-settlements.record.loanAmount': M('The amount docked', '0'),
  'channel-settlements.record.reference': TX('The payout reference', 120),
  'channel-settlements.record.settledOn': D('The settlement date'),
  'channel-settlements.void.reason': R(`Say why this settlement is being voided ${DASH} a reversal with no reason is a gap.`),
  'channel-settlements.payoutDestination.moneyAccountId': R('Choose the account this channel pays into.'),

  // ---- expenses ----
  'expenses.create.supplierInvoiceId': R('Choose a supplier invoice.'),
  'expenses.create.categoryId': R('Choose a category.'),
  'expenses.create.particulars': R('Say what this expense was actually for.'),
  'expenses.void.reason': R('Say why this expense is being voided - a reversal with no reason is a gap.'),
  'expenses.reimbursement.amount': M('The reimbursement amount', '0.01'),
  'expenses.reimbursement.on': D('The date'),
  'expenses.reimbursement.fromMoneyAccountId': R('Choose the account to pay from.'),
  'expenses.recurringTemplate.name': R('Give the template a name - "Lipa branch rent", not "expense 3".'),
  'expenses.recurringTemplate.supplierId': R('Choose the supplier the bill comes from.'),
  'expenses.recurringTemplate.categoryId': R('Choose a category.'),
  'expenses.recurringTemplate.defaultAmount': M('The default amount', '0.01'),
  'expenses.recurringTemplate.anchorDay': {
    ok: '15',
    bad: ['abc', '32', '-1', '1.5'].map((v): [string, string] => [v, 'The day must be a whole number from 0 to 31.']),
  },
  'expenses.recurringTemplate.startsOn': D('Starts from'),

  // ---- money-accounts ----
  'money-accounts.create.name': NAME('Give the account a name (up to 120 characters).', 120),
  'money-accounts.create.storeId': R('Choose a store - money always sits somewhere.'),
  'money-accounts.rename.name': NAME('Give the account a name (up to 120 characters).', 120),
  'money-accounts.rename.overdraftLimit': { bad: [['-7', 'An overdraft limit is how far below zero the drawer may go, so enter it as a positive number. Zero means it may never go below zero at all.']] },

  // ---- money-transfers ----
  'money-transfers.record.amountOut': M('The amount that left', '0.01'),
  'money-transfers.record.amountIn': M('The amount that arrived', '0.01'),
  'money-transfers.record.transferDate': D('The transfer date'),
  'money-transfers.record.reference': TX('The reference', 120),
  'money-transfers.settle.fromMoneyAccountId': R("Choose the paying store's account."),
  'money-transfers.settle.toMoneyAccountId': R("Choose the receiving store's account."),
  'money-transfers.settle.amountOut': M('The amount that left', '0.01'),
  'money-transfers.settle.amountIn': M('The amount that arrived', '0.01'),
  'money-transfers.settle.transferDate': D('The transfer date'),
  'money-transfers.settle.reference': TX('The reference', 120),
  'money-transfers.void.reason': R('Say why this transfer is being reversed - a reversal with no reason is a gap.'),

  // ---- remittance ----
  'remittance.record.remittedOn': D('The handover date'),
  'remittance.record.reference': TX('The reference', 120),
  'remittance.reverse.reason': R('Say why this remittance is being reversed.'),
  'remittance.cashPolicy.unremittedCeiling': M('The un-remitted ceiling', '0.01'),

  // ---- sales-days ----
  'sales-days.create.businessDate': D('The business date'),
  'sales-days.import.businessDate': D('The business date'),
  'sales-days.correction.entryDate': D('The correction date'),
  'sales-days.correction.reason': R('Say what changed in POS.'),
  'sales-days.void.reason': R('Say why this sales day is being withdrawn or voided.'),

  // ---- service-charge ----
  'service-charge.distribute.amount': M('The amount', '0.01'),
  'service-charge.distribute.moneyAccountId': R('Choose the account the money comes from.'),
  'service-charge.distribute.paidOn': D('The payday'),

  // ---- statutory-discounts ----
  'statutory-discounts.record.storeId': R('Choose a store.'),
  'statutory-discounts.record.businessDate': D('The date of sale'),
  'statutory-discounts.record.invoiceNumber': R('The invoice or OR number is required.'),
  'statutory-discounts.record.kind': R('Choose the discount kind.'),
  'statutory-discounts.record.holderName': R("The holder's name is required."),
  'statutory-discounts.record.idNumber': R('The ID number is required.'),
  'statutory-discounts.record.grossAmount': M('The gross amount', '0.01'),
  'statutory-discounts.record.discountAmount': M('The discount granted', '0.01'),
  'statutory-discounts.void.voidReason': R('Say why this record is being voided.'),

  // ---- till ----
  'till.openShift.businessDate': D('The trading date'),

  // ---- budgets ----
  'budgets.cap.amount': M('The cap', '0'),

  // ---- fixed-assets ----
  'fixed-assets.create.name': NAME('Give the asset a name (up to 200 characters).', 200),
  'fixed-assets.create.storeId': R('Choose a store.'),
  'fixed-assets.create.category': R('Choose an asset category from the list.'),
  'fixed-assets.create.acquiredOn': DF('The acquisition date'),
  'fixed-assets.create.inServiceOn': D('The specific in-service date'),
  'fixed-assets.create.cost': M("The asset's cost", '0.01'),
  'fixed-assets.create.salvageValue': { bad: [['-7', 'The salvage value cannot be negative.']] },
  'fixed-assets.create.usefulLifeMonths': { ok: '60', bad: ['abc', '0', '1201', '1.5'].map((v): [string, string] => [v, LIFE]) },
  'fixed-assets.terms.name': NAME('Give the asset a name (up to 200 characters).', 200),
  'fixed-assets.terms.usefulLifeMonths': { ok: '60', bad: ['abc', '0', '1201'].map((v): [string, string] => [v, LIFE]) },
  'fixed-assets.terms.salvageValue': { bad: [['-7', 'The salvage value cannot be negative.']] },
  'fixed-assets.inService.inServiceOn': D('The specific date'),
  'fixed-assets.inService.reason': R('A reason is required - an audit trail with no reason is unauditable.'),
  'fixed-assets.inServiceConfirm.reason': R('A reason is required - an audit trail with no reason is unauditable.'),
  'fixed-assets.dispose.disposedOn': DF('The disposal date'),
  'fixed-assets.dispose.reason': R('A reason is required - a write-off with no reason is unauditable.'),
};

const FILES: Record<string, Record<string, unknown>> = {
  cashRequests, channelSettlements, expenses, moneyAccounts, moneyTransfers, remittance, salesDays, serviceCharge, statutoryDiscounts, till, budgets, fixedAssets,
};
function setsOf(mod: Record<string, unknown>): FieldRuleSetLike[] {
  return Object.values(mod).filter(
    (v): v is FieldRuleSetLike => typeof v === 'object' && v !== null && typeof (v as { form?: unknown }).form === 'string',
  );
}
const ALL_SETS = Object.values(FILES).flatMap(setsOf);
const keyOf = (set: FieldRuleSetLike, rule: FieldRule) => `${set.form}.${rule.name}`;
const ALL_RULES = ALL_SETS.flatMap((set) => rulesOf(set).map((rule) => ({ set, rule, key: keyOf(set, rule) })));

const DEFAULT_OK: Record<string, string> = { text: 'Something', money: '500.00', date: '2020-01-02', number: '15', digits: '1234', pattern: 'abc' };
const okOf = (key: string, rule: FieldRule): string => ROWS[key]?.ok ?? DEFAULT_OK[rule.kind] ?? '';

/** The set's every rule filled with its passing value, so one rule can be broken at a time. */
function goodInput(set: FieldRuleSetLike): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rulesOf(set)) out[r.name] = okOf(keyOf(set, r), r);
  return out;
}
// A one-character value ("0") is a substring of any figure in a sentence ("0.01"), so it proves nothing; longer ones are real.
const echoes = (text: string, typed: string) => typed.trim().length > 1 && text.includes(typed);

describe('T-440 S6 money: the table covers exactly the rules that exist', () => {
  it('twelve rule files, each exporting at least one set', () => {
    expect(Object.keys(FILES)).toHaveLength(12);
    for (const [name, mod] of Object.entries(FILES)) expect(setsOf(mod).length, name).toBeGreaterThan(0);
  });
  it('every rule of every S6 set has a row (mutant: a rule added without a fixture)', () => {
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
});

describe('T-440 S6 money: client rule === server refusal, exact sentences, money-only input quoting', () => {
  for (const { set, rule, key } of ALL_RULES) {
    const row = ROWS[key];
    if (!row) continue;
    describe(key, () => {
      it('passes its good value and stores the normalised form (mutant: value not trimmed / normalised)', () => {
        const ok = okOf(key, rule);
        const want = row.stored === undefined ? ok : row.stored;
        expect(checkField(rule, ` ${ok} `)).toEqual({ ok: true, value: want });
        expect(assertFieldRules(set, goodInput(set))[rule.name]).toBe(want);
      });

      for (const [value, sentence] of row.bad) {
        const shown = value.length > 12 ? `${value.slice(0, 6)}...(${value.length})` : value;
        it(`refuses ${JSON.stringify(shown)} with the exact sentence, same on the server (mutant: re-worded / edited server sentence)`, () => {
          const c = checkField(rule, value);
          expect(c.ok).toBe(false);
          if (c.ok) return;
          expect(c.requirement).toBe(sentence);
          let thrown: unknown;
          try {
            assertFieldRules(set, { ...goodInput(set), [rule.name]: value });
          } catch (e) {
            thrown = e;
          }
          expect(thrown, 'the server must refuse').toBeInstanceOf(RefusalError);
          const err = thrown as RefusalError;
          expect(err.userMessage).toBe(c.requirement);
          expect(err.message).toBe(`${set.form}.${rule.name}: ${rule.kind} check failed`);
          // A5: nothing the person typed comes back in a sentence, a progress line or the raw diagnostic.
          for (const text of (rule.kind === 'money' ? [c.progress, err.message] : [c.requirement, c.progress, err.message, err.userMessage])) {
            expect(echoes(text, value), `"${text.slice(0, 80)}" must not contain the typed value`).toBe(false);
          }
        });
      }

      if (rule.optional) {
        it('a blank passes and is stored as null (mutant: optional ignored)', () => {
          expect(checkField(rule, '')).toEqual({ ok: true, value: null });
          expect(checkField(rule, '   ')).toEqual({ ok: true, value: null });
          expect(assertFieldRules(set, { ...goodInput(set), [rule.name]: '' })[rule.name]).toBeNull();
        });
      } else {
        it('a blank is refused with the blank sentence, same on the server (mutant: optional ignored the other way)', () => {
          const c = checkField(rule, '');
          expect(c.ok).toBe(false);
          if (c.ok) return;
          if (rule.kind === 'money') {
            expect(c.requirement.toLowerCase()).toContain(rule.label.toLowerCase().replace(/^the /, ''));
          } else {
            expect(c.requirement).toBe(row.blank ?? `${rule.label} is required.`);
          }
          expect(c.progress).toBe('Required');
          let thrown: unknown;
          try {
            assertFieldRules(set, { ...goodInput(set), [rule.name]: '' });
          } catch (e) {
            thrown = e;
          }
          expect(thrown).toBeInstanceOf(RefusalError);
          expect((thrown as RefusalError).userMessage).toBe(c.requirement);
        });
      }
    });
  }
});

describe('T-440 S6 money: boundaries and the Manila date', () => {
  const rule = (key: string): FieldRule => {
    const found = ALL_RULES.find((r) => r.key === key);
    if (!found) throw new Error(`no rule ${key}`);
    return found.rule;
  };
  it('the recurring anchor day accepts 0 and 31 and refuses 32 (mutant: <= for < on max / min raised)', () => {
    const r = rule('expenses.recurringTemplate.anchorDay');
    expect(checkField(r, '0').ok).toBe(true);
    expect(checkField(r, '31').ok).toBe(true);
    expect(checkField(r, '32').ok).toBe(false);
  });
  it('the useful life accepts 1 and 1200 and refuses 0 and 1201 (mutant: boundary off by one)', () => {
    for (const k of ['fixed-assets.create.usefulLifeMonths', 'fixed-assets.terms.usefulLifeMonths']) {
      const r = rule(k);
      expect(checkField(r, '1').ok, k).toBe(true);
      expect(checkField(r, '1200').ok, k).toBe(true);
      expect(checkField(r, '0').ok, k).toBe(false);
      expect(checkField(r, '1201').ok, k).toBe(false);
    }
  });
  it('the terms form needs a life; the create form may leave it blank (mutant: optional mixed up between the two sets)', () => {
    expect(checkField(rule('fixed-assets.terms.usefulLifeMonths'), '').ok).toBe(false);
    expect(checkField(rule('fixed-assets.create.usefulLifeMonths'), '').ok).toBe(true);
  });
  it('a money rule with min 0.01 refuses zero and accepts 0.01; min 0 accepts zero (mutant: > 0 / >= 0 swapped)', () => {
    expect(checkField(rule('cash-requests.create.amount'), '0').ok).toBe(false);
    expect(checkField(rule('cash-requests.create.amount'), '0.01').ok).toBe(true);
    expect(checkField(rule('budgets.cap.amount'), '0').ok).toBe(true);
    expect(checkField(rule('budgets.cap.amount'), '-0.01').ok).toBe(false);
    expect(checkField(rule('money-accounts.rename.overdraftLimit'), '0').ok).toBe(true);
    expect(checkField(rule('channel-settlements.record.loanAmount'), '0').ok).toBe(true);
  });
  it('both return boxes may be blank in the rule (the "at least one" pairing stays in the server action) (mutant: optional dropped)', () => {
    expect(checkField(rule('cash-requests.settle.returnedAmount'), '').ok).toBe(true);
    expect(checkField(rule('cash-requests.settle.shortAmount'), '').ok).toBe(true);
  });
  it('the reference accepts exactly 120 characters and refuses 121 (mutant: <= for < on max)', () => {
    for (const k of ['money-transfers.record.reference', 'money-transfers.settle.reference', 'remittance.record.reference', 'channel-settlements.record.reference']) {
      expect(checkField(rule(k), 'x'.repeat(120)).ok, k).toBe(true);
      expect(checkField(rule(k), 'x'.repeat(121)).ok, k).toBe(false);
    }
  });
  it('the account name accepts 120 characters and refuses 121; the asset name 200 and 201 (mutant: cap changed)', () => {
    expect(checkField(rule('money-accounts.create.name'), 'x'.repeat(120)).ok).toBe(true);
    expect(checkField(rule('money-accounts.create.name'), 'x'.repeat(121)).ok).toBe(false);
    expect(checkField(rule('fixed-assets.create.name'), 'x'.repeat(200)).ok).toBe(true);
    expect(checkField(rule('fixed-assets.create.name'), 'x'.repeat(201)).ok).toBe(false);
  });
  it('an acquisition / disposal date refuses tomorrow and accepts today, on the Manila date; a transfer date has no such cap (mutant: notAfterToday ignored / UTC date)', async () => {
    const { toBusinessDate } = await import('@shareat/core/datetime');
    const today = toBusinessDate();
    const [y, m, d] = today.split('-').map(Number) as [number, number, number];
    const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    for (const k of ['fixed-assets.create.acquiredOn', 'fixed-assets.dispose.disposedOn']) {
      expect(checkField(rule(k), today).ok, k).toBe(true);
      const tomorrow = checkField(rule(k), next);
      expect(tomorrow.ok, k).toBe(false);
      if (!tomorrow.ok) expect(tomorrow.requirement).toBe(`${rule(k).label} can't be after today.`);
    }
    expect(checkField(rule('money-transfers.record.transferDate'), next).ok).toBe(true);
  });
  it('an invalid money amount is quoted per Ian while progress still hides it', () => {
    const c = checkField(rule('statutory-discounts.record.grossAmount'), '12x');
    expect(c.ok).toBe(false);
    if (!c.ok) { expect(c.requirement).toContain('"12x"'); expect(c.progress).not.toContain('12x'); }
  });
});
