/**
 * T-374 S7 / DEF-578 / R13 (T11) - `pos_usage_pulls_void_shape_check`, migration 0181.
 * `docs/tasks/374-money-push-follow-ups.md` section S7.
 *
 * TESTER, not BUILDER. A pull may be `void` only when who, when and why are all recorded, and the
 * why is not blank. Raw SQL on the migration role, so the DATABASE is what is proven, not the domain.
 *
 * RED on HEAD for two different reasons, and both are the right ones:
 *  - the refusal legs: HEAD has no such check, so the `update ... status = 'void'` SUCCEEDS and
 *    `.rejects` fails ("promise resolved instead of rejecting");
 *  - the legs that name `voided_at` / `voided_by` / `void_reason`: those columns do not exist on HEAD
 *    ("column ... does not exist").
 * Every refusal has a positive control (the same row accepted with all three present).
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function pullFixture(hint: string) {
  const code = uid(`t374s7shape-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('st')}, 'Lipa', 'multi_room') returning id`;
  const storeId = store!.id;
  const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  const personId = person!.id;
  const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const [loc] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${orgId}, ${storeId}, 'KIT', 'Kitchen', ${type!.id}, 'operating', true, ${personId}) returning id`;
  const [day] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${orgId}, ${storeId}, '2027-02-10', 0, 0, 0, ${personId}) returning id`;
  const [pull] = await sql<{ id: string }[]>`
    insert into pos_usage_pulls (org_id, store_id, sales_day_id, location_id, snapshot_taken_at)
    values (${orgId}, ${storeId}, ${day!.id}, ${loc!.id}, now()) returning id`;
  return { pullId: pull!.id, personId };
}

const SHAPE = /pos_usage_pulls_void_shape_check/;

describe('T11 - pos_usage_pulls_void_shape_check', () => {
  it('control: a pull voided with who, when and why is accepted, and the three are stored', async () => {
    const { pullId, personId } = await pullFixture('ok');
    await sql`
      update pos_usage_pulls set status = 'void', voided_at = now(), voided_by = ${personId}, void_reason = 'POS corrected two receipts'
      where id = ${pullId}`;
    const [row] = await sql<{ status: string; reason: string; by: string; at: Date | null }[]>`
      select status, void_reason as reason, voided_by as by, voided_at as at from pos_usage_pulls where id = ${pullId}`;
    expect(row).toMatchObject({ status: 'void', reason: 'POS corrected two receipts', by: personId });
    expect(row!.at).not.toBeNull();
  });

  it('control: a planned pull needs none of the three (the check only bites on void)', async () => {
    const { pullId } = await pullFixture('planned');
    const [row] = await sql<{ status: string }[]>`select status from pos_usage_pulls where id = ${pullId}`;
    expect(row!.status).toBe('planned');
  });

  it('refuses status = void with no audit columns at all', async () => {
    const { pullId } = await pullFixture('none');
    await expect(sql`update pos_usage_pulls set status = 'void' where id = ${pullId}`).rejects.toThrow(SHAPE);
    const [row] = await sql<{ status: string }[]>`select status from pos_usage_pulls where id = ${pullId}`;
    expect(row!.status).toBe('planned');
  });

  it('refuses status = void without voided_by', async () => {
    const { pullId } = await pullFixture('noby');
    await expect(
      sql`update pos_usage_pulls set status = 'void', voided_at = now(), void_reason = 'why' where id = ${pullId}`,
    ).rejects.toThrow(SHAPE);
  });

  it('refuses status = void without voided_at', async () => {
    const { pullId, personId } = await pullFixture('noat');
    await expect(
      sql`update pos_usage_pulls set status = 'void', voided_by = ${personId}, void_reason = 'why' where id = ${pullId}`,
    ).rejects.toThrow(SHAPE);
  });

  it('refuses status = void without void_reason', async () => {
    const { pullId, personId } = await pullFixture('noreason');
    await expect(
      sql`update pos_usage_pulls set status = 'void', voided_at = now(), voided_by = ${personId} where id = ${pullId}`,
    ).rejects.toThrow(SHAPE);
  });

  it.each([['empty', ''], ['whitespace only', '   \t ']])('refuses status = void with a %s reason', async (_label, reason) => {
    const { pullId, personId } = await pullFixture('blank');
    await expect(
      sql`update pos_usage_pulls set status = 'void', voided_at = now(), voided_by = ${personId}, void_reason = ${reason} where id = ${pullId}`,
    ).rejects.toThrow(SHAPE);
    const [row] = await sql<{ status: string }[]>`select status from pos_usage_pulls where id = ${pullId}`;
    expect(row!.status).toBe('planned');
  });
});
