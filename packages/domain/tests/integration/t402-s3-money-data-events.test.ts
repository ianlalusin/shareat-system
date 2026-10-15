import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-402 S3 - money steps write their activity-log event IN THE SAME TRANSACTION as the step, after the step's own
 * write and before it returns (docs/tasks/402-activity-log.md "S3 contract" C4, Invariant 19). TESTER, not BUILDER.
 *
 * One test group per built S3 action (C7): expense.drafted / approved / voided, sales_day.submitted / verified,
 * remittance.recorded, cash_request.approved / rejected, ap_invoice.approved, ap_payment.recorded,
 * cutover.step_completed, cutover.opening_entry. For each: (a) the real domain call writes exactly one row with the
 * catalogue's labels and the document's store, (b) a REFUSED or no-op call writes none (mutant: event written
 * before the guards / on a retry), (c) a rolled-back caller transaction leaves none (mutant: writer opens its own tx).
 * The verb-less entries (expense.submitted/rejected, sales_day.reopened, remittance.confirmed) must stay unwritten.
 *
 * ## State at HEAD
 * Every action above is `reserved` in the catalogue and no caller writes it, so each "writes one row" leg is red with
 * "expected 0 to have a length of 1" (and the catalogue guard in packages/db/tests/t402-s1b-catalogue.test.ts goes
 * red on S3_LIVE). The refusal legs are green today by construction and keep guarding the mutants.
 *
 * ## cutover.opening_entry
 * Needs the REAL purge (C2). The lane DB is the tester's alone (fileParallelism is off); the org that needs C2 is
 * created BEFORE the purge in beforeAll (the purge TRUNCATEs the whole database), every other fixture AFTER it.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import * as D from '@shareat/domain';
import { catalogueEntry, retentionFor } from '../../../db/src/audit/catalogue';
import { asOrgOn, s6Fixture } from './_fixtures/pos-s6';
import { mkTypedDay } from './_fixtures/sales-day-flow';
import { auditRows, draftExpense, moneyFixture, pendingInvoice, uid, type AuditRow, type MoneyFx } from './_fixtures/t402-s3-money';
import { realPurge } from '../../../../tests/integration/t390-real-purge';

const sql = postgres(url, { max: 5 });
class Rollback extends Error {}

const rejection = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('NOT REFUSED - the call succeeded');
};
const rolledBack = async (orgId: string, fn: Parameters<typeof asOrgOn>[1]) => {
  try {
    await asOrgOn(orgId, async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
};

/** Labels come from the catalogue, never the call site (Invariant 2). */
function expectLabels(row: AuditRow, action: string, storeId: string | null) {
  const e = catalogueEntry(action)!;
  expect(e, `${action} is in the catalogue`).toBeDefined();
  expect(e.reserved, `${action} is live (S3 flipped it)`).toBe(false);
  expect(row.category).toBe(e.category);
  expect(row.sensitivity).toBe(e.sensitivity);
  expect(row.retention_class).toBe(retentionFor(e.category, e.sensitivity));
  expect(row.entity).toBe(e.entity);
  expect(row.store_id, `${action} is ${e.scope}-scoped`).toBe(e.scope === 'store' ? storeId : null);
}
const statusOf = (v: Record<string, unknown> | null) => (v ? v.status : undefined);
const ATTEST = { supplier: true, invoice: true, items: true, price: true };

let openingFx: MoneyFx; // created before the one real purge (C2)

beforeAll(async () => {
  openingFx = await moneyFixture(sql, 'opening');
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values
    (${openingFx.orgId}, '2026-12-01', '2026-12-31', 'open'), (${openingFx.orgId}, '2027-01-01', '2027-01-31', 'open')`;
  await realPurge(sql, openingFx.adminId);
}, 300_000);
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// ===================================================================================================== expenses
describe('expense.drafted / expense.approved / expense.voided (createExpense, approveExpense, voidExpense)', () => {
  it("createExpense writes ONE expense.drafted at the expense's store, by the creator, status draft, with the amount; the verb-less entries are never written", async () => {
    const f = await moneyFixture(sql, 'exp-draft');
    const inv = await pendingInvoice(sql, f, '5000.00');
    const created = await draftExpense(f, inv, '1200.00');
    const rows = await auditRows(sql, f.orgId, 'expense.drafted', created.id);
    expect(rows, 'exactly one row for one draft').toHaveLength(1);
    expectLabels(rows[0]!, 'expense.drafted', f.storeId);
    expect(rows[0]!.actor_person_id).toBe(f.staffId);
    expect(statusOf(rows[0]!.after)).toBe('draft');
    expect(JSON.stringify(rows[0]!.after), 'the amount rides along').toMatch(/1200(\.00)?/);
    expect(await auditRows(sql, f.orgId, 'expense.approved', created.id)).toHaveLength(0);
    for (const never of ['expense.submitted', 'expense.rejected']) {
      expect(await auditRows(sql, f.orgId, never), `${never} has no verb: never written`).toHaveLength(0);
    }
  });

  it('a refused createExpense (blank particulars) writes no expense.drafted', async () => {
    const f = await moneyFixture(sql, 'exp-draft-refused');
    const inv = await pendingInvoice(sql, f, '5000.00');
    await rejection(
      asOrgOn(f.orgId, (tx) =>
        D.createExpense(tx, f.staff, {
          storeId: f.storeId, businessDate: '', supplierId: f.supplierId, supplierInvoiceId: inv, categoryId: f.categoryId,
          particulars: '   ', payments: [{ method: 'cash', amount: '10.00', moneyAccountId: f.drawerId }],
        }),
      ),
    );
    expect(await auditRows(sql, f.orgId, 'expense.drafted')).toHaveLength(0);
  });

  it('a createExpense inside a transaction that rolls back leaves no expense.drafted (same transaction, not its own)', async () => {
    const f = await moneyFixture(sql, 'exp-draft-rb');
    const inv = await pendingInvoice(sql, f, '5000.00');
    await rolledBack(f.orgId, (tx) =>
      D.createExpense(tx, f.staff, {
        storeId: f.storeId, businessDate: '', supplierId: f.supplierId, supplierInvoiceId: inv, categoryId: f.categoryId,
        particulars: 'Rolled back', payments: [{ method: 'cash', amount: '10.00', moneyAccountId: f.drawerId }],
      }),
    );
    expect(await auditRows(sql, f.orgId, 'expense.drafted')).toHaveLength(0);
    expect((await sql`select 1 from expenses where org_id = ${f.orgId}`).length).toBe(0);
  });

  it('approveExpense (the posting) writes ONE expense.approved, draft -> posted, by the approver; a second approve is a no-op and writes none', async () => {
    const f = await moneyFixture(sql, 'exp-approve');
    const inv = await pendingInvoice(sql, f, '5000.00');
    await asOrgOn(f.orgId, (tx) => D.verifyInvoice(tx, f.manager, inv, ATTEST));
    const created = await draftExpense(f, inv, '1500.00');
    const posted = await asOrgOn(f.orgId, (tx) => D.approveExpense(tx, f.manager, created.id));
    expect(posted.created).toBe(true);
    const rows = await auditRows(sql, f.orgId, 'expense.approved', created.id);
    expect(rows).toHaveLength(1);
    expectLabels(rows[0]!, 'expense.approved', f.storeId);
    expect(rows[0]!.actor_person_id).toBe(f.managerId);
    expect(statusOf(rows[0]!.before)).toBe('draft');
    expect(statusOf(rows[0]!.after)).toBe('posted');
    const again = await asOrgOn(f.orgId, (tx) => D.approveExpense(tx, f.manager, created.id));
    expect(again.created).toBe(false);
    expect(await auditRows(sql, f.orgId, 'expense.approved', created.id), 'a no-op re-approve is not a step').toHaveLength(1);
  });

  it('an approve that is REFUSED (staff lacks approve_expense; a voided expense) writes no expense.approved', async () => {
    const f = await moneyFixture(sql, 'exp-approve-refused');
    const inv = await pendingInvoice(sql, f, '5000.00');
    await asOrgOn(f.orgId, (tx) => D.verifyInvoice(tx, f.manager, inv, ATTEST));
    const denied = await draftExpense(f, inv, '100.00');
    await rejection(asOrgOn(f.orgId, (tx) => D.approveExpense(tx, f.staff, denied.id)));
    expect(await auditRows(sql, f.orgId, 'expense.approved', denied.id)).toHaveLength(0);

    const voided = await draftExpense(f, inv, '200.00');
    await asOrgOn(f.orgId, (tx) => D.approveExpense(tx, f.manager, voided.id));
    await asOrgOn(f.orgId, (tx) => D.voidExpense(tx, f.manager, voided.id, 'Wrong supplier'));
    await rejection(asOrgOn(f.orgId, (tx) => D.approveExpense(tx, f.manager, voided.id)));
    expect(await auditRows(sql, f.orgId, 'expense.approved', voided.id), 'one approve; the refused second one wrote nothing').toHaveLength(1);
  });

  it('approveExpense in a transaction that rolls back leaves no expense.approved', async () => {
    const f = await moneyFixture(sql, 'exp-approve-rb');
    const inv = await pendingInvoice(sql, f, '5000.00');
    await asOrgOn(f.orgId, (tx) => D.verifyInvoice(tx, f.manager, inv, ATTEST));
    const created = await draftExpense(f, inv, '300.00');
    await rolledBack(f.orgId, (tx) => D.approveExpense(tx, f.manager, created.id));
    expect(await auditRows(sql, f.orgId, 'expense.approved', created.id)).toHaveLength(0);
    expect((await sql<{ status: string }[]>`select status from expenses where id = ${created.id}`)[0]!.status).toBe('draft');
  });

  it('voidExpense writes ONE expense.voided, posted -> voided; a refused void (staff) writes none', async () => {
    const f = await moneyFixture(sql, 'exp-void');
    const inv = await pendingInvoice(sql, f, '5000.00');
    await asOrgOn(f.orgId, (tx) => D.verifyInvoice(tx, f.manager, inv, ATTEST));
    const created = await draftExpense(f, inv, '400.00');
    await asOrgOn(f.orgId, (tx) => D.approveExpense(tx, f.manager, created.id));
    await rejection(asOrgOn(f.orgId, (tx) => D.voidExpense(tx, f.staff, created.id, 'staff attempt')));
    expect(await auditRows(sql, f.orgId, 'expense.voided', created.id)).toHaveLength(0);
    await asOrgOn(f.orgId, (tx) => D.voidExpense(tx, f.manager, created.id, 'Wrong supplier'));
    const rows = await auditRows(sql, f.orgId, 'expense.voided', created.id);
    expect(rows).toHaveLength(1);
    expectLabels(rows[0]!, 'expense.voided', f.storeId);
    expect(rows[0]!.actor_person_id).toBe(f.managerId);
    expect(statusOf(rows[0]!.before)).toBe('posted');
    expect(statusOf(rows[0]!.after)).toBe('voided');
  });
});

// ================================================================================================== sales days
describe('sales_day.submitted / sales_day.verified (submitSalesDay, verifySalesDay)', () => {
  async function setup(hint: string) {
    const f = await s6Fixture(sql, `t402s3-${hint}`);
    const typed = await mkTypedDay(sql, f, [f.managerId, f.adminId, f.plainStaffId]);
    return { f, dayId: typed.id, storeId: typed.storeId };
  }

  it("submitSalesDay writes ONE sales_day.submitted at the day's store; verifySalesDay writes ONE sales_day.verified; a no-op re-verify writes none", async () => {
    const { f, dayId, storeId } = await setup('flow');
    await asOrgOn(f.orgId, (tx) => D.submitSalesDay(tx, f.admin, dayId));
    const sub = await auditRows(sql, f.orgId, 'sales_day.submitted', dayId);
    expect(sub).toHaveLength(1);
    expectLabels(sub[0]!, 'sales_day.submitted', storeId);
    expect(sub[0]!.actor_person_id).toBe(f.adminId);
    expect(statusOf(sub[0]!.before)).toBe('open');
    expect(statusOf(sub[0]!.after)).toBe('submitted');
    expect(await auditRows(sql, f.orgId, 'sales_day.verified', dayId), 'submit alone does not verify').toHaveLength(0);

    const res = await asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, f.manager, dayId));
    expect(res.created).toBe(true);
    const ver = await auditRows(sql, f.orgId, 'sales_day.verified', dayId);
    expect(ver).toHaveLength(1);
    expectLabels(ver[0]!, 'sales_day.verified', storeId);
    expect(ver[0]!.actor_person_id).toBe(f.managerId);
    expect(statusOf(ver[0]!.before)).toBe('submitted');
    expect(statusOf(ver[0]!.after)).toBe('verified');

    const again = await asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, f.manager, dayId));
    expect(again.created).toBe(false);
    expect(await auditRows(sql, f.orgId, 'sales_day.verified', dayId), 'a no-op re-verify is not a step').toHaveLength(1);
    expect(await auditRows(sql, f.orgId, 'sales_day.reopened'), 'no reopen verb exists: never written').toHaveLength(0);
  });

  it('a REFUSED verify (open day not submitted; the submitter verifying their own day) writes no sales_day.verified', async () => {
    const { f, dayId } = await setup('refused');
    await rejection(asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, f.manager, dayId)));
    expect(await auditRows(sql, f.orgId, 'sales_day.verified', dayId)).toHaveLength(0);
    await asOrgOn(f.orgId, (tx) => D.submitSalesDay(tx, f.manager, dayId));
    await rejection(asOrgOn(f.orgId, (tx) => D.verifySalesDay(tx, f.manager, dayId)));
    expect(await auditRows(sql, f.orgId, 'sales_day.verified', dayId)).toHaveLength(0);
  });

  it('a submit / verify inside a transaction that rolls back leaves no event', async () => {
    const { f, dayId } = await setup('rb');
    await rolledBack(f.orgId, (tx) => D.submitSalesDay(tx, f.admin, dayId));
    expect(await auditRows(sql, f.orgId, 'sales_day.submitted', dayId)).toHaveLength(0);
    await asOrgOn(f.orgId, (tx) => D.submitSalesDay(tx, f.admin, dayId));
    await rolledBack(f.orgId, (tx) => D.verifySalesDay(tx, f.manager, dayId));
    expect(await auditRows(sql, f.orgId, 'sales_day.verified', dayId)).toHaveLength(0);
  });
});

// =================================================================================================== remittance
describe('remittance.recorded (createRemittance)', () => {
  async function remitFixture(hint: string) {
    const code = uid(`t402s3-rem-${hint}`);
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const orgId = org!.id;
    const { seedChartOfAccounts } = await import('../../../db/seed/chart-of-accounts');
    await seedChartOfAccounts(sql, orgId);
    const [store] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid(hint)}, 'S', '2020-01-01') returning id`;
    const storeId = store!.id;
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    const [till] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
    const [safe] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
    await sql`insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by)
      values (${orgId}, ${storeId}, '2026-01-01', 'verified', '0', '0', '0', ${p!.id})`;
    const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} limit 1`;
    await sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
        values (${orgId}, '2026-01-01', ${period!.id}, 'sale', ${uid('src')}, 'draft') returning id`;
      const [cash] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '1110'`;
      const [rev] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '4100'`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${cash!.id}, ${storeId}, '10000.00', '0')`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${rev!.id}, ${storeId}, '0', '10000.00')`;
      await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
    });
    return { orgId, storeId, adminId: p!.id, admin: { personId: p!.id, orgId }, till: till!.id, safe: safe!.id };
  }

  it('createRemittance writes ONE remittance.recorded at the store, by the accepting admin, with the amount handed over', async () => {
    const f = await remitFixture('ok');
    const r = await asOrgOn(f.orgId, (tx) =>
      D.createRemittance(tx, f.admin, {
        storeId: f.storeId, remittedOn: '2026-01-02',
        lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '10000.00' }],
      }),
    );
    const rows = await auditRows(sql, f.orgId, 'remittance.recorded', r.id);
    expect(rows, 'one row per remittance').toHaveLength(1);
    expectLabels(rows[0]!, 'remittance.recorded', f.storeId);
    expect(rows[0]!.actor_person_id).toBe(f.adminId);
    expect(JSON.stringify(rows[0]!.after)).toMatch(/10000(\.00)?/);
    expect(await auditRows(sql, f.orgId, 'remittance.confirmed'), 'posted on create: no separate confirm verb').toHaveLength(0);
  });

  it('a refused createRemittance (no lines) and a rolled-back one write no event', async () => {
    const f = await remitFixture('refused');
    await rejection(asOrgOn(f.orgId, (tx) => D.createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-02', lines: [] })));
    await rolledBack(f.orgId, (tx) =>
      D.createRemittance(tx, f.admin, {
        storeId: f.storeId, remittedOn: '2026-01-02',
        lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '5000.00' }],
      }),
    );
    expect(await auditRows(sql, f.orgId, 'remittance.recorded')).toHaveLength(0);
    expect((await sql`select 1 from remittances where org_id = ${f.orgId}`).length).toBe(0);
  });
});

// =============================================================================================== cash requests
describe('cash_request.approved / cash_request.rejected (decideCashRequest, one ternary action)', () => {
  async function ask(f: MoneyFx, amount = '2000.00') {
    return asOrgOn(f.orgId, (tx) =>
      D.createCashRequest(tx, f.staff, { storeId: f.storeId, requestedFor: f.staffId, purpose: 'Market run', amount, on: '2026-01-05' }),
    );
  }

  it("approve writes ONE cash_request.approved (requested -> approved, with the amount); reject writes ONE cash_request.rejected; neither writes the other's event", async () => {
    const f = await moneyFixture(sql, 'cr');
    const a = await ask(f);
    await asOrgOn(f.orgId, (tx) => D.decideCashRequest(tx, f.manager, { requestId: a.id, decision: 'approve', amount: '1800.00', on: '2026-01-05' }));
    const ap = await auditRows(sql, f.orgId, 'cash_request.approved', a.id);
    expect(ap).toHaveLength(1);
    expectLabels(ap[0]!, 'cash_request.approved', f.storeId);
    expect(ap[0]!.actor_person_id).toBe(f.managerId);
    expect(statusOf(ap[0]!.before)).toBe('requested');
    expect(statusOf(ap[0]!.after)).toBe('approved');
    expect(JSON.stringify(ap[0]!.after)).toMatch(/1800(\.00)?/);
    expect(await auditRows(sql, f.orgId, 'cash_request.rejected', a.id)).toHaveLength(0);

    const r = await ask(f, '900.00');
    await asOrgOn(f.orgId, (tx) => D.decideCashRequest(tx, f.manager, { requestId: r.id, decision: 'reject', reason: 'Not this week', on: '2026-01-05' }));
    const rj = await auditRows(sql, f.orgId, 'cash_request.rejected', r.id);
    expect(rj).toHaveLength(1);
    expectLabels(rj[0]!, 'cash_request.rejected', f.storeId);
    expect(statusOf(rj[0]!.before)).toBe('requested');
    expect(statusOf(rj[0]!.after)).toBe('rejected');
    expect(await auditRows(sql, f.orgId, 'cash_request.approved', r.id)).toHaveLength(0);
  });

  it('a refused decision (staff; an already-decided request; an empty reason) writes nothing; a rolled-back one writes nothing', async () => {
    const f = await moneyFixture(sql, 'cr-refused');
    const a = await ask(f);
    await rejection(asOrgOn(f.orgId, (tx) => D.decideCashRequest(tx, f.staff, { requestId: a.id, decision: 'approve', amount: '1.00' })));
    await rejection(asOrgOn(f.orgId, (tx) => D.decideCashRequest(tx, f.manager, { requestId: a.id, decision: 'reject', reason: '   ' })));
    await rolledBack(f.orgId, (tx) => D.decideCashRequest(tx, f.manager, { requestId: a.id, decision: 'approve', amount: '2000.00', on: '2026-01-05' }));
    expect(await auditRows(sql, f.orgId, 'cash_request.approved', a.id)).toHaveLength(0);
    expect(await auditRows(sql, f.orgId, 'cash_request.rejected', a.id)).toHaveLength(0);
    await asOrgOn(f.orgId, (tx) => D.decideCashRequest(tx, f.manager, { requestId: a.id, decision: 'approve', amount: '2000.00', on: '2026-01-05' }));
    await rejection(asOrgOn(f.orgId, (tx) => D.decideCashRequest(tx, f.manager, { requestId: a.id, decision: 'reject', reason: 'changed my mind' })));
    expect(await auditRows(sql, f.orgId, 'cash_request.approved', a.id)).toHaveLength(1);
    expect(await auditRows(sql, f.orgId, 'cash_request.rejected', a.id), 'the refused second decision wrote nothing').toHaveLength(0);
  });
});

// ============================================================================================ accounts payable
describe('ap_invoice.approved (verifyInvoice) and ap_payment.recorded (recordPayment)', () => {
  it("verifyInvoice writes ONE ap_invoice.approved (pending -> verified) at the invoice's store; its inner approveExpense also writes expense.approved (both are steps)", async () => {
    const f = await moneyFixture(sql, 'apinv');
    const inv = await pendingInvoice(sql, f, '3000.00');
    const draft = await draftExpense(f, inv, '1000.00');
    await asOrgOn(f.orgId, (tx) => D.verifyInvoice(tx, f.manager, inv, ATTEST));
    const rows = await auditRows(sql, f.orgId, 'ap_invoice.approved', inv);
    expect(rows).toHaveLength(1);
    expectLabels(rows[0]!, 'ap_invoice.approved', f.storeId);
    expect(rows[0]!.actor_person_id).toBe(f.managerId);
    expect(statusOf(rows[0]!.before)).toBe('pending');
    expect(statusOf(rows[0]!.after)).toBe('verified');
    expect(await auditRows(sql, f.orgId, 'expense.approved', draft.id), 'the draft the verification posted').toHaveLength(1);
  });

  it('a refused verification (incomplete attestation; the logger verifying their own invoice) writes no ap_invoice.approved, nor does a rolled-back one', async () => {
    const f = await moneyFixture(sql, 'apinv-refused');
    const inv = await pendingInvoice(sql, f, '3000.00');
    await rejection(asOrgOn(f.orgId, (tx) => D.verifyInvoice(tx, f.manager, inv, { ...ATTEST, price: false })));
    await rejection(asOrgOn(f.orgId, (tx) => D.verifyInvoice(tx, f.staff, inv, ATTEST)));
    await rolledBack(f.orgId, (tx) => D.verifyInvoice(tx, f.manager, inv, ATTEST));
    expect(await auditRows(sql, f.orgId, 'ap_invoice.approved', inv)).toHaveLength(0);
    expect((await sql<{ status: string }[]>`select status from supplier_invoices where id = ${inv}`)[0]!.status).toBe('pending');
  });

  async function openCreditItem(f: MoneyFx, amount: string) {
    const inv = await pendingInvoice(sql, f, amount);
    await asOrgOn(f.orgId, (tx) => D.verifyInvoice(tx, f.manager, inv, ATTEST));
    return asOrgOn(f.orgId, (tx) =>
      D.recordExpenseForInvoice(tx, f.manager, {
        storeId: f.storeId, supplierId: f.supplierId, supplierInvoiceId: inv, categoryId: f.categoryId,
        particulars: 'Credit stock', payments: [{ method: 'credit', amount }],
      }),
    );
  }

  it('recordPayment writes ONE ap_payment.recorded (entity = the payment) at the store, with the amount; a refused payment (no allocations) and a rolled-back one write none', async () => {
    const f = await moneyFixture(sql, 'appay');
    const { expenseId } = await openCreditItem(f, '6000.00');
    const base = { storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-15', amount: '4000.00', moneyAccountId: f.drawerId };
    await rejection(asOrgOn(f.orgId, (tx) => D.recordPayment(tx, f.manager, { ...base, allocations: [] })));
    await rolledBack(f.orgId, (tx) => D.recordPayment(tx, f.manager, { ...base, allocations: [{ expenseId, amountApplied: '4000.00' }] }));
    expect(await auditRows(sql, f.orgId, 'ap_payment.recorded')).toHaveLength(0);

    const paid = await asOrgOn(f.orgId, (tx) => D.recordPayment(tx, f.manager, { ...base, allocations: [{ expenseId, amountApplied: '4000.00' }] }));
    const rows = await auditRows(sql, f.orgId, 'ap_payment.recorded', paid.paymentId);
    expect(rows).toHaveLength(1);
    expectLabels(rows[0]!, 'ap_payment.recorded', f.storeId);
    expect(rows[0]!.actor_person_id).toBe(f.managerId);
    expect(JSON.stringify(rows[0]!.after)).toMatch(/4000(\.00)?/);
  });
});

// ============================================================================================= cutover (domain)
describe('cutover.step_completed (attestStep) and cutover.opening_entry (postOpeningBalances)', () => {
  it('attestStep writes ONE cutover.step_completed (org-scoped: store null) by the admin; a refused attest (staff; a step that cannot be ticked by hand) and a rolled-back one write none', async () => {
    const f = await moneyFixture(sql, 'cut-step');
    await rejection(asOrgOn(f.orgId, (tx) => D.attestStep(tx, f.staff, { stepCode: 'A3' })));
    await rejection(asOrgOn(f.orgId, (tx) => D.attestStep(tx, f.admin, { stepCode: 'C4' })));
    await rolledBack(f.orgId, (tx) => D.attestStep(tx, f.admin, { stepCode: 'A1', note: 'rolled back' }));
    expect(await auditRows(sql, f.orgId, 'cutover.step_completed')).toHaveLength(0);

    await asOrgOn(f.orgId, (tx) => D.attestStep(tx, f.admin, { stepCode: 'A1', note: 'Backlog cleared in v1.' }));
    const rows = await auditRows(sql, f.orgId, 'cutover.step_completed');
    expect(rows).toHaveLength(1);
    expectLabels(rows[0]!, 'cutover.step_completed', null);
    expect(rows[0]!.actor_person_id).toBe(f.adminId);
    expect(rows[0]!.store_id).toBeNull();
    expect(JSON.stringify(rows[0]!.after)).toContain('A1');
  });

  it('postOpeningBalances writes ONE cutover.opening_entry (critical, 10-year, org-scoped); a refused post (3900 residual) and a rolled-back one write none', async () => {
    const f = openingFx;
    const DATE = '2027-01-01';
    const fig = (code: string, direction: 'debit' | 'credit', amount: string) =>
      asOrgOn(f.orgId, (tx) => D.addOpeningFigure(tx, f.admin, { accountCode: code, storeId: f.storeId, direction, amount, entryDate: DATE }));
    await fig('1110', 'debit', '5000.00');
    await asOrgOn(f.orgId, (tx) => D.attestStep(tx, f.admin, { stepCode: 'C3P', note: 'T-402 S3 fixture' }));
    await rejection(asOrgOn(f.orgId, (tx) => D.postOpeningBalances(tx, f.admin))); // 3900 residual: no plug
    expect(await auditRows(sql, f.orgId, 'cutover.opening_entry')).toHaveLength(0);
    await fig('1130', 'credit', '5000.00');
    await rolledBack(f.orgId, (tx) => D.postOpeningBalances(tx, f.admin));
    expect(await auditRows(sql, f.orgId, 'cutover.opening_entry')).toHaveLength(0);

    const res = await asOrgOn(f.orgId, (tx) => D.postOpeningBalances(tx, f.admin));
    expect(res.posted).toBe(2);
    const rows = await auditRows(sql, f.orgId, 'cutover.opening_entry');
    expect(rows, 'one event for the one posting').toHaveLength(1);
    expectLabels(rows[0]!, 'cutover.opening_entry', null);
    expect(rows[0]!.sensitivity).toBe('critical');
    expect(rows[0]!.retention_class).toBe('r10y');
    expect(rows[0]!.actor_person_id).toBe(f.adminId);
  });
});

// ========================================================================================== free-text cap (audit 6)
// ORCHESTRATOR RULING (T-402 S3 audit finding 6): free-text fields kept in `after` are capped at 500 characters, stored as
// the first 500 chars + "…[truncated]". Free text recorded by S3 events: expense.voided `reason`, cash_request.rejected
// `reason`, cutover.step_completed `note`. A short text is stored unchanged.
describe('free text in an S3 event payload is capped at 500 characters + "…[truncated]" (audit finding 6)', () => {
  const MARK = '…[truncated]';
  const long = Array.from({ length: 2000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
  const capped = long.slice(0, 500) + MARK;

  it('expense.voided: a 2,000-char reason is stored as the first 500 chars + the marker (mutant: stored whole, or cut with no marker)', async () => {
    const f = await moneyFixture(sql, 'cap-void');
    const inv = await pendingInvoice(sql, f, '5000.00');
    await asOrgOn(f.orgId, (tx) => D.verifyInvoice(tx, f.manager, inv, ATTEST));
    const created = await draftExpense(f, inv, '400.00');
    await asOrgOn(f.orgId, (tx) => D.approveExpense(tx, f.manager, created.id));
    await asOrgOn(f.orgId, (tx) => D.voidExpense(tx, f.manager, created.id, long));
    const rows = await auditRows(sql, f.orgId, 'expense.voided', created.id);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.after as Record<string, unknown>).reason).toBe(capped);
  });

  it('cash_request.rejected: a 2,000-char reason is capped the same way; a short reason is stored unchanged', async () => {
    const f = await moneyFixture(sql, 'cap-cr');
    const mk = () => asOrgOn(f.orgId, (tx) => D.createCashRequest(tx, f.staff, { storeId: f.storeId, requestedFor: f.staffId, purpose: 'Market run', amount: '900.00', on: '2026-01-05' }));
    const a = await mk();
    await asOrgOn(f.orgId, (tx) => D.decideCashRequest(tx, f.manager, { requestId: a.id, decision: 'reject', reason: long, on: '2026-01-05' }));
    const b = await mk();
    await asOrgOn(f.orgId, (tx) => D.decideCashRequest(tx, f.manager, { requestId: b.id, decision: 'reject', reason: 'Not this week', on: '2026-01-05' }));
    expect(((await auditRows(sql, f.orgId, 'cash_request.rejected', a.id))[0]!.after as Record<string, unknown>).reason).toBe(capped);
    expect(((await auditRows(sql, f.orgId, 'cash_request.rejected', b.id))[0]!.after as Record<string, unknown>).reason).toBe('Not this week');
  });

  it('cutover.step_completed: a 2,000-char note is capped the same way; exactly 500 chars is stored unchanged (boundary)', async () => {
    const f = await moneyFixture(sql, 'cap-cut');
    await asOrgOn(f.orgId, (tx) => D.attestStep(tx, f.admin, { stepCode: 'A1', note: long }));
    await asOrgOn(f.orgId, (tx) => D.attestStep(tx, f.admin, { stepCode: 'A2', note: long.slice(0, 500) }));
    const rows = await auditRows(sql, f.orgId, 'cutover.step_completed');
    const byStep = (c: string) => rows.find((r) => (r.after as Record<string, unknown>).stepCode === c);
    expect((byStep('A1')!.after as Record<string, unknown>).note).toBe(capped);
    expect((byStep('A2')!.after as Record<string, unknown>).note).toBe(long.slice(0, 500));
  });
});

// ====================================================================================== no secrets in payloads
describe("no secret reaches any S3 event payload (R5, Invariant 18 for S3's rows)", () => {
  it('after every step above, no S3 row holds a scrypt hash, a JWT or a 4-8 digit value under a pin key', async () => {
    const rows = await sql<{ action: string; before: unknown; after: unknown }[]>`
      select action, before, after from audit_log
      where action ~ '^(expense|sales_day|remittance|cash_request|ap_invoice|ap_payment|cutover)[.]'`;
    expect(rows.length, 'the S3 rows exist to be scanned').toBeGreaterThan(0);
    for (const r of rows) {
      const text = JSON.stringify([r.before, r.after]);
      expect(text, `${r.action} scrypt`).not.toMatch(/scrypt\$/);
      expect(text, `${r.action} jwt`).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./);
      expect(text, `${r.action} pin key`).not.toMatch(/"[A-Za-z_]*[Pp]in[A-Za-z_]*":"?\d{4,8}/);
    }
  });
});
