import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-378 S3 (DEF-598, DEF-599) - `docs/tasks/378-item-unit-editable.md` S3, domain legs
 * D1-D5, F1-F4, A1-A3. TESTER file. Real Postgres, real `authorize()`, as APP_ROLE under an org
 * principal. Each test names its killing mutant and says why it is red on HEAD.
 *
 * Trap: postgres.js reports a transaction's FIRST error, so every refusal here asserts the
 * SPECIFIC constraint (`items_base_unit_fixed`, `items_base_unit_check`), never "it threw".
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
import {
  approveItemRequest,
  changeItemBaseUnit,
  createItem,
  createSupplier,
  recordInvoice,
  requestItem,
  updateItem,
  verifyInvoice,
} from '@shareat/domain';
import { testItemCode } from './_fixtures/item-code';

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
  const code = uid(`t378s3-${hint}`);
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

async function newItem(f: Fixture, baseUnit: 'kg' | 'pcs' | 'ltr' = 'kg'): Promise<string> {
  const { id } = await asOrg(f.orgId, (tx) =>
    createItem(tx, f.superAdmin, { code: testItemCode(), name: `Item ${uid('n')}`, kind: 'raw_material', baseUnit }),
  );
  return id;
}

/** History for an item: one verified supplier invoice line (the spec's `invoiceWithLines`). */
async function giveHistory(f: Fixture, itemId: string): Promise<void> {
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${f.orgId}, ${f.storeId}, 'receipt_photo', ${`orgs/${f.orgId}/receipt_photo/${uid('f')}.jpg`},
            'image/jpeg', 1024, ${uid('sum')}, ${f.staffId})
    returning id`;
  const recorder = f.manager; // staff lacks record_supplier_invoice
  const created = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, recorder, {
      storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-10', totalAmount: '100.00',
      receiptFileId: file!.id,
      lines: [{ itemId, quantity: '1', purchaseUnit: 'kg', conversionFactor: '1', unitPrice: '100', lineTotal: '100.00' }],
    }),
  );
  await asOrg(f.orgId, (tx) =>
    verifyInvoice(tx, f.admin, created.id, { supplier: true, invoice: true, items: true, price: true }),
  );
}

const itemRow = async (id: string) =>
  (await sql<{ base_unit: string; is_purchasable: boolean; sellable_retail: boolean; sellable_wholesale: boolean }[]>`
    select base_unit, is_purchasable, sellable_retail, sellable_wholesale from items where id = ${id}`)[0];
const auditRows = (itemId: string) =>
  sql<{ action: string; entity: string; entity_id: string; before: unknown; after: unknown; actor_person_id: string; source: string }[]>`
    select action, entity, entity_id, before, after, actor_person_id, source from audit_log
    where entity = 'items' and entity_id = ${itemId} and action = 'change_item_base_unit'`;

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

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('D - changeItemBaseUnit', () => {
  it(
    'D1: super-admin, no history, kg -> pcs: {changed:true}, unit pcs, exactly one audit row with before/after. Killing mutants: drop the append; swap before and after. Red today: changeItemBaseUnit does not exist',
    async () => {
      const f = await fixture('d1');
      const id = await newItem(f, 'kg');
      const res = await asOrg(f.orgId, (tx) => changeItemBaseUnit(tx, f.superAdmin, { itemId: id, baseUnit: 'pcs' }));
      expect(res).toEqual({ changed: true });
      expect((await itemRow(id))!.base_unit).toBe('pcs');
      const rows = await auditRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'change_item_base_unit', entity: 'items', entity_id: id,
        before: { baseUnit: 'kg' }, after: { baseUnit: 'pcs' },
        actor_person_id: f.superAdmin.personId, source: 'web',
      });
    },
    30_000,
  );

  it.each(['admin', 'manager'] as const)(
    'D2: %s -> AuthorizationError, unit unchanged, no audit row. Killing mutant: authorize(..., "manage_items") (admin and manager would pass). Red today: TypeError, not AuthorizationError',
    async (who) => {
      const f = await fixture(`d2${who}`);
      const id = await newItem(f, 'kg');
      const err = await failure(asOrg(f.orgId, (tx) => changeItemBaseUnit(tx, f[who], { itemId: id, baseUnit: 'pcs' })));
      expect(err).toBeInstanceOf(AuthorizationError);
      expect((await itemRow(id))!.base_unit).toBe('kg');
      expect(await auditRows(id)).toHaveLength(0);
    },
    30_000,
  );

  it(
    'D3: with one invoice line -> refused by items_base_unit_fixed, unit unchanged, no audit row. Killing mutant: trigger CONSTRAINT renamed (wrong constraint name); audit-before-UPDATE is equivalent (the refusal rolls it back). Red today: TypeError, no constraint',
    async () => {
      const f = await fixture('d3');
      const id = await newItem(f, 'kg');
      await giveHistory(f, id);
      const err = await failure(asOrg(f.orgId, (tx) => changeItemBaseUnit(tx, f.superAdmin, { itemId: id, baseUnit: 'pcs' })));
      expect(constraintOf(err)).toBe('items_base_unit_fixed');
      expect((await itemRow(id))!.base_unit).toBe('kg');
      expect(await auditRows(id)).toHaveLength(0);
    },
    30_000,
  );

  it(
    'D4: unchanged unit -> {changed:false} and no audit row. Killing mutant: append unconditionally. Red today: TypeError',
    async () => {
      const f = await fixture('d4');
      const id = await newItem(f, 'kg');
      const res = await asOrg(f.orgId, (tx) => changeItemBaseUnit(tx, f.superAdmin, { itemId: id, baseUnit: 'kg' }));
      expect(res).toEqual({ changed: false });
      expect(await auditRows(id)).toHaveLength(0);
    },
    30_000,
  );

  it(
    'D5: updateItem no longer accepts baseUnit: refused with the pointer sentence, unit unchanged. Killing mutant: updateItem passes baseUnit through. Red today: updateItem silently rewrites the unit',
    async () => {
      const f = await fixture('d5');
      const id = await newItem(f, 'kg');
      const err = await failure(asOrg(f.orgId, (tx) => updateItem(tx, f.manager, id, { baseUnit: 'pcs' } as never)));
      expect(String((err as Error).message)).toContain("Change the unit with Change unit on the item's page.");
      expect((await itemRow(id))!.base_unit).toBe('kg');
    },
    30_000,
  );
});

describe('F - the three ticks reach the item through request -> approve (DEF-599)', () => {
  const legs = [
    { id: 'F1', tick: 'isPurchasable', input: { isPurchasable: false }, col: 'is_purchasable', want: false,
      mutant: 'requestItem omits isPurchasable, or approveItemRequest omits it (DB default true hides it)' },
    { id: 'F2', tick: 'sellableRetail', input: { sellableRetail: true }, col: 'sellable_retail', want: true,
      mutant: 'requestItem omits sellableRetail, or approveItemRequest omits it' },
    { id: 'F3', tick: 'sellableWholesale', input: { sellableWholesale: true }, col: 'sellable_wholesale', want: true,
      mutant: 'requestItem omits sellableWholesale, or approveItemRequest omits it' },
  ] as const;
  for (const leg of legs) {
    it(
      `${leg.id}: ${leg.tick} ${JSON.stringify(leg.input)} -> the approved item has it. Killing mutant: ${leg.mutant}. Red today: the item has the default`,
      async () => {
        const f = await fixture(leg.id.toLowerCase());
        const { requestId } = await asOrg(f.orgId, (tx) =>
          requestItem(tx, f.manager, { name: `Req ${uid('n')}`, kind: 'retail', baseUnit: 'pcs', ...leg.input }),
        );
        const { itemId } = await asOrg(f.orgId, (tx) => approveItemRequest(tx, f.superAdmin, { requestId }));
        expect((await itemRow(itemId))![leg.col]).toBe(leg.want);
      },
      30_000,
    );
  }

  it(
    'F4 (control, green today): no flags given -> true / false / false',
    async () => {
      const f = await fixture('f4');
      const { requestId } = await asOrg(f.orgId, (tx) =>
        requestItem(tx, f.manager, { name: `Req ${uid('n')}`, kind: 'retail', baseUnit: 'pcs' }),
      );
      const { itemId } = await asOrg(f.orgId, (tx) => approveItemRequest(tx, f.superAdmin, { requestId }));
      const r = (await itemRow(itemId))!;
      expect([r.is_purchasable, r.sellable_retail, r.sellable_wholesale]).toEqual([true, false, false]);
    },
    30_000,
  );
});

describe('A - the approver confirms the unit and flags (R5)', () => {
  const request = (f: Fixture, extra: Record<string, unknown> = {}) =>
    asOrg(f.orgId, (tx) =>
      requestItem(tx, f.manager, { name: `Req ${uid('n')}`, kind: 'retail', baseUnit: 'kg', ...extra }),
    );

  it(
    'A1: request kg, approve with baseUnit pcs -> item is pcs, the request row still says kg. Killing mutants: approve ignores the override; approve writes the override back onto the request. Red today: item is kg',
    async () => {
      const f = await fixture('a1');
      const { requestId } = await request(f);
      const { itemId } = await asOrg(f.orgId, (tx) =>
        approveItemRequest(tx, f.superAdmin, { requestId, baseUnit: 'pcs' } as never),
      );
      expect((await itemRow(itemId))!.base_unit).toBe('pcs');
      const [req] = await sql<{ base_unit: string }[]>`select base_unit from item_requests where id = ${requestId}`;
      expect(req!.base_unit).toBe('kg');
    },
    30_000,
  );

  it(
    'A2: request sellableRetail false, approve with sellableRetail true -> the item is retail. Killing mutant: approve ignores the flag override. Red today: false',
    async () => {
      const f = await fixture('a2');
      const { requestId } = await request(f, { sellableRetail: false });
      const { itemId } = await asOrg(f.orgId, (tx) =>
        approveItemRequest(tx, f.superAdmin, { requestId, sellableRetail: true } as never),
      );
      expect((await itemRow(itemId))!.sellable_retail).toBe(true);
    },
    30_000,
  );

  it(
    'A3 (REV-11): approve with baseUnit "" -> refused by items_base_unit_check; request still requested; no item. Killing mutant: `input.baseUnit || req.baseUnit` (blank approves silently in the requested unit). Red today: the override is ignored and the item is created in kg',
    async () => {
      const f = await fixture('a3');
      const name = `Req ${uid('n')}`;
      const { requestId } = await asOrg(f.orgId, (tx) =>
        requestItem(tx, f.manager, { name, kind: 'retail', baseUnit: 'kg' }),
      );
      const err = await failure(
        asOrg(f.orgId, (tx) => approveItemRequest(tx, f.superAdmin, { requestId, baseUnit: '' } as never)),
      );
      expect(constraintOf(err)).toBe('items_base_unit_check');
      const [req] = await sql<{ status: string }[]>`select status from item_requests where id = ${requestId}`;
      expect(req!.status).toBe('requested');
      expect(await sql`select 1 from items where org_id = ${f.orgId} and name = ${name}`).toHaveLength(0);
    },
    30_000,
  );
});
