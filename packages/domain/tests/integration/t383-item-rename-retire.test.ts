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
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import * as domain from '@shareat/domain';
import { createItem, createSupplier, recordInvoice, updateItem, verifyInvoice } from '@shareat/domain';

// `renameItem` does not exist at HEAD. Reading it off the namespace keeps every test red on its
// BEHAVIOUR leg (TypeError at call time) instead of the whole file failing at import.
const renameItem = (domain as unknown as {
  renameItem: (tx: Tx | null, actor: Actor, input: { itemId: string; name: string; code: string }) => Promise<{ changed: boolean }>;
}).renameItem;

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
      expect(constraintOf(control)).toBe('items_org_name_key');

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
