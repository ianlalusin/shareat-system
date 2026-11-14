/**
 * T-502 S4 (TESTER, red until built) - /items/import admin CSV import. docs/tasks/502-expense-item-catalog.md section 4 S4 + section 11.
 * Real Postgres, any `*_test` database. CSV columns: item_name, kind, base_unit, expense_category, expense_subcategory, aliases (pipe-separated).
 *
 * Assumed API (builder may rename; tell the tester):
 *   previewItemImport(tx, actor, csvText) -> { rows: { line: number; name: string; status: Status; reason?: string }[]; counts: Record<Status, number>; canConfirm: boolean }
 *   confirmItemImport(tx, actor, csvText) -> { created: number; skipped: number; aliasesAdded: number }
 *   Status = 'new' | 'exists' | 'alias_clash' | 'category_not_found' | 'subcategory_not_found' | 'subcategory_required' | 'invalid' | 'duplicate_in_file'
 *   ITEM_IMPORT_MAX_ROWS (number), ITEM_IMPORT_MAX_BYTES (number) exported from @shareat/domain.
 * Rulings the tests ASSUME (orchestrator to confirm):
 *   P1 capability = approve_item_request (admin yes, manager no, staff no). createItem itself needs approve_item (super-admin), so the import
 *      inserts through the repo layer directly and does NOT call createItem's authorize; the code allocator (CHWN-001) still applies.
 *   P2 NO partial confirm: any row that is not new/exists blocks Confirm; confirm throws a plain refusal and writes nothing.
 *   P3 a row that matches an existing item (by name or other-name) is left entirely unchanged (its aliases/category in the file are ignored).
 *   P4 caps: more than ITEM_IMPORT_MAX_ROWS data rows, or csv text over ITEM_IMPORT_MAX_BYTES, is refused whole.
 *   P5 a category with active sub-categories needs one in the row (same rule as setItemExpenseCategory) -> 'subcategory_required'.
 *   P6 the same name twice in one file -> second row 'duplicate_in_file'; blocks Confirm.
 *   P7 a retired (inactive) category is "category_not_found". An item name starting = + - @ is 'invalid' (never stored).
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { AuthorizationError, type Actor } from '@shareat/auth';
import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import * as domain from '@shareat/domain';
import { ITEM_CODE_RE } from '@shareat/domain';

const d = domain as unknown as {
  previewItemImport: (tx: Tx, actor: Actor, csv: string) => Promise<{ rows: { line: number; name: string; status: string; reason?: string }[]; counts: Record<string, number>; canConfirm: boolean }>;
  confirmItemImport: (tx: Tx, actor: Actor, csv: string) => Promise<{ created: number; skipped: number; aliasesAdded: number }>;
  ITEM_IMPORT_MAX_ROWS: number;
  ITEM_IMPORT_MAX_BYTES: number;
};

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error('Refusing to run: database name must contain "_test".');
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

const HEADER = 'item_name,kind,base_unit,expense_category,expense_subcategory,aliases';

async function world(hint: string) {
  const c = uid(hint);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${c}`}, ${c}) returning id`;
  const orgId = o!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'Store') returning id`;
  const person = async (name: string, role: 'super_admin' | 'admin' | 'manager' | 'staff'): Promise<Actor> => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
    return { personId: p!.id, orgId };
  };
  const admin = await person('Admin', 'admin');
  const manager = await person('Manager', 'manager');
  const cashier = await person('Cashier', 'staff');
  const cat = async (name: string) =>
    (await sql<{ id: string }[]>`insert into expense_categories (org_id, "group", category) values (${orgId}, 'COGS', ${name}) returning id`)[0]!.id;
  const sub = async (categoryId: string, name: string) =>
    (await sql<{ id: string }[]>`insert into expense_subcategories (org_id, category_id, name, created_by) values (${orgId}, ${categoryId}, ${name}, ${admin.personId}) returning id`)[0]!.id;
  const meat = await cat('Meat');
  const supplies = await cat('Cleaning supplies'); // no sub-categories
  const utilities = await cat('Utilities');
  const pork = await sub(meat, 'Pork');
  await sub(meat, 'Beef');
  const itemSeed = async (name: string, kind = 'supply') => {
    const code = `${Math.floor(Math.random() * 36 ** 4).toString(36).toUpperCase().padStart(4, '0')}-001`;
    return (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by, expense_category_id)
      values (${orgId}, ${code}, ${name}, ${kind}, 'pcs', ${admin.personId}, ${supplies}) returning id`)[0]!.id;
  };
  const aliasSeed = (itemId: string, alias: string) =>
    sql`insert into item_aliases (org_id, item_id, alias, created_by) values (${orgId}, ${itemId}, ${alias}, ${admin.personId})`;
  return { orgId, admin, manager, cashier, meat, supplies, utilities, pork, itemSeed, aliasSeed };
}
type W = Awaited<ReturnType<typeof world>>;

const csv = (...rows: string[]) => [HEADER, ...rows].join('\r\n') + '\r\n';
const preview = (w: W, text: string, who: Actor = w.admin) => asOrg(w.orgId, (tx) => d.previewItemImport(tx, who, text));
const confirm = (w: W, text: string, who: Actor = w.admin) => asOrg(w.orgId, (tx) => d.confirmItemImport(tx, who, text));
const statusOf = (p: Awaited<ReturnType<typeof preview>>, name: string) => p.rows.find((r) => r.name === name)?.status;
const itemCount = async (w: W) => Number((await sql`select count(*)::int as n from items where org_id = ${w.orgId}`)[0]!.n);
const aliasCount = async (w: W) => Number((await sql`select count(*)::int as n from item_aliases where org_id = ${w.orgId}`)[0]!.n);
const auditCount = async (w: W) => Number((await sql`select count(*)::int as n from audit_log where org_id = ${w.orgId}`)[0]!.n);
const itemRow = async (w: W, name: string) =>
  (await sql<Record<string, unknown>[]>`select * from items where org_id = ${w.orgId} and lower(name) = lower(${name})`)[0];

describe('S4 preview - classifies every row, writes nothing', () => {
  it('new / exists (name) / exists (other-name) / alias clash / category not found / sub-category not found / invalid kind / invalid unit', async () => {
    const w = await world('pv-all');
    const have = await w.itemSeed('Dishwashing liquid');
    await w.aliasSeed(have, 'Joy');
    const other = await w.itemSeed('Sponge');
    await w.aliasSeed(other, 'Scouring pad');
    const p = await preview(w, csv(
      'Pork belly,supply,kg,Meat,Pork,',
      'dishwashing   LIQUID,supply,pcs,Cleaning supplies,,',
      'JOY,supply,pcs,Cleaning supplies,,',
      'Rag,supply,pcs,Cleaning supplies,,scouring PAD',
      'Mop,supply,pcs,Gadgets,,',
      'Chicken,supply,kg,Meat,Poultry,',
      'Soap,gizmo,pcs,Cleaning supplies,,',
      'Tissue,supply,bushel,Cleaning supplies,,',
    ));
    expect(statusOf(p, 'Pork belly')).toBe('new');
    expect(statusOf(p, 'dishwashing LIQUID')).toBe('exists');
    expect(statusOf(p, 'JOY')).toBe('exists');
    expect(statusOf(p, 'Rag')).toBe('alias_clash');
    expect(statusOf(p, 'Mop')).toBe('category_not_found');
    expect(statusOf(p, 'Chicken')).toBe('subcategory_not_found');
    expect(statusOf(p, 'Soap')).toBe('invalid');
    expect(statusOf(p, 'Tissue')).toBe('invalid');
    expect(p.counts).toMatchObject({ new: 1, exists: 2, alias_clash: 1, category_not_found: 1, subcategory_not_found: 1, invalid: 2 });
    expect(p.canConfirm).toBe(false);
    for (const r of p.rows.filter((r) => r.status !== 'new' && r.status !== 'exists')) expect(r.reason, r.name).toMatch(/\S{8,}/);
    expect(p.rows.find((r) => r.name === 'Mop')!.line).toBe(6); // line numbers count the header as line 1
  });

  it('a sub-category that exists but belongs to another category is "not found" (never guessed)', async () => {
    const w = await world('pv-wrongsub');
    const p = await preview(w, csv('Detergent,supply,pcs,Cleaning supplies,Pork,'));
    expect(statusOf(p, 'Detergent')).toBe('subcategory_not_found');
  });

  it('a category that offers sub-categories needs one in the row; blank is refused, a category without any may leave it blank', async () => {
    const w = await world('pv-subreq');
    const p = await preview(w, csv('Ribs,supply,kg,Meat,,', 'Bleach,supply,ltr,Cleaning supplies,,'));
    expect(statusOf(p, 'Ribs')).toBe('subcategory_required');
    expect(statusOf(p, 'Bleach')).toBe('new');
  });

  it('category and sub-category match ignoring case and spaces; an unknown category is refused, never guessed (no fuzzy match)', async () => {
    const w = await world('pv-fuzzy');
    const p = await preview(w, csv('Ham,supply,kg,  mEaT ,  pork,', 'Ham2,supply,kg,Meats,Pork,', 'Ham3,supply,kg,Mea,Pork,'));
    expect(statusOf(p, 'Ham')).toBe('new');
    expect(statusOf(p, 'Ham2')).toBe('category_not_found');
    expect(statusOf(p, 'Ham3')).toBe('category_not_found');
  });

  it('a purchasable item with a blank category is refused (a category is required for what you buy)', async () => {
    const w = await world('pv-nocat');
    const p = await preview(w, csv('Nameless thing,supply,pcs,,,'));
    expect(statusOf(p, 'Nameless thing')).toBe('category_not_found');
  });

  it('the same name twice in one file (any case/spacing) -> second row is duplicate_in_file', async () => {
    const w = await world('pv-dupfile');
    const p = await preview(w, csv('Foil,supply,roll,Cleaning supplies,,', ' foil ,supply,roll,Cleaning supplies,,'));
    expect(p.rows.map((r) => r.status)).toEqual(['new', 'duplicate_in_file']);
    expect(p.canConfirm).toBe(false);
  });

  it('an alias used by two rows of the same file, or equal to another row name, is an alias_clash', async () => {
    const w = await world('pv-aliasfile');
    const p = await preview(w, csv('Foil,supply,roll,Cleaning supplies,,Aluminium|Silver', 'Wrap,supply,roll,Cleaning supplies,,silver', 'Cling,supply,roll,Cleaning supplies,,Foil'));
    expect(statusOf(p, 'Foil')).toBe('new');
    expect(statusOf(p, 'Wrap')).toBe('alias_clash');
    expect(statusOf(p, 'Cling')).toBe('alias_clash');
  });

  it('service shape: pcs, purchasable, never sellable is new; a service in kg is invalid', async () => {
    const w = await world('pv-svc');
    const p = await preview(w, csv('Electricity,service,pcs,Utilities,,Meralco', 'Water,service,kg,Utilities,,'));
    expect(statusOf(p, 'Electricity')).toBe('new');
    expect(statusOf(p, 'Water')).toBe('invalid');
  });

  it('preview creates NOTHING: no items, no aliases, no audit rows', async () => {
    const w = await world('pv-nothing');
    const before = [await itemCount(w), await aliasCount(w), await auditCount(w)];
    await preview(w, csv('Pork belly,supply,kg,Meat,Pork,Liempo|Pork liempo'));
    expect([await itemCount(w), await aliasCount(w), await auditCount(w)]).toEqual(before);
  });

  it('handles a UTF-8 BOM, CRLF and LF line endings, quoted cells with commas, and blank trailing lines', async () => {
    const w = await world('pv-format');
    const text = `﻿${HEADER}\r\n"Pork, belly",supply,kg,Meat,Pork,"Liempo|Pork, liempo"\n"Foil",supply,roll,Cleaning supplies,,\r\n\r\n`;
    const p = await preview(w, text);
    expect(p.rows).toHaveLength(2);
    expect(statusOf(p, 'Pork, belly')).toBe('new');
    expect(statusOf(p, 'Foil')).toBe('new');
    expect(p.canConfirm).toBe(true);
  });

  it('a file with a missing or misspelled header column is refused whole with a plain sentence naming the column', async () => {
    const w = await world('pv-header');
    await expect(preview(w, 'item_name,kind,base_unit,expense_category,aliases\r\nFoil,supply,roll,Cleaning supplies,\r\n')).rejects.toThrow(/expense_subcategory/);
    await expect(preview(w, '')).rejects.toThrow(/file is empty/);
  });

  it('caps: more rows than ITEM_IMPORT_MAX_ROWS, or text over ITEM_IMPORT_MAX_BYTES, is refused whole', async () => {
    const w = await world('pv-cap');
    expect(d.ITEM_IMPORT_MAX_ROWS).toBeGreaterThanOrEqual(258); // Ian's draft list must fit
    expect(d.ITEM_IMPORT_MAX_ROWS).toBeLessThanOrEqual(5000);
    expect(d.ITEM_IMPORT_MAX_BYTES).toBeGreaterThan(20_000);
    const rows = Array.from({ length: d.ITEM_IMPORT_MAX_ROWS + 1 }, (_, i) => `Thing ${i},supply,pcs,Cleaning supplies,,`);
    await expect(preview(w, csv(...rows))).rejects.toThrow(/\d+/);
    const fat = csv(`Big,supply,pcs,Cleaning supplies,,${'x'.repeat(d.ITEM_IMPORT_MAX_BYTES)}`);
    await expect(preview(w, fat)).rejects.toThrow(/larger than 1 MiB/);
    expect(await itemCount(w)).toBe(0);
  });
});

describe('S4 confirm - one transaction, re-validated, audited, idempotent', () => {
  it('creates items + aliases + category + sub-category; codes follow the allocator; service shape is set', async () => {
    const w = await world('cf-ok');
    const r = await confirm(w, csv(
      'Pork belly,meat_sliced,kg,Meat,Pork,Liempo|Pork liempo',
      'Dishwashing liquid,supply,ltr,Cleaning supplies,,Joy',
      'Electricity,service,pcs,Utilities,,Meralco',
    ));
    expect(r).toMatchObject({ created: 3, skipped: 0, aliasesAdded: 4 });
    const pb = await itemRow(w, 'Pork belly');
    expect(pb).toMatchObject({ kind: 'meat_sliced', base_unit: 'kg', expense_category_id: w.meat, expense_subcategory_id: w.pork, created_by: w.admin.personId });
    expect(String(pb!.code)).toMatch(ITEM_CODE_RE);
    expect(String((await itemRow(w, 'Dishwashing liquid'))!.code)).toMatch(ITEM_CODE_RE);
    expect(await itemRow(w, 'Electricity')).toMatchObject({ kind: 'service', base_unit: 'pcs', is_purchasable: true, sellable_retail: false, sellable_wholesale: false });
    const aliases = await sql<{ alias: string }[]>`select alias from item_aliases where org_id = ${w.orgId} order by alias`;
    expect(aliases.map((a) => a.alias)).toEqual(['Joy', 'Liempo', 'Meralco', 'Pork liempo']);
  });

  it('is audited as the confirming admin: audit rows for each created item and alias, actor = the admin', async () => {
    const w = await world('cf-audit');
    const before = await auditCount(w);
    await confirm(w, csv('Pork belly,supply,kg,Meat,Pork,Liempo', 'Foil,supply,roll,Cleaning supplies,,'));
    const rows = await sql<{ actor_person_id: string; action: string }[]>`select actor_person_id, action from audit_log where org_id = ${w.orgId}`;
    expect(rows.length - before).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.actor_person_id === w.admin.personId)).toBe(true);
    expect(rows.some((r) => /item/.test(r.action))).toBe(true);
  });

  it('IDEMPOTENT: confirming the same file again creates nothing (counts, aliases and audit rows unchanged)', async () => {
    const w = await world('cf-idem');
    const file = csv('Pork belly,supply,kg,Meat,Pork,Liempo', 'Foil,supply,roll,Cleaning supplies,,Aluminium');
    await confirm(w, file);
    const snap = [await itemCount(w), await aliasCount(w), await auditCount(w)];
    const again = await confirm(w, file);
    expect(again).toMatchObject({ created: 0, skipped: 2, aliasesAdded: 0 });
    expect([await itemCount(w), await aliasCount(w), await auditCount(w)]).toEqual(snap);
    const p = await preview(w, file);
    expect(p.rows.every((r) => r.status === 'exists')).toBe(true);
    expect(p.canConfirm).toBe(true);
  });

  it('a file that is half existing, half new only creates the new ones, and leaves the matched item unchanged (P3)', async () => {
    const w = await world('cf-mixed');
    const have = await w.itemSeed('Foil');
    const r = await confirm(w, csv('Foil,supply,roll,Meat,Pork,NewAlias', 'Rag,supply,pcs,Cleaning supplies,,'));
    expect(r).toMatchObject({ created: 1, skipped: 1 });
    expect(await itemRow(w, 'Foil')).toMatchObject({ id: have, kind: 'supply', base_unit: 'pcs', expense_category_id: w.supplies });
    expect(await aliasCount(w)).toBe(0);
  });

  it('NO PARTIAL CONFIRM (P2): one bad row refuses the whole file, plainly, and nothing is created', async () => {
    const w = await world('cf-nopartial');
    const before = [await itemCount(w), await aliasCount(w), await auditCount(w)];
    for (const bad of ['Mop,supply,pcs,Gadgets,,', 'Soap,gizmo,pcs,Cleaning supplies,,', 'Ribs,supply,kg,Meat,,', 'Chicken,supply,kg,Meat,Poultry,']) {
      await expect(confirm(w, csv('Foil,supply,roll,Cleaning supplies,,Aluminium', bad))).rejects.toThrow(/\S{10,}/);
    }
    expect([await itemCount(w), await aliasCount(w), await auditCount(w)]).toEqual(before);
  });

  it('confirm RE-VALIDATES: it never trusts an earlier preview (state changed in between)', async () => {
    const w = await world('cf-revalidate');
    const file = csv('Foil,supply,roll,Cleaning supplies,,Aluminium');
    expect((await preview(w, file)).canConfirm).toBe(true);
    const other = await w.itemSeed('Wrap');
    await w.aliasSeed(other, 'Aluminium'); // someone adds the alias after the preview
    await expect(confirm(w, file)).rejects.toThrow(/Aluminium/);
    expect(await itemCount(w)).toBe(1);
  });

  it('all-or-nothing: a retired category on the 3rd row refuses the file and the first two are not created', async () => {
    const w = await world('cf-atomic');
    const before = await itemCount(w);
    await sql`update expense_categories set is_active = false where id = ${w.utilities}`;
    await expect(confirm(w, csv('Foil,supply,roll,Cleaning supplies,,', 'Rag,supply,pcs,Cleaning supplies,,', 'Electricity,service,pcs,Utilities,,'))).rejects.toThrow(/Nothing was imported.*Utilities/);
    expect(await itemCount(w)).toBe(before);
  });

  it('a retired (inactive) existing item still counts as "exists" (the name is taken); no duplicate is made', async () => {
    const w = await world('cf-inactive');
    const id = await w.itemSeed('Old foil');
    await sql`update items set status = 'inactive' where id = ${id}`;
    const p = await preview(w, csv('Old foil,supply,roll,Cleaning supplies,,'));
    expect(statusOf(p, 'Old foil')).toBe('exists');
    await confirm(w, csv('Old foil,supply,roll,Cleaning supplies,,'));
    expect(await itemCount(w)).toBe(1);
  });

  it('org isolation: an item with the same name in ANOTHER org does not make a row "exists"', async () => {
    const a = await world('cf-orga');
    const b = await world('cf-orgb');
    await b.itemSeed('Foil');
    expect(statusOf(await preview(a, csv('Foil,supply,roll,Cleaning supplies,,')), 'Foil')).toBe('new');
  });

  it('names are stored trimmed with inner spaces collapsed; a leading = + - @ in an item name is refused as invalid, never stored (P7)', async () => {
    const w = await world('cf-formula');
    const p = await preview(w, csv('=SUM(A1:A9),supply,pcs,Cleaning supplies,,', '@cmd,supply,pcs,Cleaning supplies,,', '+1 foil,supply,pcs,Cleaning supplies,,', 'Pork   belly,supply,kg,Meat,Pork,'));
    expect(p.rows.filter((r) => r.status === 'invalid').map((r) => r.name)).toEqual(['=SUM(A1:A9)', '@cmd', '+1 foil']);
    await expect(confirm(w, csv('=SUM(A1:A9),supply,pcs,Cleaning supplies,,'))).rejects.toThrow(/Nothing was imported.*cannot start with/);
    await confirm(w, csv('Pork   belly,supply,kg,Meat,Pork,'));
    expect(await itemRow(w, 'Pork belly')).toBeTruthy();
  });
});

describe('S4 who may import (approve_item_request): admin yes, manager no, cashier no', () => {
  it('admin may preview and confirm', async () => {
    const w = await world('who-admin');
    await expect(preview(w, csv('Foil,supply,roll,Cleaning supplies,,'))).resolves.toBeTruthy();
    await expect(confirm(w, csv('Foil,supply,roll,Cleaning supplies,,'))).resolves.toMatchObject({ created: 1 });
  });
  for (const [label, pick] of [['manager', (w: W) => w.manager], ['cashier (staff)', (w: W) => w.cashier]] as const) {
    it(`${label}: preview AND confirm are refused with AuthorizationError and nothing is written`, async () => {
      const w = await world(`who-${label[0]}`);
      const file = csv('Foil,supply,roll,Cleaning supplies,,Aluminium');
      await expect(preview(w, file, pick(w))).rejects.toBeInstanceOf(AuthorizationError);
      await expect(confirm(w, file, pick(w))).rejects.toBeInstanceOf(AuthorizationError);
      expect([await itemCount(w), await aliasCount(w)]).toEqual([0, 0]);
    });
  }
  it('a manager in an org with NO admin is still refused (approve_item_request has no adminless fallback)', async () => {
    const w = await world('who-adminless');
    await sql`delete from person_roles where person_id = ${w.admin.personId}`;
    await expect(confirm(w, csv('Foil,supply,roll,Cleaning supplies,,'), w.manager)).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('S4 confirm - two admins at once', () => {
  it('the second confirm waits, then finds the items already there: no raw DB error', async () => {
    const w = await world('race');
    const file = csv('Race foil,supply,roll,Cleaning supplies,,', 'Race bag,supply,pcs,Cleaning supplies,,');
    const settled = await Promise.allSettled([confirm(w, file), confirm(w, file)]);
    expect(settled.every((r) => r.status === 'fulfilled')).toBe(true);
    const results = settled.map((r) => (r as PromiseFulfilledResult<{ created: number; skipped: number; aliasesAdded: number }>).value);
    expect(results.map((r) => r.created).sort()).toEqual([0, 2]);
    expect(results.find((r) => r.created === 0)!.skipped).toBe(2);
    expect(await itemCount(w)).toBe(2);
  });
});
