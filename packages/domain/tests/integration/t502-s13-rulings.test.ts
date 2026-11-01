/**
 * T-502 section 13 rulings A1, A2, A5, A6 (DOMAIN side) and A4 (single-admin approval). Real Postgres, any `*_test` database.
 *  A1  the cutover B3 list never names a service item.
 *  A2  setStoreSellability refuses a service in plain words and writes nothing.
 *  A4  a super-admin approves their OWN request in an org whose only administrator is them.
 *  A5  mergeItems: service <-> non-service refused; differing categories: the winner keeps its own, the audit row records the loser's.
 *  A6  a service is never a variation (createItem, setItemVariantOf, requestItem), and a service is never a variation parent.
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import type { Actor } from '@shareat/auth';
import { APP_ROLE, cutoverRepo, transaction, type Tx } from '@shareat/db';
import { approveItemRequest, createItem, mergeItems, requestItem, setItemVariantOf, setStoreSellability } from '@shareat/domain';

import { testItemCode } from './_fixtures/item-code';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run: database name must contain "_test".');
const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function world(hint: string) {
  const c = uid(hint);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${c}`}, ${c}) returning id`;
  const orgId = o!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'Store') returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Super') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'super_admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
  const actor: Actor = { personId: p!.id, orgId };
  const category = async (label: string) => {
    const [r] = await sql<{ id: string }[]>`insert into expense_categories (org_id, "group", category) values (${orgId}, 'COGS', ${`${label} ${c}`}) returning id`;
    return r!.id;
  };
  const mk = async (name: string, kind = 'supply', unit = 'pcs', categoryId: string | null = null) => {
    const [r] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by, expense_category_id)
      values (${orgId}, ${testItemCode()}, ${`${name} ${uid('n')}`}, ${kind}, ${unit}, ${p!.id}, ${categoryId}) returning id`;
    return r!.id;
  };
  return { orgId, storeId: store!.id, personId: p!.id, actor, mk, category };
}
const err = (fn: () => PromiseLike<unknown>) => fn().then(() => null, (e: Error) => e);
/** What the person is told (RefusalError.userMessage), or the raw message for any other error. */
const said = (e: Error | null) => (e as { userMessage?: string } | null)?.userMessage ?? e?.message ?? '';
const PLAIN = /violates|constraint|items_|23514|service_item_never_stocked/i;

describe('A1 - the cutover B3 list never names a service item', () => {
  it('lists an active stocked item with no count, omits an active service item', async () => {
    const w = await world('a1');
    const stocked = await w.mk('Charcoal');
    const service = await w.mk('Electricity', 'service');
    const missing = await asOrg(w.orgId, (tx) => cutoverRepo.itemsWithoutCount(tx, w.orgId, w.storeId));
    const ids = missing.map((m) => m.itemId);
    expect(ids).toContain(stocked);
    expect(ids).not.toContain(service);
  });
});

describe('A2 - a service is not sellable at any store', () => {
  it('setStoreSellability refuses a service in plain words and writes no row; a stocked item still works', async () => {
    const w = await world('a2');
    const service = await w.mk('Water', 'service');
    const stocked = await w.mk('Box');
    const e = await err(() => asOrg(w.orgId, (tx) => setStoreSellability(tx, w.actor, { storeId: w.storeId, itemId: service, sellableRetail: true })));
    expect(e).toBeInstanceOf(Error);
    expect(said(e)).toMatch(/only bought/i);
    expect(said(e)).not.toMatch(PLAIN);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from store_item_sellability where item_id = ${service}`;
    expect(n!.n).toBe(0);
    await asOrg(w.orgId, (tx) => setStoreSellability(tx, w.actor, { storeId: w.storeId, itemId: stocked, sellableRetail: true }));
    const [m] = await sql<{ n: number }[]>`select count(*)::int as n from store_item_sellability where item_id = ${stocked}`;
    expect(m!.n).toBe(1);
  });
});

describe('A4 - a super-admin approves their own request in a single-admin org', () => {
  it('requests and approves as the only administrator; the item exists', async () => {
    const w = await world('a4');
    const cat = await w.category('Supplies');
    const r = await asOrg(w.orgId, (tx) => requestItem(tx, w.actor, { name: uid('Own request'), kind: 'supply', baseUnit: 'pcs', expenseCategoryId: cat } as never));
    const a = await asOrg(w.orgId, (tx) => approveItemRequest(tx, w.actor, { requestId: r.requestId }));
    expect(a.itemId).toBeTruthy();
    const [row] = await sql<{ status: string }[]>`select status from item_requests where id = ${r.requestId}`;
    expect(row!.status).toBe('approved');
  });
});

describe('A5 - mergeItems and the service line / categories', () => {
  it('refuses service -> non-service and non-service -> service with the plain sentence; nothing is merged', async () => {
    const w = await world('a5-kind');
    const service = await w.mk('Electricity', 'service');
    const stocked = await w.mk('Charcoal');
    for (const [loserId, winnerId] of [[service, stocked], [stocked, service]] as const) {
      const e = await err(() => asOrg(w.orgId, (tx) => mergeItems(tx, w.actor, { loserId, winnerId })));
      expect(e).toBeInstanceOf(Error);
      expect(said(e)).toContain('A service can only be merged into another service.');
    }
    const rows = await sql<{ status: string }[]>`select status from items where id in (${service}, ${stocked})`;
    expect(rows.every((r) => r.status !== 'merged')).toBe(true);
  });

  it('service -> service merges (control)', async () => {
    const w = await world('a5-svc');
    const a = await w.mk('Electricity', 'service');
    const b = await w.mk('Power bill', 'service');
    await asOrg(w.orgId, (tx) => mergeItems(tx, w.actor, { loserId: b, winnerId: a }));
    const [r] = await sql<{ status: string }[]>`select status from items where id = ${b}`;
    expect(r!.status).toBe('merged');
  });

  it('different categories: the winner keeps its own, the audit row records the loser category', async () => {
    const w = await world('a5-cat');
    const catW = await w.category('Winner cat');
    const catL = await w.category('Loser cat');
    const winner = await w.mk('Siling Labuyo', 'supply', 'pcs', catW);
    const loser = await w.mk('Chili Pepper', 'supply', 'pcs', catL);
    await asOrg(w.orgId, (tx) => mergeItems(tx, w.actor, { loserId: loser, winnerId: winner }));
    const [win] = await sql<{ expense_category_id: string }[]>`select expense_category_id from items where id = ${winner}`;
    expect(win!.expense_category_id).toBe(catW);
    const [log] = await sql<{ before: Record<string, unknown>; after: Record<string, unknown> }[]>`
      select "before", "after" from audit_log where org_id = ${w.orgId} and action = 'item.merged' and entity_id = ${loser}`;
    expect(log!.before.loserExpenseCategoryId).toBe(catL);
    expect(log!.after.winnerExpenseCategoryId).toBe(catW);
  });

  it('no category on either side: both are still recorded (null is a value)', async () => {
    const w = await world('a5-nocat');
    const winner = await w.mk('Box');
    const loser = await w.mk('Carton');
    await asOrg(w.orgId, (tx) => mergeItems(tx, w.actor, { loserId: loser, winnerId: winner }));
    const [log] = await sql<{ before: Record<string, unknown> }[]>`select "before" from audit_log where org_id = ${w.orgId} and action = 'item.merged' and entity_id = ${loser}`;
    expect(log!.before).toHaveProperty('loserExpenseCategoryId', null);
  });
});

describe('A6 - a service is never a variation', () => {
  it('createItem refuses a service with variantOfItemId, in plain words', async () => {
    const w = await world('a6-create');
    const parent = await w.mk('Power', 'service');
    const e = await err(() => asOrg(w.orgId, (tx) => createItem(tx, w.actor, { name: uid('Power night'), kind: 'service', baseUnit: 'pcs', variantOfItemId: parent })));
    expect(e).toBeInstanceOf(Error);
    expect(said(e)).toMatch(/service/i);
    expect(said(e)).toMatch(/variation/i);
    expect(said(e)).not.toMatch(PLAIN);
  });

  it('createItem refuses a stocked item as a variation of a service parent, in plain words', async () => {
    const w = await world('a6-parent');
    const parent = await w.mk('Power', 'service');
    const e = await err(() => asOrg(w.orgId, (tx) => createItem(tx, w.actor, { name: uid('Child'), kind: 'supply', baseUnit: 'pcs', variantOfItemId: parent })));
    expect(e).toBeInstanceOf(Error);
    expect(said(e)).toMatch(/service/i);
    expect(said(e)).not.toMatch(PLAIN);
  });

  it('setItemVariantOf refuses a service child', async () => {
    const w = await world('a6-set');
    const parent = await w.mk('Power', 'service');
    const child = await w.mk('Water', 'service');
    const e = await err(() => asOrg(w.orgId, (tx) => setItemVariantOf(tx, w.actor, { itemId: child, parentId: parent })));
    expect(e).toBeInstanceOf(Error);
    expect(said(e)).toMatch(/service/i);
    expect(said(e)).not.toMatch(PLAIN);
    const [r] = await sql<{ v: string | null }[]>`select variant_of_item_id as v from items where id = ${child}`;
    expect(r!.v).toBeNull();
  });

  it('requestItem refuses a service request with a variation parent', async () => {
    const w = await world('a6-req');
    const parent = await w.mk('Power', 'service');
    const e = await err(() => asOrg(w.orgId, (tx) => requestItem(tx, w.actor, { name: uid('Req'), kind: 'service', baseUnit: 'pcs', variantOfItemId: parent } as never)));
    expect(e).toBeInstanceOf(Error);
    expect(said(e)).not.toMatch(PLAIN);
  });
});
