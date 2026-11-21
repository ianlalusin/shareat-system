import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-598 S4 -- DEF-505 (approve gate first), DEF-507 (a rename is audited), DEF-532 (the supplier row is locked
 * for an edit, so the audit "before" is the other editor's committed value).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { APP_ROLE, transaction, closeDb, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { createSupplier, editSupplier, recordExpenseForInvoice } from '@shareat/domain';

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
  const code = uid(`s4-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
    return p!.id;
  };
  const managerId = await mk('Manager', 'manager');
  const staffId = await mk('Staff', 'staff');
  return { orgId, storeId: store!.id, manager: actor(orgId, managerId), staff: actor(orgId, staffId), staffId };
}

afterAll(async () => {
  await sql.end();
  await closeDb();
});

const renames = (orgId: string, supplierId: string) => sql<{ before: { name: string }; after: { name: string } }[]>`
  select before, after from audit_log
   where org_id = ${orgId} and action = 'supplier.renamed' and entity_id = ${supplierId}
   order by id`; // uuidv7: creation order

describe('DEF-505: recordExpenseForInvoice asks for approve_expense before it judges the form', () => {
  it('a person holding only create_expense is refused for the capability, not told what is wrong with the form', async () => {
    const f = await fixture('d505');
    await sql`insert into person_grants (person_id, grant_name) values (${f.staffId}, 'create_expense')`;
    const bogus = '00000000-0000-4000-8000-000000000001';
    const err = await asOrg(f.orgId, (tx) =>
      recordExpenseForInvoice(tx, f.staff, {
        storeId: f.storeId, categoryId: bogus, supplierId: bogus, supplierInvoiceId: bogus,
        particulars: '', payments: [],
      } as never),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthorizationError);
    expect((err as AuthorizationError).capability).toBe('approve_expense');
  });
});

describe('DEF-507: a supplier rename is audited', () => {
  it('writes one row with the old and new name; the same name writes none', async () => {
    const f = await fixture('d507');
    const { id } = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: 'Tyipco' }));
    await asOrg(f.orgId, (tx) => editSupplier(tx, f.manager, { supplierId: id, name: '  Tyipco Inc.  ' }));
    await asOrg(f.orgId, (tx) => editSupplier(tx, f.manager, { supplierId: id, name: 'Tyipco Inc.' }));
    const rows = await renames(f.orgId, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before.name).toBe('Tyipco');
    expect(rows[0]!.after.name).toBe('Tyipco Inc.');
  });
});

describe('DEF-532: editSupplier locks the supplier row before it reads it', () => {
  it('a second editor waits and sees the first editor committed name as "before"', async () => {
    const f = await fixture('d532');
    const { id } = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: 'Alpha' }));

    let firstHasEdited!: () => void;
    const reached = new Promise<void>((r) => (firstHasEdited = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const first = asOrg(f.orgId, async (tx) => {
      await editSupplier(tx, f.manager, { supplierId: id, name: 'Bravo' });
      firstHasEdited();
      await gate; // holds the row lock (and the uncommitted rename) open
    });
    await reached;
    let secondDone = false;
    const second = asOrg(f.orgId, (tx) => editSupplier(tx, f.manager, { supplierId: id, name: 'Charlie' })).then(() => {
      secondDone = true;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(secondDone).toBe(false);
    release();
    await Promise.all([first, second]);

    const rows = await renames(f.orgId, id);
    expect(rows.map((r) => `${r.before.name}>${r.after.name}`)).toEqual(['Alpha>Bravo', 'Bravo>Charlie']);
  });
});
