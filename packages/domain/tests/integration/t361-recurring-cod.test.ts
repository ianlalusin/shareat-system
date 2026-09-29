import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-361 (DEF-492) — legs J1-J2. `docs/tasks/361-def-492-cod-credit-rule-in-domain.md` §Legs, "the
 * recurring job".
 *
 * ⛔ TESTER, not BUILDER. R6: the job inherits the rule, no exemption — a template that can no
 * longer draft is REPORTED through the job's own failure path, never skipped quietly. Fixture
 * shape from `recurring-expenses-job.test.ts:54-136` (fixture/template/dueTemplate/counts),
 * supplier terms set via `createSupplier` (Amendment A1/A2 — a real writer exists now).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, recurringExpensesRepo, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createRecurringTemplate, createSupplier, runRecurringExpenses } from '@shareat/domain';

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

const NOW = Date.parse('2026-09-20T02:00:00Z'); // 10:00 Manila, 2026-09-20

async function fixture(hint: string) {
  const code = uid(`t361j-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;

  const [manager] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  const managerId = manager!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${managerId}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${managerId}, ${storeId})`;
  // The job records the invoice as the template's creator, and verifyInvoice refuses the person
  // who logged it — a second person verifies (recurring-expenses-job.test.ts:72-76).
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const adminId = admin!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;

  const [category] = await sql<{ id: string }[]>`
    insert into expense_categories (org_id, "group", category, account_code)
    values (${orgId}, 'OPEX', ${uid('cat')}, '6200') returning id`;

  // COD by default — J1's whole point. J2 grants terms are irrelevant to it (it uses a real
  // account instead), so this fixture stays COD for both legs.
  const { id: supplierId } = await asOrg(orgId, (tx) => createSupplier(tx, actor(orgId, managerId), { name: `Landlord ${hint}` }));

  const [office] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and custodian = 'office' and instrument = 'cash' limit 1`;

  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-09-01', '2026-09-30', 'open')`;

  return {
    orgId, storeId, categoryId: category!.id, supplierId,
    officeId: office!.id,
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

async function dueTemplate(f: Fixture, over: Partial<Parameters<typeof createRecurringTemplate>[2]> = {}) {
  const { id } = await asOrg(f.orgId, (tx) => createRecurringTemplate(tx, f.manager, { ...template(f), ...over, from: '2026-09-01' }));
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

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('J1 — the recurring job: a due template, COD supplier, NO default account', () => {
  it('the run\'s failures names the template and the reason contains "cash-on-delivery"; counts unchanged; the cursor is not advanced — was red today: a draft is created, with credit', async () => {
    const f = await fixture('j1');
    const id = await dueTemplate(f);
    const before = await counts(f.orgId);

    const result = await run(f);

    const after = await counts(f.orgId);
    expect(after, 'nothing written').toEqual(before);
    expect(result.hadFailures).toBe(true);
    const failure = result.outcomes[0]!.failures[0]!;
    expect(failure.subjectName).toBe('Lipa branch rent');
    expect(failure.reason).toMatch(/cash-on-delivery/i);

    const row = await asOrg(f.orgId, (tx) => recurringExpensesRepo.getById(tx, f.orgId, id));
    expect(row!.nextDueDate, 'the cursor is not advanced').toBe('2026-09-05');
  });
});

describe('J2 (green, guard; positive control) — the same, COD supplier, office CASH account', () => {
  it('drafts one cash expense', async () => {
    const f = await fixture('j2');
    await dueTemplate(f, { defaultMoneyAccountId: f.officeId });
    const before = await counts(f.orgId);

    const result = await run(f);

    const after = await counts(f.orgId);
    expect(after.e - before.e).toBe(1);
    expect(after.d - before.d).toBe(1);
    expect(result.hadFailures).toBe(false);

    // paymentForAccount('cash', acc) => { method: 'cash', moneyAccountId: null } (job.ts:428-432's
    // own unit pin) — a cash draft never carries a moneyAccountId column; the account only decided
    // WHICH method this became (job.ts:78-87), not a stored reference.
    const [payment] = await sql<{ method: string }[]>`
      select method from expense_payments
      where expense_id = (select id from expenses where org_id = ${f.orgId} order by created_at desc limit 1)`;
    expect(payment!.method).toBe('cash');
  });
});
