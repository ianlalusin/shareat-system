/**
 * T-356 / DEF-489 follow-up — `docs/tasks/356-def-489-existing-table-revokes.md`, legs D1-D2.
 * Reuses `stock-transfers.test.ts`'s fixture seeding and its `asOrg` (`:40-47`, `transaction()` plus
 * `set local role`) verbatim — this file exists for T-356's own locality (`stock_movements` keeping
 * UPDATE is the one privilege change with a real user-facing path), not to duplicate coverage that
 * `stock-transfers.test.ts` already carries.
 *
 * ⛔ Amendment A2 (binds): the arming check asserts the TARGET (current_user = shareat_app inside
 * the role-switched tx — the same thing L2 checks), never the outer `DATABASE_URL` username. `SET
 * ROLE` from a superuser session still fully assumes the target role's privilege/RLS context (the
 * effective role for permission checks becomes `current_user`, not `session_user`), so checking the
 * target is correct and sufficient regardless of whether `INTEGRATION_RESTRICTED_ROLE=0` disarmed
 * the outer connection. The `DATABASE_URL` username is logged as a report line only — a lane run
 * with `INTEGRATION_RESTRICTED_ROLE=0` must not be falsely failed.
 */
import { config } from 'dotenv';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { dispatch, quantity, saveDraft, transferNow } from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { testItemCode } from './_fixtures/item-code';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

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

const asActor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function onHand(itemId: string, locationId: string): Promise<string> {
  const [r] = await sql<{ t: string }[]>`
    select coalesce(sum(quantity),0)::text as t from stock_movements
    where item_id = ${itemId} and location_id = ${locationId}`;
  return r!.t;
}

interface Fixture {
  orgId: string;
  storeId: string;
  staff: Actor;
  roomA: string;
  roomB: string;
  itemA: string;
}

async function fixture(): Promise<Fixture> {
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${'Org ' + uid('o')}, ${uid('org')}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('st')}, 'Store One', 'multi_room') returning id`;
  const storeId = store!.id;

  const [manager] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Staff') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${manager!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staff!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${manager!.id}, ${storeId})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${staff!.id}, ${storeId})`;

  const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const [a] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, created_by)
    values (${orgId}, ${storeId}, 'A', 'Room A', ${type!.id}, ${staff!.id}) returning id`;
  const [b] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, created_by)
    values (${orgId}, ${storeId}, 'B', 'Room B', ${type!.id}, ${staff!.id}) returning id`;

  const [item] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${orgId}, ${testItemCode()}, 'Pork Belly', 'raw_material', 'kg', ${staff!.id}) returning id`;

  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) select ${orgId}::uuid, d::date, (d + interval '1 month' - interval '1 day')::date, 'open' from generate_series('2025-01-01'::date, '2026-12-01'::date, '1 month') d`;

  const [staffEmployment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staff!.id}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, {
    orgId, storeId, employmentId: staffEmployment!.id, personId: staff!.id, setBy: manager!.id,
  });

  return { orgId, storeId, staff: asActor(orgId, staff!.id), roomA: a!.id, roomB: b!.id, itemA: item!.id };
}

async function seedOnHand(f: Fixture, locationId: string, qty: string) {
  await sql`
    insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
    values (${f.orgId}, ${f.storeId}, ${locationId}, ${f.itemA}, now(), ${qty}, 'opening', 'test_seed', ${crypto.randomUUID()}, ${f.staff.personId})`;
}

beforeEach(async () => {
  await sql`
    truncate table stock_reservations, stock_transfer_lines, stock_transfers,
      stock_movements, stock_locations, location_types,
      journal_lines, journal_entries, fiscal_periods,
      person_store_scope, person_roles, person_identities, persons, items, stores, organizations
      restart identity cascade`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// =================================================================================================
// Arming check (A2) — asserts the TARGET, not the URL. Fails loudly, never skips: a dispatch run
// as the admin would pass vacuously and prove nothing about the privilege narrowing.
// =================================================================================================

beforeAll(async () => {
  console.log(`T-356 report line (not an assertion): DATABASE_URL username = ${new URL(process.env.DATABASE_URL ?? url).username}`);
  const f = await fixture();
  const cu = await asOrg(f.orgId, async (tx) => {
    const r = (await tx.execute(dsql`select current_user`)) as unknown as { current_user: string }[];
    return r[0]!.current_user;
  });
  if (cu !== APP_ROLE) {
    throw new Error(
      `T-356: armed check failed — current_user inside the role-switched tx was "${cu}", expected "${APP_ROLE}". ` +
        'D1/D2 below would pass vacuously without this. It never skips.',
    );
  }
});

// =================================================================================================
// D1 — dispatch end to end as the app role. Guard: green now, red if stock_movements UPDATE is
// ever revoked (it needs UPDATE for onHandForUpdate's row lock, per R1/L1/L2).
// =================================================================================================

describe('D1 — transfer DISPATCH end to end as the app role', () => {
  it('saveDraft then dispatch: ok true, source on-hand drops by the line quantity', async () => {
    const f = await fixture();
    await seedOnHand(f, f.roomA, '10.000');

    const draft = await asOrg(f.orgId, (tx) =>
      saveDraft(tx, { storeId: f.storeId, fromLocationId: f.roomA, toLocationId: f.roomB, lines: [{ itemId: f.itemA, quantity: quantity('4.000') }], actor: f.staff }),
    );
    expect(draft.ok, draft.ok ? '' : JSON.stringify(draft)).toBe(true);
    if (!draft.ok) return;

    const dispatched = await asOrg(f.orgId, (tx) => dispatch(tx, f.staff, draft.transferId));
    expect(dispatched.ok, dispatched.ok ? '' : JSON.stringify(dispatched)).toBe(true);

    expect(await onHand(f.itemA, f.roomA)).toBe('6.000');
  });
});

// =================================================================================================
// D2 — transferNow (the other checkSufficiency caller) as the app role. Guard.
// =================================================================================================

describe('D2 — transferNow (one-step transfer) as the app role', () => {
  it('ok true, the movements are written', async () => {
    const f = await fixture();
    await seedOnHand(f, f.roomA, '10.000');

    const res = await asOrg(f.orgId, (tx) =>
      transferNow(tx, { storeId: f.storeId, fromLocationId: f.roomA, toLocationId: f.roomB, lines: [{ itemId: f.itemA, quantity: quantity('5.000') }], actor: f.staff }),
    );
    expect(res.ok, res.ok ? '' : JSON.stringify(res)).toBe(true);

    const movements = await sql<{ n: string }[]>`select count(*)::text as n from stock_movements where source_type = 'stock_transfer'`;
    expect(movements[0]!.n).toBe('2');
    expect(await onHand(f.itemA, f.roomA)).toBe('5.000');
    expect(await onHand(f.itemA, f.roomB)).toBe('5.000');
  });
});
