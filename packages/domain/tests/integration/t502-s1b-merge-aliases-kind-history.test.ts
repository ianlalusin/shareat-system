/**
 * T-502 S1b (orchestrator rulings on gaps 4 and 5). Real Postgres, any `*_test` database.
 *  Gap 4: mergeItems MOVES the loser's aliases to the winner and adds the loser's NAME as an alias of the winner; a clashing
 *         alias is skipped (the merge still succeeds) and named in the audit payload.
 *  Gap 5: an item's kind cannot change TO or FROM 'service' once it has stock / delivery / usage / recipe / invoice history.
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import type { Actor } from '@shareat/auth';
import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import { addItemAlias, mergeItems, updateItem } from '@shareat/domain';

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
  const [lt] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const [loc] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${orgId}, ${store!.id}, 'KIT', 'Kitchen', ${lt!.id}, 'operating', true, ${p!.id}) returning id`;
  const [sup] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgId}, ${uid('sup')}, ${p!.id}) returning id`;
  const actor: Actor = { personId: p!.id, orgId };
  const mk = async (name: string, kind = 'supply', unit = 'pcs') => {
    const [r] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${testItemCode()}, ${name}, ${kind}, ${unit}, ${p!.id}) returning id`;
    return r!.id;
  };
  return { orgId, storeId: store!.id, locationId: loc!.id, supplierId: sup!.id, personId: p!.id, actor, mk };
}
type W = Awaited<ReturnType<typeof world>>;

const aliasTexts = async (itemId: string) =>
  (await sql<{ alias: string }[]>`select alias from item_aliases where item_id = ${itemId} order by alias`).map((r) => r.alias);

describe('gap 4 - merge moves aliases and keeps the old spelling findable', () => {
  it('moves the loser aliases to the winner, adds the loser name as an alias, and both resolve to the winner', async () => {
    const w = await world('mg');
    const winner = await w.mk('Siling Labuyo');
    const loser = await w.mk('Chili Pepper');
    await asOrg(w.orgId, (tx) => addItemAlias(tx, w.actor, { itemId: loser, alias: 'sili' }));
    await asOrg(w.orgId, (tx) => addItemAlias(tx, w.actor, { itemId: winner, alias: 'siling pula' }));
    await asOrg(w.orgId, (tx) => mergeItems(tx, w.actor, { loserId: loser, winnerId: winner }));
    expect(await aliasTexts(winner)).toEqual(['Chili Pepper', 'sili', 'siling pula']);
    expect(await aliasTexts(loser)).toEqual([]);
    for (const text of ['sili', 'chili pepper']) {
      const [hit] = await sql<{ item_id: string }[]>`select item_id from item_aliases where org_id = ${w.orgId} and lower(trim(alias)) = ${text}`;
      expect(hit!.item_id).toBe(winner);
    }
  });

  it('skips a clashing alias without failing the merge, and names it in the audit payload', async () => {
    const w = await world('mg-clash');
    const winner = await w.mk('Siling Labuyo');
    const loser = await w.mk('Chili Pepper');
    await asOrg(w.orgId, (tx) => addItemAlias(tx, w.actor, { itemId: loser, alias: 'sili' }));
    await asOrg(w.orgId, (tx) => addItemAlias(tx, w.actor, { itemId: loser, alias: 'Bacon' }));
    // a clash that appears after the alias was made: an item named "Bacon" now exists (loser alias "Bacon" can no longer be kept)
    await sql`alter table items disable trigger items_name_alias_guard`;
    await w.mk('Bacon');
    await sql`alter table items enable trigger items_name_alias_guard`;
    await asOrg(w.orgId, (tx) => mergeItems(tx, w.actor, { loserId: loser, winnerId: winner }));
    expect(await aliasTexts(winner)).toEqual(['Chili Pepper', 'sili']);
    const [log] = await sql<{ after: unknown }[]>`
      select "after" from audit_log where org_id = ${w.orgId} and action = 'item.merged' and entity_id = ${loser}`;
    expect(JSON.stringify(log!.after)).toContain('Bacon');
  });
});

describe('gap 5 - kind cannot cross the service line once an item has history', () => {
  const movement = (w: W, itemId: string) =>
    sql`insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
        values (${w.orgId}, ${w.storeId}, ${w.locationId}, ${itemId}, now(), 5, 'receipt', 'test', uuidv7(), ${w.personId})`;
  const state = async (fn: () => PromiseLike<unknown>) => {
    try {
      await fn();
      return null;
    } catch (e) {
      return (e as { code?: string; constraint_name?: string }).constraint_name ?? 'other';
    }
  };

  it('allowed with no history, both directions', async () => {
    const w = await world('k-ok');
    const a = await w.mk('Soap');
    await sql`update items set kind = 'service' where id = ${a}`;
    await sql`update items set kind = 'supply' where id = ${a}`;
  });

  it('refused TO service when the item has stock movements (DB), and in plain words (domain)', async () => {
    const w = await world('k-to');
    const a = await w.mk('Charcoal');
    await movement(w, a);
    expect(await state(() => sql`update items set kind = 'service' where id = ${a}`)).toBe('items_service_kind_has_history');
    const err = await asOrg(w.orgId, (tx) => updateItem(tx, w.actor, a, { kind: 'service' })).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/history|stock|recorded/i);
    expect(err!.message).not.toMatch(/violates|constraint|items_/i);
    const [r] = await sql`select kind from items where id = ${a}`;
    expect(r!.kind).toBe('supply');
  });

  it('refused TO service for a recipe output or a recipe line', async () => {
    const w = await world('k-rec');
    const out = await w.mk('Sauce', 'raw_material', 'kg');
    const inp = await w.mk('Garlic', 'raw_material', 'kg');
    const [r] = await sql<{ id: string }[]>`
      insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by) values (${w.orgId}, ${uid('R')}, ${out}, 1, ${w.personId}) returning id`;
    await sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${r!.id}, ${inp}, 1, 'kg')`;
    expect(await state(() => sql`update items set kind = 'service' where id = ${out}`)).toBe('items_service_kind_has_history');
    expect(await state(() => sql`update items set kind = 'service' where id = ${inp}`)).toBe('items_service_kind_has_history');
  });

  it('refused FROM service when the item has invoice lines', async () => {
    const w = await world('k-from');
    const svc = await w.mk('Electricity', 'service', 'pcs');
    await sql`update items set kind = 'supply' where id = ${svc}`; // no history yet: allowed
    await sql`update items set kind = 'service' where id = ${svc}`;
    const [inv] = await sql<{ id: string }[]>`
      insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, created_by) values (${w.orgId}, ${w.storeId}, ${w.supplierId}, '2026-01-20', '10.00', ${w.personId}) returning id`;
    await sql`insert into supplier_invoice_lines (supplier_invoice_id, line_no, item_id, quantity, purchase_unit, conversion_factor, unit_price, line_total)
              values (${inv!.id}, 1, ${svc}, '1', 'pcs', '1', '10.00', '10.00')`;
    expect(await state(() => sql`update items set kind = 'supply' where id = ${svc}`)).toBe('items_service_kind_has_history');
    const err = await asOrg(w.orgId, (tx) => updateItem(tx, w.actor, svc, { kind: 'supply' })).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toMatch(/violates|constraint|items_/i);
  });
});
