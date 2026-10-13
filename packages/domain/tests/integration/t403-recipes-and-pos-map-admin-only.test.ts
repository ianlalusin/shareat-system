import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { createRecipe, decideMapRequest, requestMap, upsertPosItemMap } from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { testItemCode } from './_fixtures/item-code';

/**
 * T-403 R1-R3 - recipes and the v1 POS mapping are admin-only.
 * The only production-recipe write in the domain is createRecipe (packages/domain/src/production/index.ts:112); there is no
 * edit, deactivate or line-change function (insertRecipe/insertRecipeLines in the repo are called only from it).
 * RED today: a manager SUCCEEDS at both (assertion failures, not missing symbols). The capability name is asserted as a
 * string, so no symbol is missing for this file.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test/.test(url)) throw new Error('Refusing to run: the database name must contain "shareat_test".');
const sql = postgres(url, { max: 5 });

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

let orgA: string, storeA: string, storeB: string;
let staffActor: Actor, managerActor: Actor, adminActor: Actor;
let outItem: string, ingItem: string;

async function person(name: string, role: 'staff' | 'manager' | 'admin', stores: string[]): Promise<Actor> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgA}, ${role})`;
  for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
  return { personId: p!.id, orgId: orgA };
}

const recipeInput = () => ({
  orgId: orgA, name: 'Samgyup Box', outputItemId: outItem, outputQuantity: '1',
  lines: [{ itemId: ingItem, quantity: '0.2', unit: 'kg' }],
});
const mapInput = (storeId = storeA, key = 'coke') => ({
  orgId: orgA, storeId, posItemKey: key, posItemName: key.toUpperCase(), mode: 'no_stock' as const,
});
const recipeCount = async () => Number((await sql<{ n: string }[]>`select count(*)::text n from production_recipes`)[0]!.n);
const mapCount = async () => Number((await sql<{ n: string }[]>`select count(*)::text n from pos_item_maps`)[0]!.n);

async function refusal(p: Promise<unknown>): Promise<AuthorizationError> {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e, 'expected an AuthorizationError, but the call succeeded').toBeInstanceOf(AuthorizationError);
  return e as AuthorizationError;
}

beforeEach(async () => {
  await sql`
    truncate table pos_map_requests, pos_item_maps, production_recipe_lines, production_recipes,
      person_store_scope, person_roles, audit_log, items, person_identities, persons, stores, organizations restart identity cascade`;
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org A','org-a') returning id`;
  orgA = o!.id;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgA},'A1','A One','multi_room') returning id`;
  const [s2] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgA},'A2','A Two','multi_room') returning id`;
  storeA = s!.id; storeB = s2!.id;
  staffActor = await person('Staffer', 'staff', [storeA]);
  managerActor = await person('Manager', 'manager', [storeA]);
  adminActor = await person('Admin', 'admin', [storeA, storeB]);
  const [a] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},${testItemCode()},'Sauce Box','raw_material','kg',${adminActor.personId}) returning id`;
  const [b] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},${testItemCode()},'Cheese','raw_material','kg',${adminActor.personId}) returning id`;
  outItem = a!.id; ingItem = b!.id;
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgA}, ${storeA}, ${staffActor.personId}, 'SE-001', 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId: orgA, storeId: storeA, employmentId: emp!.id, personId: staffActor.personId, setBy: adminActor.personId });
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-403 R1 - production recipe writes are admin-only (manage_recipes)', () => {
  it('a manager is refused createRecipe with capability manage_recipes, and nothing is written', async () => {
    const err = await refusal(asOrg(orgA, (tx) => createRecipe(tx, managerActor, recipeInput())));
    expect(err.capability).toBe('manage_recipes');
    expect(await recipeCount()).toBe(0);
  });
  it('staff are refused createRecipe with capability manage_recipes', async () => {
    const err = await refusal(asOrg(orgA, (tx) => createRecipe(tx, staffActor, recipeInput())));
    expect(err.capability).toBe('manage_recipes');
  });
  it('an admin creates a recipe', async () => {
    const res = await asOrg(orgA, (tx) => createRecipe(tx, adminActor, recipeInput()));
    expect(res.ok).toBe(true);
    expect(await recipeCount()).toBe(1);
  });
});

describe('T-403 R2 - the v1 POS mapping is admin-only (manage_pos_map)', () => {
  it('a manager is refused upsertPosItemMap at their OWN store, capability manage_pos_map, nothing written', async () => {
    const err = await refusal(asOrg(orgA, (tx) => upsertPosItemMap(tx, managerActor, mapInput(storeA))));
    expect(err.capability).toBe('manage_pos_map');
    expect(await mapCount()).toBe(0);
  });
  it('an admin maps at a store', async () => {
    const res = await asOrg(orgA, (tx) => upsertPosItemMap(tx, adminActor, mapInput(storeA)));
    expect(res.ok).toBe(true);
    expect(await mapCount()).toBe(1);
  });
  it('the store scope is kept: an admin scoped to store A only is refused at store B', async () => {
    const scopedAdmin = await person('Admin A only', 'admin', [storeA]);
    await refusal(asOrg(orgA, (tx) => upsertPosItemMap(tx, scopedAdmin, mapInput(storeB))));
    expect(await mapCount()).toBe(0);
  });
});

describe('T-403 R3 - staff can still flag an unmappable item; a manager still decides', () => {
  it('staff (request_pos_map, no manage_pos_map) can requestMap', async () => {
    const res = await asOrg(orgA, (tx) => requestMap(tx, staffActor, { orgId: orgA, storeId: storeA, posItemKey: 'x', posItemName: 'X' }));
    expect(res.ok).toBe(true);
  });
  it('a manager can still decide the request (decide_pos_map_request unchanged)', async () => {
    const req = await asOrg(orgA, (tx) => requestMap(tx, staffActor, { orgId: orgA, storeId: storeA, posItemKey: 'x', posItemName: 'X' }));
    if (!req.ok) throw new Error('setup: request refused');
    const res = await asOrg(orgA, (tx) => decideMapRequest(tx, managerActor, { requestId: req.requestId, decision: 'rejected' }));
    expect(res.ok).toBe(true);
  });
});
