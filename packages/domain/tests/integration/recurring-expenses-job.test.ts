import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-216 Part 2 — the recurring-expense drafting JOB.
 * `docs/tasks/216-recurring-expense-automation.md` §J7.
 *
 * ⛔ **The job drafts; it never pays.** Ian, 6–7 Sep 2026, against v1's auto-pay. Every test here
 * exists to hold one edge of that: nothing posts, nothing draws cash, and the human gate that
 * stands between a draft and the ledger is proven to still stand in front of a machine-made one.
 *
 * ⚠️ The sibling file `recurring-expenses.test.ts` covers the TEMPLATE half and is untouched.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, recurringExpensesRepo, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  approveExpense,
  createRecurringTemplate,
  paymentForAccount,
  runRecurringExpenses,
  setRecurringTemplateStatus,
  verifyInvoice,
} from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

/** The run clock. Every test pins it, so nothing here depends on the day it is executed. */
const NOW = Date.parse('2026-09-20T02:00:00Z'); // 10:00 Manila, 2026-09-20
const TODAY = '2026-09-20';

async function fixture(hint: string, opts: { periodStatus?: 'open' | 'closed' } = {}) {
  const code = uid(`job-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;

  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const managerId = await mk('Manager', 'manager');
  // ⛔ A SECOND person, and the job's design requires them: the job records the invoice as the
  // template's CREATOR, and `verifyInvoice` refuses the person who logged it ("verification is a
  // second pair of eyes"). So a recurring bill is verified by somebody other than whoever set the
  // template up — segregation of duties, inherited rather than bypassed.
  const adminId = await mk('Admin', 'admin');

  const [category] = await sql<{ id: string }[]>`
    insert into expense_categories (org_id, "group", category, account_code)
    values (${orgId}, 'OPEX', ${uid('cat')}, '6200') returning id`;
  // T-361: credit needs terms now the domain enforces it (DEF-492) — every bare dueTemplate(f)
  // call in this file drafts on credit by default (no defaultMoneyAccountId, paymentForAccount
  // falls to credit), so the Landlord needs real terms to keep those existing drafts green.
  const [supplier] = await sql<{ id: string }[]>`
    insert into suppliers (org_id, name, created_by, credit_terms_days) values (${orgId}, ${`Landlord ${hint}`}, ${managerId}, 30)
    returning id`;
  const [office] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and custodian = 'office' and instrument = 'cash' limit 1`;
  const [wallet] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'ewallet' limit 1`;

  // September 2026, so the drafted expense's business date falls inside it.
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, '2026-09-01', '2026-09-30', ${opts.periodStatus ?? 'open'})`;

  return {
    orgId, storeId, categoryId: category!.id, supplierId: supplier!.id,
    officeId: office!.id, walletId: wallet?.id ?? null,
    managerId, manager: actor(orgId, managerId),
    adminId, admin: actor(orgId, adminId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const template = (f: Fixture) => ({
  storeId: f.storeId,
  name: 'Lipa branch rent',
  categoryId: f.categoryId,
  supplierId: f.supplierId,
  defaultAmount: '25000.00',
  interval: 'monthly' as const,
  anchorDay: 5,
});

/** A template already due: created for the 5th, from a date that makes 2026-09-05 its cursor. */
async function dueTemplate(
  f: Fixture,
  over: Partial<Parameters<typeof createRecurringTemplate>[2]> = {},
) {
  const { id } = await asOrg(f.orgId, (tx) => createRecurringTemplate(tx, f.manager, {
    ...template(f), ...over, from: '2026-09-01',
  }));
  return id;
}

const run = (f: Fixture) => runRecurringExpenses({ orgId: f.orgId, nowMs: NOW, trigger: 'cron' });

async function counts(orgId: string) {
  const [row] = await sql<{ e: number; i: number; j: number; d: number }[]>`
    select (select count(*) from expenses where org_id = ${orgId})::int as e,
           (select count(*) from supplier_invoices where org_id = ${orgId})::int as i,
           (select count(*) from journal_entries where org_id = ${orgId})::int as j,
           (select count(*) from recurring_expense_drafts where org_id = ${orgId})::int as d`;
  return row!;
}

/**
 * T-233 — DEF-219: same test-local trigger lever as `scheduler.test.ts`'s T1, applied here because
 * `job.ts` carries its own copy of the runner pattern (finding 1) rather than sharing it. Dropped
 * in this helper's own `finally` AND, belt-and-braces, in this file's `afterAll`.
 */
async function withInsertRefusalTrigger(brokenOrgId: string, fn: () => Promise<void>): Promise<void> {
  await sql.unsafe(`
    create or replace function t233_refuse_run() returns trigger as $$
    begin raise exception 'T233: refused'; end $$ language plpgsql;
  `);
  // ⭐ Idempotent, unlike `create or replace function` above: a killed run (Ctrl-C, a timeout)
  // skips both this helper's `finally` and the file's `afterAll`, so the NEXT run's bare `create
  // trigger` would die on "already exists" BEFORE its own `try` — one confusing red run whose own
  // `finally` then never fires either.
  await sql.unsafe(`drop trigger if exists t233_refuse_insert on scheduler_runs`);
  await sql.unsafe(`
    create trigger t233_refuse_insert before insert on scheduler_runs
      for each row when (new.org_id = '${brokenOrgId}'::uuid) execute function t233_refuse_run();
  `);
  try {
    await fn();
  } finally {
    await sql.unsafe(`drop trigger if exists t233_refuse_insert on scheduler_runs`);
    await sql.unsafe(`drop function if exists t233_refuse_run()`);
  }
}

afterAll(async () => {
  // Belt and braces (approval condition 1): a killed test's own `finally` might never have run.
  await sql.unsafe(`drop trigger if exists t233_refuse_insert on scheduler_runs`);
  await sql.unsafe(`drop function if exists t233_refuse_run()`);
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('⛔ the job drafts, and only drafts', () => {
  it('1 — a due template produces one PENDING invoice and one DRAFT expense, and the ledger does not move', async () => {
    const f = await fixture('draft');
    await dueTemplate(f);
    const before = await counts(f.orgId);

    const result = await run(f);

    const after = await counts(f.orgId);
    expect(after.e - before.e).toBe(1);
    expect(after.i - before.i).toBe(1);
    expect(after.d - before.d).toBe(1);
    // ⛔ THE invariant. v1 auto-pays; this must not, ever.
    expect(after.j).toBe(before.j);

    const [expense] = await sql<{ status: string; journal_entry_id: string | null; business_date: string }[]>`
      select status, journal_entry_id, business_date::text from expenses where org_id = ${f.orgId}`;
    expect(expense!.status).toBe('draft');
    expect(expense!.journal_entry_id).toBeNull();

    const [invoice] = await sql<{ status: string; invoice_no: string }[]>`
      select status, invoice_no from supplier_invoices where org_id = ${f.orgId}`;
    expect(invoice!.status).toBe('pending');
    expect(invoice!.invoice_no).toMatch(/^RECUR-.+-2026-09-05$/);

    expect(result.hadFailures).toBe(false);
    expect(result.outcomes[0]!.posted).toBe(1);
  });

  it('2 — the drafted expense is dated on the DUE date, not on the day the job ran', async () => {
    // ⚠️ `createExpense` ignores `businessDate` and forces it from the invoice (receipt-date
    // authority, T-130 Inv 3). The invoice date IS the due date, which is what makes this work —
    // and it is why the job passes the due date there rather than trusting the expense input.
    const f = await fixture('dated');
    await dueTemplate(f);
    await run(f);
    const [expense] = await sql<{ business_date: string }[]>`
      select business_date::text from expenses where org_id = ${f.orgId}`;
    expect(expense!.business_date).toBe('2026-09-05');
    expect(expense!.business_date).not.toBe(TODAY);
  });

  it('3 — the cursor advances by exactly one interval', async () => {
    const f = await fixture('cursor');
    const id = await dueTemplate(f);
    await run(f);
    const row = await asOrg(f.orgId, (tx) => recurringExpensesRepo.getById(tx, f.orgId, id));
    expect(row!.nextDueDate).toBe('2026-10-05');
    expect(row!.lastDraftedExpenseId).not.toBeNull();
  });
});

describe('⭐ idempotency — the cursor, and the guard the cursor cannot be', () => {
  it('4a — running twice in one day drafts once', async () => {
    const f = await fixture('twice');
    await dueTemplate(f);
    await run(f);
    const mid = await counts(f.orgId);
    const second = await run(f);
    const after = await counts(f.orgId);
    expect(after.e).toBe(mid.e);
    expect(after.i).toBe(mid.i);
    expect(second.outcomes[0]!.posted).toBe(0);
  });

  it('4b — ⛔ a cursor moved BACKWARDS still drafts once: the unique index is the real guard', async () => {
    // This is the case the cursor cannot catch, and the reason `recurring_expense_drafts` exists.
    // An edit, a hand correction or a second job process can all put the cursor back; none of them
    // may produce a second bill for a date already billed.
    const f = await fixture('rewind');
    const id = await dueTemplate(f);
    await run(f);
    const mid = await counts(f.orgId);

    await sql`update recurring_expenses set next_due_date = '2026-09-05' where id = ${id}`;
    const second = await run(f);

    const after = await counts(f.orgId);
    expect(after.e).toBe(mid.e);
    expect(after.i).toBe(mid.i);
    expect(after.d).toBe(mid.d);
    expect(second.outcomes[0]!.skipped).toBe(1);
    expect(second.hadFailures).toBe(false);
  });

  it('5 — ⭐ a template three periods overdue drafts ONCE and advances ONE interval', async () => {
    // v1's restraint, ported in spirit: "never pre-create". Three drafts on one morning is noise;
    // three consecutive daily runs converge honestly.
    const f = await fixture('overdue');
    const id = await dueTemplate(f);
    await sql`update recurring_expenses set next_due_date = '2026-06-05' where id = ${id}`;

    await run(f);

    const after = await counts(f.orgId);
    expect(after.e).toBe(1);
    const row = await asOrg(f.orgId, (tx) => recurringExpensesRepo.getById(tx, f.orgId, id));
    expect(row!.nextDueDate).toBe('2026-07-05');

    // ...and the next run picks up the next missed one, rather than standing still.
    await run(f);
    expect((await counts(f.orgId)).e).toBe(2);
    const row2 = await asOrg(f.orgId, (tx) => recurringExpensesRepo.getById(tx, f.orgId, id));
    expect(row2!.nextDueDate).toBe('2026-08-05');
  });

  it('6 — a paused template drafts nothing', async () => {
    const f = await fixture('paused');
    const id = await dueTemplate(f);
    await asOrg(f.orgId, (tx) => setRecurringTemplateStatus(tx, f.manager, { templateId: id, status: 'paused' }));
    await run(f);
    expect((await counts(f.orgId)).e).toBe(0);
  });
});

describe('⚠️ a template that cannot draft is REPORTED, never quietly skipped', () => {
  it('7 — no supplier: nothing is drafted, and the template is named in the run failures', async () => {
    // ⛔ Reported as a failure, not counted as `skipped`. "skipped 4" on a healthy morning and
    // "skipped 4" on a morning when four bills stopped being drafted must not read the same.
    const f = await fixture('nosupp');
    const id = await dueTemplate(f);
    await sql`update recurring_expenses set supplier_id = null where id = ${id}`;

    const result = await run(f);

    expect((await counts(f.orgId)).e).toBe(0);
    expect(result.hadFailures).toBe(true);
    const failure = result.outcomes[0]!.failures[0]!;
    expect(failure.subjectName).toBe('Lipa branch rent');
    expect(failure.reason).toMatch(/no supplier/);
  });

  it('7b — no creator: same shape, because the job acts as the person who set the template up', async () => {
    const f = await fixture('nocreator');
    const id = await dueTemplate(f);
    await sql`update recurring_expenses set created_by = null where id = ${id}`;
    const result = await run(f);
    expect((await counts(f.orgId)).e).toBe(0);
    expect(result.outcomes[0]!.failures[0]!.reason).toMatch(/no creator/);
  });

  it('7c — ⭐ the job holds no privilege of its own: a creator without store scope is refused, loudly', async () => {
    // T-216 §8: the automation must never become a way to pre-authorise spending. It acts as the
    // template's creator through the real `authorize` gates, so a creator since descoped cannot
    // draft — and the run says so instead of writing under a system principal.
    const f = await fixture('descoped');
    await dueTemplate(f);
    await sql`delete from person_store_scope where person_id = ${f.managerId} and store_id = ${f.storeId}`;

    const result = await run(f);

    expect((await counts(f.orgId)).e).toBe(0);
    expect(result.hadFailures).toBe(true);
    expect(result.outcomes[0]!.failures).toHaveLength(1);
  });
});

describe('⛔ the human gate still stands in front of a machine-made draft', () => {
  it('8a — ⚠️ the template creator cannot verify the invoice the job logged in their name — segregation of duties, inherited', async () => {
    // A CONSEQUENCE of acting as the creator rather than as a system principal, and worth stating:
    // whoever sets up a recurring bill can never be the one who verifies it. A system actor would
    // have made every recurring invoice self-verifiable by anyone, which is the weaker control.
    const f = await fixture('sod');
    await dueTemplate(f);
    await run(f);
    const [invoice] = await sql<{ id: string; created_by: string }[]>`
      select id, created_by from supplier_invoices where org_id = ${f.orgId}`;
    expect(invoice!.created_by).toBe(f.managerId);
    await expect(
      asOrg(f.orgId, (tx) =>
        verifyInvoice(tx, f.manager, invoice!.id, { supplier: true, invoice: true, items: true, price: true }),
      ),
    ).rejects.toThrow(/second pair of eyes/);
  });

  it('8 — the draft cannot be approved while its invoice is pending, and the invoice cannot be verified without the real bill', async () => {
    const f = await fixture('gate');
    await dueTemplate(f);
    await run(f);

    const [expense] = await sql<{ id: string }[]>`select id from expenses where org_id = ${f.orgId}`;
    const [invoice] = await sql<{ id: string }[]>`select id from supplier_invoices where org_id = ${f.orgId}`;

    await expect(
      asOrg(f.orgId, (tx) => approveExpense(tx, f.manager, expense!.id)),
    ).rejects.toThrow(/pending/);

    // ⭐ T-130 relocated the receipt gate onto the INVOICE, and this is it holding: the machine
    // attached no bill, so verification is refused until a person does.
    await expect(
      asOrg(f.orgId, (tx) =>
        verifyInvoice(tx, f.manager, invoice!.id, { supplier: true, invoice: true, items: true, price: true }),
      ),
    ).rejects.toThrow();

    expect((await counts(f.orgId)).j).toBe(0);
  });

  it('8b — with the real bill attached, verifying posts the same draft and only THEN does the ledger move', async () => {
    const f = await fixture('posts');
    await dueTemplate(f);
    await run(f);
    const [expense] = await sql<{ id: string }[]>`select id from expenses where org_id = ${f.orgId}`;
    const [invoice] = await sql<{ id: string }[]>`select id from supplier_invoices where org_id = ${f.orgId}`;

    // The human's upload, as raw SQL — T-141's brokered upload is not what this test is about.
    const [file] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
      values (${f.orgId}, ${f.storeId}, 'receipt_photo', ${`orgs/${f.orgId}/rent.jpg`},
              'image/jpeg', 1024, ${uid('sum')}, ${f.managerId}) returning id`;
    await sql`update supplier_invoices set receipt_file_id = ${file!.id} where id = ${invoice!.id}`;

    await asOrg(f.orgId, (tx) =>
      verifyInvoice(tx, f.admin, invoice!.id, { supplier: true, invoice: true, items: true, price: true }),
    );

    const [posted] = await sql<{ status: string; journal_entry_id: string | null }[]>`
      select status, journal_entry_id from expenses where id = ${expense!.id}`;
    expect(posted!.status).toBe('posted');
    expect(posted!.journal_entry_id).not.toBeNull();
    expect((await counts(f.orgId)).j).toBe(1);
  });

  it('9 — ⭐ a due date in a CLOSED period still drafts; the draft simply cannot post', async () => {
    // §J6.8. v1 needed a period guard because it POSTED. A draft posts nothing, there is no period
    // guard on either create path to refuse it with, and a job that refused would leave the bill
    // invisible until somebody reopened the month.
    const f = await fixture('closed', { periodStatus: 'closed' });
    await dueTemplate(f);

    const result = await run(f);

    const after = await counts(f.orgId);
    expect(after.e).toBe(1);
    expect(after.i).toBe(1);
    expect(after.j).toBe(0);
    expect(result.hadFailures).toBe(false);

    const [expense] = await sql<{ id: string; status: string }[]>`
      select id, status from expenses where org_id = ${f.orgId}`;
    expect(expense!.status).toBe('draft');
    await expect(asOrg(f.orgId, (tx) => approveExpense(tx, f.manager, expense!.id))).rejects.toThrow();
  });
});

describe('the run records itself, and the payment it derives', () => {
  it('10 — a run that drafts nothing still writes one scheduler_runs row', async () => {
    // DEF-044: "it ran and there was nothing to do" and "it never ran" must be tellable apart.
    const f = await fixture('noop');
    const result = await run(f);
    expect(result.outcomes).toHaveLength(1);
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from scheduler_runs
       where org_id = ${f.orgId} and job = 'recurring_expenses'`;
    expect(row!.n).toBe(1);
    expect(result.outcomes[0]!.detail).toMatch(/due 0/);
  });

  it('11 — the payment method is derived from the account, and a template with none owes it on credit', () => {
    expect(paymentForAccount(null, null)).toEqual({ method: 'credit', moneyAccountId: null });
    expect(paymentForAccount('cash', 'acc-1')).toEqual({ method: 'cash', moneyAccountId: null });
    expect(paymentForAccount('bank', 'acc-1')).toEqual({ method: 'online', moneyAccountId: 'acc-1' });
    expect(paymentForAccount('ewallet', 'acc-2')).toEqual({ method: 'online', moneyAccountId: 'acc-2' });
  });

  it('11b — a template naming an office CASH account drafts a cash payment against it', async () => {
    const f = await fixture('cashacct');
    await dueTemplate(f, { defaultMoneyAccountId: f.officeId });
    await run(f);
    const [payment] = await sql<{ method: string }[]>`
      select p.method from expense_payments p join expenses e on e.id = p.expense_id
       where e.org_id = ${f.orgId}`;
    expect(payment!.method).toBe('cash');
  });

  it('13 — ⛔ the drafts table DENIES a write made without the org principal, and accepts one with it', async () => {
    // ⚠️ WHAT THIS DOES AND DOES NOT PROVE. It proves the policy exists and default-denies, which
    // is the half a test in this suite CAN prove. It does NOT prove the JOB sets the principal:
    // this harness connects as `postgres` (rolsuper, rolbypassrls), so reverting the job to a bare
    // `transaction()` — the form that is refused in production — still passes all 18 tests. That
    // gap is DEF-218, and its disposition is a shared job-test helper, not this file.
    const f = await fixture('rls');
    const id = await dueTemplate(f);

    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${APP_ROLE}`);
        await tx`insert into recurring_expense_drafts (org_id, recurring_expense_id, due_date)
                 values (${f.orgId}, ${id}, '2099-01-01')`;
      }),
    ).rejects.toThrow(/row-level security/);

    // The same insert, with the principal `withOrgPrincipal` sets, is accepted — the non-zero
    // control, so a passing first half cannot be a policy that simply refuses everything.
    await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${APP_ROLE}`);
      await tx`select set_config('app.principal_kind','staff',true),
                      set_config('app.org_id',${f.orgId},true)`;
      await tx`insert into recurring_expense_drafts (org_id, recurring_expense_id, due_date)
               values (${f.orgId}, ${id}, '2099-01-02')`;
    });
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from recurring_expense_drafts
       where recurring_expense_id = ${id} and due_date = '2099-01-02'`;
    expect(row!.n).toBe(1);
  });

  it('T5 — T-233/DEF-219: one org\'s first write is refused; a second org still drafts', async () => {
    // `job.ts` carries its own copy of the runner pattern (finding 1), so it needs the same
    // per-org-boundary proof as `scheduler.test.ts`'s T1 — a single sweep across multiple orgs
    // where the first org's `startRun` is refused and the next org is not skipped.
    const broken = await fixture('t233-broken');
    const healthy = await fixture('t233-healthy');
    await dueTemplate(broken);
    await dueTemplate(healthy);

    await withInsertRefusalTrigger(broken.orgId, async () => {
      // ⚠️ No `orgId` — a real sweep, which is the only way to exercise "the next org still runs".
      const result = await runRecurringExpenses({ nowMs: NOW, trigger: 'cron' });

      const brokenOutcome = result.outcomes.find((o) => o.orgId === broken.orgId)!;
      expect(brokenOutcome.error).toMatch(/could not open/);
      expect(brokenOutcome.error).toMatch(/T233: refused/);
      expect(brokenOutcome.posted).toBe(0);

      const healthyOutcome = result.outcomes.find((o) => o.orgId === healthy.orgId)!;
      expect(healthyOutcome.posted).toBe(1);
      expect(healthyOutcome.error).toBeUndefined();
    });

    expect((await counts(broken.orgId)).e).toBe(0);
    expect((await counts(healthy.orgId)).e).toBe(1);

    const [runs] = await sql<{ n: number }[]>`
      select count(*)::int as n from scheduler_runs where org_id = ${broken.orgId}`;
    expect(runs!.n).toBe(0);
  });

  it('12 — scheduler_runs admits all nine job names and refuses a tenth', async () => {
    const f = await fixture('check');
    const nine = [
      'depreciation', 'amortisation', 'attendance_sweep', 'mirror_publish', 'inbox_relay',
      'order_wastage_backstop', 'finding_observation', 'budget_reissue', 'recurring_expenses',
    ];
    for (const job of nine) {
      await sql`insert into scheduler_runs (org_id, job, period) values (${f.orgId}, ${job}, '2026-09')`;
    }
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from scheduler_runs where org_id = ${f.orgId}`;
    expect(row!.n).toBe(9);

    // ⛔ DEF-217 is what happens when this list and the constraint drift apart.
    await expect(
      sql`insert into scheduler_runs (org_id, job, period) values (${f.orgId}, 'not_a_job', '2026-09')`,
    ).rejects.toThrow(/scheduler_runs_job_check/);
  });
});

// -----------------------------------------------------------------------------------------------
// T-367 S3 (DEF-499) regression — a drafted recurring bill is DUE on its template's due date, not date + the supplier's terms
// -----------------------------------------------------------------------------------------------

describe('a recurring bill keeps the template due date, whatever the supplier\'s terms', () => {
  it('supplier on 30-day terms, template due 2026-09-05: the drafted bill is invoiced AND due 2026-09-05 (not 2026-10-05, which is date + 30)', async () => {
    const f = await fixture('s3due'); // the fixture's Landlord has credit_terms_days = 30
    await dueTemplate(f);

    const result = await run(f);

    expect(result.hadFailures).toBe(false);
    const rows = await sql<{ invoice_date: string; due_date: string | null }[]>`
      select invoice_date::text, due_date::text from supplier_invoices where org_id = ${f.orgId}`;
    expect(rows, 'control: the job drafted exactly one bill').toHaveLength(1);
    expect(rows[0]!.invoice_date).toBe('2026-09-05');
    expect(rows[0]!.due_date, "the supplier's 30-day terms overrode the template's due date (T-367 S3 regression)").toBe('2026-09-05');
  });
});
