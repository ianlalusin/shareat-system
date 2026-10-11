import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-387 S5 - `attendanceDaysRepo.countOpenToday(tx, orgId, storeIds)`. Task doc S5, "Right now".
 *
 * PINNED SIGNATURE: `(tx: Tx, orgId: string, storeIds: readonly string[]) => Promise<number>`
 *   - counts rows with `status = 'open'` and `shift_day = toBusinessDate()` (today, Asia/Manila) in the given stores
 *   - an empty `storeIds` returns 0 (never "all stores")
 *   - a COUNT only: never names, never ids
 *
 * SPEC DEFECT found while writing this: `attendance_days` is `scope: 'org_column'` in rls/registry.ts, so RLS
 * isolates ORGS, not stores. "Store B's rows are invisible to a store-A-scoped actor" is enforced by the
 * `storeIds` argument (the page passes `storesInScope`), not by RLS. This file proves both real boundaries:
 * (1) a store not in `storeIds` is excluded, (2) another ORG's open day is invisible under RLS.
 *
 * RED today: `attendanceDaysRepo.countOpenToday` does not exist.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { toBusinessDate } from '@shareat/core/datetime';
import { closeDb, attendanceDaysRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type CountFn = (tx: Tx, orgId: string, storeIds: readonly string[]) => Promise<number>;
const countFn = (): CountFn => {
  const fn = (attendanceDaysRepo as unknown as { countOpenToday?: CountFn }).countOpenToday;
  expect(fn, 'attendanceDaysRepo.countOpenToday does not exist yet (T-387 S5 builder)').toBeTypeOf('function');
  return fn!;
};

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function newOrg(hint: string) {
  const code = uid(`t387s5-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const mkStore = async (h: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(h)}, ${`Store ${h}`}) returning id`;
    await sql`insert into store_attendance_config (org_id, store_id, effective_from, required_hours_per_shift, overtime_multiplier, night_diff_multiplier, overtime_mode)
              values (${orgId}, ${s!.id}, '2020-01-01', '9', '1.25', '1.10', 'multiplier')`;
    return s!.id;
  };
  return { orgId, mkStore };
}

/** An attendance day inserted directly (the repo under test only reads). One worker per call. */
async function addDay(orgId: string, storeId: string, shiftDay: string, status: string) {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${uid('w')}) returning id`;
  const [adminP] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${uid('a')}) returning id`;
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
    values (${orgId}, ${p!.id}, ${storeId}, ${uid('sc')}, '2020-01-01', 'regular', ${adminP!.id}) returning id`;
  const [cfg] = await sql<{ id: string }[]>`select id from store_attendance_config where store_id = ${storeId} limit 1`;
  await sql`
    insert into attendance_days (org_id, store_id, person_id, employment_id, shift_day, attendance_config_id, anchor_mode,
                                 status, computed_minutes, is_half_day, pending_ot_minutes, night_diff_minutes,
                                 holiday_minutes, is_holiday, holiday_type)
    values (${orgId}, ${storeId}, ${p!.id}, ${emp!.id}, ${shiftDay}, ${cfg!.id}, 'exact', ${status}, 0, false, 0, 0, 0, false, null)`;
}

const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

describe('T-387 S5 - attendanceDaysRepo.countOpenToday', () => {
  it("counts only status=open rows on today's shift day (not yesterday, not computed)", async () => {
    const o = await newOrg('basic');
    const a = await o.mkStore('a');
    const today = toBusinessDate();
    await addDay(o.orgId, a, today, 'open');
    await addDay(o.orgId, a, today, 'open');
    await addDay(o.orgId, a, today, 'computed');
    await addDay(o.orgId, a, addDays(today, -1), 'open');
    expect(await asOrg(o.orgId, (tx) => countFn()(tx, o.orgId, [a]))).toBe(2);
  });

  it('X proof: a store not in storeIds is excluded (store B open days invisible to a store-A scope)', async () => {
    const o = await newOrg('storebound');
    const a = await o.mkStore('a');
    const b = await o.mkStore('b');
    const today = toBusinessDate();
    await addDay(o.orgId, a, today, 'open');
    await addDay(o.orgId, b, today, 'open');
    await addDay(o.orgId, b, today, 'open');
    expect(await asOrg(o.orgId, (tx) => countFn()(tx, o.orgId, [a]))).toBe(1);
    expect(await asOrg(o.orgId, (tx) => countFn()(tx, o.orgId, [b]))).toBe(2);
    expect(await asOrg(o.orgId, (tx) => countFn()(tx, o.orgId, [a, b]))).toBe(3);
  });

  it('X proof: an empty storeIds is zero, never "all stores"', async () => {
    const o = await newOrg('empty');
    const a = await o.mkStore('a');
    await addDay(o.orgId, a, toBusinessDate(), 'open');
    expect(await asOrg(o.orgId, (tx) => countFn()(tx, o.orgId, []))).toBe(0);
  });

  it("X proof (RLS): another org's open day is invisible even when its store id is passed", async () => {
    const mine = await newOrg('mine');
    const theirs = await newOrg('theirs');
    const mineStore = await mine.mkStore('a');
    const theirStore = await theirs.mkStore('x');
    const today = toBusinessDate();
    await addDay(mine.orgId, mineStore, today, 'open');
    await addDay(theirs.orgId, theirStore, today, 'open');
    expect(await asOrg(mine.orgId, (tx) => countFn()(tx, mine.orgId, [mineStore, theirStore]))).toBe(1);
  });

  it('returns a plain number (a count, never rows or names)', async () => {
    const o = await newOrg('shape');
    const a = await o.mkStore('a');
    const n = await asOrg(o.orgId, (tx) => countFn()(tx, o.orgId, [a]));
    expect(typeof n).toBe('number');
    expect(n).toBe(0);
  });
});
