import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-390 S1 (audit round) - the count screen's read side with one item counted in two rooms.
 * `loadCountSheet` shows ONE line per item with the store total; `countsWithoutCost` lists an item ONCE.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { closeDb, transaction, APP_ROLE, cutoverRepo, type Tx } from '@shareat/db';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { loadCountSheet } from '../../src/app/cutover/lib';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

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

async function fixture(hint: string) {
  const code = uid(`t390s1sheet-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, 'multi_room') returning id`;
  const [admin] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const [lt] = await sql<{ id: string }[]>`
    insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const mkRoom = async (c: string, isDefault: boolean) => {
    const [r] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${orgId}, ${store!.id}, ${c}, ${c}, ${lt!.id}, 'operating', ${isDefault}, ${admin!.id}) returning id`;
    return r!.id;
  };
  const kitchen = await mkRoom('KIT', true);
  const freezer = await mkRoom('FRZ', false);
  const [item] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${orgId}, ${testItemCode()}, ${`Pork ${uid('n')}`}, 'raw_material', 'kg', ${admin!.id}) returning id`;
  return { orgId, storeId: store!.id, kitchen, freezer, itemId: item!.id, adminId: admin!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const insertCount = (f: Fixture, room: string, qty: number) => sql`
  insert into opening_counts (org_id, store_id, location_id, item_id, quantity, counted_by)
  values (${f.orgId}, ${f.storeId}, ${room}, ${f.itemId}, ${qty}, ${f.adminId})`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('an item counted in two rooms', () => {
  it('loadCountSheet shows ONE line for it, with the store total (5 + 7 = 12)', async () => {
    const f = await fixture('sheet');
    await insertCount(f, f.kitchen, 5);
    await insertCount(f, f.freezer, 7);
    const sheet = await loadCountSheet(f.orgId, f.storeId);
    const lines = sheet.filter((r) => r.itemId === f.itemId);
    expect(lines).toHaveLength(1);
    expect(Number(lines[0]!.quantity)).toBe(12);
  });

  it('countsWithoutCost lists the uncosted item ONCE, not once per room', async () => {
    const f = await fixture('nocost');
    await insertCount(f, f.kitchen, 5);
    await insertCount(f, f.freezer, 7);
    const gaps = await asOrg(f.orgId, (tx) => cutoverRepo.countsWithoutCost(tx, f.orgId));
    expect(gaps.filter((g) => g.itemId === f.itemId && g.storeId === f.storeId)).toHaveLength(1);
  });
});
