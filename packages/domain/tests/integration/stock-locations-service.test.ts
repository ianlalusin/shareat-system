import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createLocation,
  deactivateLocation,
  ensureLocationTypes,
  reactivateLocation,
  seedStoreLocations,
  setDefaultLocation,
  updateLocation,
} from '@shareat/domain';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';

/**
 * T-160 / DEF-135 (2026-09-03) — the room service that closed the gap: schema, migration, pure
 * rules and 20 db-level tests all landed 2026-08-29 with ZERO writers anywhere in application
 * code. This file exercises `packages/domain/src/stock-locations/service.ts` — the seven
 * functions that make `stock_locations` a table the app can actually write to.
 *
 * ⭐ Test 6 (a room holding stock cannot be deactivated) attempts the refusal TWICE: once as a raw
 * SQL UPDATE against migration `0122`'s trigger directly (bible row 104 — name the statement the
 * database refuses), and once through the service, which pre-checks the same fact for a readable
 * sentence. Both must refuse, or one of the two copies has drifted from the other.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
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

const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });

interface Fixture {
  orgId: string;
  branchId: string; // single_room
  commissaryId: string; // multi_room
  itemId: string;
  fileId: string;
  staff: Actor; // scoped to branch only, role staff
  branchManager: Actor; // scoped to branch only, role manager
  commissaryManager: Actor; // scoped to commissary only, role manager — the "no scope" actor for the branch
  admin: Actor; // scoped to both, role admin
}

async function fixture(): Promise<Fixture> {
  const code = uid('org');
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;

  const [branch] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('BR')}, 'Branch', 'single_room') returning id`;
  const [commissary] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('COM')}, 'Commissary', 'multi_room') returning id`;

  const mkPerson = async (name: string, role: string, storeIds: string[]) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const storeId of storeIds) {
      await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    }
    return p!.id;
  };

  const staffId = await mkPerson('Staff', 'staff', [branch!.id]);
  const branchManagerId = await mkPerson('Branch Manager', 'manager', [branch!.id]);
  const commissaryManagerId = await mkPerson('Commissary Manager', 'manager', [commissary!.id]);
  const adminId = await mkPerson('Admin', 'admin', [branch!.id, commissary!.id]);

  const [item] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${orgId}, ${uid('ITEM')}, 'Pork Belly', 'raw_material', 'kg', ${adminId}) returning id`;

  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgId}, ${'orgs/' + orgId + '/p.jpg'}, 'image/jpeg', 10, 'x', 'receipt_photo', ${adminId}) returning id`;

  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2020-01-01', '2035-12-31', 'open')`;
  await seedChartOfAccounts(sql, orgId);

  return {
    orgId,
    branchId: branch!.id,
    commissaryId: commissary!.id,
    itemId: item!.id,
    fileId: file!.id,
    staff: actorOf(orgId, staffId),
    branchManager: actorOf(orgId, branchManagerId),
    commissaryManager: actorOf(orgId, commissaryManagerId),
    admin: actorOf(orgId, adminId),
  };
}

async function activeRooms(storeId: string): Promise<{ code: string; purpose: string; role: string; isDefault: boolean }[]> {
  return sql<{ code: string; purpose: string; role: string; isDefault: boolean }[]>`
    select code, purpose, role, is_default as "isDefault" from stock_locations
    where store_id = ${storeId} and status = 'active' order by code`;
}

/** Puts real stock into `locationId` via the real receipt path — never a raw INSERT — so test 6's
 *  "holds stock" is exactly what the trigger and `holdsStock` both actually check. */
async function putStockIn(f: Fixture, storeId: string, locationId: string, qty: string): Promise<void> {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${f.orgId}, ${storeId}, 'purchase', '2026-08-01', ${f.fileId}, ${f.admin.personId}) returning id`;
  const res = await asOrg(f.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: f.orgId,
      storeId,
      deliveryId: d!.id,
      deliveredOn: '2026-08-01',
      locations: [],
      receivedBy: f.admin.personId,
      lines: [
        {
          lineId: '1',
          itemId: f.itemId,
          itemKind: 'raw_material',
          receivedQuantity: quantity(qty),
          conversionFactor: '1',
          unitCost: '100.0000',
          locationId,
        },
      ],
    }),
  );
  if (!res.ok) throw new Error(`putStockIn fixture failed: ${res.reason}`);
}

beforeEach(async () => {
  await sql`
    truncate table stock_layer_consumptions, stock_layers, stock_movements,
      delivery_lines, deliveries,
      stock_locations, location_types, departments,
      journal_lines, journal_entries, fiscal_periods, audit_log, stored_files,
      accounts, items, person_grants, person_store_scope, person_roles,
      person_identities, persons, stores, organizations restart identity cascade`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-160 §7 test 1 — seeding a single_room store', () => {
  it('⭐ produces exactly two locations — one Main room, one Receiving — and is idempotent', async () => {
    const f = await fixture();
    await asOrg(f.orgId, (tx) => ensureLocationTypes(tx, f.admin, { storeId:f.branchId }));

    const first = await asOrg(f.orgId, (tx) => seedStoreLocations(tx, f.admin, { storeId: f.branchId }));
    expect(first.created).toHaveLength(2);

    const rooms = await activeRooms(f.branchId);
    expect(rooms).toHaveLength(2);
    const main = rooms.find((r) => r.purpose === 'normal')!;
    const receiving = rooms.find((r) => r.purpose === 'receiving')!;
    expect(main.role).toBe('operating');
    expect(main.isDefault).toBe(true);
    expect(receiving.role).toBe('storage');
    expect(receiving.isDefault).toBe(false);

    const second = await asOrg(f.orgId, (tx) => seedStoreLocations(tx, f.admin, { storeId: f.branchId }));
    expect(second.created).toHaveLength(0);
    expect(await activeRooms(f.branchId)).toHaveLength(2);
  });
});

describe('T-160 §7 test 2 — seeding a multi_room (commissary) store', () => {
  it('⭐ produces a default Stockroom (storage) plus Receiving, and a second seed adds nothing', async () => {
    const f = await fixture();
    await asOrg(f.orgId, (tx) => ensureLocationTypes(tx, f.admin, { storeId:f.commissaryId }));

    const first = await asOrg(f.orgId, (tx) => seedStoreLocations(tx, f.admin, { storeId: f.commissaryId }));
    expect(first.created).toHaveLength(2);

    const rooms = await activeRooms(f.commissaryId);
    const main = rooms.find((r) => r.purpose === 'normal')!;
    expect(main.role).toBe('storage');
    expect(main.code).toBe('STOCKROOM');
    expect(main.isDefault).toBe(true);

    const second = await asOrg(f.orgId, (tx) => seedStoreLocations(tx, f.admin, { storeId: f.commissaryId }));
    expect(second.created).toHaveLength(0);
    expect(await activeRooms(f.commissaryId)).toHaveLength(2);
  });
});

describe('T-160 — ensureLocationTypes is idempotent', () => {
  it('⭐ seeds exactly the seven-code catalogue once, and a second call adds nothing', async () => {
    const f = await fixture();
    const first = await asOrg(f.orgId, (tx) => ensureLocationTypes(tx, f.admin, { storeId:f.branchId }));
    expect(first.created).toBe(7);

    const codes = await sql<{ code: string }[]>`select code from location_types where org_id = ${f.orgId} order by code`;
    expect(codes.map((c) => c.code).sort()).toEqual(
      ['DISPLAY', 'KITCHEN', 'QUARANTINE', 'RECEIVING', 'RETURNS', 'STOCKROOM', 'TRANSIT'],
    );

    const second = await asOrg(f.orgId, (tx) => ensureLocationTypes(tx, f.admin, { storeId:f.branchId }));
    expect(second.created).toBe(0);
    const stillSeven = await sql<{ n: string }[]>`select count(*)::text as n from location_types where org_id = ${f.orgId}`;
    expect(stillSeven[0]!.n).toBe('7');
  });
});

describe('T-160 §7 test 4 — a new default clears the old one', () => {
  it('⭐ the partial unique index holds throughout, and only the newest room is default', async () => {
    const f = await fixture();
    await asOrg(f.orgId, (tx) => ensureLocationTypes(tx, f.admin, { storeId:f.commissaryId }));
    await asOrg(f.orgId, (tx) => seedStoreLocations(tx, f.admin, { storeId: f.commissaryId }));
    const types = await sql<{ id: string }[]>`select id from location_types where org_id = ${f.orgId} and code = 'DISPLAY'`;

    const { id: second } = await asOrg(f.orgId, (tx) =>
      createLocation(tx, f.admin, {
        storeId: f.commissaryId,
        code: 'DISP',
        name: 'Display Case',
        typeId: types[0]!.id,
        role: 'operating',
      }),
    );

    await asOrg(f.orgId, (tx) => setDefaultLocation(tx, f.admin, { id: second }));

    const rows = await sql<{ code: string; isDefault: boolean }[]>`
      select code, is_default as "isDefault" from stock_locations
      where store_id = ${f.commissaryId} and status = 'active' order by code`;
    const defaults = rows.filter((r) => r.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.code).toBe('DISP');
  });
});

describe('T-160 §7 test 6 — a room holding stock cannot be deactivated', () => {
  it('⭐ refused by the DATABASE in raw SQL, and by the SERVICE with a readable reason', async () => {
    const f = await fixture();
    await asOrg(f.orgId, (tx) => ensureLocationTypes(tx, f.admin, { storeId:f.commissaryId }));
    await asOrg(f.orgId, (tx) => seedStoreLocations(tx, f.admin, { storeId: f.commissaryId }));
    const [stockroom] = await sql<{ id: string }[]>`
      select id from stock_locations where store_id = ${f.commissaryId} and purpose = 'normal'`;

    await putStockIn(f, f.commissaryId, stockroom!.id, '5.000');

    // The database refuses the bare UPDATE, in raw SQL, never through the service.
    await expect(
      sql`update stock_locations set status = 'inactive' where id = ${stockroom!.id}`,
    ).rejects.toThrow(/holds stock and cannot be deactivated/);

    // The service pre-checks the same fact and throws its own readable sentence, never reaching
    // the trigger.
    await expect(
      asOrg(f.orgId, (tx) => deactivateLocation(tx, f.admin, { id: stockroom!.id })),
    ).rejects.toThrow(/still holds stock and cannot be deactivated/);

    const [row] = await sql<{ status: string }[]>`select status from stock_locations where id = ${stockroom!.id}`;
    expect(row!.status).toBe('active');
  });

  it('⛔ the DEFAULT room is refused even when empty — make another room the default first (review 2026-09-03)', async () => {
    // `defaultLocationFor` filters on `active`: retiring the default would leave the store with no
    // default and the next undecided receive line with nowhere to park.
    const f = await fixture();
    await asOrg(f.orgId, (tx) => ensureLocationTypes(tx, f.admin, { storeId: f.commissaryId }));
    await asOrg(f.orgId, (tx) => seedStoreLocations(tx, f.admin, { storeId: f.commissaryId }));
    const [stockroom] = await sql<{ id: string }[]>`
      select id from stock_locations where store_id = ${f.commissaryId} and is_default`;

    await expect(
      asOrg(f.orgId, (tx) => deactivateLocation(tx, f.admin, { id: stockroom!.id })),
    ).rejects.toThrow(/default room — make another room the default first/);

    const [row] = await sql<{ status: string }[]>`select status from stock_locations where id = ${stockroom!.id}`;
    expect(row!.status).toBe('active');
  });

  it('a room with a ZERO balance deactivates cleanly through the service', async () => {
    const f = await fixture();
    await asOrg(f.orgId, (tx) => ensureLocationTypes(tx, f.admin, { storeId:f.commissaryId }));
    await asOrg(f.orgId, (tx) => seedStoreLocations(tx, f.admin, { storeId: f.commissaryId }));
    const [receiving] = await sql<{ id: string }[]>`
      select id from stock_locations where store_id = ${f.commissaryId} and purpose = 'receiving'`;

    await asOrg(f.orgId, (tx) => deactivateLocation(tx, f.admin, { id: receiving!.id }));

    const [row] = await sql<{ status: string }[]>`select status from stock_locations where id = ${receiving!.id}`;
    expect(row!.status).toBe('inactive');

    await asOrg(f.orgId, (tx) => reactivateLocation(tx, f.admin, { id: receiving!.id }));
    const [row2] = await sql<{ status: string }[]>`select status from stock_locations where id = ${receiving!.id}`;
    expect(row2!.status).toBe('active');
  });
});

describe('T-160 §7 test 7 — a single_room store refuses a second normal room', () => {
  it('⭐ refused in SQL, and the SERVICE surfaces the same readable sentence', async () => {
    const f = await fixture();
    await asOrg(f.orgId, (tx) => ensureLocationTypes(tx, f.admin, { storeId:f.branchId }));
    await asOrg(f.orgId, (tx) => seedStoreLocations(tx, f.admin, { storeId: f.branchId }));
    const [type] = await sql<{ id: string }[]>`select id from location_types where org_id = ${f.orgId} and code = 'KITCHEN'`;

    await expect(
      asOrg(f.orgId, (tx) =>
        createLocation(tx, f.admin, {
          storeId: f.branchId,
          code: 'SECOND',
          name: 'Second room',
          typeId: type!.id,
          role: 'operating',
        }),
      ),
    ).rejects.toThrow(/single_room and already has an active non-Receiving room/);

    expect(await activeRooms(f.branchId)).toHaveLength(2);
  });
});

describe('T-160 — authorization: the ✗ that must fire', () => {
  it('⛔ staff may not create a room', async () => {
    const f = await fixture();
    await asOrg(f.orgId, (tx) => ensureLocationTypes(tx, f.admin, { storeId:f.branchId }));
    const [type] = await sql<{ id: string }[]>`select id from location_types where org_id = ${f.orgId} and code = 'STOCKROOM'`;

    await expect(
      asOrg(f.orgId, (tx) =>
        createLocation(tx, f.staff, {
          storeId: f.branchId,
          code: 'X',
          name: 'X',
          typeId: type!.id,
          role: 'storage',
        }),
      ),
    ).rejects.toThrow(/may not 'manage_locations'/);
  });

  it('⛔ a manager with no scope for THAT store is refused, even though the role would allow it', async () => {
    const f = await fixture();
    await asOrg(f.orgId, (tx) => ensureLocationTypes(tx, f.admin, { storeId:f.commissaryId }));
    const [type] = await sql<{ id: string }[]>`select id from location_types where org_id = ${f.orgId} and code = 'STOCKROOM'`;

    // commissaryManager is scoped to the COMMISSARY only — attempting the BRANCH is refused on
    // scope, not on role (the matrix would allow a manager here).
    await expect(
      asOrg(f.orgId, (tx) =>
        createLocation(tx, f.commissaryManager, {
          storeId: f.branchId,
          code: 'X',
          name: 'X',
          typeId: type!.id,
          role: 'storage',
        }),
      ),
    ).rejects.toThrow(/no store scope for/);
  });
});

describe('T-160 — updateLocation', () => {
  it('renames a room and refuses to re-role the Receiving room', async () => {
    const f = await fixture();
    await asOrg(f.orgId, (tx) => ensureLocationTypes(tx, f.admin, { storeId:f.commissaryId }));
    await asOrg(f.orgId, (tx) => seedStoreLocations(tx, f.admin, { storeId: f.commissaryId }));
    const [receiving] = await sql<{ id: string }[]>`
      select id from stock_locations where store_id = ${f.commissaryId} and purpose = 'receiving'`;

    await asOrg(f.orgId, (tx) => updateLocation(tx, f.admin, { id: receiving!.id, name: 'Dock' }));
    const [row] = await sql<{ name: string }[]>`select name from stock_locations where id = ${receiving!.id}`;
    expect(row!.name).toBe('Dock');

    await expect(
      asOrg(f.orgId, (tx) => updateLocation(tx, f.admin, { id: receiving!.id, role: 'operating' })),
    ).rejects.toThrow(/Receiving room is always a storage room/);
  });
});
