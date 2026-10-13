/**
 * T-401 S2 shared fixture (TESTER). Raw SQL for everything the domain under test is NOT the subject of, so a red test
 * names the function it proves and not a neighbour. One org per call (uid-unique codes, no truncation, files can share a DB).
 *
 * Cast of an org: stores A and B; admin / super admin / manager / manager2 / staff
 * (managerA = a manager scoped to store A only) (role rows, all scoped to BOTH stores so a refusal is the
 * capability's, not a scope accident); `grantedStaff` = staff role + the position grant `set_menu_price` for store A ONLY (T-318).
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { expect } from 'vitest';

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor, Capability } from '@shareat/auth';
import { grantEverydayPositionAccess } from './staff-everyday-access';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

export const sql = postgres(url, { max: 5 });
let seq = 0;
export const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const itemCode = () => `${Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'A')}-${String(1 + Math.floor(Math.random() * 998)).padStart(3, '0')}`;

export interface Cast {
  orgId: string;
  storeA: string;
  storeB: string;
  admin: Actor;
  superAdmin: Actor;
  manager: Actor;
  /** manager scoped to store A ONLY (Q1: a manager prices their own store; refused at B). */
  managerA: Actor;
  /** a second manager scoped to both stores (for "manager B cannot withdraw manager A's request"). */
  manager2: Actor;
  staff: Actor;
  /** staff role + position grant of set_menu_price for storeA only (scoped to both stores, so only the grant decides). */
  grantedStaff: Actor;
  stockItemId: string;
  recipeId: string;
  categoryId: string;
}

async function person(orgId: string, name: string, role: string, stores: string[]): Promise<Actor> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
  return { personId: p!.id, orgId };
}

export async function cast(hint: string): Promise<Cast> {
  const code = uid(`t401s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [a] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Lipa') returning id`;
  const [b] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Batangas') returning id`;
  const storeA = a!.id;
  const storeB = b!.id;
  const admin = await person(orgId, 'Admin', 'admin', [storeA, storeB]);
  const superAdmin = await person(orgId, 'Super', 'super_admin', [storeA, storeB]);
  const manager = await person(orgId, 'Manager', 'manager', [storeA, storeB]);
  const managerA = await person(orgId, 'Manager A', 'manager', [storeA]);
  const manager2 = await person(orgId, 'Manager 2', 'manager', [storeA, storeB]);
  const staff = await person(orgId, 'Staff', 'staff', [storeA, storeB]);
  const grantedStaff = await person(orgId, 'Granted staff', 'staff', [storeA, storeB]);
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeA}, ${grantedStaff.personId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, {
    orgId, storeId: storeA, employmentId: emp!.id, personId: grantedStaff.personId, setBy: admin.personId,
    // The capability does not exist until the builder adds it; the cast keeps this file compiling for the red run.
    capabilities: ['set_menu_price' as unknown as Capability],
  });
  const [stock] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${orgId}, ${itemCode()}, ${uid('Pork')}, 'raw_material', 'kg', ${admin.personId}) returning id`;
  const [recipe] = await sql<{ id: string }[]>`
    insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by)
    values (${orgId}, ${uid('Rec')}, ${stock!.id}, 1, ${admin.personId}) returning id`;
  const [cat] = await sql<{ id: string }[]>`
    insert into menu_categories (org_id, name, sort_order, status, created_by)
    values (${orgId}, ${uid('Cat')}, 0, 'active', ${admin.personId}) returning id`;
  return { orgId, storeA, storeB, admin, superAdmin, manager, managerA, manager2, staff, grantedStaff, stockItemId: stock!.id, recipeId: recipe!.id, categoryId: cat!.id };
}

/** A menu item plus its default variant, by raw SQL (the domain's createMenuItem is not the subject here). */
export async function rawItem(c: Cast, itemType: 'a_la_carte' | 'package' | 'refill' = 'a_la_carte', name?: string) {
  const [item] = await sql<{ id: string }[]>`
    insert into menu_items (org_id, category_id, name, item_type, sold_a_la_carte, sold_in_package_session, diner_orderable, sort_order, status, created_by)
    values (${c.orgId}, ${c.categoryId}, ${name ?? uid('Item')}, ${itemType}, ${itemType === 'a_la_carte'}, false, true, 0, 'active', ${c.admin.personId}) returning id`;
  const [variant] = await sql<{ id: string }[]>`
    insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by)
    values (${c.orgId}, ${item!.id}, null, true, 0, 'active', ${c.admin.personId}) returning id`;
  return { itemId: item!.id, variantId: variant!.id };
}

/** A no_stock rule in force now, so an offer for the variant may be live. */
export async function rawRule(c: Cast, variantId: string): Promise<string> {
  const [r] = await sql<{ id: string }[]>`
    insert into menu_depletion_rules (org_id, variant_id, mode, created_by) values (${c.orgId}, ${variantId}, 'no_stock', ${c.admin.personId}) returning id`;
  return r!.id;
}

/** An option group with one value, raw. */
export async function rawOption(c: Cast) {
  const [g] = await sql<{ id: string }[]>`
    insert into menu_option_groups (org_id, name, selection_mode, min_selections, max_selections, status, created_by)
    values (${c.orgId}, ${uid('Grp')}, 'single', 1, 1, 'active', ${c.admin.personId}) returning id`;
  const [v] = await sql<{ id: string }[]>`
    insert into menu_option_values (org_id, option_group_id, name, sort_order, status, created_by)
    values (${c.orgId}, ${g!.id}, ${uid('Val')}, 0, 'active', ${c.admin.personId}) returning id`;
  return { groupId: g!.id, valueId: v!.id };
}

/** One Drizzle transaction with the staff RLS principal of `orgId` (what a real request runs under); the SAME tx goes into the domain call. */
export async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/**
 * Runs `fn` and reports how it ended without throwing: `failed` is true for a throw OR for an `{ ok: false, reason }`
 * outcome (house style has both: authorize() throws, some domain services return an outcome). A "x is not a function"
 * TypeError (an export that does not exist yet) is RETHROWN, never counted as a refusal: a refusal test must not go green
 * because the function is missing.
 */
export async function attempt<T>(fn: () => Promise<T>): Promise<{ failed: boolean; message: string; error?: unknown; value?: T }> {
  try {
    const value = await fn();
    const o = value as { ok?: boolean; reason?: string } | null | undefined;
    if (o && typeof o === 'object' && o.ok === false) return { failed: true, message: String(o.reason ?? ''), value };
    return { failed: false, message: '', value };
  } catch (error) {
    if (error instanceof TypeError && /is not a function|is not defined|undefined/.test(error.message)) throw error;
    return { failed: true, message: error instanceof Error ? error.message : String(error), error };
  }
}

export async function auditCount(orgId: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from audit_log where org_id = ${orgId}`;
  return r!.n;
}

/**
 * A refusal in a SENTENCE: the domain's own refusal (RefusalError, or AuthorizationError with a userMessage), never a raw Postgres error.
 * Fails on a PostgresError, on a SQLSTATE `code`, on constraint/trigger words in the text, and on an empty sentence.
 */
export function expectSentence(r: { failed: boolean; message: string; error?: unknown }, what: string): void {
  expect(r.failed, `${what}: was not refused`).toBe(true);
  const e = r.error as { name?: string; code?: unknown; userMessage?: unknown; message?: string; constructor?: { name?: string } } | undefined;
  expect(e?.constructor?.name, `${what}: a raw database error leaked (${r.message})`).not.toBe('PostgresError');
  expect(typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code as string), `${what}: a SQLSTATE leaked (${String(e?.code)}): ${r.message}`).toBe(false);
  expect(typeof e?.userMessage, `${what}: no userMessage - not a domain refusal (${r.message})`).toBe('string');
  const text = `${r.message} ${String(e?.userMessage ?? '')}`;
  expect(text, `${what}: database wording in the sentence`).not.toMatch(/violates|duplicate key|unique constraint|check constraint|trigger|menu_[a-z_]+_key|relation "/i);
  expect(String(e?.userMessage).trim().length, `${what}: empty sentence`).toBeGreaterThan(10);
}
