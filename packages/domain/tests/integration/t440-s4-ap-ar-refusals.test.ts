import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-440 S4 (TESTER) - one refusal per S4 action whose rule set the sweep wired into the SERVER path (Q5: a field marked required or
 * bounded on screen but never checked by the action). Each case runs the REAL server action with ONE bad value (every other field of
 * the rule set good, so that rule is the first to fail) and proves two things: the person is told the rule's exact sentence (read
 * from the imported rule set, never a copy) and NOTHING was written (the action's own table keeps its row count).
 *
 * Every S4 action asserts at the top of the action, before it loads the target record or checks the PIN, so a made-up id is fine
 * for the void / reverse / write-off cases. createLoan, createPrepaidItem and confirmPrepaidTerm assert in the DOMAIN, after
 * `authorize` (T-364 order); the admin fixture actor passes the gate, so those cases prove the order too.
 *
 * Session mocked (t412 idiom); redirects captured; the banner read through the flash jar. Every case names the mutant it kills;
 * the mutant is "the assertFieldRules call is removed from that action" unless stated otherwise.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../../../../tests/helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../../../apps/erp/src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));

import { closeDb } from '@shareat/db';
import { captureRedirect, outcomeOf, resetJar } from '../../../../tests/helpers/flash-jar';
import { moneyFixture } from './_fixtures/t402-s3-money';
import { checkField, rulesOf, type FieldRule, type FieldRuleSetLike } from '../../src/field-rules/check';
import {
  INVOICE_EXPENSE_RULES, INVOICE_VOID_RULES, PAYMENT_VOID_RULES, SUPPLIER_INVOICE_LOG_RULES, SUPPLIER_PAYMENT_RULES,
} from '../../src/field-rules/ap';
import {
  CHARGE_VOID_RULES, CHARGE_WRITE_OFF_RULES, COLLECTION_RECORD_RULES, COLLECTION_VOID_RULES, CUSTOMER_ADD_RULES,
  CUSTOMER_RECONCILE_RULES, PRICE_LIST_ADD_RULES, PRICE_SET_RULES,
} from '../../src/field-rules/customers';
import { LIABILITY_ADD_RULES, LIABILITY_CHARGE_RULES, LIABILITY_PAY_RULES } from '../../src/field-rules/liabilities';
import { LOAN_ADD_RULES, LOAN_DRAW_RULES, LOAN_PAYMENT_RULES, LOAN_REVERSE_RULES } from '../../src/field-rules/loans';
import {
  PREPAID_ADD_RULES, PREPAID_MONTH_REVERSE_RULES, PREPAID_RELEASE_RULES, PREPAID_TERM_RULES, PREPAID_WRITE_OFF_RULES,
} from '../../src/field-rules/prepaid';
import {
  RETURN_RECORD_RULES, RETURN_VOID_RULES, TRADE_DISPATCH_RULES, TRADE_ORDER_RULES, TRADE_RECEIVE_RULES, TRADE_VOID_RULES,
} from '../../src/field-rules/trade';

const sql = postgres(url, { max: 5 });
const APP = '../../../../apps/erp/src/app';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type Fx = Awaited<ReturnType<typeof moneyFixture>>;
let fxPromise: Promise<Fx> | null = null;
const fixture = () => (fxPromise ??= moneyFixture(sql, 't440s4'));

const GOOD: Record<string, string> = { text: 'Something', money: '500.00', date: '2020-01-02', number: '15', digits: '1234', pattern: 'abc' };

/** Every rule of the set filled with a passing value, so one rule can be broken at a time. `good` overrides (pattern rules need a real shape). */
function goodFields(set: FieldRuleSetLike, good: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rulesOf(set)) out[r.name] = good[r.name] ?? GOOD[r.kind] ?? '';
  return out;
}

/** The sentence the SCREEN shows for this value: the rule set's own, so client === server is the thing under test. */
function sentence(rule: FieldRule, value: string): string {
  const c = checkField(rule, value);
  if (c.ok) throw new Error(`the fixture value ${JSON.stringify(value.slice(0, 12))} passes ${rule.name}; pick a failing one`);
  return c.requirement;
}

async function count(table: string, orgId: string): Promise<number> {
  const rows = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table} where org_id = '${orgId}'`);
  return rows[0]?.n ?? 0;
}

type Case = {
  title: string;
  mod: string;
  action: string;
  set: FieldRuleSetLike;
  rule: string;
  value: string;
  /** The table the action would write to. */
  table: string;
  /** Fields the action reads BEFORE / besides the rule set (ids, a decision, the store). */
  extra?: Record<string, string>;
  /** Passing values for rules whose shape GOOD does not satisfy. */
  good?: Record<string, string>;
  mutant?: string;
};

const FAKE = () => randomUUID();
const CASES: Case[] = [
  // ---- ap
  { title: 'ap recordInvoiceAction: an invoice total of 0', mod: 'ap/actions', action: 'recordInvoiceAction', set: SUPPLIER_INVOICE_LOG_RULES, rule: 'totalAmount', value: '0', table: 'supplier_invoices', mutant: 'min 0.01 loosened to 0', extra: { supplierId: FAKE() } },
  { title: 'ap recordInvoiceAction: an invoice date that is not a date', mod: 'ap/actions', action: 'recordInvoiceAction', set: SUPPLIER_INVOICE_LOG_RULES, rule: 'invoiceDate', value: 'soon', table: 'supplier_invoices', extra: { supplierId: FAKE() } },
  { title: 'ap recordInvoiceAction: a negative delivery fee', mod: 'ap/actions', action: 'recordInvoiceAction', set: SUPPLIER_INVOICE_LOG_RULES, rule: 'deliveryFee', value: '-1', table: 'supplier_invoices', mutant: 'optional fee min 0 dropped', extra: { supplierId: FAKE() } },
  { title: 'ap recordPaymentAction: a payment of 0', mod: 'ap/actions', action: 'recordPaymentAction', set: SUPPLIER_PAYMENT_RULES, rule: 'amount', value: '0', table: 'ap_payments', mutant: 'min 0.01 loosened to 0', extra: { supplierId: FAKE() } },
  { title: 'ap recordPaymentAction: no source of money', mod: 'ap/actions', action: 'recordPaymentAction', set: SUPPLIER_PAYMENT_RULES, rule: 'source', value: '  ', table: 'ap_payments', extra: { supplierId: FAKE() } },
  { title: 'ap voidInvoiceAction: a blank reason', mod: 'ap/actions', action: 'voidInvoiceAction', set: INVOICE_VOID_RULES, rule: 'reason', value: '  ', table: 'supplier_invoices', extra: { invoiceId: FAKE() } },
  { title: 'ap recordInvoiceExpenseAction: no category', mod: 'ap/actions', action: 'recordInvoiceExpenseAction', set: INVOICE_EXPENSE_RULES, rule: 'categoryId', value: '  ', table: 'expenses', extra: { supplierInvoiceId: FAKE() } },
  { title: 'ap recordInvoiceExpenseAction: blank particulars', mod: 'ap/actions', action: 'recordInvoiceExpenseAction', set: INVOICE_EXPENSE_RULES, rule: 'particulars', value: '  ', table: 'expenses', extra: { supplierInvoiceId: FAKE() }, mutant: 'the hand-off runs without the rule judged first' },
  { title: 'ap voidPaymentAction: a blank reason', mod: 'ap/actions', action: 'voidPaymentAction', set: PAYMENT_VOID_RULES, rule: 'reason', value: '  ', table: 'ap_payments', extra: { paymentId: FAKE() } },
  { title: 'ap voidPaymentAction: a reversal date that is not a date', mod: 'ap/actions', action: 'voidPaymentAction', set: PAYMENT_VOID_RULES, rule: 'voidOn', value: 'soon', table: 'ap_payments', extra: { paymentId: FAKE() }, mutant: 'optional date never checked when typed' },
  // ---- customers
  { title: 'customers createCustomerAction: a blank name', mod: 'customers/actions', action: 'createCustomerAction', set: CUSTOMER_ADD_RULES, rule: 'name', value: '  ', table: 'customers' },
  { title: 'customers reconcileCustomerAction: an anchor date that is not a date', mod: 'customers/actions', action: 'reconcileCustomerAction', set: CUSTOMER_RECONCILE_RULES, rule: 'asOf', value: 'soon', table: 'customers', extra: { customerId: FAKE() } },
  { title: 'customers recordCollectionAction: an amount of 0', mod: 'customers/actions', action: 'recordCollectionAction', set: COLLECTION_RECORD_RULES, rule: 'amount', value: '0', table: 'ar_collections', mutant: 'min 0.01 loosened to 0', extra: { customerId: FAKE() } },
  { title: 'customers recordCollectionAction: no account the money went into', mod: 'customers/actions', action: 'recordCollectionAction', set: COLLECTION_RECORD_RULES, rule: 'moneyAccountId', value: '  ', table: 'ar_collections', extra: { customerId: FAKE() } },
  { title: 'customers recordCollectionAction: a negative platform fee', mod: 'customers/actions', action: 'recordCollectionAction', set: COLLECTION_RECORD_RULES, rule: 'platformFee', value: '-1', table: 'ar_collections', extra: { customerId: FAKE() } },
  { title: 'customers voidCollectionAction: a blank reason', mod: 'customers/actions', action: 'voidCollectionAction', set: COLLECTION_VOID_RULES, rule: 'reason', value: '  ', table: 'ar_collections', extra: { customerId: FAKE(), collectionId: FAKE() } },
  { title: 'customers voidChargeAction: a blank reason', mod: 'customers/actions', action: 'voidChargeAction', set: CHARGE_VOID_RULES, rule: 'reason', value: '  ', table: 'ar_charges', extra: { customerId: FAKE(), chargeId: FAKE() } },
  { title: 'customers writeOffChargeAction: a write-off of 0', mod: 'customers/actions', action: 'writeOffChargeAction', set: CHARGE_WRITE_OFF_RULES, rule: 'amount', value: '0', table: 'ar_charges', extra: { customerId: FAKE(), chargeId: FAKE() }, mutant: 'min 0.01 loosened to 0' },
  { title: 'customers writeOffChargeAction: a blank reason', mod: 'customers/actions', action: 'writeOffChargeAction', set: CHARGE_WRITE_OFF_RULES, rule: 'reason', value: '  ', table: 'ar_charges', extra: { customerId: FAKE(), chargeId: FAKE() } },
  { title: 'customers createPriceListAction: a blank name', mod: 'customers/actions', action: 'createPriceListAction', set: PRICE_LIST_ADD_RULES, rule: 'name', value: '  ', table: 'price_lists' },
  { title: 'customers setPriceAction: a negative rate', mod: 'customers/actions', action: 'setPriceAction', set: PRICE_SET_RULES, rule: 'rate', value: '-1', table: 'price_list_items', extra: { priceListId: FAKE() }, mutant: 'rate min 0 dropped' },
  { title: 'customers setPriceAction: no item picked', mod: 'customers/actions', action: 'setPriceAction', set: PRICE_SET_RULES, rule: 'itemId', value: '  ', table: 'price_list_items', extra: { priceListId: FAKE() } },
  // ---- liabilities
  { title: 'liabilities createLiabilityAction: a blank name', mod: 'liabilities/actions', action: 'createLiabilityAction', set: LIABILITY_ADD_RULES, rule: 'name', value: '  ', table: 'liabilities' },
  { title: 'liabilities createLiabilityAction: a due date that is not a date', mod: 'liabilities/actions', action: 'createLiabilityAction', set: LIABILITY_ADD_RULES, rule: 'dueOn', value: 'soon', table: 'liabilities' },
  { title: 'liabilities chargeAction: a charge of 0', mod: 'liabilities/actions', action: 'chargeAction', set: LIABILITY_CHARGE_RULES, rule: 'amount', value: '0', table: 'journal_entries', extra: { liabilityId: FAKE() }, mutant: 'min 0.01 loosened to 0' },
  { title: 'liabilities chargeAction: nothing chosen for what it was for', mod: 'liabilities/actions', action: 'chargeAction', set: LIABILITY_CHARGE_RULES, rule: 'againstAccountCode', value: '  ', table: 'journal_entries', extra: { liabilityId: FAKE() } },
  { title: 'liabilities payAction: a payment of 0', mod: 'liabilities/actions', action: 'payAction', set: LIABILITY_PAY_RULES, rule: 'amount', value: '0', table: 'journal_entries', extra: { liabilityId: FAKE() }, mutant: 'min 0.01 loosened to 0' },
  { title: 'liabilities payAction: no account to pay from', mod: 'liabilities/actions', action: 'payAction', set: LIABILITY_PAY_RULES, rule: 'fromMoneyAccountId', value: '  ', table: 'journal_entries', extra: { liabilityId: FAKE() } },
  // ---- loans
  { title: 'loans createLoanAction: a blank loan name (asserted in the domain, after the gate)', mod: 'loans/actions', action: 'createLoanAction', set: LOAN_ADD_RULES, rule: 'name', value: '  ', table: 'loans', good: { interestRate: '12' } },
  { title: 'loans createLoanAction: a 121-character lender', mod: 'loans/actions', action: 'createLoanAction', set: LOAN_ADD_RULES, rule: 'lenderName', value: 'x'.repeat(121), table: 'loans', good: { interestRate: '12' }, mutant: 'max 120 dropped' },
  { title: 'loans createLoanAction: an interest rate with five decimals', mod: 'loans/actions', action: 'createLoanAction', set: LOAN_ADD_RULES, rule: 'interestRate', value: '1.23456', table: 'loans', good: { interestRate: '12' }, mutant: 'rate pattern loosened' },
  { title: 'loans createLoanAction: 0 payments', mod: 'loans/actions', action: 'createLoanAction', set: LOAN_ADD_RULES, rule: 'termPeriods', value: '0', table: 'loans', good: { interestRate: '12' }, mutant: 'termPeriods min 1 dropped' },
  { title: 'loans disburseLoanAction: a draw of 0', mod: 'loans/actions', action: 'disburseLoanAction', set: LOAN_DRAW_RULES, rule: 'amount', value: '0', table: 'journal_entries', extra: { loanId: FAKE() }, mutant: 'min 0.01 loosened to 0' },
  { title: 'loans disburseLoanAction: no account', mod: 'loans/actions', action: 'disburseLoanAction', set: LOAN_DRAW_RULES, rule: 'intoMoneyAccountId', value: '  ', table: 'journal_entries', extra: { loanId: FAKE() } },
  { title: 'loans recordPaymentAction: a payment of 0', mod: 'loans/actions', action: 'recordPaymentAction', set: LOAN_PAYMENT_RULES, rule: 'amount', value: '0', table: 'journal_entries', extra: { loanId: FAKE() }, mutant: 'min 0.01 loosened to 0' },
  { title: 'loans recordPaymentAction: a payment date that is not a date', mod: 'loans/actions', action: 'recordPaymentAction', set: LOAN_PAYMENT_RULES, rule: 'on', value: 'soon', table: 'journal_entries', extra: { loanId: FAKE() } },
  { title: 'loans reverseEntryAction: a blank reason', mod: 'loans/actions', action: 'reverseEntryAction', set: LOAN_REVERSE_RULES, rule: 'reason', value: '  ', table: 'journal_entries', extra: { loanId: FAKE(), entryId: FAKE() } },
  // ---- prepaid
  { title: 'prepaid createPrepaidItemAction: a blank name (asserted in the domain, after the gate)', mod: 'prepaid/actions', action: 'createPrepaidItemAction', set: PREPAID_ADD_RULES, rule: 'name', value: '  ', table: 'prepaid_items', extra: { category: 'insurance' } },
  { title: 'prepaid createPrepaidItemAction: a total cost of 0', mod: 'prepaid/actions', action: 'createPrepaidItemAction', set: PREPAID_ADD_RULES, rule: 'totalCost', value: '0', table: 'prepaid_items', extra: { category: 'insurance' }, mutant: 'min 0.01 loosened to 0' },
  { title: 'prepaid createPrepaidItemAction: 121 months of coverage', mod: 'prepaid/actions', action: 'createPrepaidItemAction', set: PREPAID_ADD_RULES, rule: 'coverageMonths', value: '121', table: 'prepaid_items', extra: { category: 'insurance' }, mutant: 'max 120 dropped' },
  { title: 'prepaid amortiseAction: a release month of 2026-13', mod: 'prepaid/actions', action: 'amortiseAction', set: PREPAID_RELEASE_RULES, rule: 'asOfPeriod', value: '2026-13', table: 'journal_entries', extra: { prepaidItemId: FAKE() }, good: { asOfPeriod: '2026-10' }, mutant: 'month pattern loosened' },
  { title: 'prepaid confirmTermAction: 0 months (asserted in the domain, after the gate)', mod: 'prepaid/actions', action: 'confirmTermAction', set: PREPAID_TERM_RULES, rule: 'coverageMonths', value: '0', table: 'prepaid_items', extra: { prepaidItemId: FAKE() }, mutant: 'min 1 dropped' },
  { title: 'prepaid confirmTermAction: a start date that is not a date', mod: 'prepaid/actions', action: 'confirmTermAction', set: PREPAID_TERM_RULES, rule: 'coverageStartDate', value: 'soon', table: 'prepaid_items', extra: { prepaidItemId: FAKE() } },
  { title: 'prepaid reverseMonthAction: a blank reason', mod: 'prepaid/actions', action: 'reverseMonthAction', set: PREPAID_MONTH_REVERSE_RULES, rule: 'reason', value: '  ', table: 'journal_entries', extra: { prepaidItemId: FAKE(), period: '2026-10' } },
  { title: 'prepaid writeOffAction: a 201-character reason', mod: 'prepaid/actions', action: 'writeOffAction', set: PREPAID_WRITE_OFF_RULES, rule: 'reason', value: 'x'.repeat(201), table: 'journal_entries', extra: { prepaidItemId: FAKE() }, mutant: 'max 200 dropped' },
  { title: 'prepaid writeOffAction: a negative refund', mod: 'prepaid/actions', action: 'writeOffAction', set: PREPAID_WRITE_OFF_RULES, rule: 'refundAmount', value: '-1', table: 'journal_entries', extra: { prepaidItemId: FAKE() } },
  // ---- trade
  { title: 'trade/orders createOrderAction: no customer', mod: 'trade/orders/actions', action: 'createOrderAction', set: TRADE_ORDER_RULES, rule: 'customerId', value: '  ', table: 'trade_orders' },
  { title: 'trade/orders createOrderAction: a negative delivery fee', mod: 'trade/orders/actions', action: 'createOrderAction', set: TRADE_ORDER_RULES, rule: 'deliveryFee', value: '-1', table: 'trade_orders' },
  { title: 'trade/orders dispatchOrderAction: an amount paid now of 0', mod: 'trade/orders/actions', action: 'dispatchOrderAction', set: TRADE_DISPATCH_RULES, rule: 'payNowAmount', value: '0', table: 'ar_collections', extra: { orderId: FAKE() }, mutant: 'min 0.01 loosened to 0' },
  { title: 'trade/orders receiveOrderAction: a received-on date that is not a date', mod: 'trade/orders/actions', action: 'receiveOrderAction', set: TRADE_RECEIVE_RULES, rule: 'receivedOn', value: 'soon', table: 'trade_orders', extra: { orderId: FAKE() }, mutant: 'optional date never checked when typed' },
  { title: 'trade/orders voidOrderAction: a blank reason', mod: 'trade/orders/actions', action: 'voidOrderAction', set: TRADE_VOID_RULES, rule: 'reason', value: '  ', table: 'trade_orders', extra: { orderId: FAKE() } },
  { title: 'trade/returns recordReturnAction: a quantity of 0', mod: 'trade/returns/actions', action: 'recordReturnAction', set: RETURN_RECORD_RULES, rule: 'quantity', value: '0', table: 'customer_returns', good: { quantity: '1' }, extra: { tradeOrderId: FAKE(), tradeOrderLineId: FAKE() }, mutant: 'quantity pattern loosened to allow zero' },
  { title: 'trade/returns recordReturnAction: a quantity with four decimals', mod: 'trade/returns/actions', action: 'recordReturnAction', set: RETURN_RECORD_RULES, rule: 'quantity', value: '1.2345', table: 'customer_returns', good: { quantity: '1' }, extra: { tradeOrderId: FAKE(), tradeOrderLineId: FAKE() }, mutant: 'three-decimal cap dropped' },
  { title: 'trade/returns recordReturnAction: a blank reason', mod: 'trade/returns/actions', action: 'recordReturnAction', set: RETURN_RECORD_RULES, rule: 'reason', value: '  ', table: 'customer_returns', good: { quantity: '1' }, extra: { tradeOrderId: FAKE(), tradeOrderLineId: FAKE() } },
  { title: 'trade/returns voidReturnAction: a blank reason', mod: 'trade/returns/actions', action: 'voidReturnAction', set: RETURN_VOID_RULES, rule: 'reason', value: '  ', table: 'customer_returns', extra: { returnId: FAKE() } },
];

describe('T-440 S4: a bad value is refused with the rule sentence and nothing is written', () => {
  for (const c of CASES) {
    it(`${c.title} (mutant: ${c.mutant ?? 'assertFieldRules removed from the action'})`, async () => {
      const f = await fixture();
      const rule = (c.set as unknown as Record<string, FieldRule>)[c.rule];
      if (!rule) throw new Error(`${c.set.form} has no rule ${c.rule}`);
      const before = await count(c.table, f.orgId);

      const mod = (await import(/* @vite-ignore */ `${APP}/${c.mod}`)) as Record<string, (fd: FormData) => Promise<void>>;
      const act = mod[c.action];
      if (!act) throw new Error(`${c.mod} exports no ${c.action}`);
      resetJar();
      h.actor = f.admin;
      const fd = new FormData();
      const fields = { storeId: f.storeId, ...(c.extra ?? {}), ...goodFields(c.set, c.good), [c.rule]: c.value };
      for (const [k, v] of Object.entries(fields)) fd.set(k, v);
      const o = outcomeOf(await captureRedirect(() => act(fd)));

      expect(o.flash.error).toBe(sentence(rule, c.value));
      expect(await count(c.table, f.orgId)).toBe(before);
    });
  }
});
