import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-216 — recurring-expense TEMPLATES. `docs/tasks/216-recurring-expense-automation.md`.
 *
 * ⚠️ **This covers the template only. The JOB is not built**, because whether a due template
 * DRAFTS an expense (§3's design) or AUTO-PAYS it (v1's) is an open decision for Ian and it changes
 * the job's shape rather than a flag. The spec's job cases (1–6, 9, 10) are therefore absent, and
 * their absence is a decision rather than an omission — see the module header.
 *
 * ⭐ What IS proved here is everything that is the same under either answer: the table's own
 * refusals, the till rule v1 learned the hard way, the cursor derivation, and the capability gate.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { recurringExpensesRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createRecurringTemplate,
  deleteRecurringTemplate,
  setRecurringTemplateStatus,
  updateRecurringTemplate,
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

/**
 * Every one of these is reached in production only through an API-layer wrapper that has
 * already called withOrgPrincipal — none establishes a principal itself. Standing in for
 * that layer here (via this file's own asOrg, the same pattern), at the same depth
 * production wraps at, instead of passing `null` and running with no principal at all.
 */
function createRecurringTemplateAsOrg(orgId: string, actorArg: Actor, input: Parameters<typeof createRecurringTemplate>[2]) {
  return asOrg(orgId, (tx) => createRecurringTemplate(tx, actorArg, input));
}
function setRecurringTemplateStatusAsOrg(orgId: string, actorArg: Actor, input: Parameters<typeof setRecurringTemplateStatus>[2]) {
  return asOrg(orgId, (tx) => setRecurringTemplateStatus(tx, actorArg, input));
}
function deleteRecurringTemplateAsOrg(orgId: string, actorArg: Actor, input: Parameters<typeof deleteRecurringTemplate>[2]) {
  return asOrg(orgId, (tx) => deleteRecurringTemplate(tx, actorArg, input));
}
function updateRecurringTemplateAsOrg(orgId: string, actorArg: Actor, input: Parameters<typeof updateRecurringTemplate>[2]) {
  return asOrg(orgId, (tx) => updateRecurringTemplate(tx, actorArg, input));
}

async function fixture(hint: string) {
  const code = uid(`rec-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, '2020-01-01') returning id`;
  const storeId = store!.id;
  const [other] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid('oth')}, ${'Other store'}, '2020-01-01') returning id`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${other!.id})`;
    return p!.id;
  };
  const managerId = await mk('Manager', 'manager');
  const staffId = await mk('Staff', 'staff');
  const [category] = await sql<{ id: string }[]>`
    insert into expense_categories (org_id, "group", category, account_code)
    values (${orgId}, 'OPEX', ${uid('cat')}, '6200') returning id`;
  // T-216 Part 2: a template names the party the bill comes from. The JOB cannot draft without it
  // (`expenses.supplier_id` is NOT NULL), so `createRecurringTemplate` requires it.
  const [supplier] = await sql<{ id: string }[]>`
    insert into suppliers (org_id, name, created_by) values (${orgId}, ${`Landlord ${hint}`}, ${managerId})
    returning id`;
  // ⭐ Every store is born with five money accounts (bible row 156) — the till and the office safe
  // are both already there, which is what makes the till rule testable without inventing fixtures.
  const [till] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and custodian = 'cashier' and instrument = 'cash' limit 1`;
  const [office] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and custodian = 'office' and instrument = 'cash' limit 1`;
  const [otherStoreOffice] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${other!.id} and custodian = 'office' limit 1`;
  return {
    orgId, storeId, otherStoreId: other!.id, categoryId: category!.id, supplierId: supplier!.id,
    tillId: till!.id, officeId: office!.id, otherStoreAccountId: otherStoreOffice!.id,
    manager: actor(orgId, managerId), staff: actor(orgId, staffId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const base = (f: Fixture) => ({
  storeId: f.storeId,
  name: 'Lipa branch rent',
  categoryId: f.categoryId,
  supplierId: f.supplierId,
  defaultAmount: '25000.00',
  interval: 'monthly' as const,
  anchorDay: 5,
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('a template, and the cursor it starts on', () => {
  it('⭐ a template created before its anchor is due THIS month, not next', async () => {
    // Getting this wrong makes every new template a month late, silently, and only the person
    // waiting for the bill would ever notice.
    const f = await fixture('cursor');
    const { nextDueDate } = await createRecurringTemplateAsOrg(f.orgId, f.manager, {
      ...base(f), startsOn: '2026-09-03',
    });
    expect(nextDueDate).toBe('2026-09-05');
  });

  it('a template created AFTER its anchor rolls to next month', async () => {
    const f = await fixture('cursor2');
    const { nextDueDate } = await createRecurringTemplateAsOrg(f.orgId, f.manager, {
      ...base(f), startsOn: '2026-09-20',
    });
    expect(nextDueDate).toBe('2026-10-05');
  });

  it('⚠️ a 31st anchor clamps rather than being refused — "the last day of the month"', async () => {
    const f = await fixture('clamp');
    const { nextDueDate } = await createRecurringTemplateAsOrg(f.orgId, f.manager, {
      ...base(f), anchorDay: 31, startsOn: '2026-02-01',
    });
    expect(nextDueDate).toBe('2026-02-28');
  });
});

describe('⛔ the till rule v1 learned the hard way', () => {
  it('refuses a CASHIER account as the default unless it was deliberately chosen', async () => {
    // v1: "a recurring/scheduled payment must never silently draw from the cashier till." v1 solves
    // it with a runtime fallback to office cash; here the bad value cannot be stored at all.
    const f = await fixture('till');
    await expect(
      createRecurringTemplateAsOrg(f.orgId, f.manager, { ...base(f), defaultMoneyAccountId: f.tillId }),
    ).rejects.toThrow(/CASHIER account/);
  });

  it('accepts the till when the choice is explicit, and RECORDS that it was', async () => {
    const f = await fixture('till-ok');
    const { id } = await createRecurringTemplateAsOrg(f.orgId, f.manager, {
      ...base(f), defaultMoneyAccountId: f.tillId, tillIsDeliberate: true,
    });
    const row = await asOrg(f.orgId, (tx) => recurringExpensesRepo.getById(tx, f.orgId, id));
    expect(row!.tillIsDeliberate).toBe(true);
  });

  it('⚠️ an OFFICE account never sets the deliberate flag, whatever was passed', async () => {
    // Otherwise the flag would claim a considered decision about an account nobody had to think
    // about, and the one place it means something would stop meaning anything.
    const f = await fixture('till-office');
    const { id } = await createRecurringTemplateAsOrg(f.orgId, f.manager, {
      ...base(f), defaultMoneyAccountId: f.officeId, tillIsDeliberate: true,
    });
    const row = await asOrg(f.orgId, (tx) => recurringExpensesRepo.getById(tx, f.orgId, id));
    expect(row!.tillIsDeliberate).toBe(false);
  });

  it('refuses an account belonging to a DIFFERENT store', async () => {
    const f = await fixture('crossstore');
    await expect(
      createRecurringTemplateAsOrg(f.orgId, f.manager, { ...base(f), defaultMoneyAccountId: f.otherStoreAccountId }),
    ).rejects.toThrow(/different store/);
  });
});

describe('the database refuses what a service must not be trusted to remember', () => {
  it('⛔ anchor_day = 32 is refused BY THE DATABASE', async () => {
    // v1 stores an out-of-range anchor happily and clamps at read time, so a template can hold 45
    // for ever and merely behave as though it said 31.
    const f = await fixture('anchor32');
    await expect(
      sql`insert into recurring_expenses (org_id, store_id, name, category_id, default_amount, interval, anchor_day, next_due_date)
          values (${f.orgId}, ${f.storeId}, 'bad', ${f.categoryId}, '100.00', 'monthly', 32, '2026-09-05')`,
    ).rejects.toThrow(/recurring_expenses_anchor_day_check/);
  });

  it('⛔ a WEEKLY template anchored on day 15 is refused — the check knows both families', async () => {
    const f = await fixture('anchorweek');
    await expect(
      sql`insert into recurring_expenses (org_id, store_id, name, category_id, default_amount, interval, anchor_day, next_due_date)
          values (${f.orgId}, ${f.storeId}, 'bad', ${f.categoryId}, '100.00', 'weekly', 15, '2026-09-05')`,
    ).rejects.toThrow(/recurring_expenses_anchor_day_check/);
  });

  it('⛔ a zero default amount is refused BY THE DATABASE', async () => {
    const f = await fixture('zeroamt');
    await expect(
      sql`insert into recurring_expenses (org_id, store_id, name, category_id, default_amount, interval, anchor_day, next_due_date)
          values (${f.orgId}, ${f.storeId}, 'bad', ${f.categoryId}, '0.00', 'monthly', 5, '2026-09-05')`,
    ).rejects.toThrow(/recurring_expenses_amount_check/);
  });

  it('⛔ STAFF may not manage a template — the ✗ in the matrix fires', async () => {
    const f = await fixture('denied');
    await expect(createRecurringTemplateAsOrg(f.orgId, f.staff, base(f))).rejects.toThrow(/manage_recurring_expenses/);
  });
});

describe('pause, resume, and the one thing that may not be deleted', () => {
  it('pausing and resuming flips the status', async () => {
    const f = await fixture('pause');
    const { id } = await createRecurringTemplateAsOrg(f.orgId, f.manager, base(f));
    await setRecurringTemplateStatusAsOrg(f.orgId, f.manager, { templateId: id, status: 'paused' });
    let row = await asOrg(f.orgId, (tx) => recurringExpensesRepo.getById(tx, f.orgId, id));
    expect(row!.status).toBe('paused');
    await setRecurringTemplateStatusAsOrg(f.orgId, f.manager, { templateId: id, status: 'active' });
    row = await asOrg(f.orgId, (tx) => recurringExpensesRepo.getById(tx, f.orgId, id));
    expect(row!.status).toBe('active');
  });

  it('⭐ resuming a long-paused template moves its cursor to the FUTURE, not the past', async () => {
    // Otherwise it wakes with a due date months behind and drafts its way forward — noise on the
    // morning somebody switched it back on, and the opposite of what "resume" means.
    const f = await fixture('stale');
    const { id } = await createRecurringTemplateAsOrg(f.orgId, f.manager, { ...base(f), startsOn: '2026-01-02' });
    await sql`update recurring_expenses set next_due_date = '2026-01-05', status = 'paused' where id = ${id}`;
    await setRecurringTemplateStatusAsOrg(f.orgId, f.manager, { templateId: id, status: 'active' });
    const row = await asOrg(f.orgId, (tx) => recurringExpensesRepo.getById(tx, f.orgId, id));
    expect(row!.nextDueDate > '2026-01-05').toBe(true);
  });

  it('a never-used template can be deleted', async () => {
    const f = await fixture('del');
    const { id } = await createRecurringTemplateAsOrg(f.orgId, f.manager, base(f));
    await deleteRecurringTemplateAsOrg(f.orgId, f.manager, { templateId: id });
    expect(await asOrg(f.orgId, (tx) => recurringExpensesRepo.getById(tx, f.orgId, id))).toBeUndefined();
  });

  it('⛔ one that has already produced an expense is refused — pause it instead', async () => {
    const f = await fixture('delused');
    const { id } = await createRecurringTemplateAsOrg(f.orgId, f.manager, base(f));
    // Stand in for the job's stamp. ⚠️ A real `expenses` row is needed because the FK is real; the
    // point of the test is the SERVICE's refusal, not how the id got there.
    const [supplier] = await sql<{ id: string }[]>`
      insert into suppliers (org_id, name, created_by) values (${f.orgId}, ${uid('sup')}, ${f.manager.personId}) returning id`;
    const [inv] = await sql<{ id: string }[]>`
      insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, status, created_by)
      values (${f.orgId}, ${f.storeId}, ${supplier!.id}, '2026-09-05', '100.00', 'pending', ${f.staff.personId}) returning id`;
    const [exp] = await sql<{ id: string }[]>`
      insert into expenses (org_id, store_id, business_date, total_amount, category_id, supplier_id,
                            supplier_invoice_id, particulars, status, created_by)
      values (${f.orgId}, ${f.storeId}, '2026-09-05', '100.00', ${f.categoryId}, ${supplier!.id},
              ${inv!.id}, 'from a template', 'draft', ${f.manager.personId}) returning id`;
    await sql`update recurring_expenses set last_drafted_expense_id = ${exp!.id} where id = ${id}`;

    await expect(deleteRecurringTemplateAsOrg(f.orgId, f.manager, { templateId: id })).rejects.toThrow(/pause it instead/);
  });

  it('⛔ editing only the NAME leaves the due date alone', async () => {
    // The screen posts every field on every save, so a naive "was a value supplied?" check would
    // move the due date whenever anyone corrected a typo — a silent change to when a bill comes up,
    // made by an edit that had nothing to do with timing. Found in self-review, and this is the
    // test that keeps it found.
    const f = await fixture('editname');
    const { id } = await createRecurringTemplateAsOrg(f.orgId, f.manager, { ...base(f), startsOn: '2026-01-02' });
    const before = await asOrg(f.orgId, (tx) => recurringExpensesRepo.getById(tx, f.orgId, id));
    await updateRecurringTemplateAsOrg(f.orgId, f.manager, {
      templateId: id,
      name: 'Lipa branch rent (corrected)',
      interval: before!.interval,
      anchorDay: before!.anchorDay,
    });
    const after = await asOrg(f.orgId, (tx) => recurringExpensesRepo.getById(tx, f.orgId, id));
    expect(after!.name).toBe('Lipa branch rent (corrected)');
    expect(after!.nextDueDate).toBe(before!.nextDueDate);
  });

  it('⚠️ changing the INTERVAL re-derives the cursor — an old due date the new rule could not produce is not kept', async () => {
    const f = await fixture('edit');
    const { id } = await createRecurringTemplateAsOrg(f.orgId, f.manager, { ...base(f), anchorDay: 30, startsOn: '2026-01-02' });
    const before = await asOrg(f.orgId, (tx) => recurringExpensesRepo.getById(tx, f.orgId, id));
    await updateRecurringTemplateAsOrg(f.orgId, f.manager, { templateId: id, interval: 'weekly', anchorDay: 2 });
    const after = await asOrg(f.orgId, (tx) => recurringExpensesRepo.getById(tx, f.orgId, id));
    expect(after!.interval).toBe('weekly');
    expect(after!.anchorDay).toBe(2);
    expect(after!.nextDueDate).not.toBe(before!.nextDueDate);
    // A weekly-on-Tuesday cursor must actually be a Tuesday.
    expect(new Date(`${after!.nextDueDate}T00:00:00Z`).getUTCDay()).toBe(2);
  });
});

describe('DEF-272 — a sub-centavo amount is refused with a written sentence, not driver text', () => {
  it('createRecurringTemplate refuses "0.004" for defaultAmount', async () => {
    const f = await fixture('def272-create');
    await expect(
      createRecurringTemplateAsOrg(f.orgId, f.manager, { ...base(f), defaultAmount: '0.004' }),
    ).rejects.toThrow(/createRecurringTemplate: the default amount.*"0\.004"/);
  });

  it('an ordinary template still works, and the exact value is stored', async () => {
    const f = await fixture('def272-happy');
    const { id } = await createRecurringTemplateAsOrg(f.orgId, f.manager, { ...base(f), defaultAmount: '0.01' });
    const row = await asOrg(f.orgId, (tx) => recurringExpensesRepo.getById(tx, f.orgId, id));
    expect(row!.defaultAmount).toBe('0.01');
  });

  it('updateRecurringTemplate refuses "0.004" for defaultAmount', async () => {
    const f = await fixture('def272-update');
    const { id } = await createRecurringTemplateAsOrg(f.orgId, f.manager, base(f));
    await expect(
      updateRecurringTemplateAsOrg(f.orgId, f.manager, { templateId: id, defaultAmount: '0.004' }),
    ).rejects.toThrow(/updateRecurringTemplate: the default amount.*"0\.004"/);
  });
});
