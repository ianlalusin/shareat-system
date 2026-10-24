import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-383 S1 - `docs/tasks/383-item-rename.md` S1, domain legs R1-R8 (rename). TESTER file.
 * Real Postgres, real `authorize()`, as APP_ROLE under an org principal. Each test names its
 * killing mutant and says why it is red on HEAD.
 *
 * Trap: postgres.js reports a transaction's FIRST error, so every refusal here asserts the
 * SPECIFIC constraint (`items_org_name_key`, ...), never "it threw".
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, itemsRepo, transaction, APP_ROLE, RefusalError, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import * as domain from '@shareat/domain';
import { createItem, createSupplier, recordInvoice, updateItem, verifyInvoice } from '@shareat/domain';

// `renameItem` does not exist at HEAD. Reading it off the namespace keeps every test red on its
// BEHAVIOUR leg (TypeError at call time) instead of the whole file failing at import.
const renameItem = (domain as unknown as {
  renameItem: (tx: Tx | null, actor: Actor, input: { itemId: string; name: string; code: string }) => Promise<{ changed: boolean }>;
}).renameItem;

// `setItemStatus` and `itemsRepo.retireReadout` do not exist at HEAD (T-383 S2a). Read off the namespaces so each test
// fails on its BEHAVIOUR (TypeError at call time), not the whole file at import.
const setItemStatus = (domain as unknown as {
  setItemStatus: (tx: Tx | null, actor: Actor, input: { itemId: string; status: 'active' | 'inactive' }) => Promise<{ changed: boolean }>;
}).setItemStatus;
type Readout = { onHand: { storeName: string; quantity: string }[]; activePosMaps: number; activeRecipes: number };
const retireReadout = (tx: Tx, orgId: string, itemId: string): Promise<Readout> =>
  (itemsRepo as unknown as { retireReadout: (tx: Tx, orgId: string, itemId: string) => Promise<Readout> }).retireReadout(tx, orgId, itemId);

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
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`t383s1-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
    return p!.id;
  };
  const superId = await mk('Super', 'super_admin');
  const adminId = await mk('Admin', 'admin');
  const managerId = await mk('Manager', 'manager');
  const staffId = await mk('Staff', 'staff');
  const supplier = await asOrg(orgId, (tx) => createSupplier(tx, actor(orgId, managerId), { name: `Supplier ${code}` }));
  return {
    orgId, storeId: store!.id, staffId, supplierId: supplier.id,
    superAdmin: actor(orgId, superId), admin: actor(orgId, adminId), manager: actor(orgId, managerId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function newNamed(f: Fixture, name: string, code: string, baseUnit: 'kg' | 'pcs' = 'kg'): Promise<string> {
  const { id } = await asOrg(f.orgId, (tx) =>
    createItem(tx, f.superAdmin, { code, name, kind: 'raw_material', baseUnit }),
  );
  return id;
}

/** History for an item: one verified supplier invoice line (the spec's `invoiceWithLines`). Returns the invoice id. */
async function giveHistory(f: Fixture, itemId: string): Promise<string> {
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${f.orgId}, ${f.storeId}, 'receipt_photo', ${`orgs/${f.orgId}/receipt_photo/${uid('f')}.jpg`},
            'image/jpeg', 1024, ${uid('sum')}, ${f.staffId})
    returning id`;
  const created = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.manager, {
      storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-10', totalAmount: '100.00',
      receiptFileId: file!.id,
      lines: [{ itemId, quantity: '1', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '100', lineTotal: '100.00' }],
    }),
  );
  await asOrg(f.orgId, (tx) =>
    verifyInvoice(tx, f.admin, created.id, { supplier: true, invoice: true, items: true, price: true }),
  );
  return created.id;
}

const itemRow = async (id: string) =>
  (await sql<{ name: string; code: string; status: string; base_unit: string }[]>`
    select name, code, status, base_unit from items where id = ${id}`)[0]!;
const auditRows = (itemId: string) =>
  sql<{ action: string; entity: string; entity_id: string; before: unknown; after: unknown; actor_person_id: string; source: string }[]>`
    select action, entity, entity_id, before, after, actor_person_id, source from audit_log
    where entity = 'items' and entity_id = ${itemId} and action = 'rename_item'`;

/** The Postgres error's constraint name, found anywhere on the cause chain. */
function constraintOf(err: unknown): string | undefined {
  for (let e: unknown = err, i = 0; e && i < 6; i++, e = (e as { cause?: unknown }).cause) {
    const c = (e as { constraint_name?: string }).constraint_name ?? (e as { constraint?: string }).constraint;
    if (c) return c;
  }
  return undefined;
}
async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to be refused');
}
const rename = (f: Fixture, who: Actor, itemId: string, name: string, code: string) =>
  asOrg(f.orgId, (tx) => renameItem(tx, who, { itemId, name, code }));

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('R - renameItem', () => {
  it(
    'R1: super-admin renames name and code: row has both, {changed:true}, exactly one audit row with before/after, actor, source web. Killing mutants: drop the append; swap before and after. Red today: renameItem is not a function',
    async () => {
      const f = await fixture('r1');
      const id = await newNamed(f, 'Coke 1.5', 'CK15-001');
      const res = await rename(f, f.superAdmin, id, 'Coke 1.5 (old)', 'CK1O-001');
      expect(res).toEqual({ changed: true });
      expect(await itemRow(id)).toMatchObject({ name: 'Coke 1.5 (old)', code: 'CK1O-001' });
      const rows = await auditRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'rename_item', entity: 'items', entity_id: id,
        before: { name: 'Coke 1.5', code: 'CK15-001' }, after: { name: 'Coke 1.5 (old)', code: 'CK1O-001' },
        actor_person_id: f.superAdmin.personId, source: 'web',
      });
    },
    30_000,
  );

  it.each(['admin', 'manager'] as const)(
    'R2: %s -> AuthorizationError, row unchanged, no audit row. Killing mutant: authorize(..., "manage_items") (admin and manager would pass). Red today: TypeError, not AuthorizationError',
    async (who) => {
      const f = await fixture(`r2${who}`);
      const id = await newNamed(f, 'Coke 1.5', 'CK15-001');
      const err = await failure(rename(f, f[who], id, 'Coke 1.5 (old)', 'CK1O-001'));
      expect(err).toBeInstanceOf(AuthorizationError);
      expect(await itemRow(id)).toMatchObject({ name: 'Coke 1.5', code: 'CK15-001' });
      expect(await auditRows(id)).toHaveLength(0);
    },
    30_000,
  );

  it(
    'R3 (row 287, the point of the task): a kg item with an invoice line holds its name; rename it, then the replacement in pcs under the old name and code is accepted, the old item stays kg and its invoice line still points at it. Control leg: before the rename the same createItem is refused by items_org_name_key. Red today: control leg passes, renameItem is not a function',
    async () => {
      const f = await fixture('r3');
      const oldId = await newNamed(f, 'Coke 1.5', 'CK15-001', 'kg');
      const invoiceId = await giveHistory(f, oldId);
      const control = await failure(
        asOrg(f.orgId, (tx) =>
          createItem(tx, f.superAdmin, { code: 'CK15-002', name: 'coke 1.5', kind: 'raw_material', baseUnit: 'pcs' }),
        ),
      );
      // T-443 R5: the approval-time guard now speaks first (a RefusalError naming the item); `items_org_name_key` stays the backstop.
      expect(control).toBeInstanceOf(RefusalError);
      expect((control as RefusalError).userMessage).toMatch(/already exists/);

      await rename(f, f.superAdmin, oldId, 'Coke 1.5 (old)', 'CK1O-001');
      const replacement = await asOrg(f.orgId, (tx) =>
        createItem(tx, f.superAdmin, { code: 'CK15-002', name: 'Coke 1.5', kind: 'raw_material', baseUnit: 'pcs' }),
      );
      expect(replacement.id).not.toBe(oldId);
      expect(await itemRow(replacement.id)).toMatchObject({ name: 'Coke 1.5', code: 'CK15-002', base_unit: 'pcs' });
      expect((await itemRow(oldId)).base_unit).toBe('kg');
      const lines = await sql<{ item_id: string; purchase_unit: string }[]>`
        select item_id, purchase_unit from supplier_invoice_lines where supplier_invoice_id = ${invoiceId}`;
      expect(lines).toEqual([{ item_id: oldId, purchase_unit: 'kg' }]);
    },
    60_000,
  );

  it(
    "R4: rename to another item's name (different case) -> items_org_name_key; to another item's code -> items_org_code_key; row unchanged, no audit. Killing mutant: swallow the error and report changed. Red today: TypeError, no constraint",
    async () => {
      const f = await fixture('r4');
      await newNamed(f, 'Pepsi 1.5', 'PEPS-001');
      const id = await newNamed(f, 'Coke 1.5', 'CK15-001');
      const byName = await failure(rename(f, f.superAdmin, id, 'PEPSI 1.5', 'CK15-001'));
      expect(constraintOf(byName)).toBe('items_org_name_key');
      const byCode = await failure(rename(f, f.superAdmin, id, 'Coke 1.5', 'PEPS-001'));
      // T-386 S3: the domain's high-water-mark check speaks before the unique index: the 'cannot be used' sentence, never the constraint.
      expect((byCode as { userMessage?: string }).userMessage).toMatch(/^PEPS-001 cannot be used: /);
      expect(await itemRow(id)).toMatchObject({ name: 'Coke 1.5', code: 'CK15-001' });
      expect(await auditRows(id)).toHaveLength(0);
    },
    30_000,
  );

  it(
    'R5: blank name -> items_name_not_blank_check, blank code -> items_code_not_blank_check; unchanged, no audit. (The two sentences are asserted in the web file, W2b.) Killing mutant: name || item.name (a silent no-op, no refusal). Red today: TypeError',
    async () => {
      const f = await fixture('r5');
      const id = await newNamed(f, 'Coke 1.5', 'CK15-001');
      const blankName = await failure(rename(f, f.superAdmin, id, '   ', 'CK15-001'));
      expect(constraintOf(blankName)).toBe('items_name_not_blank_check');
      const blankCode = await failure(rename(f, f.superAdmin, id, 'Coke 1.5', ''));
      expect(constraintOf(blankCode)).toBe('items_code_not_blank_check');
      expect(await itemRow(id)).toMatchObject({ name: 'Coke 1.5', code: 'CK15-001' });
      expect(await auditRows(id)).toHaveLength(0);
    },
    30_000,
  );

  it(
    'R6: same name and code -> {changed:false}, no audit row. Killing mutant: append unconditionally. Red today: TypeError',
    async () => {
      const f = await fixture('r6');
      const id = await newNamed(f, 'Coke 1.5', 'CK15-001');
      expect(await rename(f, f.superAdmin, id, 'Coke 1.5', 'CK15-001')).toEqual({ changed: false });
      expect(await auditRows(id)).toHaveLength(0);
    },
    30_000,
  );

  it(
    'R6b: case-only change "coke 1.5" -> "Coke 1.5" is a real change: {changed:true}, one audit row, no clash with the row itself. Killing mutant: compare lower-cased (reports unchanged). Red today: TypeError',
    async () => {
      const f = await fixture('r6b');
      const id = await newNamed(f, 'coke 1.5', 'CK15-001');
      expect(await rename(f, f.superAdmin, id, 'Coke 1.5', 'CK15-001')).toEqual({ changed: true });
      expect((await itemRow(id)).name).toBe('Coke 1.5');
      expect(await auditRows(id)).toHaveLength(1);
    },
    30_000,
  );

  it(
    'R6c: name and code are trimmed before they are compared and written. Killing mutant: no trim (stores padded text, reports changed). Red today: TypeError',
    async () => {
      const f = await fixture('r6c');
      const id = await newNamed(f, 'Coke 1.5', 'CK15-001');
      expect(await rename(f, f.superAdmin, id, '  Coke 1.5  ', ' CK15-001 ')).toEqual({ changed: false });
      expect(await rename(f, f.superAdmin, id, '  Coke 2  ', ' CK2X-001 ')).toEqual({ changed: true });
      expect(await itemRow(id)).toMatchObject({ name: 'Coke 2', code: 'CK2X-001' });
    },
    30_000,
  );

  it.each(['name', 'code'] as const)(
    'R7: updateItem no longer accepts %s: refused with the pointer sentence, row unchanged. Killing mutant: updateItem passes name/code through. Red today: updateItem silently rewrites the row (promise resolves, "expected the call to be refused")',
    async (key) => {
      const f = await fixture(`r7${key}`);
      const id = await newNamed(f, 'Coke 1.5', 'CK15-001');
      const err = await failure(asOrg(f.orgId, (tx) => updateItem(tx, f.manager, id, { [key]: 'x' } as never)));
      expect(String((err as Error).message)).toContain("Rename an item with Rename on the item's page.");
      expect(await itemRow(id)).toMatchObject({ name: 'Coke 1.5', code: 'CK15-001' });
    },
    30_000,
  );

  it(
    'R7 (control): the flags edit through updateItem still works for a manager. Green today and after',
    async () => {
      const f = await fixture('r7c');
      const id = await newNamed(f, 'Coke 1.5', 'CK15-001');
      await asOrg(f.orgId, (tx) => updateItem(tx, f.manager, id, { sellableRetail: true }));
      const [row] = await sql<{ sellable_retail: boolean }[]>`select sellable_retail from items where id = ${id}`;
      expect(row!.sellable_retail).toBe(true);
    },
    30_000,
  );

  it(
    'R8: renaming an inactive item leaves it inactive (v1 reactivation bug); a merged item may be renamed and stays merged. Killing mutant: the rename writes status "active". Red today: TypeError',
    async () => {
      const f = await fixture('r8');
      const id = await newNamed(f, 'Coke 1.5', 'CK15-001');
      await sql`update items set status = 'inactive' where id = ${id}`;
      expect(await rename(f, f.superAdmin, id, 'Coke 1.5 (old)', 'CK1O-001')).toEqual({ changed: true });
      expect((await itemRow(id)).status).toBe('inactive');

      const target = await newNamed(f, 'Target', 'TGTX-001');
      const mergedId = await newNamed(f, 'Merged one', 'MRGX-001');
      await sql`update items set status = 'merged', merged_into_id = ${target} where id = ${mergedId}`;
      expect(await rename(f, f.superAdmin, mergedId, 'Merged one (x)', 'MRGY-001')).toEqual({ changed: true });
      expect(await itemRow(mergedId)).toMatchObject({ status: 'merged', name: 'Merged one (x)' });
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------------------------------------------
// T-383 S2a (Amendment B2.4): retire, restore, readout. TESTER additions. Each names its killing mutant and why it
// is red on HEAD (setItemStatus / itemsRepo.retireReadout / the removal of deactivateItem do not exist yet).
// ---------------------------------------------------------------------------------------------------------------
const MERGED_SENTENCE = 'This item was merged into another, so it cannot be retired or restored.';
const statusAudit = (itemId: string) =>
  sql<{ action: string; entity: string; entity_id: string; before: unknown; after: unknown; actor_person_id: string; source: string }[]>`
    select action, entity, entity_id, before, after, actor_person_id, source from audit_log
    where entity = 'items' and entity_id = ${itemId} and action in ('retire_item', 'restore_item') order by occurred_at, id`;
const setStatus = (f: Fixture, who: Actor, itemId: string, status: 'active' | 'inactive') =>
  asOrg(f.orgId, (tx) => setItemStatus(tx, who, { itemId, status }));

/** A stock room for a store (stock_movements needs a location). */
async function roomFor(orgId: string, storeId: string, personId: string): Promise<string> {
  const [t] = await sql<{ id: string }[]>`
    insert into location_types (org_id, code, name) values (${orgId}, ${uid('lt')}, 'Stockroom') returning id`;
  const [l] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${orgId}, ${storeId}, ${uid('loc')}, 'Kitchen', ${t!.id}, 'operating', true, ${personId}) returning id`;
  return l!.id;
}
async function addStore(orgId: string, name: string): Promise<string> {
  const [s] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, ${name}) returning id`;
  return s!.id;
}
// DEF-491 (0213/0214): the database refuses a row whose item is another org's. S6 plants exactly such
// foreign rows to prove retireReadout's own org filters, so those plants run with FKs and triggers
// skipped (session_replication_role = replica); every other call keeps the plain connection.
let db: postgres.Sql | postgres.TransactionSql = sql;
async function plantForeign(fn: () => Promise<void>): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    db = tx;
    try {
      await fn();
    } finally {
      db = sql;
    }
  });
}
async function moveStock(orgId: string, storeId: string, locationId: string, itemId: string, qty: string, by: string) {
  await db`
    insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
    values (${orgId}, ${storeId}, ${locationId}, ${itemId}, now(), ${qty}, 'receipt', 'test', ${crypto.randomUUID()}, ${by})`;
}
async function posMap(orgId: string, storeId: string, itemId: string, status: 'active' | 'inactive', by: string) {
  await db`
    insert into pos_item_maps (org_id, store_id, pos_item_key, pos_item_name, mode, item_id, quantity_per_sale, status, created_by)
    values (${orgId}, ${storeId}, ${uid('pk')}, 'POS thing', 'direct', ${itemId}, 1, ${status}, ${by})`;
}
async function recipe(orgId: string, outputItemId: string, lineItemIds: string[], status: 'active' | 'inactive', by: string) {
  const [r] = await db<{ id: string }[]>`
    insert into production_recipes (org_id, name, output_item_id, output_quantity, status, created_by)
    values (${orgId}, ${uid('recipe')}, ${outputItemId}, 1, ${status}, ${by}) returning id`;
  for (const [i, it] of lineItemIds.entries()) {
    await db`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${r!.id}, ${it}, 1, ${i % 2 ? 'g' : 'kg'})`;
  }
}

describe('S - setItemStatus (retire / restore)', () => {
  it(
    'S1: super-admin retires an active item WITH history: status inactive, {changed:true}, exactly one retire_item audit row (before {status:active}, after {status:inactive}, actor, source web), and listItems(includeInactive:false) omits it while the row and its invoice line stay. Killing mutants: drop the append; swap before/after; write nothing. Red today: setItemStatus is not a function',
    async () => {
      const f = await fixture('s1');
      const id = await newNamed(f, 'Coke 1.5', 'CK15-001');
      const invoiceId = await giveHistory(f, id);
      const res = await setStatus(f, f.superAdmin, id, 'inactive');
      expect(res).toEqual({ changed: true });
      expect((await itemRow(id)).status).toBe('inactive');
      const rows = await statusAudit(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'retire_item', entity: 'items', entity_id: id,
        before: { status: 'active' }, after: { status: 'inactive' },
        actor_person_id: f.superAdmin.personId, source: 'web',
      });
      const listed = await asOrg(f.orgId, (tx) => itemsRepo.listItems(tx, f.orgId, { includeInactive: false }));
      expect(listed.map((i) => i.id)).not.toContain(id);
      const all = await asOrg(f.orgId, (tx) => itemsRepo.listItems(tx, f.orgId, { includeInactive: true }));
      expect(all.map((i) => i.id)).toContain(id);
      const lines = await sql<{ item_id: string }[]>`select item_id from supplier_invoice_lines where supplier_invoice_id = ${invoiceId}`;
      expect(lines).toEqual([{ item_id: id }]);
    },
    60_000,
  );

  it(
    'S2: restore returns it to active with a restore_item row (before inactive, after active); retire then restore leaves two rows with different actions. Killing mutant: one action name for both directions. Red today: setItemStatus is not a function',
    async () => {
      const f = await fixture('s2');
      const id = await newNamed(f, 'Coke 1.5', 'CK15-001');
      await setStatus(f, f.superAdmin, id, 'inactive');
      expect(await setStatus(f, f.superAdmin, id, 'active')).toEqual({ changed: true });
      expect((await itemRow(id)).status).toBe('active');
      const rows = await statusAudit(id);
      expect(rows.map((r) => r.action)).toEqual(['retire_item', 'restore_item']);
      expect(rows[1]).toMatchObject({ before: { status: 'inactive' }, after: { status: 'active' }, source: 'web' });
    },
    30_000,
  );

  it.each([
    ['admin', 'active', 'inactive'],
    ['manager', 'active', 'inactive'],
    ['admin', 'inactive', 'active'],
    ['manager', 'inactive', 'active'],
  ] as const)(
    'S3: %s asking to move an item from %s to %s -> AuthorizationError, status unchanged, no audit row. Killing mutant: authorize(..., "manage_items") (managers pass). Red today: TypeError, not AuthorizationError',
    async (who, from, to) => {
      const f = await fixture(`s3${who}${to}`);
      const id = await newNamed(f, 'Coke 1.5', 'CK15-001');
      if (from === 'inactive') await sql`update items set status = 'inactive' where id = ${id}`;
      const err = await failure(setStatus(f, f[who], id, to));
      expect(err).toBeInstanceOf(AuthorizationError);
      expect((await itemRow(id)).status).toBe(from);
      expect(await statusAudit(id)).toHaveLength(0);
    },
    30_000,
  );

  it.each(['inactive', 'active'] as const)(
    'S4: a merged item asked to become %s -> refused with the merged sentence (not the DB constraint text), still merged, no audit row. Killing mutant: drop the domain check (items_merged_shape_check fires with another message). Red today: TypeError, no sentence',
    async (to) => {
      const f = await fixture(`s4${to}`);
      const target = await newNamed(f, 'Target', 'TGTX-001');
      const mergedId = await newNamed(f, 'Merged one', 'MRGX-001');
      await sql`update items set status = 'merged', merged_into_id = ${target} where id = ${mergedId}`;
      const err = await failure(setStatus(f, f.superAdmin, mergedId, to));
      expect((err as { userMessage?: string }).userMessage).toBe(MERGED_SENTENCE);
      expect((await itemRow(mergedId)).status).toBe('merged');
      expect(await statusAudit(mergedId)).toHaveLength(0);
    },
    30_000,
  );

  it(
    'S5: restoring an already-active item and retiring an already-inactive one -> {changed:false}, no audit row, status untouched. Killing mutant: append unconditionally. Red today: TypeError',
    async () => {
      const f = await fixture('s5');
      const id = await newNamed(f, 'Coke 1.5', 'CK15-001');
      expect(await setStatus(f, f.superAdmin, id, 'active')).toEqual({ changed: false });
      await sql`update items set status = 'inactive' where id = ${id}`;
      expect(await setStatus(f, f.superAdmin, id, 'inactive')).toEqual({ changed: false });
      expect((await itemRow(id)).status).toBe('inactive');
      expect(await statusAudit(id)).toHaveLength(0);
    },
    30_000,
  );

  it(
    'S5b: retire is NOT gated on stock, maps or recipes (R3): an item with stock, a live POS map and a live recipe retires. Killing mutant: a refusal when the readout is non-empty. Red today: TypeError',
    async () => {
      const f = await fixture('s5b');
      const id = await newNamed(f, 'Coke 1.5', 'CK15-001');
      const other = await newNamed(f, 'Other', 'OTHR-001');
      const loc = await roomFor(f.orgId, f.storeId, f.staffId);
      await moveStock(f.orgId, f.storeId, loc, id, '5', f.staffId);
      await posMap(f.orgId, f.storeId, id, 'active', f.staffId);
      await recipe(f.orgId, other, [id], 'active', f.staffId);
      expect(await setStatus(f, f.superAdmin, id, 'inactive')).toEqual({ changed: true });
      expect((await itemRow(id)).status).toBe('inactive');
    },
    30_000,
  );

  it('S7: deactivateItem is gone from the domain (replaced by setItemStatus). Killing mutant: leave deactivateItem exported. Red today: it is still exported and setItemStatus is missing', () => {
    expect('deactivateItem' in domain).toBe(false);
    expect(typeof setItemStatus).toBe('function');
  });
});

describe('S6 - itemsRepo.retireReadout', () => {
  it(
    'S6: item with +5 at store A, +3 then -3 at store B (net zero), one active and one inactive POS map, an active recipe using it on two lines, an inactive recipe using it, and an active recipe that outputs it: onHand is only store A with "5.000", activePosMaps 1, activeRecipes 2 (DISTINCT: the two-line recipe counts once; the inactive one not). Another org\'s movement, map and recipe pointing at the same item are not counted. Killing mutants: drop HAVING <> 0 (store B appears); drop the map status filter (2); count(*) not DISTINCT (3); drop the recipe status filter (3); drop an org filter (red); drop the output leg (1). Red today: retireReadout is not a function',
    async () => {
      const f = await fixture('s6');
      const storeB = await addStore(f.orgId, 'Store Bravo');
      const locA = await roomFor(f.orgId, f.storeId, f.staffId);
      const locB = await roomFor(f.orgId, storeB, f.staffId);
      const id = await newNamed(f, 'Coke 1.5', 'CK15-001');
      const other = await newNamed(f, 'Other', 'OTHR-001');
      await moveStock(f.orgId, f.storeId, locA, id, '5', f.staffId);
      await moveStock(f.orgId, storeB, locB, id, '3', f.staffId);
      await moveStock(f.orgId, storeB, locB, id, '-3', f.staffId);
      await posMap(f.orgId, f.storeId, id, 'active', f.staffId);
      await posMap(f.orgId, f.storeId, id, 'inactive', f.staffId);
      await recipe(f.orgId, other, [id, id], 'active', f.staffId);
      await recipe(f.orgId, other, [id], 'inactive', f.staffId);
      await recipe(f.orgId, id, [other], 'active', f.staffId);

      // A second org whose rows point at this item (the FKs do not carry the org): they must not be counted.
      const g = await fixture('s6x');
      const gStore = await addStore(g.orgId, 'Store Foreign');
      const gLoc = await roomFor(g.orgId, gStore, g.staffId);
      const gOther = await newNamed(g, 'Other', 'OTHR-001');
      await plantForeign(async () => {
        await moveStock(g.orgId, gStore, gLoc, id, '7', g.staffId);
        await posMap(g.orgId, gStore, id, 'active', g.staffId);
        await recipe(g.orgId, gOther, [id], 'active', g.staffId);
      });

      // Sanity (green today): the foreign rows really are attached to this item, so the org filters are what is tested.
      const [seen] = await sql<{ n: string }[]>`select count(*)::text as n from stock_movements where item_id = ${id}`;
      expect(seen!.n).toBe('4');

      const out = await asOrg(f.orgId, (tx) => retireReadout(tx, f.orgId, id));
      expect(out.onHand).toEqual([{ storeName: 'Store s6', quantity: '5.000' }]);
      expect(Number(out.activePosMaps)).toBe(1);
      expect(Number(out.activeRecipes)).toBe(2);
    },
    60_000,
  );

  it(
    'S6b: an item nothing uses -> onHand [], 0 maps, 0 recipes (the page then draws no readout lines). Killing mutant: null counts. Red today: retireReadout is not a function',
    async () => {
      const f = await fixture('s6b');
      const id = await newNamed(f, 'Coke 1.5', 'CK15-001');
      const out = await asOrg(f.orgId, (tx) => retireReadout(tx, f.orgId, id));
      expect(out.onHand).toEqual([]);
      expect(Number(out.activePosMaps)).toBe(0);
      expect(Number(out.activeRecipes)).toBe(0);
    },
    30_000,
  );

  it(
    'S6c: onHand is ordered by store name and reads for an INACTIVE item too (the page shows the readout after the retire). Killing mutants: add a status = active filter; order by quantity. Red today: retireReadout is not a function',
    async () => {
      const f = await fixture('s6c');
      const storeA = await addStore(f.orgId, 'Alpha');
      const storeZ = await addStore(f.orgId, 'Zulu');
      const locA = await roomFor(f.orgId, storeA, f.staffId);
      const locZ = await roomFor(f.orgId, storeZ, f.staffId);
      const id = await newNamed(f, 'Coke 1.5', 'CK15-001');
      await moveStock(f.orgId, storeZ, locZ, id, '1', f.staffId);
      await moveStock(f.orgId, storeA, locA, id, '9', f.staffId);
      await sql`update items set status = 'inactive' where id = ${id}`;
      const out = await asOrg(f.orgId, (tx) => retireReadout(tx, f.orgId, id));
      expect(out.onHand).toEqual([
        { storeName: 'Alpha', quantity: '9.000' },
        { storeName: 'Zulu', quantity: '1.000' },
      ]);
    },
    30_000,
  );
});
