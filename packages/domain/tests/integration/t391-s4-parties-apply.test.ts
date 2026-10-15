import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-391 S4 - `docs/tasks/391-production-master-data-load.md`, test 21 (+ P5, P7, P8, R2, R4, R8, R16, I2, I4, I8). TESTER file.
 * Real Postgres. The suppliers and customers APPLY, and the three new audited writers.
 *
 * CONTRACT these tests pin (the spec names files, not signatures - the builder builds to this):
 *   scripts/lib/master-data-apply.ts
 *     applySuppliers(input) and applyCustomers(input), each -> Promise<{ dryRun: boolean; created: number; linked: number; held: number }>
 *       input = exactly applyItems' input ({ snapshot, snapshotSha, map, orgId, orgCode, storeCodes?, answers, actor, apply });
 *       the plan is planParties(...) (packages/etl/src/master-data/parties-plan.ts, see t391-s4-parties-plan.test.ts) run INSIDE the
 *       locked transaction, the same lock key as S3 (pg_advisory_xact_lock(hashtext('master-data:' || org_id))).
 *       Each writes only ITS entity's writes. `created` = parties created; `linked` = v1_master_links rows inserted (entity 'supplier' /
 *       'customer', v1_unit NULL, factor_to_base NULL); a mirror or a status call is not counted in either.
 *       Refuses (writes nothing, not even the clean rows) when held > 0 (/held/i), no actor, an actor of another org, assertRunTarget fails;
 *       AuthorizationError from the domain gate (approve_supplier for suppliers, manage_chart_of_accounts for customers).
 *       One audit row per apply: action 'master_data_load', entity 'suppliers'|'supplier' / 'customers'|'customer', source 'etl',
 *       after = { snapshotSha, stores, created, linked, held }, actor_person_id = the actor.
 *       A store link (counterpartyV1StoreId) is resolved through the store map: store_code -> this org's stores.code.
 *   @shareat/domain, new exports (all take (tx | null, actor, input) like their neighbours):
 *     setSupplierCounterpartyStore(tx, actor, { supplierId, storeId })   approve_supplier; refuses a store of another org;
 *                                                  sets suppliers.counterparty_store_id; ONE audit_log row, action 'set_supplier_counterparty_store', entity 'suppliers'
 *     setCustomerStatus(tx, actor, { customerId, status: 'active'|'inactive' })   manage_chart_of_accounts;
 *                                                  ONE audit_log row, action 'set_customer_status', entity 'customers'
 *     editSupplier(tx, actor, { supplierId, status })   (the field exists) now writes ONE audit_log row, action 'set_supplier_status',
 *                                                  entity 'suppliers', before {status}, after {status}, only when the status really changes
 *
 * Each test names its killing mutant. Red today: the apply functions and the two new writers do not exist; the
 * status audit row of editSupplier is not written.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, withOrgPrincipal } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { parseStoreMap } from '../../../etl/src/master-data/store-map';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${++seq}`.toUpperCase();

const L = 'b9DzsnPbr1BUnY88lyT4';
const M = 'dZUyvX4q824JBSVDAfE9';
const B = 'iGOW7q2pZbeHWV832UNh';
const P = 'y1DMgfisuTHBF57cNL6i';
const SHA = 'b'.repeat(64);

const mapCsv = (se: string, pg: string): string =>
  [
    'v1_store_id,name,role,org_code,store_code',
    `${L},SharEat Lipa,own,${se},LIPA`,
    `${M},SharEat Malvar,own,${se},MLVR`,
    `${B},SharEat Banay-Banay,own,${se},BNBN`,
    `${P},SharEat Padre Garcia,franchise,${pg},PGAR`,
  ].join('\r\n');

interface Env {
  orgId: string;
  orgCode: string;
  pgOrgId: string;
  pgCode: string;
  stores: Record<string, string>;
  pgStoreId: string;
  map: Any[];
  superA: Actor;
  admin: Actor;
  manager: Actor;
  staff: Actor;
}

async function mkOrg(code: string, storeCodes: string[]) {
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const stores: Record<string, string> = {};
  for (const sc of storeCodes) {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${sc}, ${`Store ${sc}`}) returning id`;
    stores[sc] = s!.id;
  }
  const first = Object.values(stores)[0]!;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${first})`;
    return p!.id;
  };
  return { orgId, stores, mk };
}

async function env(hint: string): Promise<Env> {
  const orgCode = uid(`S${hint}`);
  const pgCode = uid(`G${hint}`);
  const a = await mkOrg(orgCode, ['LIPA', 'MLVR', 'BNBN']);
  const b = await mkOrg(pgCode, ['PGAR']);
  const act = (orgId: string, personId: string): Actor => ({ orgId, personId });
  return {
    orgId: a.orgId,
    orgCode,
    pgOrgId: b.orgId,
    pgCode,
    stores: a.stores,
    pgStoreId: b.stores.PGAR!,
    map: parseStoreMap(mapCsv(orgCode, pgCode)),
    superA: act(a.orgId, await a.mk('Super', 'super_admin')),
    admin: act(a.orgId, await a.mk('Admin', 'admin')),
    manager: act(a.orgId, await a.mk('Manager', 'manager')),
    staff: act(a.orgId, await a.mk('Staff', 'staff')),
  };
}

let rid = 0;
const sup = (store: string, name: string, over: Record<string, unknown> = {}): Any => ({
  id: `sp${++rid}`, store, businessName: name, classification: 'Corporate', isActive: true, updatedAt: '2026-01-01T00:00:00.000Z', ...over,
});
const cust = (store: string, name: string, over: Record<string, unknown> = {}): Any => ({
  id: `cu${++rid}`, store, name, classification: 'corporate', status: 'active', updatedAt: '2026-01-01T00:00:00.000Z', ...over,
});
const snap = (suppliers: Any[] = [], arCustomers: Any[] = []): Any => ({
  version: 1, stores: [], items: [], suppliers, arCustomers, staff: [], staffIdentities: [],
});

type ApplyResult = { dryRun: boolean; created: number; linked: number; held: number };
type Apply = (a: Record<string, unknown>) => Promise<ApplyResult>;
async function fn(name: 'applySuppliers' | 'applyCustomers'): Promise<Apply> {
  const mod: Any = await import('../../../../scripts/lib/master-data-apply');
  return mod[name] as Apply;
}
async function runS(e: Env, snapshot: Any, over: Record<string, unknown> = {}) {
  return (await fn('applySuppliers'))({
    snapshot, snapshotSha: SHA, map: e.map, orgId: e.orgId, orgCode: e.orgCode, answers: {}, actor: e.superA, apply: true, ...over,
  });
}
async function runC(e: Env, snapshot: Any, over: Record<string, unknown> = {}) {
  return (await fn('applyCustomers'))({
    snapshot, snapshotSha: SHA, map: e.map, orgId: e.orgId, orgCode: e.orgCode, answers: {}, actor: e.superA, apply: true, ...over,
  });
}
async function dom(): Promise<Any> {
  return import('@shareat/domain');
}
/** Call a domain writer the way the load does: inside an org-principal transaction. */
async function call(orgId: string, name: string, actor: Actor, input: Record<string, unknown>): Promise<unknown> {
  const mod = await dom();
  const f = mod[name];
  if (typeof f !== 'function') throw new Error(`@shareat/domain does not export ${name}`);
  return withOrgPrincipal(orgId, (tx: Any) => f(tx, actor, input));
}
async function failure(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to be refused');
}

const suppliers = (orgId: string) =>
  sql<Any[]>`select id, name, status, vat_status, tin, classification, credit_terms_days, address, contact_no, email, representative_name,
    bank_name, bank_account_name, bank_account_number, counterparty_store_id, notes from suppliers where org_id = ${orgId} order by name`;
const customers = (orgId: string) =>
  sql<Any[]>`select id, name, status, customer_group, counterparty_store_id, counterparty_org_id, address, contact_no from customers where org_id = ${orgId} order by name`;
const links = (orgId: string, entity: string) =>
  sql<Any[]>`select entity, v1_store_id, v1_id, v2_id, v1_unit, factor_to_base, created_by from v1_master_links where org_id = ${orgId} and entity = ${entity} order by v1_id`;
const audits = (orgId: string, action: string) =>
  sql<Any[]>`select action, entity, entity_id, before, after, source, actor_person_id from audit_log where org_id = ${orgId} and action = ${action} order by occurred_at, id`;
// T-402 S2: a refused authorize() writes a `security.authorize_denied` security event (async outbox) -- the refusal itself, not a write by the refused call.
const allAuditCount = async (orgId: string) => Number((await sql<Any[]>`select count(*)::int as n from audit_log where org_id = ${orgId} and action <> 'security.authorize_denied'`)[0]!.n);
const docCount = async (orgId: string): Promise<number> => {
  const q = async (t: string) => Number((await sql.unsafe(`select count(*)::int as n from ${t} where org_id = $1`, [orgId]))[0]!.n);
  return (await q('supplier_invoices')) + (await q('ar_charges')) + (await q('ar_collections')) + (await q('journal_entries')) + (await q('expenses'));
};
const state = async (orgId: string) => ({
  suppliers: await suppliers(orgId),
  customers: await customers(orgId),
  sLinks: await links(orgId, 'supplier'),
  cLinks: await links(orgId, 'customer'),
  audit: await allAuditCount(orgId),
});

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('S4 apply - suppliers: create, link, audit', () => {
  it(
    'one supplier with two links: one row, two supplier links (no unit, no factor), the P4 mapping stored, one master_data_load audit row. Killing mutants: one row per record; a link not written; no audit row; unit or factor on a party link. Red today: applySuppliers does not exist',
    async () => {
      const e = await env('A');
      const s = snap([
        sup(L, 'Acme Foods', { vatStatus: 'VAT Reg', tin: '123-456-789-000', lastCreditDueDays: 30, classification: 'Corporate', contacts: [{ name: 'Ana', phone: '0917-123-4567' }], address: '1 Main St' }),
        sup(M, 'acme foods ', { vatStatus: 'VAT Reg', tin: '123-456-789-000', updatedAt: '2026-05-01T00:00:00.000Z' }),
        sup(L, 'Solo Vendor', { classification: 'Individual', vatStatus: 'Non-VAT Reg' }),
      ]);
      const r = await runS(e, s);
      expect(r).toMatchObject({ dryRun: false, created: 2, linked: 3, held: 0 });

      const got = await suppliers(e.orgId);
      expect(got).toHaveLength(2);
      const acme = got.find((x) => x.name.trim().toLowerCase() === 'acme foods')!;
      expect(acme).toMatchObject({ status: 'active', vat_status: 'vat_registered', tin: '123-456-789-000', classification: 'corporate', credit_terms_days: 30, contact_no: '0917-123-4567' });
      expect(got.find((x) => x.name === 'Solo Vendor')).toMatchObject({ classification: 'individual', vat_status: 'non_vat' });

      const ls = await links(e.orgId, 'supplier');
      expect(ls).toHaveLength(3);
      expect(ls.filter((l) => l.v2_id === acme.id).map((l) => l.v1_store_id).sort()).toEqual([L, M].sort());
      for (const l of ls) {
        expect(l.v1_unit).toBeNull();
        expect(l.factor_to_base).toBeNull();
        expect(l.created_by).toBe(e.superA.personId);
        expect(got.some((x) => x.id === l.v2_id)).toBe(true); // I4
      }

      const a = await audits(e.orgId, 'master_data.suppliers_load');
      expect(a).toHaveLength(1);
      expect(a[0].entity).toBe('suppliers');
      expect(a[0]).toMatchObject({ source: 'etl', actor_person_id: e.superA.personId });
      expect(a[0].after).toMatchObject({ snapshotSha: SHA, created: 2, linked: 3, held: 0 });
      expect(JSON.stringify(a[0].after.stores)).toMatch(/LIPA/);
    },
    60_000,
  );

  it(
    'no AP or AR document, no journal entry and no expense is created (balances and documents are not imported). Killing mutant: a balance or opening invoice carried over',
    async () => {
      const e = await env('NOD');
      const before = await docCount(e.orgId);
      await runS(e, snap([sup(L, 'Acme Foods')]));
      await runC(e, snap([], [cust(L, 'Tonyo Eatery')]));
      expect(await docCount(e.orgId)).toBe(before);
    },
    60_000,
  );

  it(
    'P8 / I8: no full bank account number reaches the database; a masked snapshot never yields more than its last four digits. Killing mutant: the raw number copied through',
    async () => {
      const e = await env('BK');
      const FULL = '1234567890123456';
      await runS(e, snap([sup(L, 'Beta Co', { bankAccount: { bankName: 'BDO', accountName: 'Beta Co', accountNumberMasked: '************3456', accountNumber: FULL } })]));
      const [row] = await suppliers(e.orgId);
      expect(row!.bank_name).toBe('BDO');
      expect(JSON.stringify(row)).not.toContain(FULL);
      expect(String(row!.bank_account_number ?? '').replace(/[^0-9]/g, '').length).toBeLessThanOrEqual(4);
      expect(row!.bank_account_number).toBe('************3456');
      expect(JSON.stringify([...(await audits(e.orgId, 'master_data.suppliers_load')), ...(await audits(e.orgId, 'master_data.customers_load'))])).not.toContain(FULL);
    },
    60_000,
  );
});

describe('S4 apply - the mirror writer (P5)', () => {
  it(
    "a commissary mirror supplier ends with counterparty_store_id set to the Malvar store, through setSupplierCounterpartyStore, with ONE audit row naming the actor. Killing mutants: the link never set; set by a repo update that skips the writer (no audit row)",
    async () => {
      const e = await env('MR');
      const r = await runS(e, snap([sup(L, 'SharEat Malvar', { linkedStoreId: M })]));
      expect(r).toMatchObject({ created: 1, linked: 1 });
      const [s] = await suppliers(e.orgId);
      expect(s!.counterparty_store_id).toBe(e.stores.MLVR);
      const a = await audits(e.orgId, 'set_supplier_counterparty_store');
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ entity: 'suppliers', entity_id: s!.id, actor_person_id: e.superA.personId });
      expect(JSON.stringify(a[0].after)).toContain(e.stores.MLVR);
    },
    60_000,
  );

  it(
    "setSupplierCounterpartyStore refuses another organisation's store and writes nothing. Killing mutant: the org check dropped",
    async () => {
      const e = await env('MX');
      await runS(e, snap([sup(L, 'Acme Foods')]));
      const [s] = await suppliers(e.orgId);
      const before = await allAuditCount(e.orgId);
      const err = await failure(call(e.orgId, 'setSupplierCounterpartyStore', e.superA, { supplierId: s!.id, storeId: e.pgStoreId }));
      expect(err).toBeTruthy();
      expect((await suppliers(e.orgId))[0]!.counterparty_store_id).toBeNull();
      expect(await allAuditCount(e.orgId)).toBe(before);
    },
    60_000,
  );

  it(
    'setSupplierCounterpartyStore is gated on approve_supplier: a staff actor is refused (the x fires), a manager may. Killing mutant: the authorize call removed',
    async () => {
      const e = await env('MG');
      await runS(e, snap([sup(L, 'Acme Foods')]));
      const [s] = await suppliers(e.orgId);
      const err = await failure(call(e.orgId, 'setSupplierCounterpartyStore', e.staff, { supplierId: s!.id, storeId: e.stores.MLVR }));
      expect(err).toBeInstanceOf(AuthorizationError);
      expect((await suppliers(e.orgId))[0]!.counterparty_store_id).toBeNull();
      expect(await audits(e.orgId, 'set_supplier_counterparty_store')).toHaveLength(0);
      await call(e.orgId, 'setSupplierCounterpartyStore', e.manager, { supplierId: s!.id, storeId: e.stores.MLVR });
      expect(await audits(e.orgId, 'set_supplier_counterparty_store')).toHaveLength(1);
    },
    60_000,
  );

  it(
    'a customer linked to an own store becomes group internal with counterparty_store_id and no counterparty org (ADR-008). Killing mutant: written as wholesale with no link',
    async () => {
      const e = await env('CI');
      const r = await runC(e, snap([], [cust(L, 'SharEat Malvar', { linkedStoreId: M })]));
      expect(r).toMatchObject({ created: 1, linked: 1 });
      const [c] = await customers(e.orgId);
      expect(c).toMatchObject({ customer_group: 'internal', counterparty_store_id: e.stores.MLVR, counterparty_org_id: null });
    },
    60_000,
  );

  it(
    'a franchise-pointing customer or supplier is never written into the main org, and nothing in the main org points at the franchise store (I1, P5). Killing mutant: the franchise link written',
    async () => {
      const e = await env('FR');
      const s = snap([sup(L, 'SharEat Padre Garcia', { linkedStoreId: P }), sup(L, 'Acme Foods')], [cust(L, 'SharEat Padre Garcia', { linkedStoreId: P }), cust(L, 'Tonyo')]);
      expect(typeof (await fn('applySuppliers'))).toBe('function'); // red until the apply exists (the catches below would pass vacuously)
      // the franchise rows wait outside the run: whatever the held count means for them, they must not become rows
      await runS(e, s).catch(() => undefined);
      await runC(e, s).catch(() => undefined);
      expect((await suppliers(e.orgId)).map((x) => x.name)).not.toContain('SharEat Padre Garcia');
      expect((await customers(e.orgId)).map((x) => x.name)).not.toContain('SharEat Padre Garcia');
      expect((await suppliers(e.orgId)).every((x) => x.counterparty_store_id !== e.pgStoreId)).toBe(true);
      expect((await customers(e.orgId)).every((x) => x.counterparty_org_id === null && x.counterparty_store_id !== e.pgStoreId)).toBe(true);
      expect(await suppliers(e.pgOrgId)).toHaveLength(0);
      expect(await customers(e.pgOrgId)).toHaveLength(0);
    },
    60_000,
  );
});

describe('S4 apply - statuses (P7)', () => {
  it(
    'inactive v1 records end inactive: a supplier through editSupplier status (audited set_supplier_status), a customer through setCustomerStatus (audited set_customer_status). Killing mutants: left active; the status writer unaudited',
    async () => {
      const e = await env('ST');
      await runS(e, snap([sup(L, 'Dead Supplier', { isActive: false }), sup(L, 'Live Supplier')]));
      await runC(e, snap([], [cust(L, 'Dead Customer', { status: 'inactive' }), cust(L, 'Live Customer')]));
      const ss = await suppliers(e.orgId);
      const cs = await customers(e.orgId);
      expect(ss.find((x) => x.name === 'Dead Supplier')!.status).toBe('inactive');
      expect(ss.find((x) => x.name === 'Live Supplier')!.status).toBe('active');
      expect(cs.find((x) => x.name === 'Dead Customer')!.status).toBe('inactive');
      expect(cs.find((x) => x.name === 'Live Customer')!.status).toBe('active');

      const sa = await audits(e.orgId, 'set_supplier_status');
      expect(sa).toHaveLength(1);
      expect(sa[0]).toMatchObject({ entity: 'suppliers', entity_id: ss.find((x) => x.name === 'Dead Supplier')!.id, actor_person_id: e.superA.personId });
      expect(sa[0].after).toMatchObject({ status: 'inactive' });
      const ca = await audits(e.orgId, 'set_customer_status');
      expect(ca).toHaveLength(1);
      expect(ca[0]).toMatchObject({ entity: 'customers', entity_id: cs.find((x) => x.name === 'Dead Customer')!.id, actor_person_id: e.superA.personId });
      expect(ca[0].after).toMatchObject({ status: 'inactive' });
    },
    60_000,
  );

  it(
    'editSupplier status is gated on approve_supplier (staff refused, row unchanged, no audit) and a no-op status writes no audit row. Killing mutants: authorize dropped; audit written on no change',
    async () => {
      const e = await env('SG');
      await runS(e, snap([sup(L, 'Acme Foods')]));
      const [s] = await suppliers(e.orgId);
      const err = await failure(call(e.orgId, 'editSupplier', e.staff, { supplierId: s!.id, status: 'inactive' }));
      expect(err).toBeInstanceOf(AuthorizationError);
      expect((await suppliers(e.orgId))[0]!.status).toBe('active');
      await call(e.orgId, 'editSupplier', e.manager, { supplierId: s!.id, status: 'active' }); // same status: nothing to record
      expect(await audits(e.orgId, 'set_supplier_status')).toHaveLength(0);
      await call(e.orgId, 'editSupplier', e.manager, { supplierId: s!.id, status: 'inactive' });
      const a = await audits(e.orgId, 'set_supplier_status');
      expect(a).toHaveLength(1);
      expect(a[0].before).toMatchObject({ status: 'active' });
      expect(a[0].after).toMatchObject({ status: 'inactive' });
    },
    60_000,
  );

  it.each(['manager', 'staff'] as const)(
    'setCustomerStatus is gated on manage_chart_of_accounts: %s is refused (AuthorizationError), row unchanged, no audit; an admin may. Killing mutant: the authorize call removed',
    async (who) => {
      const e = await env(`CG${who[0]}`);
      await runC(e, snap([], [cust(L, 'Tonyo Eatery')]));
      const [c] = await customers(e.orgId);
      const err = await failure(call(e.orgId, 'setCustomerStatus', e[who], { customerId: c!.id, status: 'inactive' }));
      expect(err).toBeInstanceOf(AuthorizationError);
      expect((await customers(e.orgId))[0]!.status).toBe('active');
      expect(await audits(e.orgId, 'set_customer_status')).toHaveLength(0);
      await call(e.orgId, 'setCustomerStatus', e.admin, { customerId: c!.id, status: 'inactive' });
      expect((await customers(e.orgId))[0]!.status).toBe('inactive');
      expect(await audits(e.orgId, 'set_customer_status')).toHaveLength(1);
    },
    60_000,
  );
});

describe('S4 apply - actor, held, dry run, idempotence', () => {
  it(
    'a manager (approve_supplier yes) may apply suppliers but NOT customers; a staff actor neither: AuthorizationError before any write. Killing mutant: the wrong capability on either apply',
    async () => {
      const e = await env('AU');
      const before = await state(e.orgId);
      expect(await failure(runC(e, snap([], [cust(L, 'Tonyo')]), { actor: e.manager }))).toBeInstanceOf(AuthorizationError);
      expect(await failure(runS(e, snap([sup(L, 'Acme Foods')]), { actor: e.staff }))).toBeInstanceOf(AuthorizationError);
      expect(await failure(runC(e, snap([], [cust(L, 'Tonyo')]), { actor: e.staff }))).toBeInstanceOf(AuthorizationError);
      expect(await state(e.orgId)).toEqual(before);
      expect(await runS(e, snap([sup(L, 'Acme Foods')]), { actor: e.manager })).toMatchObject({ created: 1 });
    },
    60_000,
  );

  it(
    'no actor, or an actor of another org, is refused and nothing is written; --org with the wrong org code is refused (assertRunTarget). Killing mutants: a default actor; the org not compared; the target check dropped',
    async () => {
      const e = await env('NA');
      const s = snap([sup(L, 'Acme Foods')]);
      const before = await state(e.orgId);
      expect(String(((await failure(runS(e, s, { actor: undefined }))) as Error).message)).toMatch(/actor/i);
      expect(String(((await failure(runS(e, s, { actor: { orgId: e.pgOrgId, personId: e.superA.personId } }))) as Error).message)).toMatch(/actor|org/i);
      expect(String(((await failure(runS(e, s, { orgCode: e.pgCode }))) as Error).message)).toMatch(/refused|--org/i);
      expect(await state(e.orgId)).toEqual(before);
    },
    60_000,
  );

  it(
    'anything held (a vat_status disagreement) refuses the whole apply and writes nothing, not even the clean rows. Killing mutant: apply what is ready, skip the held',
    async () => {
      const e = await env('HD');
      const s = snap([
        sup(L, 'Acme Foods', { vatStatus: 'VAT Reg', tin: '1' }),
        sup(M, 'Acme Foods', { vatStatus: 'Non-VAT Reg', tin: '1', updatedAt: '2026-09-01T00:00:00.000Z' }),
        sup(L, 'Clean Co'),
      ]);
      const before = await state(e.orgId);
      expect(String(((await failure(runS(e, s))) as Error).message)).toMatch(/held/i);
      expect(await state(e.orgId)).toEqual(before);
    },
    60_000,
  );

  it(
    'a second apply changes nothing: no supplier, no customer, no link, no status or mirror audit; only the apply rows themselves. Killing mutants: links re-inserted; the plan ignores existing links',
    async () => {
      const e = await env('ID');
      const s = snap(
        [sup(L, 'Acme Foods'), sup(M, 'Acme Foods'), sup(L, 'Dead Supplier', { isActive: false }), sup(L, 'SharEat Malvar', { linkedStoreId: M })],
        [cust(L, 'Tonyo'), cust(L, 'Dead Customer', { status: 'inactive' })],
      );
      await runS(e, s);
      await runC(e, s);
      const one = await state(e.orgId);
      expect(one.suppliers).toHaveLength(3);
      expect(one.customers).toHaveLength(2);

      expect(await runS(e, s)).toMatchObject({ created: 0, linked: 0, held: 0 });
      expect(await runC(e, s)).toMatchObject({ created: 0, linked: 0, held: 0 });
      const two = await state(e.orgId);
      expect(two.suppliers).toEqual(one.suppliers);
      expect(two.customers).toEqual(one.customers);
      expect(two.sLinks).toEqual(one.sLinks);
      expect(two.cLinks).toEqual(one.cLinks);
      expect(two.audit - one.audit).toBe(2); // the two apply rows, nothing else (no repeated status or mirror row)
    },
    60_000,
  );

  it(
    'a dry run commits nothing (rows, links, audit unchanged) and reports the counts the following apply writes. Killing mutant: commit in the dry run',
    async () => {
      const e = await env('DR');
      const s = snap([sup(L, 'Acme Foods'), sup(M, 'Acme Foods'), sup(L, 'Dead', { isActive: false })], [cust(L, 'Tonyo')]);
      const before = await state(e.orgId);
      const ds = await runS(e, s, { apply: false });
      const dc = await runC(e, s, { apply: false });
      expect(ds.dryRun).toBe(true);
      expect(dc.dryRun).toBe(true);
      expect(await state(e.orgId)).toEqual(before);
      const rs = await runS(e, s);
      const rc = await runC(e, s);
      expect({ created: ds.created, linked: ds.linked, held: ds.held }).toEqual({ created: rs.created, linked: rs.linked, held: rs.held });
      expect({ created: dc.created, linked: dc.linked, held: dc.held }).toEqual({ created: rc.created, linked: rc.linked, held: rc.held });
      expect(rs.created).toBe(2);
    },
    60_000,
  );
});

describe('S4 apply - existing rows, scope, drift', () => {
  it(
    'an exact-name supplier already in v2 is linked, not duplicated, and its row is untouched (I7). Killing mutants: a second row created; the v2 row edited from v1',
    async () => {
      const e = await env('EX');
      const [pre] = await sql<{ id: string }[]>`
        insert into suppliers (org_id, name, address, created_by) values (${e.orgId}, 'Acme Foods', 'Real St', ${e.superA.personId}) returning id`;
      const before = (await suppliers(e.orgId))[0];
      const r = await runS(e, snap([sup(L, 'ACME FOODS', { address: 'Different St', email: 'x@acme.test' })]));
      expect(r).toMatchObject({ created: 0, linked: 1 });
      expect((await links(e.orgId, 'supplier'))[0]!.v2_id).toBe(pre!.id);
      const after = await suppliers(e.orgId);
      expect(after).toHaveLength(1);
      expect(after[0]).toEqual(before);
    },
    60_000,
  );

  it(
    "--stores LIPA then --stores MLVR: Malvar's record links to Lipa's supplier, no duplicate, only Malvar-only names are created; Padre Garcia never. Killing mutant: the exact key made per store",
    async () => {
      const e = await env('SC');
      const s = snap([sup(L, 'Acme Foods'), sup(M, 'Acme Foods'), sup(L, 'Lipa Only'), sup(M, 'Malvar Only'), sup(P, 'Franchise Only')]);
      const r1 = await runS(e, s, { storeCodes: ['LIPA'] });
      expect(r1.created).toBe(2);
      expect((await links(e.orgId, 'supplier')).every((l) => l.v1_store_id === L)).toBe(true);
      const r2 = await runS(e, s, { storeCodes: ['MLVR'] });
      expect(r2.created).toBe(1);
      expect((await suppliers(e.orgId)).map((x) => x.name).sort()).toEqual(['Acme Foods', 'Lipa Only', 'Malvar Only']);
      const acme = (await suppliers(e.orgId)).find((x) => x.name === 'Acme Foods')!;
      expect((await links(e.orgId, 'supplier')).filter((l) => l.v2_id === acme.id).map((l) => l.v1_store_id).sort()).toEqual([L, M].sort());
      expect((await links(e.orgId, 'supplier')).some((l) => l.v1_store_id === P)).toBe(false);
      expect(await suppliers(e.pgOrgId)).toHaveLength(0);
    },
    60_000,
  );

  it(
    'test 23 drift: re-run with a changed supplier contact writes nothing to the linked supplier. Killing mutant: survivorship re-applied to linked rows',
    async () => {
      const e = await env('DF');
      const s1 = snap([sup(L, 'Acme Foods', { contacts: [{ name: 'Ana', phone: '0917-111-1111' }] })]);
      await runS(e, s1);
      const one = await state(e.orgId);
      const s2 = JSON.parse(JSON.stringify(s1));
      s2.suppliers[0].contacts = [{ name: 'Ana', phone: '0917-999-9999' }];
      s2.suppliers[0].updatedAt = '2026-12-01T00:00:00.000Z';
      expect(await runS(e, s2)).toMatchObject({ created: 0, linked: 0, held: 0 });
      const two = await state(e.orgId);
      expect(two.suppliers).toEqual(one.suppliers);
      expect(two.suppliers[0]!.contact_no).toBe('0917-111-1111');
    },
    60_000,
  );
});

describe('S4 apply - rulings', () => {
  it(
    'franchise-pointing rows never block: the other parties apply, held is 0, the franchise rows are not written. Killing mutant: franchise rows counted as held (apply refused)',
    async () => {
      const e = await env('FH');
      const s = snap(
        [sup(L, 'SharEat Padre Garcia', { linkedStoreId: P }), sup(L, 'Acme Foods')],
        [cust(L, 'SharEat Padre Garcia', { linkedStoreId: P }), cust(L, 'Tonyo')],
      );
      expect(await runS(e, s)).toMatchObject({ created: 1, linked: 1, held: 0 });
      expect(await runC(e, s)).toMatchObject({ created: 1, linked: 1, held: 0 });
      expect((await suppliers(e.orgId)).map((x) => x.name)).toEqual(['Acme Foods']);
      expect((await customers(e.orgId)).map((x) => x.name)).toEqual(['Tonyo']);
    },
    60_000,
  );

  it(
    'merged copies, one active one inactive, end active with no status audit row. Killing mutant: newest copy decides the status',
    async () => {
      const e = await env('MA');
      await runS(e, snap([sup(L, 'Acme Foods', { isActive: true }), sup(M, 'Acme Foods', { isActive: false, updatedAt: '2026-09-01T00:00:00.000Z' })]));
      expect((await suppliers(e.orgId))[0]!.status).toBe('active');
      expect(await audits(e.orgId, 'set_supplier_status')).toHaveLength(0);
    },
    60_000,
  );
});

describe('S4 apply - audit round', () => {
  it.each([Number.NaN, -5, 7.5])(
    'lastCreditDueDays %s does not make the apply throw: the supplier is created with null credit terms. Killing mutant: the bad number passed to createSupplier',
    async (bad) => {
      const e = await env('CT');
      const r = await runS(e, snap([sup(L, 'Acme Foods', { lastCreditDueDays: bad })]));
      expect(r).toMatchObject({ created: 1, held: 0 });
      expect((await suppliers(e.orgId))[0]!.credit_terms_days).toBeNull();
    },
    60_000,
  );

  it(
    'g: a manager (approve_supplier yes, manage_chart_of_accounts no) running the combined apply with customers in scope is refused BEFORE anything is written: no supplier, no customer, no link, no audit row; the error names the missing capability. Contract addition: applyMasterData({ snapshot, snapshotSha, map, orgId, orgCode, storeCodes?, answers, actor, apply, only?: string[] }) in scripts/lib/master-data-apply.ts runs the entities in R3 order after an UPFRONT authorize of every entity in scope. Killing mutant: suppliers applied first, customers refused after',
    async () => {
      const e = await env('PR');
      const mod: Any = await import('../../../../scripts/lib/master-data-apply');
      expect(typeof mod.applyMasterData).toBe('function');
      const s = snap([sup(L, 'Acme Foods')], [cust(L, 'Tonyo')]);
      const before = await state(e.orgId);
      const err = await failure(
        mod.applyMasterData({ snapshot: s, snapshotSha: SHA, map: e.map, orgId: e.orgId, orgCode: e.orgCode, answers: {}, actor: e.manager, apply: true, only: ['suppliers', 'customers'] }),
      );
      expect(err).toBeInstanceOf(AuthorizationError);
      expect(String((err as Error).message)).toMatch(/manage_chart_of_accounts/);
      expect(await state(e.orgId)).toEqual(before);
    },
    60_000,
  );
});

describe('S4 apply - re-audit round', () => {
  const item = (store: string, name: string): Any => ({ id: `it${++rid}`, store, name, kind: 'raw_material', baseUnit: 'kg' });
  const mixed = (): Any => ({
    ...snap([sup(L, 'Acme Foods Inc'), sup(M, 'ACME FOODS INC.')]),
    items: [item(L, 'Flour')],
  });
  const all = async (e: Env, s: Any, over: Record<string, unknown> = {}) => {
    const mod: Any = await import('../../../../scripts/lib/master-data-apply');
    return mod.applyMasterData({ snapshot: s, snapshotSha: SHA, map: e.map, orgId: e.orgId, orgCode: e.orgCode, answers: {}, actor: e.superA, apply: true, ...over });
  };
  const itemCount = async (orgId: string) => Number((await sql<Any[]>`select count(*)::int as n from items where org_id = ${orgId}`)[0]!.n);

  it(
    'a: items commit, then suppliers hit held: the error says items were ALREADY COMMITTED (with created and linked counts) and to RERUN; items stay; a rerun with the answers finishes without re-creating them. Killing mutant: the bare HeldError message',
    async () => {
      const e = await env('PC');
      const s = mixed();
      const err = await failure(all(e, s));
      const msg = String((err as Error).message);
      expect(msg).toMatch(/already committed/i);
      expect(msg).toMatch(/created\D*1/i);
      expect(msg).toMatch(/linked\D*1/i);
      expect(msg).toMatch(/rerun/i);
      expect(msg).toMatch(/held/i);
      expect(await itemCount(e.orgId)).toBe(1);
      expect(await suppliers(e.orgId)).toHaveLength(0);

      const mod: Any = await import('../../../etl/src/master-data/parties-plan');
      const first = mod.planParties({ snapshot: s, map: e.map, orgCode: e.orgCode, existingSuppliers: [], existingCustomers: [], links: [], answers: {} });
      const rows = first.sheets['suppliers-twins'].map((r: Any) => ({ ...r, same_or_different: 'same' }));
      const r = await all(e, s, { answers: { 'suppliers-twins': rows } });
      expect(r.items).toMatchObject({ created: 0, linked: 0 });
      expect(r.suppliers).toMatchObject({ created: 1, linked: 2 });
      expect(await itemCount(e.orgId)).toBe(1);
    },
    60_000,
  );

  it(
    'b: a DRY RUN by a manager with customers in scope is refused by the precheck (manage_chart_of_accounts) before anything is planned or written. Killing mutant: the precheck skipped when apply is false',
    async () => {
      const e = await env('PD');
      const before = await state(e.orgId);
      const err = await failure(all(e, snap([sup(L, 'Acme Foods')], [cust(L, 'Tonyo')]), { actor: e.manager, apply: false, only: ['suppliers', 'customers'] }));
      expect(err).toBeInstanceOf(AuthorizationError);
      expect(String((err as Error).message)).toMatch(/manage_chart_of_accounts/);
      expect(await state(e.orgId)).toEqual(before);
    },
    60_000,
  );

  it(
    'd: an unknown entity name in only (the singular supplier) throws and names it; nothing is written. Killing mutant: unknown names silently filtered out',
    async () => {
      const e = await env('UN');
      const before = await state(e.orgId);
      const err = await failure(all(e, snap([sup(L, 'Acme Foods')]), { only: ['supplier'] }));
      expect(String((err as Error).message)).toMatch(/supplier/);
      expect(String((err as Error).message)).toMatch(/unknown|not a/i);
      expect(await state(e.orgId)).toEqual(before);
      const err2 = await failure(all(e, snap([sup(L, 'Acme Foods')]), { only: ['suppliers', 'vendors'] }));
      expect(String((err2 as Error).message)).toMatch(/vendors/);
      expect(await state(e.orgId)).toEqual(before);
    },
    60_000,
  );
});
