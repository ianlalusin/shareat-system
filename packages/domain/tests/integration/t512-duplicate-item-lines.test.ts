import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { money } from '@shareat/core/money';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { addUsageLine, postUsage, recordReturn, saveUsageDraft } from '@shareat/domain';
import { stockUsageRepo } from '@shareat/db';
import { postUsageRecord } from '../../src/stock/usage';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import type { LocationLike } from '../../src/stock-locations/rules';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { testItemCode } from './_fixtures/item-code';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';

/**
 * T-512 (audit CR-1) - a usage, wastage or supplier return with the same item twice is refused in plain words, before any write,
 * instead of reaching the unique index stock_movements_source_pair_key and surfacing a raw 23505.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(
    `Refusing to run against ${redactDbUrl(url)} — the database name must contain "_test".`,
  );
}

const sql = postgres(url, { max: 5 });

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

let orgA: string, storeA: string, staffId: string, managerId: string, fileA: string;
let kitchen: string, stockroom: string, itemA: string;
let staffActor: Actor, managerActor: Actor;
// Finding B — cross-store ✗: a manager whose ONLY scope is a different store in the same org.
let storeB: string, otherManagerId: string;
let otherManagerActor: Actor;

const locations = (): LocationLike[] => [
  { id: kitchen, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' },
  { id: stockroom, role: 'storage', purpose: 'normal', isDefault: false, status: 'active' },
];

async function onHand(loc = kitchen): Promise<string> {
  const [r] = await sql<{ t: string }[]>`
    select coalesce(sum(quantity),0)::text as t from stock_movements
    where item_id = ${itemA} and location_id = ${loc}`;
  return r!.t;
}

async function layerRemaining(): Promise<string[]> {
  const rows = await sql<{ remaining_quantity: string }[]>`
    select remaining_quantity from stock_layers where item_id = ${itemA} order by received_at`;
  return rows.map((r) => r.remaining_quantity);
}

async function balances(): Promise<Record<string, string>> {
  const rows = await sql<{ code: string; net: string }[]>`
    select a.code, (sum(l.debit) - sum(l.credit))::text as net
    from journal_lines l join accounts a on a.id = l.account_id
    where a.org_id = ${orgA} group by a.code`;
  return Object.fromEntries(rows.map((r) => [r.code, r.net]));
}

/** Two receipts at different costs into the kitchen, so FIFO has something to choose. */
async function stockUp() {
  for (const [n, cost, day] of [['10', '100.0000', '01'], ['8', '120.0000', '05']] as const) {
    const [d] = await sql<{ id: string }[]>`
      insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
      values (${orgA},${storeA},'purchase',${'2026-08-' + day},${fileA},${staffId}) returning id`;
    await asOrg(orgA, (tx) =>
      receiveDelivery(tx, {
        orgId: orgA, storeId: storeA, deliveryId: d!.id, deliveredOn: `2026-08-${day}`,
        locations: locations(), receivedBy: staffId,
        lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', receivedQuantity: quantity(n), conversionFactor: '1', unitCost: cost, locationId: kitchen }],
      }),
    );
  }
}

const draftInput = (over: Record<string, unknown> = {}) => ({
  orgId: orgA,
  storeId: storeA,
  locationId: kitchen,
  kind: 'usage' as const,
  usedOn: '2026-08-20',
  lines: [{ itemId: itemA, quantity: '15' }],
  ...over,
});

beforeEach(async () => {
  await sql`
    truncate table count_lines, count_session_locations, count_sessions,
      stock_usage_lines, stock_usage_records, delivery_lines, deliveries,
      stock_layer_consumptions, stock_layers, stock_movements,
      stock_locations, location_types, departments,
      person_store_scope, person_roles,
      journal_lines, journal_entries, fiscal_periods, audit_log, stored_files,
      accounts, items, person_identities, persons, stores, organizations restart identity cascade`;
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org A','org-a') returning id`;
  orgA = o!.id;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgA},'A1','A One','multi_room') returning id`;
  storeA = s!.id;
  const [sB] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgA},'B1','B One','multi_room') returning id`;
  storeB = sB!.id;
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Staffer') returning id`;
  const [manager] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Manager') returning id`;
  const [otherManager] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Other Store Manager') returning id`;
  staffId = staff!.id;
  managerId = manager!.id;
  otherManagerId = otherManager!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${staffId}, ${orgA}, 'staff')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${managerId}, ${orgA}, 'manager')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${otherManagerId}, ${orgA}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${staffId}, ${storeA})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${managerId}, ${storeA})`;
  // ⭐ Finding B — scoped to storeB ONLY, never storeA, so acting on a storeA record is refused.
  await sql`insert into person_store_scope (person_id, store_id) values (${otherManagerId}, ${storeB})`;
  // T-318: Staffer's only capabilities beyond the matrix now come from a position grant.
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgA}, ${storeA}, ${staffId}, 'SE-001', 'regular', '2025-01-01')
    returning id
  `;
  await grantEverydayPositionAccess(sql, {
    orgId: orgA, storeId: storeA, employmentId: employment!.id, personId: staffId, setBy: managerId,
  });
  staffActor = { personId: staffId, orgId: orgA };
  managerActor = { personId: managerId, orgId: orgA };
  otherManagerActor = { personId: otherManagerId, orgId: orgA };

  const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgA},'STK','Stockroom') returning id`;
  const [r2] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${orgA},${storeA},'KIT','Kitchen',${t!.id},'operating',true,${staffId}) returning id`;
  const [r3] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, created_by) values (${orgA},${storeA},'STORE','Stockroom',${t!.id},${staffId}) returning id`;
  kitchen = r2!.id; stockroom = r3!.id;
  const [i] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},${testItemCode()},'Pork Belly','raw_material','kg',${staffId}) returning id`;
  itemA = i!.id;
  const [f] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgA}, ${'orgs/' + orgA + '/p.jpg'}, 'image/jpeg', 10, 'x', 'receipt_photo', ${staffId}) returning id`;
  fileA = f!.id;
  await seedChartOfAccounts(sql, orgA);
  // ⚠️ Wide on purpose — DEF-141's void now reverses a journal entry too, and `voidUsage` dates
  // that reversal on the REAL business date (`toBusinessDate()`, today), not the record's fixed
  // `usedOn`. A single-month window sized to match `usedOn` (as the engine's own fixture uses)
  // would pass or fail depending on which real month the suite happens to run in.
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) select ${orgA}, m::date, (m + interval '1 month' - interval '1 day')::date, 'open' from generate_series('2026-01-01'::date, greatest('2026-12-01'::date, date_trunc('month', now() at time zone 'Asia/Manila')::date), interval '1 month') m`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});


const dupRe = (name: string) => new RegExp(`^Item ${name} is on this record twice\\. Put it on one line with the total quantity\\.$`);

async function counts() {
  const [r] = await sql<{ rec: string; line: string; mov: string; je: string }[]>`
    select (select count(*) from stock_usage_records)::text as rec,
           (select count(*) from stock_usage_lines)::text as line,
           (select count(*) from stock_movements where source_type in ('usage','wastage'))::text as mov,
           (select count(*) from journal_entries where source_type in ('usage','wastage'))::text as je`;
  return r!;
}

async function secondItem(): Promise<string> {
  const [i] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},${testItemCode()},'Chicken Thigh','raw_material','kg',${staffId}) returning id`;
  return i!.id;
}

describe('T-512 - (a) saveUsageDraft refuses a repeated item', () => {
  it('usage: ok:false naming the item, no record and no line written', async () => {
    const before = await counts();
    const res = await asOrg(orgA, (tx) =>
      saveUsageDraft(tx, staffActor, draftInput({ lines: [{ itemId: itemA, quantity: '2' }, { itemId: itemA, quantity: '3' }] })),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(dupRe('Pork Belly'));
    expect(await counts()).toEqual(before);
  });
});

describe('T-512 - (d) wastage kind', () => {
  it('saveUsageDraft refuses a repeated item on a wastage draft, nothing written', async () => {
    const before = await counts();
    const res = await asOrg(orgA, (tx) =>
      saveUsageDraft(
        tx,
        staffActor,
        draftInput({ kind: 'wastage', reasonCode: 'spoilage', lines: [{ itemId: itemA, quantity: '1' }, { itemId: itemA, quantity: '1' }] }),
      ),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(dupRe('Pork Belly'));
    expect(await counts()).toEqual(before);
  });
});

describe('T-512 - (b) addUsageLine refuses an item already on the draft', () => {
  it('ok:false, line count unchanged', async () => {
    const draft = await asOrg(orgA, (tx) => saveUsageDraft(tx, staffActor, draftInput()));
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const before = await counts();
    const res = await asOrg(orgA, (tx) => addUsageLine(tx, staffActor, { recordId: draft.recordId, itemId: itemA, quantity: '1' }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(dupRe('Pork Belly'));
    expect(await counts()).toEqual(before);
  });
});

describe('T-512 - (c) a legacy draft with the item twice cannot post, and says why', () => {
  it('postUsage returns ok:false (not a thrown 23505); record stays draft; no movement, entry or layer change', async () => {
    await stockUp();
    const recordId = await asOrg(orgA, async (tx) => {
      const { id } = await stockUsageRepo.insertUsageRecord(tx, {
        orgId: orgA, storeId: storeA, locationId: kitchen, kind: 'usage', usedOn: '2026-08-20',
        departmentId: null, reasonCode: null, createdBy: staffId,
      });
      await stockUsageRepo.insertUsageLines(tx, id, [
        { lineNo: '1', itemId: itemA, quantity: quantity('2') },
        { lineNo: '2', itemId: itemA, quantity: quantity('3') },
      ]);
      return id;
    });
    const layersBefore = await layerRemaining();
    const res = await asOrg(orgA, (tx) => postUsage(tx, managerActor, { recordId }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(dupRe('Pork Belly'));
    const [rec] = await sql<{ status: string }[]>`select status from stock_usage_records where id = ${recordId}`;
    expect(rec!.status).toBe('draft');
    const c = await counts();
    expect(c.mov).toBe('0');
    expect(c.je).toBe('0');
    expect(await layerRemaining()).toEqual(layersBefore);
  });

  it('the engine itself refuses a repeated item before any write (defensive guard)', async () => {
    await stockUp();
    const res = await asOrg(orgA, (tx) =>
      postUsageRecord(tx, {
        orgId: orgA, storeId: storeA, locationId: kitchen, recordId: crypto.randomUUID(), kind: 'usage', usedOn: '2026-08-20', postedBy: staffId,
        lines: [
          { lineId: '1', itemId: itemA, cogsCategory: 'meat', inventoryAccount: '1310', quantity: quantity('1') },
          { lineId: '2', itemId: itemA, cogsCategory: 'meat', inventoryAccount: '1310', quantity: quantity('1') },
        ],
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/is on this record twice/);
    expect((await counts()).mov).toBe('0');
  });
});

describe('T-512 - (f) positive control: two different items still save and post', () => {
  it('saves, posts and costs both lines as before', async () => {
    await stockUp();
    const itemB = await secondItem();
    const [d] = await sql<{ id: string }[]>`
      insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
      values (${orgA},${storeA},'purchase','2026-08-02',${fileA},${staffId}) returning id`;
    await asOrg(orgA, (tx) =>
      receiveDelivery(tx, {
        orgId: orgA, storeId: storeA, deliveryId: d!.id, deliveredOn: '2026-08-02', locations: locations(), receivedBy: staffId,
        lines: [{ lineId: '1', itemId: itemB, itemKind: 'raw_material', receivedQuantity: quantity('5'), conversionFactor: '1', unitCost: '50.0000', locationId: kitchen }],
      }),
    );
    const draft = await asOrg(orgA, (tx) =>
      saveUsageDraft(tx, staffActor, draftInput({ lines: [{ itemId: itemA, quantity: '2' }, { itemId: itemB, quantity: '4' }] })),
    );
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const res = await asOrg(orgA, (tx) => postUsage(tx, managerActor, { recordId: draft.recordId }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.totalCost).toBe(money('400.00')); // 2 x 100 + 4 x 50
    expect((await counts()).mov).toBe('2');
  });
});

describe('T-512 - (e) recordReturn', () => {
  async function retFixture() {
    const [sup] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgA}, 'Acme Meats', ${staffId}) returning id`;
    await stockUp(); // 18 kg in the kitchen
    const [d] = await sql<{ id: string }[]>`
      insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
      values (${orgA},${storeA},'purchase','2026-08-03',${fileA},${staffId}) returning id`;
    await asOrg(orgA, (tx) =>
      receiveDelivery(tx, {
        orgId: orgA, storeId: storeA, deliveryId: d!.id, deliveredOn: '2026-08-03', locations: locations(), receivedBy: staffId,
        lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', receivedQuantity: quantity('6'), conversionFactor: '1', unitCost: '110.0000', locationId: stockroom }],
      }),
    );
    return sup!.id;
  }
  const line = (locationId: string, q: string) => ({ itemId: itemA, itemKind: 'raw_material', locationId, quantity: q, deliveryLineId: null });
  const returnMovements = async () =>
    (await sql<{ n: string }[]>`select count(*)::text as n from stock_movements where source_type = 'supplier_return'`)[0]!.n;

  it('same item, same location twice: ok:false, nothing written', async () => {
    const supplierId = await retFixture();
    const res = await asOrg(orgA, (tx) =>
      recordReturn(tx, { storeId: storeA, supplierId, deliveryId: null, returnedOn: '2026-08-20', reason: 'damaged', lines: [line(kitchen, '1'), line(kitchen, '2')], actor: staffActor }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(dupRe('Pork Belly'));
    expect(await returnMovements()).toBe('0');
    expect(await onHand()).toBe('18.000');
  });

  it('positive control: same item at two DIFFERENT locations still succeeds', async () => {
    const supplierId = await retFixture();
    const res = await asOrg(orgA, (tx) =>
      recordReturn(tx, { storeId: storeA, supplierId, deliveryId: null, returnedOn: '2026-08-20', reason: 'damaged', lines: [line(kitchen, '1'), line(stockroom, '2')], actor: staffActor }),
    );
    expect(res.ok).toBe(true);
    expect(await returnMovements()).toBe('2');
  });
});
