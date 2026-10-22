import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  advanceCountSession,
  cancelCountSession,
  commitCount,
  openCountSession,
  quantity,
  receiveDelivery,
  recordCount,
} from '@shareat/domain';
import type { LocationLike } from '../../src/stock-locations/rules';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { testItemCode } from './_fixtures/item-code';

/**
 * T-169 workflow — the layer `count-sessions.ts` (the engine) deliberately does not own: who may
 * open a room, record a count, advance, commit and cancel, and what a real single-room count does
 * to the freeze.
 *
 * ⭐⚠️ **Found while writing this file, not specced**: `commitCount` must RELEASE the freeze
 * (flip the session to `closed`) BEFORE calling the engine, because every counted line's room is,
 * by construction, one of THIS session's own frozen rooms, and `stock_movements_check_not_frozen_trg`
 * would otherwise refuse the engine's own variance movement. `count-sessions.test.ts`'s engine-level
 * tests dodge this by freezing a DIFFERENT room than the one they count ("freeze a different room
 * so the write can land") — a real single-room count is the only kind this screen offers, so tests
 * 5/6/8 below freeze the room they actually count, which the engine-level suite never does.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "shareat_test".`,
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

const asActor = (orgId: string, personId: string): Actor => ({ personId, orgId });

interface Fixture {
  orgId: string;
  storeId: string;
  fileId: string;
  staff: Actor;
  manager: Actor;
  /** Finding B — a manager whose ONLY store scope is `otherStoreId`, never `storeId`. */
  otherManager: Actor;
  otherStoreId: string;
  kitchen: string;
  stockroom: string;
  itemA: string;
  itemB: string;
}

async function onHand(itemId: string, locationId: string): Promise<string> {
  const [r] = await sql<{ t: string }[]>`
    select coalesce(sum(quantity),0)::text as t from stock_movements
    where item_id = ${itemId} and location_id = ${locationId}`;
  return r!.t;
}

async function balances(orgId: string): Promise<Record<string, string>> {
  const rows = await sql<{ code: string; net: string }[]>`
    select a.code, (sum(l.debit) - sum(l.credit))::text as net
    from journal_lines l join accounts a on a.id = l.account_id
    where a.org_id = ${orgId} group by a.code`;
  return Object.fromEntries(rows.map((r) => [r.code, r.net]));
}

async function fixture(): Promise<Fixture> {
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${'Org ' + uid('o')}, ${uid('org')}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('st')}, 'Store One', 'multi_room') returning id`;
  const storeId = store!.id;
  const [otherStore] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('st2')}, 'Store Two', 'multi_room') returning id`;
  const otherStoreId = otherStore!.id;

  const [manager] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Staff') returning id`;
  const [otherManager] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Other Store Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${manager!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staff!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${otherManager!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${manager!.id}, ${storeId})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${staff!.id}, ${storeId})`;
  // ⭐ Finding B — scoped to otherStoreId ONLY, never storeId, so acting on this store's session
  // is refused.
  await sql`insert into person_store_scope (person_id, store_id) values (${otherManager!.id}, ${otherStoreId})`;

  const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const [kitchen] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${orgId}, ${storeId}, 'KIT', 'Kitchen', ${type!.id}, 'operating', true, ${staff!.id}) returning id`;
  const [stockroom] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, created_by)
    values (${orgId}, ${storeId}, 'STORE', 'Stockroom', ${type!.id}, ${staff!.id}) returning id`;

  const [item] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${orgId}, ${testItemCode()}, 'Pork Belly', 'raw_material', 'kg', ${staff!.id}) returning id`;
  const [itemB] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${orgId}, ${testItemCode()}, 'Chicken', 'raw_material', 'kg', ${staff!.id}) returning id`;

  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgId}, ${'orgs/' + orgId + '/p.jpg'}, 'image/jpeg', 10, 'x', 'receipt_photo', ${staff!.id}) returning id`;

  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-08-01', '2026-08-31', 'open')`;

  const { seedChartOfAccounts } = await import('../../../db/seed/chart-of-accounts');
  await seedChartOfAccounts(sql, orgId);

  const [staffEmployment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staff!.id}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01')
    returning id
  `;
  await grantEverydayPositionAccess(sql, {
    orgId, storeId, employmentId: staffEmployment!.id, personId: staff!.id, setBy: manager!.id,
  });

  return {
    orgId,
    storeId,
    fileId: file!.id,
    staff: asActor(orgId, staff!.id),
    manager: asActor(orgId, manager!.id),
    otherManager: asActor(orgId, otherManager!.id),
    otherStoreId,
    kitchen: kitchen!.id,
    stockroom: stockroom!.id,
    itemA: item!.id,
    itemB: itemB!.id,
  };
}

/** Stocks `locationId` with real FIFO layers via a real receipt — the count engine needs a layer
 *  to relieve (short) or price against (long), same fixture shape as `count-sessions.test.ts`. */
async function stockUp(f: Fixture, locationId: string, qty = '10', cost = '100.0000', itemId = f.itemA) {
  const locations: LocationLike[] = [
    { id: f.kitchen, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' },
    { id: f.stockroom, role: 'storage', purpose: 'normal', isDefault: false, status: 'active' },
  ];
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${f.orgId}, ${f.storeId}, 'purchase', '2026-08-01', ${f.fileId}, ${f.staff.personId}) returning id`;
  await asOrg(f.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: f.orgId,
      storeId: f.storeId,
      deliveryId: d!.id,
      deliveredOn: '2026-08-01',
      locations,
      receivedBy: f.staff.personId,
      lines: [
        {
          lineId: '1',
          itemId,
          itemKind: 'raw_material',
          receivedQuantity: quantity(qty),
          conversionFactor: '1',
          unitCost: cost,
          locationId,
        },
      ],
    }),
  );
}

beforeEach(async () => {
  await sql`
    truncate table count_lines, count_session_locations, count_sessions,
      stock_usage_lines, stock_usage_records, delivery_lines, deliveries,
      stock_layer_consumptions, stock_layers, stock_movements,
      stock_locations, location_types, departments,
      person_store_scope, person_roles,
      journal_lines, journal_entries, fiscal_periods, audit_log, stored_files,
      accounts, items, person_identities, persons, stores, organizations restart identity cascade`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-169 workflow — opening freezes the room for every OTHER writer', () => {
  it('spec test 1: a usage post into the frozen room is refused; an unfrozen room in the same store is not', async () => {
    const f = await fixture();
    await stockUp(f, f.kitchen, '10');

    const opened = await asOrg(f.orgId, (tx) =>
      openCountSession(tx, f.manager, { storeId: f.storeId, locationIds: [f.kitchen], countedOn: '2026-08-20' }),
    );
    expect(opened.ok).toBe(true);

    const { postUsageRecord } = await import('../../src/stock/usage');
    await expect(
      asOrg(f.orgId, (tx) =>
        postUsageRecord(tx, {
          orgId: f.orgId,
          storeId: f.storeId,
          locationId: f.kitchen,
          recordId: crypto.randomUUID(),
          kind: 'usage',
          usedOn: '2026-08-20',
          postedBy: f.staff.personId,
          lines: [{ lineId: '1', itemId: f.itemA, cogsCategory: 'meat', inventoryAccount: '1310', quantity: quantity('2') }],
        }),
      ),
    ).rejects.toThrow(/frozen/);

    // the stockroom, untouched by this session, is unaffected
    await expect(stockUp(f, f.stockroom, '1')).resolves.toBeUndefined();
  });

  it('spec test 2: a second session over the same room is refused by the database, with a readable sentence', async () => {
    const f = await fixture();
    const opened = await asOrg(f.orgId, (tx) =>
      openCountSession(tx, f.manager, { storeId: f.storeId, locationIds: [f.kitchen], countedOn: '2026-08-20' }),
    );
    expect(opened.ok).toBe(true);

    await expect(
      asOrg(f.orgId, (tx) =>
        openCountSession(tx, f.manager, { storeId: f.storeId, locationIds: [f.kitchen], countedOn: '2026-08-20' }),
      ),
    ).rejects.toThrow(/already in active count session/);
  });

  it('⛔ staff may not open a count session', async () => {
    const f = await fixture();
    await expect(
      asOrg(f.orgId, (tx) => openCountSession(tx, f.staff, { storeId: f.storeId, locationIds: [f.kitchen], countedOn: '2026-08-20' })),
    ).rejects.toThrow(/may not 'open_count_session'/);
  });

  it('✅ staff MAY record a counted line — counting is floor work', async () => {
    const f = await fixture();
    await stockUp(f, f.kitchen, '10');
    const opened = await asOrg(f.orgId, (tx) =>
      openCountSession(tx, f.manager, { storeId: f.storeId, locationIds: [f.kitchen], countedOn: '2026-08-20' }),
    );
    if (!opened.ok) throw new Error('setup failed');

    const result = await asOrg(f.orgId, (tx) =>
      recordCount(tx, f.staff, { sessionId: opened.sessionId, itemId: f.itemA, locationId: f.kitchen, countedQuantity: quantity('9') }),
    );
    expect(result.ok).toBe(true);
  });

  it('a zero count is stored explicitly — absent and zero are different answers', async () => {
    const f = await fixture();
    const opened = await asOrg(f.orgId, (tx) =>
      openCountSession(tx, f.manager, { storeId: f.storeId, locationIds: [f.kitchen], countedOn: '2026-08-20' }),
    );
    if (!opened.ok) throw new Error('setup failed');

    const result = await asOrg(f.orgId, (tx) =>
      recordCount(tx, f.staff, { sessionId: opened.sessionId, itemId: f.itemA, locationId: f.kitchen, countedQuantity: quantity('0') }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [row] = await sql<{ counted_quantity: string }[]>`select counted_quantity from count_lines where id = ${result.lineId}`;
    expect(row!.counted_quantity).toBe('0.000');
  });
});

describe('T-169 workflow — commit, a real single-room count', () => {
  it('spec test 5: 98 vs 100 → Dr 5400 / Cr 1310 for 2kg at FIFO cost, one count_adjustment movement, the line carries expected/variance/movement', async () => {
    const f = await fixture();
    await stockUp(f, f.kitchen, '100', '100.0000');

    const opened = await asOrg(f.orgId, (tx) =>
      openCountSession(tx, f.manager, { storeId: f.storeId, locationIds: [f.kitchen], countedOn: '2026-08-20' }),
    );
    if (!opened.ok) throw new Error('setup failed');
    const sessionId = opened.sessionId;

    const recorded = await asOrg(f.orgId, (tx) =>
      recordCount(tx, f.staff, { sessionId, itemId: f.itemA, locationId: f.kitchen, countedQuantity: quantity('98') }),
    );
    expect(recorded.ok).toBe(true);

    const committed = await asOrg(f.orgId, (tx) => commitCount(tx, f.manager, { sessionId }));
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.shortEntryId).not.toBeNull();
    expect(committed.longEntryId).toBeNull();

    const b = await balances(f.orgId);
    expect(b['5400']).toBe('200.00');
    expect(b['1310']).toBe('9800.00');
    expect(await onHand(f.itemA, f.kitchen)).toBe('98.000');

    const [line] = await sql<{ expected_quantity: string; variance: string; movement_id: string | null }[]>`
      select expected_quantity, variance, movement_id from count_lines where session_id = ${sessionId}`;
    expect(line!.expected_quantity).toBe('100.000');
    expect(line!.variance).toBe('-2.000');
    expect(line!.movement_id).not.toBeNull();

    const [session] = await sql<{ status: string; committed_at: Date | null }[]>`select status, committed_at from count_sessions where id = ${sessionId}`;
    expect(session!.status).toBe('closed');
    expect(session!.committed_at).not.toBeNull();
  });

  it('spec test 6: 102 vs 100 → a new layer at the most recent unit cost, Dr 1310 / Cr 5400', async () => {
    const f = await fixture();
    await stockUp(f, f.kitchen, '100', '100.0000');

    const opened = await asOrg(f.orgId, (tx) =>
      openCountSession(tx, f.manager, { storeId: f.storeId, locationIds: [f.kitchen], countedOn: '2026-08-20' }),
    );
    if (!opened.ok) throw new Error('setup failed');
    const sessionId = opened.sessionId;

    await asOrg(f.orgId, (tx) => recordCount(tx, f.staff, { sessionId, itemId: f.itemA, locationId: f.kitchen, countedQuantity: quantity('102') }));

    const committed = await asOrg(f.orgId, (tx) => commitCount(tx, f.manager, { sessionId }));
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.longEntryId).not.toBeNull();
    expect(committed.shortEntryId).toBeNull();

    const b = await balances(f.orgId);
    expect(b['1310']).toBe('10200.00');
    expect(b['5400']).toBe('-200.00');
    expect(await onHand(f.itemA, f.kitchen)).toBe('102.000');
  });

  it('spec test 8: an exact count posts nothing and closes cleanly', async () => {
    const f = await fixture();
    await stockUp(f, f.kitchen, '100', '100.0000');
    const opened = await asOrg(f.orgId, (tx) =>
      openCountSession(tx, f.manager, { storeId: f.storeId, locationIds: [f.kitchen], countedOn: '2026-08-20' }),
    );
    if (!opened.ok) throw new Error('setup failed');
    const sessionId = opened.sessionId;

    await asOrg(f.orgId, (tx) => recordCount(tx, f.staff, { sessionId, itemId: f.itemA, locationId: f.kitchen, countedQuantity: quantity('100') }));
    const committed = await asOrg(f.orgId, (tx) => commitCount(tx, f.manager, { sessionId }));
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.shortEntryId).toBeNull();
    expect(committed.longEntryId).toBeNull();
    expect((await balances(f.orgId))['5400']).toBeUndefined();

    const [session] = await sql<{ status: string }[]>`select status from count_sessions where id = ${sessionId}`;
    expect(session!.status).toBe('closed');
  });

  it('spec test 9: an uncounted item with stock in the frozen room refuses the commit, naming it', async () => {
    const f = await fixture();
    // Two items in the same frozen room; only one gets counted.
    await stockUp(f, f.kitchen, '100', '100.0000', f.itemA);
    await stockUp(f, f.kitchen, '50', '80.0000', f.itemB);
    const opened = await asOrg(f.orgId, (tx) =>
      openCountSession(tx, f.manager, { storeId: f.storeId, locationIds: [f.kitchen], countedOn: '2026-08-20' }),
    );
    if (!opened.ok) throw new Error('setup failed');
    const sessionId = opened.sessionId;

    // Counting itemA moves the session to 'counting'; itemB is left with real stock and no line.
    await asOrg(f.orgId, (tx) => recordCount(tx, f.staff, { sessionId, itemId: f.itemA, locationId: f.kitchen, countedQuantity: quantity('100') }));

    const committed = await asOrg(f.orgId, (tx) => commitCount(tx, f.manager, { sessionId }));
    expect(committed.ok).toBe(false);
    if (committed.ok) return;
    expect(committed.reason).toContain('never counted');

    const [session] = await sql<{ status: string }[]>`select status from count_sessions where id = ${sessionId}`;
    expect(session!.status).toBe('counting');
  });

  it('spec test 10: a second commit is refused', async () => {
    const f = await fixture();
    await stockUp(f, f.kitchen, '100', '100.0000');
    const opened = await asOrg(f.orgId, (tx) =>
      openCountSession(tx, f.manager, { storeId: f.storeId, locationIds: [f.kitchen], countedOn: '2026-08-20' }),
    );
    if (!opened.ok) throw new Error('setup failed');
    const sessionId = opened.sessionId;
    await asOrg(f.orgId, (tx) => recordCount(tx, f.staff, { sessionId, itemId: f.itemA, locationId: f.kitchen, countedQuantity: quantity('100') }));
    const first = await asOrg(f.orgId, (tx) => commitCount(tx, f.manager, { sessionId }));
    expect(first.ok).toBe(true);

    const second = await asOrg(f.orgId, (tx) => commitCount(tx, f.manager, { sessionId }));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toContain('closed');
  });

  it('⛔ staff may not commit a count', async () => {
    const f = await fixture();
    await stockUp(f, f.kitchen, '100', '100.0000');
    const opened = await asOrg(f.orgId, (tx) =>
      openCountSession(tx, f.manager, { storeId: f.storeId, locationIds: [f.kitchen], countedOn: '2026-08-20' }),
    );
    if (!opened.ok) throw new Error('setup failed');
    const sessionId = opened.sessionId;
    await asOrg(f.orgId, (tx) => recordCount(tx, f.staff, { sessionId, itemId: f.itemA, locationId: f.kitchen, countedQuantity: quantity('100') }));

    await expect(asOrg(f.orgId, (tx) => commitCount(tx, f.staff, { sessionId }))).rejects.toThrow(/may not 'commit_count'/);
  });

  it('advance moves counting → reviewing, and commit works from reviewing too', async () => {
    const f = await fixture();
    await stockUp(f, f.kitchen, '100', '100.0000');
    const opened = await asOrg(f.orgId, (tx) =>
      openCountSession(tx, f.manager, { storeId: f.storeId, locationIds: [f.kitchen], countedOn: '2026-08-20' }),
    );
    if (!opened.ok) throw new Error('setup failed');
    const sessionId = opened.sessionId;
    await asOrg(f.orgId, (tx) => recordCount(tx, f.staff, { sessionId, itemId: f.itemA, locationId: f.kitchen, countedQuantity: quantity('100') }));

    const advanced = await asOrg(f.orgId, (tx) => advanceCountSession(tx, f.manager, { sessionId, to: 'reviewing' }));
    expect(advanced.ok).toBe(true);

    const committed = await asOrg(f.orgId, (tx) => commitCount(tx, f.manager, { sessionId }));
    expect(committed.ok).toBe(true);
  });
});

describe('Finding B — cross-store ✗: a manager scoped to a DIFFERENT store is refused', () => {
  it('⛔ openCountSession: authorized as manager, but not for THIS store', async () => {
    const f = await fixture();
    await expect(
      asOrg(f.orgId, (tx) =>
        openCountSession(tx, f.otherManager, { storeId: f.storeId, locationIds: [f.kitchen], countedOn: '2026-08-20' }),
      ),
    ).rejects.toThrow(/has no store scope/);
  });

  it('⛔ commitCount: authorized as manager, but not for the SESSION\'s store', async () => {
    const f = await fixture();
    await stockUp(f, f.kitchen, '100', '100.0000');
    const opened = await asOrg(f.orgId, (tx) =>
      openCountSession(tx, f.manager, { storeId: f.storeId, locationIds: [f.kitchen], countedOn: '2026-08-20' }),
    );
    if (!opened.ok) throw new Error('setup failed');
    const sessionId = opened.sessionId;
    await asOrg(f.orgId, (tx) =>
      recordCount(tx, f.staff, { sessionId, itemId: f.itemA, locationId: f.kitchen, countedQuantity: quantity('100') }),
    );

    await expect(
      asOrg(f.orgId, (tx) => commitCount(tx, f.otherManager, { sessionId })),
    ).rejects.toThrow(/has no store scope/);

    // still open for commit — the refusal did not partially close the session
    const [session] = await sql<{ status: string }[]>`select status from count_sessions where id = ${sessionId}`;
    expect(session!.status).not.toBe('closed');
  });
});

describe('T-169 workflow — spec test 13: cancel releases the freeze and posts nothing', () => {
  it('cancels a session, unfreezes the room, and posts no journal entry', async () => {
    const f = await fixture();
    await stockUp(f, f.kitchen, '10', '100.0000');
    const opened = await asOrg(f.orgId, (tx) =>
      openCountSession(tx, f.manager, { storeId: f.storeId, locationIds: [f.kitchen], countedOn: '2026-08-20' }),
    );
    if (!opened.ok) throw new Error('setup failed');

    const cancelled = await asOrg(f.orgId, (tx) => cancelCountSession(tx, f.manager, { sessionId: opened.sessionId }));
    expect(cancelled.ok).toBe(true);

    // the room is free again
    await expect(stockUp(f, f.kitchen, '1')).resolves.toBeUndefined();
    expect(await balances(f.orgId)).not.toHaveProperty('5400');

    const [session] = await sql<{ status: string }[]>`select status from count_sessions where id = ${opened.sessionId}`;
    expect(session!.status).toBe('cancelled');
  });
});
