import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

/**
 * T-418 (TESTER) - the race gaps the audit found, now that the admin PIN no longer sits in front of a draft delete.
 * The domain checks "is it still a draft / never produced" and THEN calls the repo; between the two a post (or the recurring
 * job) can land. So the repo's own DELETE must carry the guard, not rely on the caller having looked.
 *
 *  R1  stockUsageRepo.deleteUsageDraft(tx, id) on a record that is no longer 'draft' must refuse (throw) or delete 0 rows;
 *      the posted record stays.  RED TODAY: the DELETE is `WHERE id = $1` only, so the posted record is deleted.
 *  R2  recurringExpensesRepo.deleteTemplate(tx, orgId, id) on a template whose last_drafted_expense_id is set must refuse
 *      (throw) or delete 0 rows; the template stays.  RED TODAY: `WHERE id AND org_id` only, so it is deleted.
 *
 * Deterministic: no concurrency, the state is set first and the repo called directly.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, transaction, APP_ROLE, stockUsageRepo, recurringExpensesRepo, type Tx } from '../../src';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/** Run the repo call and report how it ended: it threw, or it returned (then the row count decides). */
async function attempt(fn: () => Promise<unknown>): Promise<'threw' | 'returned'> {
  try {
    await fn();
    return 'returned';
  } catch {
    return 'threw';
  }
}

describe('T-418 R1: the usage repo will not delete a record that is no longer a draft', () => {
  it('a posted usage record survives deleteUsageDraft', async () => {
    const code = uid('t418r1');
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const orgId = org!.id;
    const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S')}, 'S') returning id`;
    const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'P') returning id`;
    const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, ${uid('T')}, 'Room') returning id`;
    const [loc] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${orgId}, ${store!.id}, ${uid('K')}, 'Kitchen', ${type!.id}, 'operating', true, ${person!.id}) returning id`;
    const [rec] = await sql<{ id: string }[]>`
      insert into stock_usage_records (org_id, store_id, location_id, kind, used_on, created_by)
      values (${orgId}, ${store!.id}, ${loc!.id}, 'usage', '2026-01-10', ${person!.id}) returning id`;
    // the post lands between the domain's draft check and the repo's DELETE
    await sql`update stock_usage_records set status = 'posted', posted_at = now(), posted_by = ${person!.id} where id = ${rec!.id}`;

    const how = await attempt(() => asOrg(orgId, (tx) => stockUsageRepo.deleteUsageDraft(tx, rec!.id)));
    const [left] = await sql<{ n: number }[]>`select count(*)::int as n from stock_usage_records where id = ${rec!.id}`;
    expect(left!.n, `the posted record must still exist (the repo call ${how})`).toBe(1);
    const [status] = await sql<{ status: string }[]>`select status from stock_usage_records where id = ${rec!.id}`;
    expect(status!.status).toBe('posted');
  });
});

describe('T-418 R2: the recurring repo will not delete a template that has produced an expense', () => {
  it('a template with last_drafted_expense_id set survives deleteTemplate', async () => {
    const code = uid('t418r2');
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const orgId = org!.id;
    const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S')}, 'S') returning id`;
    const [cat] = await sql<{ id: string }[]>`
      insert into expense_categories (org_id, "group", category, account_code) values (${orgId}, 'OPEX', ${uid('cat')}, '6200') returning id`;
    const [tpl] = await sql<{ id: string }[]>`
      insert into recurring_expenses (org_id, store_id, name, category_id, default_amount, interval, anchor_day, next_due_date)
      values (${orgId}, ${store!.id}, 'Lipa rent', ${cat!.id}, '25000.00', 'monthly', 5, '2026-02-05') returning id`;
    // As the job would set it. A real expense needs an invoice chain; this test is about the repo's DELETE, so the FK
    // and triggers are stepped around on the owner connection for this one UPDATE only.
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update recurring_expenses set last_drafted_expense_id = ${randomUUID()}, last_drafted_at = now() where id = ${tpl!.id}`;
    });
    const [pre] = await sql<{ x: string | null }[]>`select last_drafted_expense_id as x from recurring_expenses where id = ${tpl!.id}`;
    expect(pre!.x, 'fixture: the template looks produced').not.toBeNull();

    const how = await attempt(() => asOrg(orgId, (tx) => recurringExpensesRepo.deleteTemplate(tx, orgId, tpl!.id)));
    const [left] = await sql<{ n: number }[]>`select count(*)::int as n from recurring_expenses where id = ${tpl!.id}`;
    expect(left!.n, `the template must still exist (the repo call ${how})`).toBe(1);
  });
});
