import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-160 §7 — the invariants only PostgreSQL can hold, proven against real PostgreSQL.
 *
 * ⭐ **Every refusal here is attempted in RAW SQL, never through a service.** Bible row 104: name
 * the statement the DATABASE rejects, not the call our code declines to make. A guard that only
 * exists in TypeScript is a convention, and DEF-041 is what happens when a test proves a
 * convention and calls it a constraint.
 *
 * The pure decisions — where an undecided receive parks, what an unknown role becomes — live in
 * `packages/domain/tests/unit/stock-location-rules.test.ts` and need no database.
 */
config({ path: '../../../.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { APP_ROLE } from '../../src/rls/registry';

const sql = postgres(url, { max: 3 });

let orgA: string;
let orgB: string;
let storeA: string;
let storeB: string;
let personA: string;
let personB: string;
let typeA: string;

async function asOrg<T>(org: string | null, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${APP_ROLE}`);
    if (org !== null) await tx`select set_config('app.org_id', ${org}, true)`;
    return (await fn(tx)) as never;
  })) as T;
}

/** Insert a room as the owner, bypassing RLS — the fixture, not the thing under test. */
async function room(
  storeId: string,
  orgId: string,
  code: string,
  over: { role?: string; purpose?: string; isDefault?: boolean; status?: string } = {},
) {
  const [r] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, purpose, is_default, status, created_by)
    values (${orgId}, ${storeId}, ${code}, ${code}, ${typeA},
            ${over.role ?? 'storage'}, ${over.purpose ?? 'normal'},
            ${over.isDefault ?? false}, ${over.status ?? 'active'}, ${orgId === orgB ? personB : personA})
    returning id`;
  return r!.id;
}

beforeEach(async () => {
  await sql`
    truncate table stock_locations, location_types, departments,
      person_grants, person_store_scope, person_roles,
      journal_lines, journal_entries, audit_log, fiscal_periods,
      accounts, person_identities, persons, stores, organizations restart identity cascade
  `;
  const [a] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org A','org-a') returning id`;
  const [b] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org B','org-b') returning id`;
  orgA = a!.id;
  orgB = b!.id;

  // ⚠️ multi_room for the default fixture: the single-room trigger is exercised deliberately in
  // its own block, and having it fire in unrelated setups would hide what those tests mean.
  const [sa] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, stock_model) values (${orgA}, 'A1', 'A One', 'multi_room') returning id`;
  const [sb] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, stock_model) values (${orgB}, 'B1', 'B One', 'multi_room') returning id`;
  storeA = sa!.id;
  storeB = sb!.id;

  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA}, 'Alice') returning id`;
  personA = p!.id;
  const [pb] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgB}, 'Bob') returning id`;
  personB = pb!.id;

  const [t] = await sql<{ id: string }[]>`
    insert into location_types (org_id, code, name) values (${orgA}, 'STOCKROOM', 'Stockroom') returning id`;
  typeA = t!.id;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('T-160 — one Receiving room per store, refused by the database', () => {
  it('⭐ a second active Receiving location is REFUSED', async () => {
    await room(storeA, orgA, 'RCV1', { purpose: 'receiving' });
    await expect(room(storeA, orgA, 'RCV2', { purpose: 'receiving' })).rejects.toThrow(
      /stock_locations_one_receiving_per_store/,
    );
  });

  it('a different store may have its own Receiving room', async () => {
    await room(storeA, orgA, 'RCV', { purpose: 'receiving' });
    await expect(room(storeB, orgB, 'RCV', { purpose: 'receiving' })).resolves.toBeTruthy();
  });

  it('⚠️ an INACTIVE Receiving room neither holds the slot nor blocks a new one', async () => {
    await room(storeA, orgA, 'OLD', { purpose: 'receiving', status: 'inactive' });
    await expect(room(storeA, orgA, 'NEW', { purpose: 'receiving' })).resolves.toBeTruthy();
  });

  it('⛔ a Receiving room may not be an operating room — it is a parking spot', async () => {
    await expect(
      room(storeA, orgA, 'RCV', { purpose: 'receiving', role: 'operating' }),
    ).rejects.toThrow(/stock_locations_receiving_is_storage_check/);
  });
});

describe('T-160 — one default room per store, refused by the database', () => {
  it('⭐ a second active default is REFUSED', async () => {
    await room(storeA, orgA, 'R1', { isDefault: true });
    await expect(room(storeA, orgA, 'R2', { isDefault: true })).rejects.toThrow(
      /stock_locations_one_default_per_store/,
    );
  });

  it('the flag can be MOVED within one transaction — clear, then set', async () => {
    const first = await room(storeA, orgA, 'R1', { isDefault: true });
    const second = await room(storeA, orgA, 'R2');
    await sql.begin(async (tx) => {
      await tx`update stock_locations set is_default = false where id = ${first}`;
      await tx`update stock_locations set is_default = true where id = ${second}`;
    });
    const [row] = await sql<{ code: string }[]>`
      select code from stock_locations where store_id = ${storeA} and is_default`;
    expect(row!.code).toBe('R2');
  });
});

describe('T-160 — the single-room rule that replaces v1’s repair tool', () => {
  let singleStore: string;

  beforeEach(async () => {
    const [s] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name, stock_model) values (${orgA}, 'BR', 'Branch', 'single_room') returning id`;
    singleStore = s!.id;
  });

  it('⭐ one non-Receiving room plus a Receiving room is legal', async () => {
    await expect(room(singleStore, orgA, 'ROOM')).resolves.toBeTruthy();
    await expect(room(singleStore, orgA, 'RCV', { purpose: 'receiving' })).resolves.toBeTruthy();
  });

  it('⭐ a SECOND non-Receiving room is REFUSED by the trigger', async () => {
    await room(singleStore, orgA, 'ROOM');
    await expect(room(singleStore, orgA, 'ROOM2')).rejects.toThrow(/single_room/);
  });

  it('⚠️ an inactive room does not count against the limit', async () => {
    await room(singleStore, orgA, 'OLD', { status: 'inactive' });
    await expect(room(singleStore, orgA, 'ROOM')).resolves.toBeTruthy();
  });

  it('⭐ the trigger fires on UPDATE too — reactivating a retired room is caught', async () => {
    // The hole a BEFORE INSERT-only trigger would leave: two rooms, one retired, then someone
    // flips the retired one back on and the store silently has two again.
    const retired = await room(singleStore, orgA, 'OLD', { status: 'inactive' });
    await room(singleStore, orgA, 'ROOM');
    await expect(
      sql`update stock_locations set status = 'active' where id = ${retired}`,
    ).rejects.toThrow(/single_room/);
  });

  it('a multi_room store is unconstrained', async () => {
    await room(storeA, orgA, 'R1');
    await room(storeA, orgA, 'R2');
    await expect(room(storeA, orgA, 'R3')).resolves.toBeTruthy();
  });
});

describe('T-160 — org isolation', () => {
  it('org A sees only its own rooms, with no WHERE clause at all', async () => {
    await room(storeA, orgA, 'A-ROOM');
    await room(storeB, orgB, 'B-ROOM');

    const a = await asOrg(orgA, async (tx) => tx<{ code: string }[]>`select code from stock_locations`);
    expect(a.map((r) => r.code)).toEqual(['A-ROOM']);

    const b = await asOrg(orgB, async (tx) => tx<{ code: string }[]>`select code from stock_locations`);
    expect(b.map((r) => r.code)).toEqual(['B-ROOM']);
  });

  it('org A cannot INSERT a room carrying org B’s id', async () => {
    await expect(
      asOrg(orgA, async (tx) => tx`
        insert into stock_locations (org_id, store_id, code, name, type_id, created_by)
        values (${orgB}, ${storeB}, 'X', 'Smuggled', ${typeA}, ${personA})`),
    ).rejects.toThrow(/row-level security/i);
  });

  it('⭐ NO principal returns ZERO rooms, never every room', async () => {
    await room(storeA, orgA, 'A-ROOM');
    const rows = await asOrg(null, async (tx) => tx<{ code: string }[]>`select code from stock_locations`);
    expect(rows).toHaveLength(0);
  });

  it('location_types and departments are isolated the same way', async () => {
    await sql`insert into departments (org_id, code, name) values (${orgA}, 'KIT', 'Kitchen')`;
    await sql`insert into departments (org_id, code, name) values (${orgB}, 'BAR', 'Bar')`;

    const types = await asOrg(orgA, async (tx) => tx<{ code: string }[]>`select code from location_types`);
    expect(types.map((r) => r.code)).toEqual(['STOCKROOM']);

    const depts = await asOrg(orgA, async (tx) => tx<{ code: string }[]>`select code from departments`);
    expect(depts.map((r) => r.code)).toEqual(['KIT']);
  });
});

describe('T-160 — the ordinary constraints', () => {
  it('a room code is unique within a store but free across stores', async () => {
    await room(storeA, orgA, 'STOCK');
    await expect(room(storeA, orgA, 'STOCK')).rejects.toThrow(/stock_locations_store_code_key/);
    await expect(room(storeB, orgB, 'STOCK')).resolves.toBeTruthy();
  });

  it('a blank code or name is refused', async () => {
    await expect(room(storeA, orgA, '   ')).rejects.toThrow(/not_blank/);
  });

  it('an unknown role or purpose is refused', async () => {
    await expect(room(storeA, orgA, 'R', { role: 'kitchen' })).rejects.toThrow(/role_check/);
    await expect(room(storeA, orgA, 'R2', { purpose: 'parking' })).rejects.toThrow(/purpose_check/);
  });

  it('⭐ a store defaults to single_room — the STRICTER of the two', async () => {
    // An unset stock model must not quietly mean "unconstrained": that is the drift v1 needed a
    // repair tool for, and defaulting to the loose end would reintroduce it silently.
    const [s] = await sql<{ stock_model: string }[]>`
      insert into stores (org_id, code, name) values (${orgA}, 'DEF', 'Defaulted') returning stock_model`;
    expect(s!.stock_model).toBe('single_room');
  });

  it('a location type in use cannot be deleted', async () => {
    await room(storeA, orgA, 'R1');
    await expect(sql`delete from location_types where id = ${typeA}`).rejects.toThrow(/foreign key/i);
  });
});
