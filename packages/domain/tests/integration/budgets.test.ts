import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-215 — expense budgets. `docs/tasks/215-expense-budgets.md`.
 *
 * ⭐ **Case 2 is the one that matters.** Three account codes in the seed are shared by TWO
 * categories each — `6890`, `6620`, `6600` (39 categories, 36 distinct codes) — so a consumption
 * query grouped by `account_code` instead of `category_id` over-counts six envelopes and the
 * failure is completely silent: a manager sees a cap as exhausted when half the spend belongs to a
 * different one. Every other test here would pass against that wrong implementation.
 *
 * ⛔ And nothing in this file asserts a stored `consumed` column, because there is none. v1 keeps
 * one and increments it from the expense actions; it is the same shape as AR's
 * `outstanding_amount`, measured wrong on 106 of 794 live rows.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { budgetsRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { removeExpenseBudget, runBudgetReissue, setExpenseBudget } from '@shareat/domain';

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

async function fixture(hint: string) {
  const code = uid(`bud-${hint}`);
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
  const staffId = await mk('Staff', 'staff');
  return {
    orgId,
    storeId,
    managerId,
    staffId,
    manager: actor(orgId, managerId),
    staff: actor(orgId, staffId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A category with a chosen account code — the collision in case 2 needs two of these. */
async function category(f: Fixture, accountCode: string | null): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into expense_categories (org_id, "group", category, account_code)
    values (${f.orgId}, 'OPEX', ${uid('cat')}, ${accountCode}) returning id`;
  return row!.id;
}

/**
 * A posted expense, inserted directly.
 *
 * ⚠️ Deliberately NOT through `createExpense`/`approveExpense`: this file tests the CONSUMPTION
 * QUERY, and driving AP's segregation-of-duties and evidence rules to produce a row would test
 * those instead. Same reasoning `oil-wave-2.test.ts` states for its own fixture.
 *
 * ⚠️ **The invoice is still RECORDED and VERIFIED by two different people**, because
 * `supplier_invoices_two_person_verification_check` refuses one person doing both — the first
 * version of this fixture used the manager for each and the database said no. Inserting around a
 * workflow is fine; inserting around a CONSTRAINT is not, and the constraint is right.
 */
async function expense(
  f: Fixture,
  opts: { categoryId: string; businessDate: string; amount: string; status?: 'draft' | 'posted' | 'voided' },
): Promise<string> {
  const [supplier] = await sql<{ id: string }[]>`
    insert into suppliers (org_id, name, created_by) values (${f.orgId}, ${uid('sup')}, ${f.managerId}) returning id`;
  const [invoice] = await sql<{ id: string }[]>`
    insert into supplier_invoices
      (org_id, store_id, supplier_id, invoice_date, total_amount, status, verified_by, verified_at,
       attested_supplier, attested_invoice, attested_items, attested_price, created_by)
    values (${f.orgId}, ${f.storeId}, ${supplier!.id}, ${opts.businessDate}, ${opts.amount}, 'verified',
      ${f.managerId}, now(), true, true, true, true, ${f.staffId})
    returning id`;
  const [row] = await sql<{ id: string }[]>`
    insert into expenses
      (org_id, store_id, business_date, total_amount, category_id, supplier_id, supplier_invoice_id,
       particulars, status, created_by)
    values (${f.orgId}, ${f.storeId}, ${opts.businessDate}, ${opts.amount}, ${opts.categoryId},
      ${supplier!.id}, ${invoice!.id}, 'budget fixture', ${opts.status ?? 'posted'}, ${f.managerId})
    returning id`;
  return row!.id;
}

const consumedFor = async (f: Fixture, categoryId: string, periodKey: string) => {
  const rows = await asOrg(f.orgId, (tx) => budgetsRepo.listForStorePeriod(tx, f.orgId, f.storeId, periodKey));
  return rows.find((r) => r.categoryId === categoryId);
};

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('a cap, what has been spent against it, and what is left', () => {
  it('consumption sums POSTED expenses only — a draft is not yet a fact, a void is no longer one', async () => {
    const f = await fixture('consume');
    const cat = await category(f, '6200');
    await setExpenseBudget(null, f.manager, {
      storeId: f.storeId, categoryId: cat, periodKey: '202609', amount: '10000.00',
    });

    await expense(f, { categoryId: cat, businessDate: '2026-09-03', amount: '1500.00' });
    await expense(f, { categoryId: cat, businessDate: '2026-09-04', amount: '500.00', status: 'draft' });
    await expense(f, { categoryId: cat, businessDate: '2026-09-05', amount: '900.00', status: 'voided' });
    // Right category, wrong month — the period filter has to bite.
    await expense(f, { categoryId: cat, businessDate: '2026-08-30', amount: '4000.00' });

    const row = await consumedFor(f, cat, '202609');
    expect(row!.consumed).toBe('1500.00');
    expect(row!.remaining).toBe('8500.00');
    expect(row!.overBudget).toBe(false);
  });

  it('⛔ TWO CATEGORIES SHARING ONE ACCOUNT CODE HAVE SEPARATE CONSUMPTION — the §3 trap', async () => {
    // `6890` is one of three codes the seed gives to two categories each. An implementation that
    // groups by account_code passes every other test in this file and silently doubles both of
    // these figures. THIS is the test that catches it.
    const f = await fixture('collide');
    const a = await category(f, '6890');
    const b = await category(f, '6890');
    await setExpenseBudget(null, f.manager, {
      storeId: f.storeId, categoryId: a, periodKey: '202609', amount: '5000.00',
    });
    await setExpenseBudget(null, f.manager, {
      storeId: f.storeId, categoryId: b, periodKey: '202609', amount: '5000.00',
    });

    await expense(f, { categoryId: a, businessDate: '2026-09-10', amount: '1000.00' });
    await expense(f, { categoryId: b, businessDate: '2026-09-11', amount: '250.00' });

    expect((await consumedFor(f, a, '202609'))!.consumed).toBe('1000.00');
    expect((await consumedFor(f, b, '202609'))!.consumed).toBe('250.00');
  });

  it('voiding a posted expense reduces consumption on the next read — because nothing is stored', async () => {
    const f = await fixture('void');
    const cat = await category(f, '6200');
    await setExpenseBudget(null, f.manager, {
      storeId: f.storeId, categoryId: cat, periodKey: '202609', amount: '3000.00',
    });
    const id = await expense(f, { categoryId: cat, businessDate: '2026-09-07', amount: '1200.00' });
    expect((await consumedFor(f, cat, '202609'))!.consumed).toBe('1200.00');

    await sql`update expenses set status = 'voided' where id = ${id}`;
    // ⭐ No recompute, no repair button, no cron. v1 needs all three because its figure is stored.
    expect((await consumedFor(f, cat, '202609'))!.consumed).toBe('0.00');
  });

  it('⚠️ remaining goes NEGATIVE rather than flooring at zero — the floor would hide the signal', async () => {
    const f = await fixture('over');
    const cat = await category(f, '6200');
    await setExpenseBudget(null, f.manager, {
      storeId: f.storeId, categoryId: cat, periodKey: '202609', amount: '1000.00',
    });
    await expense(f, { categoryId: cat, businessDate: '2026-09-09', amount: '1750.00' });
    const row = await consumedFor(f, cat, '202609');
    expect(row!.remaining).toBe('-750.00');
    expect(row!.overBudget).toBe(true);
  });
});

describe('the database refuses what a service must not be trusted to remember', () => {
  it('⛔ auto_reissue with NO interval is refused BY THE DATABASE', async () => {
    const f = await fixture('nointerval');
    const cat = await category(f, '6200');
    await expect(
      sql`insert into expense_budgets (org_id, store_id, category_id, period_key, amount, auto_reissue)
          values (${f.orgId}, ${f.storeId}, ${cat}, '202609', '100.00', true)`,
    ).rejects.toThrow(/expense_budgets_reissue_interval_check/);
  });

  it('⛔ a duplicate (store, category, period) is refused BY THE DATABASE', async () => {
    const f = await fixture('dupe');
    const cat = await category(f, '6200');
    await sql`insert into expense_budgets (org_id, store_id, category_id, period_key, amount)
              values (${f.orgId}, ${f.storeId}, ${cat}, '202609', '100.00')`;
    await expect(
      sql`insert into expense_budgets (org_id, store_id, category_id, period_key, amount)
          values (${f.orgId}, ${f.storeId}, ${cat}, '202609', '200.00')`,
    ).rejects.toThrow(/expense_budgets_unique_envelope/);
  });

  it('⚠️ setting a cap twice EDITS it — the screen must not have to explain a unique violation', async () => {
    const f = await fixture('upsert');
    const cat = await category(f, '6200');
    await setExpenseBudget(null, f.manager, {
      storeId: f.storeId, categoryId: cat, periodKey: '202609', amount: '100.00',
    });
    await setExpenseBudget(null, f.manager, {
      storeId: f.storeId, categoryId: cat, periodKey: '202609', amount: '250.00',
    });
    const rows = await asOrg(f.orgId, (tx) => budgetsRepo.listForStorePeriod(tx, f.orgId, f.storeId, '202609'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe('250.00');
  });

  it('⛔ STAFF may not set a cap — the ✗ in the matrix fires', async () => {
    // Every ✅ in CAPABILITY-MATRIX.md needs a test proving the ✗ is real. A cap is a control ON
    // spending, and the person it constrains is not the person who sets it.
    const f = await fixture('denied');
    const cat = await category(f, '6200');
    await expect(
      setExpenseBudget(null, f.staff, {
        storeId: f.storeId, categoryId: cat, periodKey: '202609', amount: '100.00',
      }),
    ).rejects.toThrow(/manage_expense_budgets/);
  });

  it('removing a cap deletes the row — "no cap" and "a cap of zero" are different states', async () => {
    const f = await fixture('remove');
    const cat = await category(f, '6200');
    const { id } = await setExpenseBudget(null, f.manager, {
      storeId: f.storeId, categoryId: cat, periodKey: '202609', amount: '0.00',
    });
    // ⚠️ Zero is a real cap and reads as one.
    let rows = await asOrg(f.orgId, (tx) => budgetsRepo.listForStorePeriod(tx, f.orgId, f.storeId, '202609'));
    expect(rows[0]!.amount).toBe('0.00');

    await removeExpenseBudget(null, f.manager, { budgetId: id });
    rows = await asOrg(f.orgId, (tx) => budgetsRepo.listForStorePeriod(tx, f.orgId, f.storeId, '202609'));
    expect(rows).toHaveLength(0);
  });
});

describe('reissue — the envelope rolls forward without anyone remembering', () => {
  const at = (iso: string) => new Date(iso).getTime();

  it('a monthly budget creates the next period ONCE, and a second run creates nothing', async () => {
    const f = await fixture('monthly');
    const cat = await category(f, '6200');
    await setExpenseBudget(null, f.manager, {
      storeId: f.storeId, categoryId: cat, periodKey: '202609', amount: '4000.00',
      autoReissue: true, reissueInterval: 'monthly',
    });

    const first = await runBudgetReissue({ orgId: f.orgId, trigger: 'manual', nowMs: at('2026-10-05T02:00:00Z') });
    expect(first.outcomes[0]!.posted).toBe(1);

    const second = await runBudgetReissue({ orgId: f.orgId, trigger: 'manual', nowMs: at('2026-10-05T09:00:00Z') });
    // ⭐ Idempotent as a DATABASE fact — `ON CONFLICT DO NOTHING` against the unique envelope.
    expect(second.outcomes[0]!.posted).toBe(0);

    const rows = await asOrg(f.orgId, (tx) => budgetsRepo.listForStorePeriod(tx, f.orgId, f.storeId, '202610'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe('4000.00');
    expect(rows[0]!.autoReissue).toBe(true);
    expect(rows[0]!.reissuedFromId).not.toBeNull();
  });

  it('⛔ a period that has NOT ARRIVED is never pre-created — v1’s restraint, ported', async () => {
    const f = await fixture('future');
    const cat = await category(f, '6200');
    await setExpenseBudget(null, f.manager, {
      storeId: f.storeId, categoryId: cat, periodKey: '202609', amount: '4000.00',
      autoReissue: true, reissueInterval: 'monthly',
    });
    // Still September: October has not arrived.
    const run = await runBudgetReissue({ orgId: f.orgId, trigger: 'manual', nowMs: at('2026-09-20T02:00:00Z') });
    expect(run.outcomes[0]!.posted).toBe(0);
    const rows = await asOrg(f.orgId, (tx) => budgetsRepo.listForStorePeriod(tx, f.orgId, f.storeId, '202610'));
    expect(rows).toHaveLength(0);
  });

  it('a weekly budget moves its WINDOW, and consumption is then measured from it', async () => {
    const f = await fixture('weekly');
    const cat = await category(f, '6200');
    await setExpenseBudget(null, f.manager, {
      storeId: f.storeId, categoryId: cat, periodKey: '202609', amount: '2000.00',
      autoReissue: true, reissueInterval: 'weekly',
    });
    await expense(f, { categoryId: cat, businessDate: '2026-09-02', amount: '800.00' });
    expect((await consumedFor(f, cat, '202609'))!.consumed).toBe('800.00');

    // Two weeks in: the window advances by WHOLE weeks from 1 September, to the 15th.
    await runBudgetReissue({ orgId: f.orgId, trigger: 'manual', nowMs: at('2026-09-16T02:00:00Z') });
    const after = await consumedFor(f, cat, '202609');
    expect(after!.lastResetAt).not.toBeNull();
    // ⭐ The 2 September spend is behind the window now, so the fresh envelope reads clean —
    // WITHOUT anything having zeroed a counter.
    expect(after!.consumed).toBe('0.00');

    await expense(f, { categoryId: cat, businessDate: '2026-09-17', amount: '350.00' });
    expect((await consumedFor(f, cat, '202609'))!.consumed).toBe('350.00');
  });

  it('⚠️ a weekly window that has crossed a MONTH boundary still counts — the silent-zero trap', async () => {
    // Keep the `period_key` filter as well as the window and a weekly cap stops counting anything
    // the moment its window crosses into the next month: consumption reads zero for ever and the
    // cap silently becomes infinite. A budget reporting zero spent is indistinguishable from one
    // nobody has spent against, which is why this is its own test.
    const f = await fixture('crossmonth');
    const cat = await category(f, '6200');
    await setExpenseBudget(null, f.manager, {
      storeId: f.storeId, categoryId: cat, periodKey: '202609', amount: '2000.00',
      autoReissue: true, reissueInterval: 'weekly',
    });
    await runBudgetReissue({ orgId: f.orgId, trigger: 'manual', nowMs: at('2026-10-08T02:00:00Z') });
    await expense(f, { categoryId: cat, businessDate: '2026-10-09', amount: '640.00' });
    const row = await consumedFor(f, cat, '202609');
    expect(row!.consumed).toBe('640.00');
  });

  it('the job writes a scheduler_runs row even on a NO-OP run', async () => {
    // T-140's contract. A job that stays silent when it did nothing is indistinguishable from a job
    // that is not running at all — DEF-044 exactly.
    const f = await fixture('noop');
    const before = await sql<{ n: string }[]>`
      select count(*)::text as n from scheduler_runs where org_id = ${f.orgId} and job = 'budget_reissue'`;
    expect(before[0]!.n).toBe('0');

    const run = await runBudgetReissue({ orgId: f.orgId, trigger: 'manual', nowMs: at('2026-10-05T02:00:00Z') });
    expect(run.hadFailures).toBe(false);
    expect(run.outcomes[0]!.posted).toBe(0);

    const after = await sql<{ n: string; outcome: string }[]>`
      select count(*)::text as n, min(outcome) as outcome
      from scheduler_runs where org_id = ${f.orgId} and job = 'budget_reissue'`;
    expect(after[0]!.n).toBe('1');
    expect(after[0]!.outcome).toBe('ok');
  });
});
