import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-430 — recurring templates: a starting period, and catch-up drafting.
 * `docs/tasks/430-recurring-catch-up.md` cases 1-15 (case 16 is `apps/erp/tests/t430-starts-from-field.test.ts`).
 *
 * The job drafts one bill per MISSED due date, up to CATCH_UP_CAP per template per night. It never pays.
 * Every job case pins `nowMs`, so no count here depends on the day it runs.
 *
 * Contract this file assumes where the spec leaves a name open (the builder must match, or say so):
 *  - `createRecurringTemplate(..., { startsOn })`, stored in `recurring_expenses.starts_on` (needs migration 0201).
 *  - `recurringExpensesRepo.stampDrafted(tx, orgId, id, { expenseId, nextDueDate, at, expectedDueDate })`.
 *  - audit rows are found by `entity_id = template id`; the payload (before/after JSON) carries `starts_on` /
 *    `dropped_due_dates`. The action name is NOT asserted.
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
  CATCH_UP_CAP,
  createExpense,
  createRecurringTemplate,
  deleteRecurringTemplate,
  nextDueDate,
  recordInvoice,
  runRecurringExpenses,
  setRecurringTemplateStatus,
  updateRecurringTemplate,
} from '@shareat/domain';
import { money } from '@shareat/core/money';

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

/** The run clock: 10:00 Manila, Sunday 2026-09-20. */
const NOW = Date.parse('2026-09-20T02:00:00Z');

async function fixture(hint: string, opts: { sept?: 'open' | 'closed' | 'locked' | null; opening?: string | null } = {}) {
  const code = uid(`t430-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  // An opening date well before every start date used here, so the "no past before opening" rule never decides these cases.
  const opening = opts.opening === undefined ? '2025-01-01' : opts.opening;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, ${opening}) returning id`;
  const storeId = store!.id;

  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const managerId = await mk('Manager', 'manager');
  const [category] = await sql<{ id: string }[]>`
    insert into expense_categories (org_id, "group", category, account_code)
    values (${orgId}, 'OPEX', ${uid('cat')}, '6200') returning id`;
  const [supplier] = await sql<{ id: string }[]>`
    insert into suppliers (org_id, name, created_by, credit_terms_days) values (${orgId}, ${`Landlord ${hint}`}, ${managerId}, 30)
    returning id`;
  if (opts.sept !== null) {
    await sql`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      values (${orgId}, '2026-09-01', '2026-09-30', ${opts.sept ?? 'open'})`;
  }
  return {
    orgId, storeId, categoryId: category!.id, supplierId: supplier!.id,
    managerId, manager: actor(orgId, managerId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function addPeriod(f: Fixture, month: string, status: 'open' | 'closed' | 'locked') {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${f.orgId}, ${`${month}-01`}, ${`${month}-${String(last).padStart(2, '0')}`}, ${status})`;
}

const base = (f: Fixture) => ({
  storeId: f.storeId,
  name: 'Lipa branch rent',
  categoryId: f.categoryId,
  supplierId: f.supplierId,
  defaultAmount: '25000.00',
  interval: 'monthly' as const,
  anchorDay: 5,
});

async function mkTemplate(f: Fixture, startsOn: string | undefined, over: Record<string, unknown> = {}) {
  return asOrg(f.orgId, (tx) =>
    createRecurringTemplate(tx, f.manager, { ...base(f), ...over, ...(startsOn ? { startsOn } : {}) } as never),
  );
}

const run = (f: Fixture, nowMs = NOW) => runRecurringExpenses({ orgId: f.orgId, nowMs, trigger: 'cron' });

const draftDates = async (orgId: string) =>
  (await sql<{ d: string }[]>`select due_date::text as d from recurring_expense_drafts where org_id = ${orgId} order by due_date`).map(
    (r) => r.d,
  );
const cursorOf = async (id: string) =>
  (await sql<{ c: string }[]>`select next_due_date::text as c from recurring_expenses where id = ${id}`)[0]!.c;

async function counts(orgId: string) {
  const [row] = await sql<{ e: number; i: number; j: number; d: number; t: number }[]>`
    select (select count(*) from expenses where org_id = ${orgId})::int as e,
           (select count(*) from supplier_invoices where org_id = ${orgId})::int as i,
           (select count(*) from journal_entries where org_id = ${orgId})::int as j,
           (select count(*) from recurring_expense_drafts where org_id = ${orgId})::int as d,
           (select count(*) from money_transfers where org_id = ${orgId})::int as t`;
  return row!;
}

const auditText = async (entityId: string) =>
  (await sql<{ t: string }[]>`select coalesce(before::text,'') || ' ' || coalesce(after::text,'') as t from audit_log where entity_id = ${entityId}`).map(
    (r) => r.t,
  );
const droppedOf = (texts: string[]) => {
  const hit = texts.map((t) => /dropped_due_dates"?\s*:\s*"?(\d+)/.exec(t)).find((m) => m);
  return hit ? Number(hit[1]) : null;
};

/** Test-local trigger lever: runs `body` (SQL) once the template's FIRST draft has been stamped (after it, in the same tx). */
async function withAfterFirstStamp(name: string, orgId: string, body: string, fn: () => Promise<void>) {
  await sql.unsafe(`create or replace function ${name}_fn() returns trigger as $$ begin ${body} return new; end $$ language plpgsql`);
  await sql.unsafe(`drop trigger if exists ${name} on recurring_expenses`);
  await sql.unsafe(`
    create trigger ${name} after update on recurring_expenses for each row
    when (new.org_id = '${orgId}'::uuid and old.last_drafted_expense_id is null and new.last_drafted_expense_id is not null)
    execute function ${name}_fn()`);
  try {
    await fn();
  } finally {
    await sql.unsafe(`drop trigger if exists ${name} on recurring_expenses`);
    await sql.unsafe(`drop function if exists ${name}_fn()`);
  }
}

afterAll(async () => {
  await sql.unsafe(`drop trigger if exists t430_pause on recurring_expenses`);
  await sql.unsafe(`drop function if exists t430_pause_fn()`);
  await sql.unsafe(`drop trigger if exists t430_deact on recurring_expenses`);
  await sql.unsafe(`drop function if exists t430_deact_fn()`);
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('catch-up: one draft per missed due date', () => {
  it('1 — monthly, started 3 due dates ago: exactly 3 drafts, cursor on the next future date, starts_on stored', async () => {
    const f = await fixture('c1');
    for (const m of ['2026-07', '2026-08']) await addPeriod(f, m, 'open');
    const { id } = await mkTemplate(f, '2026-07-01');

    const r = await run(f);

    expect(await draftDates(f.orgId)).toEqual(['2026-07-05', '2026-08-05', '2026-09-05']);
    const c = await counts(f.orgId);
    expect([c.e, c.i, c.d]).toEqual([3, 3, 3]);
    expect(await cursorOf(id)).toBe('2026-10-05');
    expect(r.outcomes[0]!.posted).toBe(3);
    expect(r.hadFailures).toBe(false);
    const [row] = await sql<{ s: string }[]>`select starts_on::text as s from recurring_expenses where id = ${id}`;
    expect(row!.s).toBe('2026-07-01');
  });

  it('2 — weekly, started exactly 21 days before the pinned clock: 4 drafts (days 0, 7, 14, 21), all in one month', async () => {
    const f = await fixture('c2');
    const now = Date.parse('2026-09-28T02:00:00Z'); // Monday, Manila 2026-09-28
    const { id } = await mkTemplate(f, '2026-09-07', { interval: 'weekly', anchorDay: 1 });

    await run(f, now);

    expect(await draftDates(f.orgId)).toEqual(['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
    expect(await cursorOf(id)).toBe('2026-10-05');
  });

  it('3 — a second run the same day drafts nothing and reports due 0', async () => {
    const f = await fixture('c3');
    await addPeriod(f, '2026-07', 'open');
    await addPeriod(f, '2026-08', 'open');
    await mkTemplate(f, '2026-07-01');
    await run(f);
    const mid = await counts(f.orgId);

    const second = await run(f);

    const after = await counts(f.orgId);
    expect([after.e, after.i, after.d]).toEqual([3, 3, 3]);
    expect(mid.d).toBe(3);
    expect(second.outcomes[0]!.posted).toBe(0);
    expect(second.outcomes[0]!.detail).toMatch(/due 0\b/);
  });

  it('4 — two runs started at once: each due date is drafted once, no orphan invoice or expense', async () => {
    const f = await fixture('c4');
    await addPeriod(f, '2026-07', 'open');
    await addPeriod(f, '2026-08', 'open');
    await mkTemplate(f, '2026-07-01');

    await Promise.allSettled([run(f), run(f)]);

    expect(await draftDates(f.orgId)).toEqual(['2026-07-05', '2026-08-05', '2026-09-05']);
    const c = await counts(f.orgId);
    expect([c.e, c.i, c.d]).toEqual([3, 3, 3]);
    const [orphans] = await sql<{ n: number }[]>`
      select count(*)::int as n from recurring_expense_drafts where org_id = ${f.orgId} and (expense_id is null or supplier_invoice_id is null)`;
    expect(orphans!.n).toBe(0);
  });

  it('5 — stampDrafted with a wrong expected due date updates nothing, throws, and rolls back the documents made before it', async () => {
    const f = await fixture('c5');
    const { id } = await mkTemplate(f, '2026-09-01'); // cursor 2026-09-05
    const before = await counts(f.orgId);

    await expect(
      asOrg(f.orgId, async (tx) => {
        const invoice = await recordInvoice(tx, f.manager, {
          storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-09-05', dueDate: '2026-09-05',
          totalAmount: money('25000.00'), invoiceNo: uid('RECUR-t430'), notes: 'x',
        });
        const expense = await createExpense(tx, f.manager, {
          storeId: f.storeId, businessDate: '2026-09-05', categoryId: f.categoryId, supplierId: f.supplierId,
          supplierInvoiceId: invoice.id, particulars: 'x',
          payments: [{ method: 'credit', amount: money('25000.00'), moneyAccountId: null }],
        });
        await recurringExpensesRepo.stampDrafted(tx, f.orgId, id, {
          expenseId: expense.id, nextDueDate: '2026-10-05', at: new Date(NOW),
          expectedDueDate: '2026-08-05',
        } as never);
      }),
    ).rejects.toThrow();

    const after = await counts(f.orgId);
    expect([after.e, after.i]).toEqual([before.e, before.i]);
    expect(await cursorOf(id)).toBe('2026-09-05');
  });

  it('6 — a stuck cursor (drafts row exists, cursor never stamped) advances with no new documents, then drafts the next date', async () => {
    const f = await fixture('c6');
    await addPeriod(f, '2026-08', 'open');
    const { id } = await mkTemplate(f, '2026-08-01'); // cursor 2026-08-05
    await sql`insert into recurring_expense_drafts (org_id, recurring_expense_id, due_date) values (${f.orgId}, ${id}, '2026-08-05')`;

    const r = await run(f);

    const c = await counts(f.orgId);
    expect([c.e, c.i, c.d]).toEqual([1, 1, 2]);
    const [exp] = await sql<{ d: string }[]>`select business_date::text as d from expenses where org_id = ${f.orgId}`;
    expect(exp!.d).toBe('2026-09-05');
    expect(await cursorOf(id)).toBe('2026-10-05');
    expect(r.outcomes[0]!.skipped).toBe(1);
    expect(r.hadFailures).toBe(false);
  });

  it('7 — a template paused between iterations stops: no 2nd draft, "paused during run", no failure', async () => {
    const f = await fixture('c7');
    await addPeriod(f, '2026-07', 'open');
    await addPeriod(f, '2026-08', 'open');
    const { id } = await mkTemplate(f, '2026-07-01');
    let r!: Awaited<ReturnType<typeof run>>;
    await withAfterFirstStamp(
      't430_pause', f.orgId,
      `update recurring_expenses set status = 'paused' where id = new.id;`,
      async () => { r = await run(f); },
    );

    expect((await counts(f.orgId)).e).toBe(1);
    expect(await draftDates(f.orgId)).toEqual(['2026-07-05']);
    expect(r.outcomes[0]!.detail).toMatch(/paused during run/);
    expect(r.outcomes[0]!.failures).toEqual([]);
    expect(r.hadFailures).toBe(false);
    expect(await cursorOf(id)).toBe('2026-08-05');
  });

  it('8 — 15 due dates elapsed: 12 drafted and reported capped, still due; the next run drafts the other 3', async () => {
    expect(CATCH_UP_CAP).toBe(12);
    const f = await fixture('c8');
    const { id } = await mkTemplate(f, '2025-07-01'); // 2025-07-05 .. 2026-09-05 = 15 due dates

    const first = await run(f);

    expect((await counts(f.orgId)).e).toBe(12);
    expect(first.outcomes[0]!.detail).toMatch(/capped 3\b/);
    expect(await cursorOf(id)).toBe('2026-07-05');

    const second = await run(f);

    expect((await counts(f.orgId)).e).toBe(15);
    expect(second.outcomes[0]!.posted).toBe(3);
    expect(await cursorOf(id)).toBe('2026-10-05');
  });

  it('9 — failure on the 2nd of 3: the 1st is kept, the failure names the template, nothing is left from the 2nd', async () => {
    const f = await fixture('c9');
    await addPeriod(f, '2026-07', 'open');
    await addPeriod(f, '2026-08', 'open');
    const { id } = await mkTemplate(f, '2026-07-01');
    let r!: Awaited<ReturnType<typeof run>>;
    await withAfterFirstStamp(
      't430_deact', f.orgId,
      `update suppliers set status = 'inactive' where org_id = new.org_id;`,
      async () => { r = await run(f); },
    );

    const c = await counts(f.orgId);
    expect([c.e, c.i, c.d]).toEqual([1, 1, 1]);
    expect(await draftDates(f.orgId)).toEqual(['2026-07-05']);
    expect(r.outcomes[0]!.failures.map((x) => x.subjectName)).toEqual(['Lipa branch rent']);
    expect(r.hadFailures).toBe(true);
    expect(await cursorOf(id)).toBe('2026-08-05');
  });
});

describe('closed months: dated on the first open day, real due date kept', () => {
  // A locked period must sit in a year with no open period (DB trigger), so the locked case uses December 2025.
  const shut = [
    { status: 'closed' as const, month: '2026-08', startsOn: '2026-08-01', real: '2026-08-05', open: '2026-09-01', total: 2 },
    { status: 'locked' as const, month: '2025-12', startsOn: '2025-12-01', real: '2025-12-05', open: '2026-01-01', total: 10 },
  ];
  for (const c of shut) {
    it(`10 — a due date in a ${c.status} period: invoice date = due date = expense date = first open day; real date kept in the drafts row and the notes`, async () => {
      const f = await fixture(`c10${c.status}`);
      await addPeriod(f, c.month, c.status);
      await mkTemplate(f, c.startsOn);

      const r = await run(f);

      expect(r.hadFailures).toBe(false);
      const dates = await draftDates(f.orgId);
      expect(dates.length).toBe(c.total);
      expect(dates[0]).toBe(c.real); // keyed on the REAL date
      const [inv] = await sql<{ invoice_date: string; due_date: string; notes: string }[]>`
        select i.invoice_date::text, i.due_date::text, i.notes
        from recurring_expense_drafts d join supplier_invoices i on i.id = d.supplier_invoice_id
        where d.org_id = ${f.orgId} and d.due_date = ${c.real}`;
      expect(inv!.invoice_date).toBe(c.open);
      expect(inv!.due_date).toBe(c.open);
      expect(inv!.notes).toContain(c.real);
      expect(inv!.notes).toContain(c.open);
      expect(inv!.notes).toContain(c.status);
      const [exp] = await sql<{ business_date: string; particulars: string }[]>`
        select e.business_date::text, e.particulars
        from recurring_expense_drafts d join expenses e on e.id = d.expense_id
        where d.org_id = ${f.orgId} and d.due_date = ${c.real}`;
      expect(exp!.business_date).toBe(c.open);
      expect(exp!.particulars).toContain(c.real);
      expect(exp!.particulars).toContain(c.open);
    });
  }

  it('11a — no period row covering the date: dated on the real due date, not treated as closed', async () => {
    const f = await fixture('c11a'); // only September exists
    await mkTemplate(f, '2026-08-01');

    await run(f);

    const rows = await sql<{ d: string; due: string }[]>`
      select e.business_date::text as d, i.due_date::text as due from expenses e
      join supplier_invoices i on i.id = e.supplier_invoice_id where e.org_id = ${f.orgId} order by e.business_date`;
    expect(rows.map((x) => x.d)).toEqual(['2026-08-05', '2026-09-05']);
    expect(rows.map((x) => x.due)).toEqual(['2026-08-05', '2026-09-05']);
  });

  it('11b — every period through today closed: nothing drafted, cursor unchanged, "no open period" reported', async () => {
    const f = await fixture('c11b', { sept: 'closed' });
    await addPeriod(f, '2026-08', 'closed');
    const { id } = await mkTemplate(f, '2026-08-01'); // cursor 2026-08-05

    const r = await run(f);

    const c = await counts(f.orgId);
    expect([c.e, c.i, c.d]).toEqual([0, 0, 0]);
    expect(await cursorOf(id)).toBe('2026-08-05');
    expect(r.outcomes[0]!.detail).toMatch(/no open period/);
  });
});

describe('never pays', () => {
  it('12 — every draft is draft/pending; no ledger entry, no transfer, no payment', async () => {
    const f = await fixture('c12');
    await addPeriod(f, '2026-07', 'open');
    await addPeriod(f, '2026-08', 'open');
    await mkTemplate(f, '2026-07-01');

    await run(f);

    const c = await counts(f.orgId);
    expect(c.e).toBe(3);
    expect(c.j).toBe(0);
    expect(c.t).toBe(0);
    const ex = await sql<{ status: string; journal_entry_id: string | null }[]>`
      select status, journal_entry_id from expenses where org_id = ${f.orgId}`;
    expect(ex.every((x) => x.status === 'draft' && x.journal_entry_id === null)).toBe(true);
    const inv = await sql<{ status: string }[]>`select status from supplier_invoices where org_id = ${f.orgId}`;
    expect(inv.every((x) => x.status === 'pending')).toBe(true);
  });
});

describe('the starting period on create', () => {
  it('13a — a future start is accepted: no draft before that due date, the first draft on it', async () => {
    const f = await fixture('c13a');
    const { id, nextDueDate: first } = await mkTemplate(f, '2027-12-01');
    expect(first).toBe('2027-12-05');

    await run(f); // 2026-09-20
    expect((await counts(f.orgId)).e).toBe(0);
    expect(await cursorOf(id)).toBe('2027-12-05');

    await run(f, Date.parse('2027-12-05T02:00:00Z'));
    expect(await draftDates(f.orgId)).toEqual(['2027-12-05']);
  });

  it('13b — before the store opening date is refused; equal to it is accepted', async () => {
    const f = await fixture('c13b', { opening: '2026-03-01' });
    await expect(mkTemplate(f, '2026-02-28')).rejects.toThrow();
    const ok = await mkTemplate(f, '2026-03-01');
    expect(ok.nextDueDate).toBe('2026-03-05');
    expect((await sql`select 1 from recurring_expenses where store_id = ${f.storeId}`).length).toBe(1);
  });

  it('13c — a store with no opening date: a past start is refused; today and an omitted start are accepted', async () => {
    const f = await fixture('c13c', { opening: null });
    await expect(mkTemplate(f, '2020-01-01')).rejects.toThrow();
    const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
    await mkTemplate(f, today);
    await mkTemplate(f, undefined, { name: 'Internet' });
    expect((await sql`select 1 from recurring_expenses where store_id = ${f.storeId}`).length).toBe(2);
  });
});

describe('what a catch-up drops is never silent', () => {
  /** Old-rule due dates from the old cursor up to (not including) the new cursor. */
  const walk = (from: string, to: string) => {
    let n = 0;
    for (let d = from; d < to && n < 100; d = nextDueDate(d, 'monthly', 5)) n += 1;
    return n;
  };
  /** 17 due dates owed (2025-05-05 .. 2026-09-05); one capped run leaves 5 (2026-05-05 .. 2026-09-05). */
  async function cappedWithFiveLeft(hint: string) {
    const f = await fixture(hint);
    const { id } = await mkTemplate(f, '2025-05-01');
    await run(f);
    expect((await counts(f.orgId)).e).toBe(12);
    expect(await cursorOf(id)).toBe('2026-05-05');
    return { f, id };
  }

  it('14a — resume after pause: the audit row carries dropped_due_dates equal to the owed dates skipped over', async () => {
    const { f, id } = await cappedWithFiveLeft('c14a');
    await asOrg(f.orgId, (tx) => setRecurringTemplateStatus(tx, f.manager, { templateId: id, status: 'paused' }));
    await asOrg(f.orgId, (tx) => setRecurringTemplateStatus(tx, f.manager, { templateId: id, status: 'active' }));

    // Resume re-derives the cursor from the REAL clock (the domain function takes no nowMs), so the expected count is
    // computed from where the cursor actually landed, not hard-coded.
    const moved = await cursorOf(id);
    expect(moved > '2026-05-05').toBe(true);
    const expected = walk('2026-05-05', moved);
    expect(expected).toBeGreaterThanOrEqual(5);
    expect(droppedOf(await auditText(id))).toBe(expected);
  });

  it('14b — an anchor edit: the audit row carries dropped_due_dates', async () => {
    const { f, id } = await cappedWithFiveLeft('c14b');
    await asOrg(f.orgId, (tx) => updateRecurringTemplate(tx, f.manager, { templateId: id, anchorDay: 10 }));

    const moved = await cursorOf(id);
    expect(moved > '2026-05-05').toBe(true);
    expect(droppedOf(await auditText(id))).toBe(walk('2026-05-05', moved));
  });
});

describe('history and audit', () => {
  it('15 — a caught-up template cannot be deleted; a never-drafted one can; create writes one audit row carrying starts_on', async () => {
    const f = await fixture('c15');
    await addPeriod(f, '2026-08', 'open');
    const { id } = await mkTemplate(f, '2026-08-01');
    const texts = await auditText(id);
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain('starts_on');
    expect(texts[0]).toContain('2026-08-01');

    await run(f);
    await expect(
      asOrg(f.orgId, (tx) => deleteRecurringTemplate(tx, f.manager, { templateId: id })),
    ).rejects.toThrow(/history|pause/);

    const fresh = await mkTemplate(f, '2027-01-01', { name: 'Water' });
    await asOrg(f.orgId, (tx) => deleteRecurringTemplate(tx, f.manager, { templateId: fresh.id }));
    expect((await sql`select 1 from recurring_expenses where id = ${fresh.id}`).length).toBe(0);
  });
});

describe('DEF-663 — a catch-up must not multiply an unapprovable cash line', () => {
  it('17 — cash default account, 3 periods: no draft carries a cash payment with a NULL money account (a line with the account, or no line)', async () => {
    const f = await fixture('c17');
    await addPeriod(f, '2026-07', 'open');
    await addPeriod(f, '2026-08', 'open');
    const [office] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${f.storeId} and custodian = 'office' and instrument = 'cash' limit 1`;
    await mkTemplate(f, '2026-07-01', { defaultMoneyAccountId: office!.id });

    const r = await run(f);

    expect(r.hadFailures).toBe(false);
    expect((await counts(f.orgId)).e).toBe(3);
    const bad = await sql<{ n: number }[]>`
      select count(*)::int as n from expense_payments p join expenses e on e.id = p.expense_id
      where e.org_id = ${f.orgId} and p.method = 'cash' and p.money_account_id is null`;
    expect(bad[0]!.n).toBe(0);
    // Either branch of the ruling: a resolvable account is used, an unresolvable one leaves no payment line at all.
    const lines = await sql<{ expense_id: string; money_account_id: string | null }[]>`
      select p.expense_id, p.money_account_id from expense_payments p join expenses e on e.id = p.expense_id where e.org_id = ${f.orgId}`;
    expect(lines.every((l) => l.money_account_id !== null)).toBe(true);
  });
});
