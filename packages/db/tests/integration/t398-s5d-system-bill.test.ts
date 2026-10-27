/**
 * T-398 S5d (TESTER), QI-2 = A (Ian, 26 Oct; bible row 389) - the SYSTEM-MADE bill the buyer's receipt creates.
 * docs/tasks/398-s5/QUESTIONS.md "QI-2". Real Postgres (TEST_DATABASE_URL, `_test` guard); app-role legs run as shareat_app inside a
 * ROLLED-BACK transaction, owner legs on the connection owner.
 *
 * COLUMN NAMES THIS FILE ASSUMES (the spec does not name them; flagged in the hand-back): supplier_invoices.system_made boolean NOT NULL
 * DEFAULT false, and supplier_invoices.inter_entity_shipment_id uuid NULL (the shipment the bill is for). The exempt shape is
 * created_by = verified_by (one person, no self_verified flag), status 'verified', all four attestations true.
 *
 * RULE: a flagged invoice is exempt from the two-person check ONLY when its total = its shipment's received_total and it links that
 * shipment (the shipment must be addressed to the invoice's org); only the owner/definer path sets the flag; flagged amounts are frozen.
 *
 * MUTANTS: app role may set the flag -> S2a, S2b; app role may clear it -> S2c; no total check -> S3a; amount editable -> S3b; exemption
 *   for every flagged invoice (no shipment link) -> S5b; link to another org's shipment accepted -> S5a; two-person rule loosened for
 *   ordinary invoices too -> S4a.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

import { menuFixture, sql, uid, asApp, type PgErr, type MenuFx } from './_fixtures/t401-menu';

config({ path: '.env.local' });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

type Tx = postgres.TransactionSql;
const asSql = (q: Tx | postgres.Sql) => q as unknown as postgres.Sql;
const BROKEN = ['42P01', '42703', '42883', '42704']; // missing object / column: the behaviour is not built, which is not a refusal
const GUARD = ['42501', '23514'];

async function owner(fn: () => PromiseLike<unknown>): Promise<PgErr | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e as PgErr;
  }
}
function refused(err: PgErr | undefined, why: string, codes = GUARD) {
  expect(err, `${why}: the statement was ACCEPTED`).toBeDefined();
  expect(BROKEN, `${why}: raised ${err?.code} ${err?.message} - an object is missing, not a refusal`).not.toContain(err?.code);
  expect(codes, `${why}: wrong SQLSTATE ${err?.code} (${err?.message})`).toContain(err?.code);
}

interface World { a: MenuFx; b: MenuFx; c: MenuFx; supplierB: string; verifierB: string }
let worldP: Promise<World> | undefined;
const world = () => (worldP ??= (async () => {
  const a = await menuFixture('s5sa');
  const b = await menuFixture('s5sb');
  const c = await menuFixture('s5sc');
  await sql`insert into customers (org_id, name, counterparty_org_id, created_by) values (${a.orgId}, ${uid('PG')}, ${b.orgId}, ${a.personId})`;
  await sql`insert into customers (org_id, name, counterparty_org_id, created_by) values (${a.orgId}, ${uid('C')}, ${c.orgId}, ${a.personId})`;
  const [sup] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, status, created_by, counterparty_org_id) values (${b.orgId}, ${uid('Commissary')}, 'active', ${b.personId}, ${a.orgId}) returning id`;
  const [ver] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${b.orgId}, 'Second person') returning id`;
  return { a, b, c, supplierB: sup!.id, verifierB: ver!.id };
})());

/** A received shipment a -> `to` (owner, one transaction): 10.000 kg at 310.00 billed 3100.00; received_total as given. */
async function shipment(w: World, o: { to?: MenuFx; received?: string } = {}) {
  const to = o.to ?? w.b;
  const received = o.received ?? '2480.00';
  const [cust] = await sql<{ id: string }[]>`select id from customers where org_id = ${w.a.orgId} and counterparty_org_id = ${to.orgId} limit 1`;
  return sql.begin(async (tx) => {
    const t = asSql(tx);
    const [ord] = await t<{ id: string }[]>`
      insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount, created_by)
      values (${w.a.orgId}, ${w.a.storeId}, ${cust!.id}, current_date, 'draft', '3100.00', ${w.a.personId}) returning id`;
    const [ol] = await t<{ id: string }[]>`
      insert into trade_order_lines (org_id, order_id, item_id, quantity, unit, rate, line_total)
      values (${w.a.orgId}, ${ord!.id}, ${w.a.stockItemId}, '10.000', 'kg', '310.00', '3100.00') returning id`;
    const [sh] = await t<{ id: string }[]>`
      insert into inter_entity_shipments (org_id, buyer_org_id, trade_order_id, store_id, shipped_on, billed_total, status)
      values (${w.a.orgId}, ${to.orgId}, ${ord!.id}, ${w.a.storeId}, '2026-12-01', '3100.00', 'in_transit') returning id`;
    await t`
      insert into inter_entity_shipment_lines (org_id, buyer_org_id, shipment_id, trade_order_line_id, line_no, item_name, unit, quantity, rate, line_total)
      values (${w.a.orgId}, ${to.orgId}, ${sh!.id}, ${ol!.id}, 1, 'Pork belly', 'kg', '10.000', '310.00', '3100.00')`;
    await t`update inter_entity_shipment_lines set received_quantity = '8.000' where shipment_id = ${sh!.id}`;
    await t`update inter_entity_shipments set status = 'received', received_at = now(), received_by = ${to.personId}, received_total = ${received} where id = ${sh!.id}`;
    return sh!.id;
  });
}

/** An invoice in org b (owner). A system-made row is the exempt shape: one person created and verified it. */
async function invoice(w: World, o: { systemMade?: boolean; shipmentId?: string | null; total?: string; verifiedBy?: string } = {}) {
  const sys = o.systemMade ?? false;
  const verifiedBy = o.verifiedBy ?? (sys ? w.b.personId : w.verifierB);
  const ship = o.shipmentId ?? null;
  if (!sys && ship === null) {
    // an ordinary invoice names neither new column, so the S4 controls run on today's schema too
    const [r] = await sql<{ id: string }[]>`
      insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, status, verified_by, verified_at,
                                     attested_supplier, attested_invoice, attested_items, attested_price, created_by)
      values (${w.b.orgId}, ${w.b.storeId}, ${w.supplierB}, '2026-12-02', ${o.total ?? '2480.00'}, 'verified', ${verifiedBy}, now(),
              true, true, true, true, ${w.b.personId}) returning id`;
    return r!.id;
  }
  const [r] = await sql<{ id: string }[]>`
    insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, status, verified_by, verified_at,
                                   attested_supplier, attested_invoice, attested_items, attested_price, system_made, inter_entity_shipment_id, created_by)
    values (${w.b.orgId}, ${w.b.storeId}, ${w.supplierB}, '2026-12-02', ${o.total ?? '2480.00'}, 'verified', ${verifiedBy}, now(),
            true, true, true, true, ${sys}, ${ship}, ${w.b.personId}) returning id`;
  return r!.id;
}
const count = async (w: World) => (await sql<{ n: number }[]>`select count(*)::int n from supplier_invoices where org_id = ${w.b.orgId}`)[0]!.n;
const row = async (id: string) =>
  (await sql<{ system_made: boolean; total_amount: string }[]>`select coalesce((to_jsonb(supplier_invoices) ->> 'system_made')::boolean, false) as system_made, total_amount::text from supplier_invoices where id = ${id}`)[0]!;

// ================================================================================================ S2
describe('S2 only the owner/definer path sets or clears the system-made flag', () => {
  it('S2a. the app role INSERTing an ordinary invoice with system_made = true is refused (42501 / 23514); nothing written', async () => {
    const w = await world();
    const ship = await shipment(w);
    const before = await count(w);
    const r = await asApp(w.b.orgId, (tx) => asSql(tx)`
      insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, status, system_made, inter_entity_shipment_id, created_by)
      values (${w.b.orgId}, ${w.b.storeId}, ${w.supplierB}, '2026-12-02', '2480.00', 'pending', true, ${ship}, ${w.b.personId})`);
    refused(r.err, 'S2a app INSERT with system_made');
    expect(await count(w)).toBe(before);
  });

  it('S2b. the app role UPDATEing an ordinary invoice to system_made = true is refused; the row is unchanged', async () => {
    const w = await world();
    const id = await invoice(w);
    const r = await asApp(w.b.orgId, (tx) => asSql(tx)`update supplier_invoices set system_made = true where id = ${id}`);
    refused(r.err, 'S2b app UPDATE to system_made');
    expect((await row(id)).system_made).toBe(false);
  });

  it('S2c. the app role clearing the flag on a system-made invoice is refused; the flag stays', async () => {
    const w = await world();
    const ship = await shipment(w);
    const id = await invoice(w, { systemMade: true, shipmentId: ship });
    const r = await asApp(w.b.orgId, (tx) => asSql(tx)`update supplier_invoices set system_made = false where id = ${id}`);
    refused(r.err, 'S2c app UPDATE clearing system_made');
    expect((await row(id)).system_made).toBe(true);
  });
});

// ================================================================================================ S3
describe('S3 a system-made invoice equals its shipment received total, and its amount is frozen', () => {
  it('S3a. owner insert with a total that differs from received_total is refused 23514; the exact total is accepted (control)', async () => {
    const w = await world();
    const ship = await shipment(w, { received: '2480.00' });
    const before = await count(w);
    refused(await owner(() => invoice(w, { systemMade: true, shipmentId: ship, total: '2480.01' })), 'S3a wrong total', ['23514']);
    expect(await count(w)).toBe(before);
    const id = await invoice(w, { systemMade: true, shipmentId: ship, total: '2480.00' });
    expect((await row(id)).system_made).toBe(true);
  });

  it('S3b. the app role changing total_amount of a system-made invoice is refused; the amount is unchanged', async () => {
    const w = await world();
    const ship = await shipment(w);
    const id = await invoice(w, { systemMade: true, shipmentId: ship });
    const r = await asApp(w.b.orgId, (tx) => asSql(tx)`update supplier_invoices set total_amount = '1.00' where id = ${id}`);
    refused(r.err, 'S3b app UPDATE of total_amount');
    expect((await row(id)).total_amount).toBe('2480.00');
  });
});

// ================================================================================================ S4
describe('S4 control: an ordinary invoice is unchanged', () => {
  it('S4a. verified_by = created_by with no admin self-verify is still refused 23514 (two-person rule)', async () => {
    const w = await world();
    const before = await count(w);
    refused(await owner(() => invoice(w, { verifiedBy: w.b.personId })), 'S4a ordinary self-verification', ['23514']);
    expect(await count(w)).toBe(before);
  });

  it('S4b. a second person verifying is accepted (control)', async () => {
    const w = await world();
    const id = await invoice(w);
    expect((await row(id)).system_made).toBe(false);
  });
});

// ================================================================================================ S5
describe('S5 the flag needs a real link to a shipment addressed to the invoice org', () => {
  it('S5a. a system-made invoice pointing at ANOTHER org shipment (addressed to C, invoice in B) is refused; nothing written', async () => {
    const w = await world();
    const other = await shipment(w, { to: w.c });
    const before = await count(w);
    refused(await owner(() => invoice(w, { systemMade: true, shipmentId: other })), 'S5a foreign shipment', ['23514', '23503']);
    expect(await count(w)).toBe(before);
  });

  it('S5b. a system-made invoice with NO shipment link is refused 23514 (the flag alone buys no exemption); nothing written', async () => {
    const w = await world();
    const before = await count(w);
    refused(await owner(() => invoice(w, { systemMade: true })), 'S5b no link', ['23514']);
    expect(await count(w)).toBe(before);
  });
});

// ================================================================================================ A1 (auditor, MEDIUM)
interface Stored { id: string; supplier_id: string; store_id: string; system_made: boolean }
/** The definer called directly as the app role, as `person`; returns the stored row seen inside the (rolled-back) transaction. */
async function callDefiner(w: World, ship: string, person: string, o: { supplierId?: string; storeId?: string } = {}) {
  return asApp(w.b.orgId, async (tx) => {
    const t = asSql(tx);
    await t`select set_config('app.person_id', ${person}, true)`;
    const [r] = await t<{ id: string }[]>`
      select create_system_supplier_invoice(${ship}::uuid, ${o.storeId ?? w.b.storeId}::uuid, ${o.supplierId ?? w.supplierB}::uuid, '2026-12-02'::date, null::date, null::text) as id`;
    const [row] = await t<Stored[]>`select id, supplier_id, store_id, system_made from supplier_invoices where id = ${r!.id}`;
    return row!;
  });
}
const systemBills = async (ship: string) =>
  (await sql<{ n: number }[]>`select count(*)::int n from supplier_invoices where inter_entity_shipment_id = ${ship}`)[0]!.n;

describe('A1 create_system_supplier_invoice called directly by the app role', () => {
  it('A1a. a person who is NOT the shipment\'s received_by is refused (42501); no bill is written', async () => {
    const w = await world();
    const ship = await shipment(w); // received_by = w.b.personId
    const r = await callDefiner(w, ship, w.verifierB);
    refused(r.err, 'A1a other person files the bill');
    expect(await systemBills(ship)).toBe(0);
  });

  it('A1b. once per shipment, ever: a second system bill is refused, even after the first was voided; the count stays at one', async () => {
    const w = await world();
    const live = await shipment(w);
    await invoice(w, { systemMade: true, shipmentId: live });
    refused((await callDefiner(w, live, w.b.personId)).err, 'A1b second bill while one is live', [...GUARD, '23505']);
    expect(await systemBills(live)).toBe(1);

    const voided = await shipment(w);
    const first = await invoice(w, { systemMade: true, shipmentId: voided });
    await sql`update supplier_invoices set status = 'voided', voided_by = ${w.verifierB}, voided_at = now(), void_reason = 'test' where id = ${first}`;
    refused((await callDefiner(w, voided, w.b.personId)).err, 'A1b second bill after the first was voided', [...GUARD, '23505']);
    expect(await systemBills(voided)).toBe(1);
  });

  it('A1c. the supplier and store are derived (PG supplier row of the seller org; the shipment delivery store), not caller-supplied: a stray supplier/store is refused, or the stored values equal the derived ones', async () => {
    const w = await world();
    const ship = await shipment(w);
    await sql`insert into deliveries (org_id, store_id, kind, supplier_id, delivered_on, status, received_by, received_at, created_by, inter_entity_shipment_id)
              values (${w.b.orgId}, ${w.b.storeId}, 'inter_entity', ${w.supplierB}, '2026-12-02', 'received', ${w.b.personId}, now(), ${w.b.personId}, ${ship})`;
    const [stray] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, status, created_by) values (${w.b.orgId}, ${uid('Stray')}, 'active', ${w.b.personId}) returning id`;
    const r = await callDefiner(w, ship, w.b.personId, { supplierId: stray!.id, storeId: w.b.store2Id });
    if (r.err) {
      refused(r.err, 'A1c stray supplier/store');
      expect(await systemBills(ship)).toBe(0);
    } else {
      expect({ supplier: r.value!.supplier_id, store: r.value!.store_id }, 'caller-supplied supplier/store were stored').toEqual({ supplier: w.supplierB, store: w.b.storeId });
    }
  });
});

// ================================================================================================ A2 (LOW)
describe('A2 the app role cannot change status, verifier or attestations of a system-made bill', () => {
  const edits: [string, (id: string, w: World) => string, string][] = [
    ['status -> voided', () => `status = 'voided', voided_by = '00000000-0000-0000-0000-000000000000', voided_at = now(), void_reason = 'x'`, 'status'],
    ['verified_by', (_id, w) => `verified_by = '${w.verifierB}'`, 'verified_by'],
    ['verified_at', () => `verified_at = now() + interval '1 day'`, 'verified_at'],
    ['attested_price', () => `attested_price = false`, 'attested_price'],
  ];
  for (const [label, setClause, col] of edits) {
    it(`A2. ${label}: refused 42501; the row is unchanged`, async () => {
      const w = await world();
      const ship = await shipment(w);
      const id = await invoice(w, { systemMade: true, shipmentId: ship });
      const [before] = await sql<Record<string, unknown>[]>`select status, verified_by, verified_at, attested_price from supplier_invoices where id = ${id}`;
      const stmt = setClause(id, w).replace('00000000-0000-0000-0000-000000000000', w.verifierB);
      const r = await asApp(w.b.orgId, (tx) => asSql(tx).unsafe(`update supplier_invoices set ${stmt} where id = $1`, [id]));
      refused(r.err, `A2 app UPDATE of ${col}`, ['42501']);
      const [after] = await sql<Record<string, unknown>[]>`select status, verified_by, verified_at, attested_price from supplier_invoices where id = ${id}`;
      expect(after).toEqual(before);
    });
  }
});

// ================================================================================================ A3 (INFO, re-ruled 26 Oct)
describe('A3 the restated two-person constraint stays NOT VALID on purpose but is live for new rows', () => {
  // stays NOT VALID like 0046/0217: legacy rows; orchestrator 26 Oct (a failed VALIDATE would abort the deploy)
  it('A3. supplier_invoices_two_person_verification_check has convalidated = false AND a new ordinary self-verified-by-a-non-admin invoice is still refused 23514, nothing written', async () => {
    const [c] = await sql<{ convalidated: boolean }[]>`select convalidated from pg_constraint where conname = 'supplier_invoices_two_person_verification_check' and conrelid = 'supplier_invoices'::regclass`;
    expect(c, 'constraint missing').toBeDefined();
    expect(c!.convalidated, 'validated: legacy rows would make the deploy fail').toBe(false);
    const w = await world();
    const before = await count(w);
    refused(await owner(() => invoice(w, { verifiedBy: w.b.personId })), 'A3 new row, self-verified by a non-admin', ['23514']);
    expect(await count(w)).toBe(before);
  });
});
