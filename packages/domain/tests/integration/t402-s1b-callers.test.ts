import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-402 S1b - the existing callers write the catalogue's labels and store, through their REAL domain functions.
 * docs/tasks/402-activity-log.md R1, R2, R5 (Q6), R14, Invariant 6 ("every one of the 20 migrated callers' real payloads
 * passes through with nothing secret left"), Slice S1b ("exactly one audit row per write, same transaction").
 * A representative set: money/high with the bank mask (set_supplier_bank_account), money/normal (set_supplier_credit_terms),
 * money/normal at a store (create_tender), security/high at a store (reopen_pin_sign_in). The static scan of ALL the call
 * sites (storeId passed, no entity/labels) is in packages/db/tests/t402-s1b-catalogue.test.ts.
 *
 * ## State at HEAD
 * The catalogue import does not resolve yet, so the whole file is red on that single cause. Once it does, the judging legs are
 * the bank-number mask (the full number is stored today) and every `store_id` leg whose catalogue scope is 'store'.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { catalogueEntry, retentionFor, severityFor } from '../../../db/src/audit/catalogue';
import * as auth from '@shareat/auth';
import type { Actor } from '@shareat/auth';
import { createSupplier, editSupplier } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await closeDb();
});

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
  const code = uid(`t402c-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id, source) values (${p!.id}, ${store!.id}, 'manual')`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin');
  const managerId = await mk('Manager', 'manager');
  await sql`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${store!.id}, 'Cashier drawer', 'cash', '1110', 'cashier')`;
  return { orgId, storeId: store!.id, admin: actor(orgId, adminId), manager: actor(orgId, managerId) };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

interface Row {
  id: string;
  store_id: string | null;
  actor_person_id: string | null;
  entity: string;
  category: string;
  sensitivity: string;
  severity: number;
  retention_class: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  redacted_keys: string[];
}
const rows = (orgId: string, action: string, entityId?: string) =>
  entityId
    ? sql<Row[]>`select * from audit_log where org_id = ${orgId} and action = ${action} and entity_id = ${entityId} order by recorded_at`
    : sql<Row[]>`select * from audit_log where org_id = ${orgId} and action = ${action} order by recorded_at`;

function expectCatalogueRow(row: Row, action: string, fx: Fx) {
  const e = catalogueEntry(action)!;
  expect(e, `${action} in the catalogue`).toBeDefined();
  expect(row.category, 'category').toBe(e.category);
  expect(row.sensitivity, 'sensitivity').toBe(e.sensitivity);
  expect(row.severity, 'severity').toBe(severityFor(e.sensitivity));
  expect(row.retention_class, 'retention').toBe(retentionFor(e.category, e.sensitivity));
  expect(row.entity, 'entity').toBe(e.entity);
  expect(row.store_id, `store_id for a ${e.scope}-scoped entry`).toBe(e.scope === 'store' ? fx.storeId : null);
}

describe('set_supplier_bank_account - money/high, the bank number masked (Q6)', () => {
  it('one row per real change; labels from the catalogue; last 4 digits only; Changed flag; no full number anywhere in the row', async () => {
    const fx = await fixture('bank');
    const { id } = await asOrg(fx.orgId, (tx) => createSupplier(tx, fx.admin, { name: `Bank ${uid('s')}` }));
    await asOrg(fx.orgId, (tx) => editSupplier(tx, fx.admin, { supplierId: id, bankName: 'BDO', bankAccountName: 'Acme Inc', bankAccountNumber: '1234567890123' }));
    const base = (await rows(fx.orgId, 'set_supplier_bank_account', id)).length;
    await asOrg(fx.orgId, (tx) => editSupplier(tx, fx.manager, { supplierId: id, bankAccountNumber: '9876543210987' }));
    const all = await rows(fx.orgId, 'set_supplier_bank_account', id);
    expect(all.length, 'exactly +1 row for one edit').toBe(base + 1);
    const row = all.at(-1)!;
    expectCatalogueRow(row, 'set_supplier_bank_account', fx);
    expect(row.actor_person_id).toBe(fx.manager.personId);
    expect(row.before!.bankAccountNumber).toBe('••••0123');
    expect(row.after!.bankAccountNumber).toBe('••••0987');
    expect(row.after!.bankAccountNumberChanged).toBe(true);
    expect(row.after!.bankName, 'non-secret bank fields stay readable').toBe('BDO');
    expect(JSON.stringify([row.before, row.after])).not.toMatch(/\d{5,}/);
    // the first set (before = nothing) is masked too: no full number survives on ANY row of this supplier
    for (const r of all) expect(JSON.stringify([r.before, r.after]), 'no full account number on any row').not.toMatch(/\d{5,}/);
  });
});

describe('set_supplier_credit_terms - money/normal', () => {
  it('one row, catalogue labels, store_id per the entry scope; a no-op edit writes none', async () => {
    const fx = await fixture('terms');
    const { id } = await asOrg(fx.orgId, (tx) => createSupplier(tx, fx.admin, { name: `Terms ${uid('s')}` }));
    await asOrg(fx.orgId, (tx) => editSupplier(tx, fx.admin, { supplierId: id, creditTermsDays: 30 }));
    const base = (await rows(fx.orgId, 'set_supplier_credit_terms', id)).length;
    await asOrg(fx.orgId, (tx) => editSupplier(tx, fx.admin, { supplierId: id, creditTermsDays: 45 }));
    const all = await rows(fx.orgId, 'set_supplier_credit_terms', id);
    expect(all.length).toBe(base + 1);
    expectCatalogueRow(all.at(-1)!, 'set_supplier_credit_terms', fx);
    expect(all.at(-1)!.after).toEqual({ creditTermsDays: 45 });
    await asOrg(fx.orgId, (tx) => editSupplier(tx, fx.admin, { supplierId: id, creditTermsDays: 45 }));
    expect((await rows(fx.orgId, 'set_supplier_credit_terms', id)).length, 'no-op writes nothing').toBe(base + 1);
  });
});

describe('create_tender - money/normal at a store', () => {
  it('the row carries the store the tender belongs to and the catalogue labels', async () => {
    const fx = await fixture('tender');
    const mod = await import('../../src/pos/tenders');
    const created = (await asOrg(fx.orgId, (tx) =>
      mod.createTender(tx, fx.admin, { storeId: fx.storeId, name: 'Cash', kind: 'cash', posV1Alias: 'Cash' } as never),
    )) as { id: string };
    const all = await rows(fx.orgId, 'create_tender', created.id);
    expect(all).toHaveLength(1);
    expectCatalogueRow(all[0]!, 'create_tender', fx);
    expect(all[0]!.store_id, 'a tender is a per-store thing: its row names the store').toBe(fx.storeId);
  });
});

describe('reopen_pin_sign_in - security/high at the store (credentials-admin)', () => {
  it('the row carries the reopened store, catalogue labels, no secret', async () => {
    const fx = await fixture('reopen');
    await sql`
      insert into pin_attempt_throttle (org_id, store_id, fail_count, window_started_at, locked_until, stopped_at)
      values (${fx.orgId}, ${fx.storeId}, 7, now() - interval '30 seconds', now() + interval '90 seconds', now() - interval '1 hour')`;
    const reopen = (auth as unknown as { reopenPinSignIn: (tx: Tx, a: Actor, storeId: string) => Promise<{ reopened: boolean }> }).reopenPinSignIn;
    const res = await asOrg(fx.orgId, (tx) => reopen(tx, fx.manager, fx.storeId));
    expect(res).toEqual({ reopened: true });
    const all = await rows(fx.orgId, 'reopen_pin_sign_in', fx.storeId);
    expect(all).toHaveLength(1);
    expectCatalogueRow(all[0]!, 'reopen_pin_sign_in', fx);
    expect(all[0]!.store_id).toBe(fx.storeId);
    expect(all[0]!.actor_person_id).toBe(fx.manager.personId);
    expect(all[0]!.redacted_keys).toEqual([]);
  });
});
