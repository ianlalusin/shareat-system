import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-440 S6 (TESTER) - one refusal per S6 action whose rule set the sweep wired into the SERVER path (Q5: a field marked required or
 * bounded on screen but never checked by the action). Each case runs the REAL server action with ONE bad value (every other field of
 * the rule set good, so that rule is the first to fail) and proves two things: the person is told the rule's exact sentence (read
 * from the imported rule set, never a copy) and NOTHING was written (the action's own table keeps its row count).
 *
 * Not covered here, by construction: voidExpenseAction, voidStatutoryDiscountAction, voidSalesDayAction and disposeAssetAction load
 * the target record BEFORE the field check (a destructive-action guard), so a made-up id is refused by the guard first; their
 * sentences are pinned by the unit parity fixture (apps/erp/tests/t440-s6-money-rules.test.ts).
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
import { asOrgOn } from './_fixtures/pos-s6';
import { createMoneyTransfer } from '@shareat/domain';
import { checkField, rulesOf, type FieldRule, type FieldRuleSetLike } from '../../src/field-rules/check';
import {
  CASH_REQUEST_CREATE_RULES, CASH_REQUEST_APPROVE_RULES, CASH_REQUEST_REFUSE_RULES, CASH_REQUEST_RELEASE_RULES, CASH_REQUEST_SETTLE_RULES,
} from '../../src/field-rules/cash-requests';
import { CHANNEL_SETTLEMENT_RECORD_RULES, CHANNEL_SETTLEMENT_VOID_RULES, CHANNEL_PAYOUT_DESTINATION_RULES } from '../../src/field-rules/channel-settlements';
import { EXPENSE_CREATE_RULES, EXPENSE_REIMBURSEMENT_RULES, RECURRING_TEMPLATE_RULES } from '../../src/field-rules/expenses';
import { MONEY_ACCOUNT_CREATE_RULES, MONEY_ACCOUNT_RENAME_RULES } from '../../src/field-rules/money-accounts';
import { TRANSFER_RECORD_RULES, TRANSFER_SETTLE_RULES, TRANSFER_VOID_RULES } from '../../src/field-rules/money-transfers';
import { REMITTANCE_RECORD_RULES, REMITTANCE_REVERSE_RULES, CASH_POLICY_RULES } from '../../src/field-rules/remittance';
import { SALES_DAY_CREATE_RULES, SALES_DAY_CORRECTION_RULES } from '../../src/field-rules/sales-days';
import { SERVICE_CHARGE_DISTRIBUTE_RULES } from '../../src/field-rules/service-charge';
import { STATUTORY_DISCOUNT_RECORD_RULES } from '../../src/field-rules/statutory-discounts';
import { TILL_OPEN_SHIFT_RULES } from '../../src/field-rules/till';
import { BUDGET_CAP_RULES } from '../../src/field-rules/budgets';
import { ASSET_CREATE_RULES, ASSET_TERMS_RULES, ASSET_IN_SERVICE_RULES } from '../../src/field-rules/fixed-assets';

const sql = postgres(url, { max: 5 });
const APP = '../../../../apps/erp/src/app';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function createFixture() {
  const f = await moneyFixture(sql, 't440s6');
  const [office] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${f.storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  const transfer = await asOrgOn(f.orgId, (tx) => createMoneyTransfer(tx, f.admin, { fromMoneyAccountId: f.drawerId, toMoneyAccountId: office!.id, amountOut: '10.00', amountIn: '10.00', transferDate: '2026-01-10' }));
  // Requested cash and draft settlement/template records exist before their authorized bad-field posts.
  const [request] = await sql<{ id: string }[]>`insert into cash_requests (org_id, store_id, requested_for, purpose, requested_amount, requested_on, created_by) values (${f.orgId}, ${f.storeId}, ${f.staffId}, 'Synthetic float', '100.00', '2026-01-10', ${f.adminId}) returning id`;
  const [day] = await sql<{ id: string }[]>`insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by) values (${f.orgId}, ${f.storeId}, '2026-01-10', '0', '0', '0', ${f.adminId}) returning id`;
  const [channel] = await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code) values (${f.orgId}, ${f.storeId}, 'Synthetic channel', false, '1220') returning id`;
  const [settlement] = await sql<{ id: string }[]>`insert into channel_settlements (org_id, store_id, channel_id, sales_day_id, business_date, gross_amount, outstanding_cleared, net_deposited, destination_money_account_id, settled_on, created_by) values (${f.orgId}, ${f.storeId}, ${channel!.id}, ${day!.id}, '2026-01-10', '0', '0', '0', ${office!.id}, '2026-01-10', ${f.adminId}) returning id`;
  const [template] = await sql<{ id: string }[]>`insert into recurring_expenses (org_id, store_id, name, category_id, supplier_id, default_amount, interval, anchor_day, starts_on, next_due_date, created_by) values (${f.orgId}, ${f.storeId}, 'Synthetic template', ${f.categoryId}, ${f.supplierId}, '100.00', 'monthly', 1, '2026-01-01', '2026-02-01', ${f.adminId}) returning id`;
  const [remittance] = await sql<{ id: string }[]>`insert into remittances (org_id, store_id, remitted_on, created_by) values (${f.orgId}, ${f.storeId}, '2026-01-10', ${f.adminId}) returning id`;
  return { ...f, requestedFor: f.staffId, fromMoneyAccountId: f.drawerId, toMoneyAccountId: office!.id, requestId: request!.id, channelId: channel!.id, settlementId: settlement!.id, templateId: template!.id, moneyTransferId: transfer.id, remittanceId: remittance!.id, salesDayId: day!.id };
}
type Fx = Awaited<ReturnType<typeof createFixture>>;
let fxPromise: Promise<Fx> | null = null;
const fixture = () => (fxPromise ??= createFixture());

const GOOD: Record<string, string> = { text: 'Something', money: '500.00', date: '2020-01-02', number: '15', digits: '1234', pattern: 'abc' };

/** Every rule of the set filled with a passing value, so one rule can be broken at a time. */
function goodFields(set: FieldRuleSetLike): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rulesOf(set)) out[r.name] = r.name === 'usefulLifeMonths' ? '60' : (GOOD[r.kind] ?? '');
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
  /** Reads like the title: "<folder> <action>: <what is wrong>". */
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
  mutant?: string;
};

const FAKE = () => randomUUID();
const CASES: Case[] = [
  { title: 'cash-requests createRequestAction: a blank purpose', mod: 'cash-requests/actions', action: 'createRequestAction', set: CASH_REQUEST_CREATE_RULES, rule: 'purpose', value: '  ', table: 'cash_requests' },
  { title: 'cash-requests createRequestAction: an amount of 0', mod: 'cash-requests/actions', action: 'createRequestAction', set: CASH_REQUEST_CREATE_RULES, rule: 'amount', value: '0', table: 'cash_requests', mutant: 'min 0.01 loosened to 0' },
  { title: 'cash-requests decideAction (refuse): a blank reason', mod: 'cash-requests/actions', action: 'decideAction', set: CASH_REQUEST_REFUSE_RULES, rule: 'reason', value: '  ', table: 'cash_requests', extra: { decision: 'reject', requestId: FAKE() } },
  { title: 'cash-requests decideAction (approve): an amount of 0', mod: 'cash-requests/actions', action: 'decideAction', set: CASH_REQUEST_APPROVE_RULES, rule: 'amount', value: '0', table: 'cash_requests', extra: { decision: 'approve', requestId: FAKE() }, mutant: 'approve branch not checked' },
  { title: 'cash-requests releaseAction: no source account', mod: 'cash-requests/actions', action: 'releaseAction', set: CASH_REQUEST_RELEASE_RULES, rule: 'fromMoneyAccountId', value: '  ', table: 'cash_requests', extra: { requestId: FAKE() } },
  { title: 'cash-requests settleAction: a returned amount of 12x', mod: 'cash-requests/actions', action: 'settleAction', set: CASH_REQUEST_SETTLE_RULES, rule: 'returnedAmount', value: '12x', table: 'cash_requests', extra: { requestId: FAKE() } },
  { title: 'channel-settlements recordSettlementAction: a negative amount docked', mod: 'channel-settlements/actions', action: 'recordSettlementAction', set: CHANNEL_SETTLEMENT_RECORD_RULES, rule: 'loanAmount', value: '-1', table: 'channel_settlements', extra: { channelId: FAKE() } },
  { title: 'channel-settlements recordSettlementAction: a settlement date that is not a date', mod: 'channel-settlements/actions', action: 'recordSettlementAction', set: CHANNEL_SETTLEMENT_RECORD_RULES, rule: 'settledOn', value: 'soon', table: 'channel_settlements', extra: { channelId: FAKE() } },
  { title: 'channel-settlements voidSettlementAction: a blank reason', mod: 'channel-settlements/actions', action: 'voidSettlementAction', set: CHANNEL_SETTLEMENT_VOID_RULES, rule: 'reason', value: '  ', table: 'channel_settlements', extra: { settlementId: FAKE() } },
  { title: 'channel-settlements setPayoutDestinationAction: no payout account', mod: 'channel-settlements/actions', action: 'setPayoutDestinationAction', set: CHANNEL_PAYOUT_DESTINATION_RULES, rule: 'moneyAccountId', value: '  ', table: 'sales_channels', extra: { channelId: FAKE() } },
  { title: 'expenses createExpenseAction: blank particulars', mod: 'expenses/actions', action: 'createExpenseAction', set: EXPENSE_CREATE_RULES, rule: 'particulars', value: '  ', table: 'expenses' },
  { title: 'expenses/reimbursements payReimbursementAction: an amount of 0', mod: 'expenses/reimbursements/actions', action: 'payReimbursementAction', set: EXPENSE_REIMBURSEMENT_RULES, rule: 'amount', value: '0', table: 'journal_entries' },
  { title: 'expenses/recurring createTemplateAction: day 32', mod: 'expenses/recurring/actions', action: 'createTemplateAction', set: RECURRING_TEMPLATE_RULES, rule: 'anchorDay', value: '32', table: 'recurring_expenses', mutant: 'max 31 dropped' },
  { title: 'expenses/recurring updateTemplateAction: a blank template name', mod: 'expenses/recurring/actions', action: 'updateTemplateAction', set: RECURRING_TEMPLATE_RULES, rule: 'name', value: '  ', table: 'recurring_expenses', extra: { templateId: FAKE() } },
  { title: 'money-accounts createMoneyAccountAction: a 121-character name', mod: 'money-accounts/actions', action: 'createMoneyAccountAction', set: MONEY_ACCOUNT_CREATE_RULES, rule: 'name', value: 'x'.repeat(121), table: 'money_accounts', mutant: 'max 120 dropped' },
  { title: 'money-accounts renameMoneyAccountAction: a negative overdraft limit', mod: 'money-accounts/actions', action: 'renameMoneyAccountAction', set: MONEY_ACCOUNT_RENAME_RULES, rule: 'overdraftLimit', value: '-1', table: 'money_accounts', extra: { moneyAccountId: FAKE() } },
  { title: 'money-transfers createMoneyTransferAction: an amount that left of 0', mod: 'money-transfers/actions', action: 'createMoneyTransferAction', set: TRANSFER_RECORD_RULES, rule: 'amountOut', value: '0', table: 'money_transfers' },
  { title: 'money-transfers settleBetweenStoresAction: no receiving account', mod: 'money-transfers/actions', action: 'settleBetweenStoresAction', set: TRANSFER_SETTLE_RULES, rule: 'toMoneyAccountId', value: '  ', table: 'money_transfers' },
  { title: 'money-transfers voidMoneyTransferAction: a blank reason', mod: 'money-transfers/actions', action: 'voidMoneyTransferAction', set: TRANSFER_VOID_RULES, rule: 'reason', value: '  ', table: 'money_transfers', extra: { moneyTransferId: FAKE() } },
  { title: 'remittance createRemittanceAction: a handover date that is not a date', mod: 'remittance/actions', action: 'createRemittanceAction', set: REMITTANCE_RECORD_RULES, rule: 'remittedOn', value: 'soon', table: 'remittances' },
  { title: 'remittance reverseRemittanceAction: a blank reason', mod: 'remittance/actions', action: 'reverseRemittanceAction', set: REMITTANCE_REVERSE_RULES, rule: 'reason', value: '  ', table: 'remittances', extra: { remittanceId: FAKE() } },
  { title: 'remittance setCashPolicyAction: a ceiling of 0', mod: 'remittance/actions', action: 'setCashPolicyAction', set: CASH_POLICY_RULES, rule: 'unremittedCeiling', value: '0', table: 'remittances' },
  { title: 'sales-days createSalesDayAction: a business date that is not a date', mod: 'sales-days/actions', action: 'createSalesDayAction', set: SALES_DAY_CREATE_RULES, rule: 'businessDate', value: 'soon', table: 'sales_days' },
  { title: 'sales-days postPosCorrectionAction: a blank reason', mod: 'sales-days/actions', action: 'postPosCorrectionAction', set: SALES_DAY_CORRECTION_RULES, rule: 'reason', value: '  ', table: 'sales_day_pos_corrections', extra: { salesDayId: FAKE(), feedId: FAKE() } },
  { title: 'service-charge distributeAction: an amount of 0', mod: 'service-charge/actions', action: 'distributeAction', set: SERVICE_CHARGE_DISTRIBUTE_RULES, rule: 'amount', value: '0', table: 'journal_entries' },
  { title: 'statutory-discounts recordStatutoryDiscountAction: a blank ID number', mod: 'statutory-discounts/actions', action: 'recordStatutoryDiscountAction', set: STATUTORY_DISCOUNT_RECORD_RULES, rule: 'idNumber', value: '  ', table: 'statutory_discount_records' },
  { title: 'till openShiftAction: a trading date that is not a date', mod: 'till/actions', action: 'openShiftAction', set: TILL_OPEN_SHIFT_RULES, rule: 'businessDate', value: 'soon', table: 'till_custody_shifts' },
  { title: 'budgets setBudgetAction: a negative cap', mod: 'budgets/actions', action: 'setBudgetAction', set: BUDGET_CAP_RULES, rule: 'amount', value: '-1', table: 'expense_budgets' },
  { title: 'fixed-assets createAssetAction: an acquisition date in the future', mod: 'fixed-assets/actions', action: 'createAssetAction', set: ASSET_CREATE_RULES, rule: 'acquiredOn', value: '2999-01-01', table: 'fixed_assets', mutant: 'notAfterToday dropped' },
  { title: 'fixed-assets createAssetAction: a useful life of 1201 months', mod: 'fixed-assets/actions', action: 'createAssetAction', set: ASSET_CREATE_RULES, rule: 'usefulLifeMonths', value: '1201', table: 'fixed_assets', mutant: 'max 1200 dropped' },
  { title: 'fixed-assets updateTermsAction: a useful life of 0', mod: 'fixed-assets/actions', action: 'updateTermsAction', set: ASSET_TERMS_RULES, rule: 'usefulLifeMonths', value: '0', table: 'fixed_assets', extra: { assetId: FAKE() } },
  { title: 'fixed-assets setAssetInServiceAction: a blank reason', mod: 'fixed-assets/actions', action: 'setAssetInServiceAction', set: ASSET_IN_SERVICE_RULES, rule: 'reason', value: '  ', table: 'fixed_assets', extra: { assetId: FAKE(), mode: 'set' } },
];

describe('T-440 S6: a bad value is refused with the rule sentence and nothing is written', () => {
  for (const c of CASES) {
    it(`${c.title} (mutant: ${c.mutant ?? 'assertFieldRules removed from the action'})`, async () => {
      const f = await fixture();
      const rule = (c.set as unknown as Record<string, FieldRule>)[c.rule];
      if (!rule) throw new Error(`${c.set.form} has no rule ${c.rule}`);
      const before = await count(c.table, f.orgId);
      const beforeRows = Array.from(await sql.unsafe(`select * from ${c.table} where org_id = $1 order by id`, [f.orgId]));

      const mod = (await import(/* @vite-ignore */ `${APP}/${c.mod}`)) as Record<string, (fd: FormData) => Promise<void>>;
      const act = mod[c.action];
      if (!act) throw new Error(`${c.mod} exports no ${c.action}`);
      resetJar();
      h.actor = f.admin;
      const fd = new FormData();
      const fields: Record<string, string> = { ...goodFields(c.set), ...(c.extra ?? {}), storeId: f.storeId };
      for (const key of Object.keys(fields)) {
        const real = f[key as keyof Fx];
        if (typeof real === 'string') fields[key] = real;
      }
      if (c.mod === 'money-transfers/actions') {
        fields.fromMoneyAccountId ??= f.fromMoneyAccountId;
        fields.toMoneyAccountId ??= f.toMoneyAccountId;
        if (c.action === 'settleBetweenStoresAction') fields.settlementId = randomUUID();
      }
      fields[c.rule] = c.value;
      for (const [k, v] of Object.entries(fields)) fd.set(k, v);
      const o = outcomeOf(await captureRedirect(() => act(fd)));

      expect(o.flash.error).toBe(sentence(rule, c.value));
      expect(await count(c.table, f.orgId)).toBe(before);
      expect(Array.from(await sql.unsafe(`select * from ${c.table} where org_id = $1 order by id`, [f.orgId]))).toEqual(beforeRows);
    });
  }
});
