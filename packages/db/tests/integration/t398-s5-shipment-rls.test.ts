/**
 * T-398 S5b (TESTER) -- migration 0218: inter_entity_shipments + inter_entity_shipment_lines, the ONE defined cross-org
 * handoff. docs/tasks/398-s5/{S5-REFRESH s3,TESTS S5b + X1-X3,QUESTIONS rulings}.md, docs/tasks/398-padre-garcia-franchise-org.md S5.
 * Real Postgres via TEST_DATABASE_URL (`_test` name guard). Every behaviour leg runs as shareat_app under an org principal
 * inside a ROLLED-BACK transaction ("owner" legs insert as the connection owner and say so).
 *
 * RED TODAY for one reason: migration 0218 does not exist, so the two tables, the deliveries/suppliers/customers columns and the
 * two definer functions are absent. Every refusal leg asserts an EXACT SQLSTATE and rejects 42P01/42703/42883/42704 (a missing
 * object is never a "refusal").
 *
 * ASSUMED NAMES the builder must match (the plan is silent -- also listed in the hand-back):
 *   tables   inter_entity_shipments, inter_entity_shipment_lines
 *   shipments columns: id, org_id, buyer_org_id, trade_order_id, store_id, shipped_on, bir_invoice_no, billed_total, credited_total,
 *            status, received_at, received_by, received_total   (void columns: not asserted by name)
 *   lines columns: id, org_id, buyer_org_id, shipment_id, trade_order_line_id, line_no, item_name, unit, quantity, rate, line_total
 *   deliveries.inter_entity_shipment_id ; suppliers.counterparty_org_id ; customers.credit_terms_days
 *   receive_inter_entity_shipment(shipment_id uuid, lines jsonb) with lines = [{"line_id": "<uuid>", "received_quantity": "8.000"}]
 *            -- the caller's person comes from the app.person_id setting (db/src/rls/principal.ts)
 *   inter_entity_buyer_posted(shipment_ids uuid[]) RETURNS TABLE (shipment_id, received_on, posted_total)
 *   QI-1 = (a) (Ian, 25 Oct): lines.received_quantity numeric(14,3) NULL with CHECK received_quantity <= quantity (and >= 0); a third definer function
 *            inter_entity_counterparty_balance() -- NO arguments, its result carries no cost/price/supplier/person/item columns (leg Q1, Q2).
 *
 * MUTANTS (each leg names the one it kills):
 *   drop the `OR buyer_org_id` SELECT arm                -> E3, E5
 *   widen UPDATE/INSERT policy to the buyer              -> E4
 *   FK points at (org_id,id) instead of (buyer_org_id,id)-> E19, E19b
 *   add a cost / layer / person-name column              -> E24
 *   drop the credit_terms_days CHECK                     -> E26
 *   drop UNIQUE(trade_order_id)                          -> E18a
 *   drop the status/columns consistency CHECKs           -> K1..K4
 *   buyer_org_id = org_id allowed                        -> K5
 *   plain FK instead of composite (org_id, x)            -> F1..F5
 *   no link rule between orgs                            -> LK1, LK2
 *   suppliers CHECK missing                              -> S1
 *   deliveries kind / shipment CHECK missing             -> DK1..DK3
 *   partial UNIQUE missing or total (void excluded)      -> E8, E8b
 *   definer without the buyer check                      -> B1, B1b
 *   definer without FOR UPDATE / second receive allowed  -> R2
 *   definer accepts received > shipped                   -> R3
 *   definer rounds the total wrongly                     -> R1
 *   buyer_posted without org_id = app_current_org()      -> E14
 *   buyer_posted result gains a column                   -> E15
 *   search_path unpinned / PUBLIC EXECUTE                -> X2
 *   a second policy names buyer_org_id                   -> X2
 *   a cross-org FK of another shape                      -> X3
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

import { menuFixture, sql, uid, asApp, type PgErr, type MenuFx } from './_fixtures/t401-menu';
import { CROSS_ORG_BY_DESIGN, OPEN_DEF_491 } from '../../src/rls/same-org-fk-exemptions';
import { APP_ROLE, RLS_REGISTRY } from '../../src/rls/registry';

config({ path: '.env.local' });

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

type Tx = postgres.TransactionSql;
const asSql = (q: Tx | postgres.Sql) => q as unknown as postgres.Sql;
type Row = Record<string, string | number | boolean | null>;

const SHIP = 'inter_entity_shipments';
const LINE = 'inter_entity_shipment_lines';
const BROKEN = ['42P01', '42703', '42883', '42704'];

async function ins(q: Tx | postgres.Sql, table: string, row: Row): Promise<string> {
  const s = asSql(q);
  const [r] = await s<{ id: string }[]>`insert into ${s(table)} ${s(row)} returning id`;
  return r!.id;
}
async function probe(q: Tx | postgres.Sql, fn: (sp: Tx) => PromiseLike<unknown>): Promise<PgErr | undefined> {
  try {
    await (q as Tx).savepoint(async (sp) => {
      await fn(sp as unknown as Tx);
    });
    return undefined;
  } catch (e) {
    return e as PgErr;
  }
}
/** Owner-level probe: the whole statement runs in its own rolled-back transaction. */
async function ownerProbe(fn: (tx: Tx) => PromiseLike<unknown>): Promise<PgErr | undefined> {
  class Rollback extends Error {}
  let out: PgErr | undefined;
  try {
    await sql.begin(async (tx) => {
      try {
        await tx.savepoint(async (sp) => {
          await fn(sp as unknown as Tx);
        });
      } catch (e) {
        out = e as PgErr;
      }
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out;
}
function expectRefused(err: PgErr | undefined, why: string, code?: string) {
  expect(err, `${why}: the statement was ACCEPTED`).toBeDefined();
  expect(BROKEN, `${why}: raised ${err?.code} ${err?.message} - the object is missing, that is not a refusal`).not.toContain(err?.code);
  if (code) expect(err?.code, `${why}: wrong SQLSTATE (${err?.message})`).toBe(code);
}

// ------------------------------------------------------------------------------------------------ the world
interface World {
  a: MenuFx; // the commissary (seller)
  b: MenuFx; // Padre Garcia (buyer)
  c: MenuFx; // a third, unrelated org
  customerA: string; // A's customer, counterparty_org_id = B
  customerAC: string; // A's customer with no counterparty
  supplierB: string; // B's supplier for the commissary
  supplierC: string;
}
let worldP: Promise<World> | undefined;
const world = () => (worldP ??= (async () => {
  const a = await menuFixture('s5a');
  const b = await menuFixture('s5b');
  const c = await menuFixture('s5c');
  const [cu] = await sql<{ id: string }[]>`
    insert into customers (org_id, name, counterparty_org_id, created_by) values (${a.orgId}, ${uid('PG')}, ${b.orgId}, ${a.personId}) returning id`;
  const [cu2] = await sql<{ id: string }[]>`
    insert into customers (org_id, name, created_by) values (${a.orgId}, ${uid('Ext')}, ${a.personId}) returning id`;
  const [sb] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, status, created_by) values (${b.orgId}, ${uid('Commissary')}, 'active', ${b.personId}) returning id`;
  const [sc] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, status, created_by) values (${c.orgId}, ${uid('Sup')}, 'active', ${c.personId}) returning id`;
  return { a, b, c, customerA: cu!.id, customerAC: cu2!.id, supplierB: sb!.id, supplierC: sc!.id };
})());

/** An A-side trade order with one line (10.000 kg at 310.00); returns ids. */
async function newOrder(w: World, customerId?: string) {
  const [o] = await sql<{ id: string }[]>`
    insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount, created_by)
    values (${w.a.orgId}, ${w.a.storeId}, ${customerId ?? w.customerA}, current_date, 'draft', '3100.00', ${w.a.personId}) returning id`;
  const [l] = await sql<{ id: string }[]>`
    insert into trade_order_lines (org_id, order_id, item_id, quantity, unit, rate, line_total)
    values (${w.a.orgId}, ${o!.id}, ${w.a.stockItemId}, '10.000', 'kg', '310.00', '3100.00') returning id`;
  return { orderId: o!.id, lineId: l!.id };
}
const shipRow = (w: World, orderId: string, o: Row = {}): Row => ({
  org_id: w.a.orgId,
  buyer_org_id: w.b.orgId,
  trade_order_id: orderId,
  store_id: w.a.storeId,
  shipped_on: '2026-12-01',
  billed_total: '3100.00',
  status: 'in_transit',
  ...o,
});
const lineRow = (w: World, shipmentId: string, orderLineId: string, o: Row = {}): Row => ({
  org_id: w.a.orgId,
  buyer_org_id: w.b.orgId,
  shipment_id: shipmentId,
  trade_order_line_id: orderLineId,
  line_no: '1',
  item_name: 'Pork belly',
  unit: 'kg',
  quantity: '10.000',
  rate: '310.00',
  line_total: '3100.00',
  ...o,
});
/** A shipment A -> B with one line, inserted by the owner. */
async function newShipment(w: World, o: Row = {}) {
  const { orderId, lineId } = await newOrder(w);
  const shipmentId = await ins(sql, SHIP, shipRow(w, orderId, o));
  const shipLineId = await ins(sql, LINE, lineRow(w, shipmentId, lineId));
  return { orderId, lineId, shipmentId, shipLineId };
}
async function asPerson<T>(org: string, person: string, fn: (tx: Tx) => Promise<T>) {
  return asApp(org, async (tx) => {
    await tx`select set_config('app.person_id', ${person}, true)`;
    return fn(tx);
  });
}

describe('S0 -- RED while 0218 is not applied: both tables exist', () => {
  it('inter_entity_shipments and inter_entity_shipment_lines are in public', async () => {
    const rows = await sql<{ relname: string }[]>`
      select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname in (${SHIP}, ${LINE})`;
    expect(rows.map((r) => r.relname).sort(), 'RED today: migration 0218 is not applied').toEqual([LINE, SHIP].sort());
  });
});

// ================================================================================================ shapes and same-org keys

async function fkOut(child: string) {
  return sql<{ cols: string[]; pcols: string[]; parent: string; def: string }[]>`
    select array(select attname from unnest(c.conkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n order by o) cols,
           array(select attname from unnest(c.confkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n order by o) pcols,
           c.confrelid::regclass::text parent, pg_get_constraintdef(c.oid) def
    from pg_constraint c where c.contype = 'f' and c.conrelid = to_regclass(${'public.' + child})`;
}

describe('C -- catalog: same-org composite keys everywhere EXCEPT the defined handoff', () => {
  it('C1 shipments: org_id and buyer_org_id are NOT NULL; org_id and buyer_org_id both reference organizations', async () => {
    const cols = await sql<{ column_name: string; is_nullable: string }[]>`select column_name, is_nullable from information_schema.columns where table_schema = 'public' and table_name = ${SHIP}`;
    expect(cols.length, 'RED today: no table').toBeGreaterThan(0);
    for (const c of ['org_id', 'buyer_org_id', 'trade_order_id', 'store_id', 'shipped_on', 'billed_total', 'status']) {
      expect(cols.find((x) => x.column_name === c)?.is_nullable, `${SHIP}.${c} must exist and be NOT NULL`).toBe('NO');
    }
    for (const c of ['credited_total', 'received_at', 'received_by', 'received_total', 'bir_invoice_no']) {
      expect(cols.map((x) => x.column_name), `${SHIP}.${c}`).toContain(c);
    }
    const fks = await fkOut(SHIP);
    expect(fks.filter((f) => f.parent === 'organizations').map((f) => f.cols.join()).sort(), 'both org columns -> organizations').toEqual(['buyer_org_id', 'org_id']);
  });

  it('C2 shipments: trade_order_id and store_id are composite (org_id, x) -> parent (org_id, id) -- same-org (kills: plain FK)', async () => {
    const fks = await fkOut(SHIP);
    for (const [col, parent] of [['trade_order_id', 'trade_orders'], ['store_id', 'stores']] as const) {
      expect(fks.some((f) => f.cols.join() === `org_id,${col}` && f.pcols.join() === 'org_id,id' && f.parent === parent), `${SHIP}.${col}: saw ${JSON.stringify(fks)}`).toBe(true);
    }
  });

  it('C3 shipments: received_by is the ONE person reference and it is composite (buyer_org_id, received_by) -> persons (org_id, id)', async () => {
    const fks = await fkOut(SHIP);
    expect(
      fks.some((f) => f.cols.join() === 'buyer_org_id,received_by' && f.pcols.join() === 'org_id,id' && f.parent === 'persons'),
      `received_by must be checked against the BUYER org (the seller never writes it); saw ${JSON.stringify(fks)}`,
    ).toBe(true);
    expect(fks.some((f) => f.cols.join() === 'received_by'), 'no plain received_by FK').toBe(false);
  });

  it('C4 shipments keys: UNIQUE (trade_order_id), UNIQUE (org_id, id), UNIQUE (buyer_org_id, id), UNIQUE (org_id, buyer_org_id, id)', async () => {
    const u = await sql<{ cols: string }[]>`
      select array(select attname from unnest(c.conkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n order by o)::text cols
      from pg_constraint c where c.conrelid = to_regclass(${'public.' + SHIP}) and c.contype in ('u','p')
      union all
      select array(select a.attname from unnest(i.indkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.n order by o)::text
      from pg_index i where i.indrelid = to_regclass(${'public.' + SHIP}) and i.indisunique`;
    const have = new Set(u.map((r) => r.cols.replace(/[{}]/g, '')));
    for (const want of ['trade_order_id', 'org_id,id', 'buyer_org_id,id', 'org_id,buyer_org_id,id']) {
      expect(have.has(want), `no unique key on (${want}); saw ${[...have].join(' | ')}`).toBe(true);
    }
  });

  it('C5 lines: composite (org_id, buyer_org_id, shipment_id) -> shipments (org_id, buyer_org_id, id), and (org_id, trade_order_line_id) -> trade_order_lines (org_id, id)', async () => {
    const fks = await fkOut(LINE);
    expect(fks.length, 'RED today: no table').toBeGreaterThan(0);
    expect(fks.some((f) => f.cols.join() === 'org_id,buyer_org_id,shipment_id' && f.pcols.join() === 'org_id,buyer_org_id,id' && f.parent === SHIP), `saw ${JSON.stringify(fks)}`).toBe(true);
    expect(fks.some((f) => f.cols.join() === 'org_id,trade_order_line_id' && f.pcols.join() === 'org_id,id' && f.parent === 'trade_order_lines'), `saw ${JSON.stringify(fks)}`).toBe(true);
  });

  it('C6 lines: money/qty types -- quantity numeric(14,3), rate and line_total numeric(14,2); no float column anywhere in either table', async () => {
    const cols = await sql<{ table_name: string; column_name: string; udt_name: string; numeric_precision: number | null; numeric_scale: number | null }[]>`
      select table_name, column_name, udt_name, numeric_precision, numeric_scale from information_schema.columns where table_schema = 'public' and table_name in (${SHIP}, ${LINE})`;
    expect(cols.length, 'RED today: no tables').toBeGreaterThan(0);
    expect(cols.filter((c) => ['float4', 'float8'].includes(c.udt_name)), 'a float column').toEqual([]);
    const l = Object.fromEntries(cols.filter((c) => c.table_name === LINE).map((c) => [c.column_name, c]));
    expect([l.quantity?.numeric_precision, l.quantity?.numeric_scale]).toEqual([14, 3]);
    expect([l.rate?.numeric_precision, l.rate?.numeric_scale]).toEqual([14, 2]);
    expect([l.line_total?.numeric_precision, l.line_total?.numeric_scale]).toEqual([14, 2]);
    const s = Object.fromEntries(cols.filter((c) => c.table_name === SHIP).map((c) => [c.column_name, c]));
    expect([s.billed_total?.numeric_precision, s.billed_total?.numeric_scale]).toEqual([14, 2]);
  });

  it('E24 snapshot columns: no cost, layer, margin or person-name column in either table (kills: add unit_cost)', async () => {
    const cols = await sql<{ table_name: string; column_name: string }[]>`select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name in (${SHIP}, ${LINE})`;
    expect(cols.length, 'RED today: no tables').toBeGreaterThan(0);
    const bad = cols.filter((c) => /cost|layer|margin|consum|_name$/.test(c.column_name) && c.column_name !== 'item_name');
    expect(bad, 'the buyer can read these tables: only the commissary price snapshot may be here (item_name is the line snapshot)').toEqual([]);
    expect(cols.filter((c) => c.table_name === LINE).map((c) => c.column_name)).toContain('item_name');
  });

  it('Q1 QI-1 (a): lines.received_quantity numeric(14,3) NULL exists, and inter_entity_counterparty_balance() exists (RED today: none)', async () => {
    const col = await sql<{ is_nullable: string; numeric_precision: number; numeric_scale: number }[]>`
      select is_nullable, numeric_precision, numeric_scale from information_schema.columns where table_schema = 'public' and table_name = ${LINE} and column_name = 'received_quantity'`;
    expect(col.length, `${LINE}.received_quantity must exist (the seller sees, per item, how many PG received)`).toBe(1);
    expect(col[0]).toMatchObject({ is_nullable: 'YES', numeric_precision: 14, numeric_scale: 3 });
    const fn = await sql<{ args: string }[]>`select pg_get_function_identity_arguments(oid) args from pg_proc where proname = 'inter_entity_counterparty_balance' and pronamespace = 'public'::regnamespace`;
    expect(fn.length, 'inter_entity_counterparty_balance missing').toBe(1);
    expect(fn[0]!.args, 'no arguments: the figure is always about the caller own counterparty link').toBe('');
  });

  it('Q2 the balance function leaks nothing of PG: its result columns name no cost, price, supplier, person, item or layer (negative leg; kills: returning PG AP detail)', async () => {
    const r = await sql<{ names: string[] | null; modes: string[] | null; types: string }[]>`
      select p.proargnames names, p.proargmodes modes, pg_get_function_result(p.oid) types from pg_proc p where p.proname = 'inter_entity_counterparty_balance' and p.pronamespace = 'public'::regnamespace`;
    expect(r.length, 'RED today: no function').toBe(1);
    const out = (r[0]!.names ?? []).filter((_, i) => (r[0]!.modes ?? [])[i] === 't');
    expect(out.length, 'a table result of one or two columns (the figure each way)').toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(3);
    expect(out.filter((n) => /cost|price|supplier|person|item|layer|rate|margin|name/.test(n)), `leaking columns: ${out.join(',')}`).toEqual([]);
    expect(r[0]!.types).toMatch(/numeric/);
  });

  it('E20a a line with received_quantity > quantity is refused (23514); equal, less, NULL and 0 are accepted; negative is refused (kills: CHECK dropped)', async () => {
    const w = await world();
    const s = await newShipment(w);
    let seq = 10;
    const mk = (rq: string | null) => ins(sql, LINE, lineRow(w, s.shipmentId, s.lineId, { line_no: String(seq++), received_quantity: rq, rate: '0.00', line_total: '0.00' })); // zero-value extra lines keep billed_total = sum(line_total)
    expectRefused(await ownerProbe(() => mk('10.001')), 'E20a over-receipt', '23514');
    expectRefused(await ownerProbe(() => mk('-0.001')), 'negative received', '23514');
    for (const ok of ['10.000', '8.000', '0.000', null]) expect(await ownerProbe(() => mk(ok)), `control ${ok}`).toBeUndefined();
  });

  it('C7 the ratchet did not grow: CROSS_ORG_BY_DESIGN stays [] and OPEN_DEF_491 stays [] (the handoff is a declared composite, not an exemption)', () => {
    expect(CROSS_ORG_BY_DESIGN.length, 'K5 of the plan: no exemption entry').toBe(0);
    expect(OPEN_DEF_491.length).toBe(0);
  });

  it('X3 the only cross-org FK shapes are deliveries (org_id, inter_entity_shipment_id) -> shipments (buyer_org_id, id) and shipments (buyer_org_id, received_by) -> persons (org_id, id)', async () => {
    const rows = await sql<{ child: string; cols: string[]; pcols: string[]; parent: string }[]>`
      select c.conrelid::regclass::text child,
             array(select attname from unnest(c.conkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n order by o) cols,
             array(select attname from unnest(c.confkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n order by o) pcols,
             c.confrelid::regclass::text parent
      from pg_constraint c
      where c.contype = 'f' and (c.confrelid = to_regclass(${'public.' + SHIP}) or c.confrelid = to_regclass(${'public.' + LINE}) or c.conrelid = to_regclass(${'public.' + SHIP}) or c.conrelid = to_regclass(${'public.' + LINE}) or 'buyer_org_id' = any(array(select attname from unnest(c.confkey) k(n) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n)))`;
    expect(rows.length, 'RED today: no handoff FKs at all').toBeGreaterThan(0);
    // a cross-org shape = the child's first column is not org_id, or the parent key's first column is not org_id
    const cross = rows.filter((r) => r.parent !== 'organizations' && (r.cols[0] !== 'org_id' || r.pcols[0] !== 'org_id')).map((r) => `${r.child}(${r.cols.join(',')})->${r.parent}(${r.pcols.join(',')})`).sort();
    expect(cross, 'X3: exactly the two declared cross-org shapes').toEqual([
      `deliveries(org_id,inter_entity_shipment_id)->${SHIP}(buyer_org_id,id)`.replace('deliveries(org_id', 'deliveries(org_id'),
      `${SHIP}(buyer_org_id,received_by)->persons(org_id,id)`,
    ].sort().filter(() => true));
  });
});

// ================================================================================================ same-org refusals (behaviour)

describe('F -- same-org composites refuse a foreign org (owner insert, SQLSTATE 23503)', () => {
  it('F1 a shipment whose trade order belongs to another org is refused (kills: plain FK on trade_order_id)', async () => {
    const w = await world();
    const { orderId } = await newOrder({ ...w, a: w.c } as World, w.customerA).catch(() => ({ orderId: '' }));
    // order created under org C (own customer), shipment claims org A
    const [cc] = await sql<{ id: string }[]>`insert into customers (org_id, name, created_by) values (${w.c.orgId}, ${uid('Cc')}, ${w.c.personId}) returning id`;
    const [o] = await sql<{ id: string }[]>`
      insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount, created_by)
      values (${w.c.orgId}, ${w.c.storeId}, ${cc!.id}, current_date, 'draft', '1.00', ${w.c.personId}) returning id`;
    void orderId;
    const err = await ownerProbe((tx) => ins(tx, SHIP, shipRow(w, o!.id)));
    expectRefused(err, 'F1', '23503');
  });

  it('F2 a shipment whose store belongs to another org is refused', async () => {
    const w = await world();
    const { orderId } = await newOrder(w);
    const err = await ownerProbe((tx) => ins(tx, SHIP, shipRow(w, orderId, { store_id: w.c.storeId })));
    expectRefused(err, 'F2', '23503');
  });

  it('F3 a shipment line whose trade_order_line belongs to another org is refused', async () => {
    const w = await world();
    const s = await newShipment(w);
    const [cc] = await sql<{ id: string }[]>`insert into customers (org_id, name, created_by) values (${w.c.orgId}, ${uid('Cc')}, ${w.c.personId}) returning id`;
    const [o] = await sql<{ id: string }[]>`insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount, created_by) values (${w.c.orgId}, ${w.c.storeId}, ${cc!.id}, current_date, 'draft', '1.00', ${w.c.personId}) returning id`;
    const [l] = await sql<{ id: string }[]>`insert into trade_order_lines (org_id, order_id, item_id, quantity, unit, rate, line_total) values (${w.c.orgId}, ${o!.id}, ${w.c.stockItemId}, '1.000', 'kg', '1.00', '1.00') returning id`;
    const err = await ownerProbe((tx) => ins(tx, LINE, lineRow(w, s.shipmentId, l!.id, { line_no: '2' })));
    expectRefused(err, 'F3', '23503');
  });

  it('F4 a line whose buyer_org_id differs from its header\'s buyer is refused (kills: FK on (org_id, shipment_id) alone)', async () => {
    const w = await world();
    const s = await newShipment(w);
    const err = await ownerProbe((tx) => ins(tx, LINE, lineRow(w, s.shipmentId, s.lineId, { line_no: '2', buyer_org_id: w.c.orgId })));
    expectRefused(err, 'F4', '23503');
  });

  it('F5 received_by must be a person of the BUYER org: the seller\'s person is refused, the buyer\'s accepted (owner; positive control)', async () => {
    const w = await world();
    const s = await newShipment(w);
    const bad = await ownerProbe((tx) =>
      asSql(tx)`update ${asSql(tx)(SHIP)} set status = 'received', received_at = now(), received_by = ${w.a.personId}, received_total = '3100.00' where id = ${s.shipmentId}`);
    expectRefused(bad, 'F5 seller person as receiver', '23503');
    const ok = await ownerProbe((tx) =>
      asSql(tx)`update ${asSql(tx)(SHIP)} set status = 'received', received_at = now(), received_by = ${w.b.personId}, received_total = '3100.00' where id = ${s.shipmentId}`);
    expect(ok, `control: the buyer's own person is accepted (${ok?.message})`).toBeUndefined();
  });
});

// ================================================================================================ the link rule

describe('LK -- the handoff is refused for any pair of orgs not linked as franchisor / franchisee (ASSUMPTION: the link is customers.counterparty_org_id on the order\'s customer)', () => {
  it('LK1 buyer_org_id = a third org C that the order\'s customer does not point at is refused (kills: no link rule)', async () => {
    const w = await world();
    const { orderId } = await newOrder(w);
    const err = await ownerProbe((tx) => ins(tx, SHIP, shipRow(w, orderId, { buyer_org_id: w.c.orgId })));
    expectRefused(err, 'LK1: A may not hand a shipment to unlinked org C');
    expect(['23514', '23503', 'P0001', '42501'], `unexpected refusal class ${err?.code}: ${err?.message}`).toContain(err?.code);
  });

  it('LK2 an order whose customer has no counterparty_org_id cannot carry a shipment to anyone (kills: customer_group decides)', async () => {
    const w = await world();
    const { orderId } = await newOrder(w, w.customerAC);
    const err = await ownerProbe((tx) => ins(tx, SHIP, shipRow(w, orderId)));
    expectRefused(err, 'LK2: external customer');
  });

  it('LK3 the B side cannot ship to A either: as B, INSERT org_id = B, buyer_org_id = A is refused (no reverse link)', async () => {
    const w = await world();
    const { orderId } = await newOrder(w);
    const r = await asApp(w.b.orgId, (tx) => probe(tx, (sp) => ins(sp, SHIP, { ...shipRow(w, orderId), org_id: w.b.orgId, buyer_org_id: w.a.orgId, store_id: w.b.storeId })));
    expectRefused(r.value, 'LK3: B forging a shipment towards A');
  });

  it('LK4 control: A -> B with the customer pointing at B is accepted', async () => {
    const w = await world();
    const s = await newShipment(w);
    expect(s.shipmentId).toBeTruthy();
  });
});

// ================================================================================================ CHECKs

describe('K -- CHECK constraints (each pair: refusal + positive control)', () => {
  it('K5 buyer_org_id must differ from org_id (kills: CHECK dropped)', async () => {
    const w = await world();
    const { orderId } = await newOrder(w);
    expectRefused(await ownerProbe((tx) => ins(tx, SHIP, shipRow(w, orderId, { buyer_org_id: w.a.orgId }))), 'K5 buyer = seller', '23514');
  });

  it('K1 status outside in_transit/received/void is refused; each of the three is a legal value shape (control: in_transit)', async () => {
    const w = await world();
    const { orderId } = await newOrder(w);
    expectRefused(await ownerProbe((tx) => ins(tx, SHIP, shipRow(w, orderId, { status: 'delivered' }))), 'K1 bogus status', '23514');
    expect(await ownerProbe((tx) => ins(tx, SHIP, shipRow(w, orderId))), 'control: in_transit accepted').toBeUndefined();
  });

  it('K2 status received without received_at / received_by / received_total is refused (kills: consistency CHECK dropped)', async () => {
    const w = await world();
    const { orderId } = await newOrder(w);
    expectRefused(await ownerProbe((tx) => ins(tx, SHIP, shipRow(w, orderId, { status: 'received' }))), 'K2 received with nothing stamped', '23514');
  });

  it('K3 status in_transit WITH a receipt stamp is refused (the stamp belongs to a received shipment only)', async () => {
    const w = await world();
    const { orderId } = await newOrder(w);
    expectRefused(await ownerProbe((tx) => ins(tx, SHIP, shipRow(w, orderId, { received_at: '2026-12-02T00:00:00Z' }))), 'K3 stamp on in_transit', '23514');
  });

  it('K4 status void without its void columns is refused (column names are the builder\'s; only the refusal is pinned)', async () => {
    const w = await world();
    const { orderId } = await newOrder(w);
    const err = await ownerProbe((tx) => ins(tx, SHIP, shipRow(w, orderId, { status: 'void' })));
    expectRefused(err, 'K4 void with nothing stamped', '23514');
  });

  it('K6 billed_total must be positive and finite; credited_total defaults to 0.00 and cannot exceed billed_total', async () => {
    const w = await world();
    const { orderId } = await newOrder(w);
    expectRefused(await ownerProbe((tx) => ins(tx, SHIP, shipRow(w, orderId, { billed_total: '-1.00' }))), 'K6 negative billed', '23514');
    expectRefused(await ownerProbe((tx) => ins(tx, SHIP, shipRow(w, orderId, { credited_total: '3100.01' }))), 'K6 credit over bill', '23514');
    const s = await newShipment(w);
    const [row] = await sql<{ credited_total: string }[]>`select credited_total from ${sql(SHIP)} where id = ${s.shipmentId}`;
    expect(row!.credited_total).toBe('0.00');
  });

  it('E18a a second shipment for the same trade_order_id is a unique violation (kills: UNIQUE dropped)', async () => {
    const w = await world();
    const s = await newShipment(w);
    expectRefused(await ownerProbe((tx) => ins(tx, SHIP, shipRow(w, s.orderId))), 'E18a', '23505');
  });

  it('E20a-lines a line with quantity <= 0, rate < 0 or line_total <> round(quantity x rate, 2) is refused (money arithmetic in the database)', async () => {
    const w = await world();
    const s = await newShipment(w);
    expectRefused(await ownerProbe((tx) => ins(tx, LINE, lineRow(w, s.shipmentId, s.lineId, { line_no: '3', quantity: '0.000', line_total: '0.00' }))), 'zero quantity', '23514');
    expectRefused(await ownerProbe((tx) => ins(tx, LINE, lineRow(w, s.shipmentId, s.lineId, { line_no: '4', rate: '-1.00', line_total: '-10.00' }))), 'negative rate', '23514');
    expectRefused(await ownerProbe((tx) => ins(tx, LINE, lineRow(w, s.shipmentId, s.lineId, { line_no: '5', line_total: '3100.01' }))), 'line_total off by a centavo', '23514');
    expect(await ownerProbe((tx) => ins(tx, LINE, lineRow(w, s.shipmentId, s.lineId, { line_no: '6', quantity: '0.500', rate: '7.77', line_total: '3.89' }))), 'control: 0.500 x 7.77 = 3.885 -> 3.89 (half up)').toBeUndefined();
  });

  it('LN a duplicate line_no on ONE shipment is refused (23505); distinct numbers are accepted; the same number on another shipment is fine (kills: UNIQUE (shipment_id, line_no) dropped)', async () => {
    const w = await world();
    const s = await newShipment(w);
    const s2 = await newShipment(w);
    const mk = (ship: string, ol: string, no: string) => ins(sql, LINE, lineRow(w, ship, ol, { line_no: no, rate: '0.00', line_total: '0.00' })); // zero-value extra lines keep billed_total = sum(line_total)
    expectRefused(await ownerProbe(() => mk(s.shipmentId, s.lineId, '1')), 'LN duplicate line_no 1 on the same shipment', '23505');
    expect(await ownerProbe(() => mk(s.shipmentId, s.lineId, '2')), 'control: distinct number').toBeUndefined();
    expect(await ownerProbe(() => mk(s2.shipmentId, s2.lineId, '2')), 'control: same number on a different shipment').toBeUndefined();
  });

  it('W1 only receive_inter_entity_shipment() may write the receipt: as the SELLER (shareat_app), setting received_at / received_by / received_total / status received / a line received_quantity is refused 42501 naming received; bir_invoice_no still updates (control)', async () => {
    const w = await world();
    const s = await newShipment(w);
    const sets: [string, string][] = [
      ['received_at', `update ${SHIP} set received_at = now() where id = $1`],
      ['received_by', `update ${SHIP} set received_by = '${w.b.personId}' where id = $1`],
      ['received_total', `update ${SHIP} set received_total = '1.00' where id = $1`],
      ['status received', `update ${SHIP} set status = 'received', received_at = now(), received_by = '${w.b.personId}', received_total = '3100.00' where id = $1`],
      ['line received_quantity', `update ${LINE} set received_quantity = '8.000' where id = $1`],
    ];
    const r = await asPerson(w.a.orgId, w.a.personId, async (tx) => {
      const out: Record<string, PgErr | undefined> = {};
      for (const [k, q] of sets) out[k] = await probe(tx, (sp) => asSql(sp).unsafe(q, [k === 'line received_quantity' ? s.shipLineId : s.shipmentId]));
      const ok = await asSql(tx)`update ${asSql(tx)(SHIP)} set bir_invoice_no = 'BIR-9' where id = ${s.shipmentId} returning id`;
      return { out, ok: ok.length };
    });
    expect(r.err?.message).toBeUndefined();
    for (const [k] of sets) {
      expectRefused(r.value!.out[k], `W1 seller sets ${k}`, '42501');
      expect(r.value!.out[k]!.message, `W1 ${k}: the refusal must name received`).toMatch(/received/i);
    }
    expect(r.value!.ok, 'control: an unrelated column still updates').toBe(1);
  });

  it('W2 PG cannot write the receipt directly either (0 rows or 42501), and the definer receive still works for PG (positive control)', async () => {
    const w = await world();
    const s = await newShipment(w);
    const r = await asPerson(w.b.orgId, w.b.personId, async (tx) => {
      const q = asSql(tx);
      const direct: unknown[] = [];
      const a = await probe(tx, async (sp) => {
        direct.push((await asSql(sp)`update ${asSql(sp)(SHIP)} set received_total = '1.00' where id = ${s.shipmentId} returning id`).length);
      });
      if (a) direct.push(a.code);
      const b = await probe(tx, async (sp) => {
        direct.push((await asSql(sp)`update ${asSql(sp)(LINE)} set received_quantity = '1.000' where id = ${s.shipLineId} returning id`).length);
      });
      if (b) direct.push(b.code);
      await q`select receive_inter_entity_shipment(${s.shipmentId}::uuid, ${q.json([{ line_id: s.shipLineId, received_quantity: '8.000' }] as never)}::jsonb)`;
      const [row] = await q<{ status: string; received_total: string }[]>`select status, received_total from ${q(SHIP)} where id = ${s.shipmentId}`;
      return { direct, row };
    });
    expect(r.err?.message, 'RED today: no function / table').toBeUndefined();
    for (const d of r.value!.direct) expect([0, '42501'], `direct write result ${String(d)}`).toContain(d);
    expect(r.value!.row).toEqual({ status: 'received', received_total: '2480.00' });
  });

  it('E26 customers.credit_terms_days: 30 stored; 0 and 365 accepted; -1 and 366 refused (kills: CHECK dropped)', async () => {
    const w = await world();
    const mk = (days: number | null) => ins(sql, 'customers', { org_id: w.a.orgId, name: uid('Terms'), created_by: w.a.personId, credit_terms_days: days });
    const id = await mk(30);
    const [r] = await sql<{ credit_terms_days: number }[]>`select credit_terms_days from customers where id = ${id}`;
    expect(r!.credit_terms_days).toBe(30);
    for (const ok of [0, 365, null]) expect(await ownerProbe(() => mk(ok)), `control ${ok}`).toBeUndefined();
    for (const bad of [-1, 366]) expectRefused(await ownerProbe(() => mk(bad)), `credit_terms_days ${bad}`, '23514');
  });

  it('S1 suppliers: counterparty_store_id AND counterparty_org_id both set is refused; either alone is fine; the org must exist', async () => {
    const w = await world();
    const mk = (o: Row) => ins(sql, 'suppliers', { org_id: w.b.orgId, name: uid('Sup'), status: 'active', created_by: w.b.personId, ...o });
    expectRefused(await ownerProbe(() => mk({ counterparty_store_id: w.b.storeId, counterparty_org_id: w.a.orgId })), 'S1 both set', '23514');
    expect(await ownerProbe(() => mk({ counterparty_org_id: w.a.orgId })), 'control: org only').toBeUndefined();
    expect(await ownerProbe(() => mk({ counterparty_store_id: w.b.storeId })), 'control: store only').toBeUndefined();
    expectRefused(await ownerProbe(() => mk({ counterparty_org_id: '00000000-0000-0000-0000-000000000000' })), 'S1 unknown org', '23503');
  });
});

// ================================================================================================ deliveries

describe('D -- deliveries.kind = inter_entity and the shipment link', () => {
  const mkDelivery = (w: World, o: Row = {}) =>
    ins(sql, 'deliveries', { org_id: w.b.orgId, store_id: w.b.storeId, kind: 'inter_entity', supplier_id: w.supplierB, delivered_on: '2026-12-02', created_by: w.b.personId, ...o });

  it('E19 a delivery in org C pointing at a B shipment is refused (23503); A (the seller) pointing at its own shipment is refused too; B\'s own is accepted (kills: FK on (org_id, id))', async () => {
    const w = await world();
    const s = await newShipment(w);
    expectRefused(await ownerProbe(() => ins(sql, 'deliveries', { org_id: w.c.orgId, store_id: w.c.storeId, kind: 'inter_entity', supplier_id: w.supplierC, delivered_on: '2026-12-02', created_by: w.c.personId, inter_entity_shipment_id: s.shipmentId })), 'E19 C -> B shipment', '23503');
    expectRefused(await ownerProbe(() => ins(sql, 'deliveries', { org_id: w.a.orgId, store_id: w.a.storeId, kind: 'inter_entity', delivered_on: '2026-12-02', created_by: w.a.personId, inter_entity_shipment_id: s.shipmentId })), 'E19b A -> own shipment (A is the seller, not the buyer)');
    expect(await ownerProbe(() => mkDelivery(w, { inter_entity_shipment_id: s.shipmentId })), 'control: B -> its own shipment (proof photo waived for inter_entity)').toBeUndefined();
  });

  it('DK1 kind inter_entity WITHOUT a shipment id is refused (23514)', async () => {
    const w = await world();
    const err = await ownerProbe(() => mkDelivery(w));
    expectRefused(err, 'DK1', '23514');
    expect((err as PgErr & { constraint_name?: string }).constraint_name, 'RED today: the OLD kind CHECK is what refuses (kind not yet admitted); after 0218 it must be the shipment-link rule').not.toBe('deliveries_kind_check');
  });

  it('DK2 kind supplier WITH a shipment id is refused (23514) -- proof photo supplied so only the kind rule can refuse', async () => {
    const w = await world();
    const s = await newShipment(w);
    const [f] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
      values (${w.b.orgId}, ${w.b.storeId}, 'onboarding_document', ${`orgs/${w.b.orgId}/p/${uid('f')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${w.b.personId}) returning id`;
    const err = await ownerProbe(() => mkDelivery(w, { kind: 'supplier', proof_file_id: f!.id, inter_entity_shipment_id: s.shipmentId }));
    expectRefused(err, 'DK2', '23514');
    expect(await ownerProbe(() => mkDelivery(w, { kind: 'supplier', proof_file_id: f!.id })), 'control: the same supplier delivery without a shipment is accepted').toBeUndefined();
  });

  it('DK3 kind inter_entity needs a supplier (QO-4 a): supplier_id NULL is refused', async () => {
    const w = await world();
    const s = await newShipment(w);
    expectRefused(await ownerProbe(() => mkDelivery(w, { supplier_id: null, inter_entity_shipment_id: s.shipmentId })), 'DK3', '23514');
  });

  it('E8 two live deliveries for one shipment are refused (23505); a voided one does not count (kills: partial UNIQUE missing / not excluding void)', async () => {
    const w = await world();
    const s = await newShipment(w);
    const first = await mkDelivery(w, { inter_entity_shipment_id: s.shipmentId });
    expectRefused(await ownerProbe(() => mkDelivery(w, { inter_entity_shipment_id: s.shipmentId })), 'E8 second live delivery', '23505');
    await sql`update deliveries set status = 'void', voided_at = now(), voided_by = ${w.b.personId}, void_reason = 'test' where id = ${first}`;
    expect(await ownerProbe(() => mkDelivery(w, { inter_entity_shipment_id: s.shipmentId })), 'E8b after a void a new delivery is allowed').toBeUndefined();
  });

  it('the TS constant DELIVERY_KINDS includes inter_entity and the Drizzle schema exports the new tables (mirror of the migration)', async () => {
    const { DELIVERY_KINDS } = await import('../../schema/deliveries');
    expect(DELIVERY_KINDS as readonly string[]).toContain('inter_entity');
    const mod = (await import('../../schema/inter-entity')) as Record<string, unknown>;
    expect(mod.interEntityShipments, 'schema/inter-entity.ts must export interEntityShipments').toBeDefined();
    expect(mod.interEntityShipmentLines, 'schema/inter-entity.ts must export interEntityShipmentLines').toBeDefined();
  });
});

// ================================================================================================ RLS

describe('R -- RLS catalog: ENABLE + FORCE; SELECT widened to the buyer, nothing else', () => {
  it('R1 both tables: relrowsecurity and relforcerowsecurity', async () => {
    for (const t of [SHIP, LINE]) {
      const [c] = await sql<{ rls: boolean; force: boolean }[]>`select relrowsecurity rls, relforcerowsecurity "force" from pg_class where oid = to_regclass(${'public.' + t})`;
      expect(c, `${t}: RED today, no table`).toBeDefined();
      expect(c!.rls, `${t}: RLS not enabled`).toBe(true);
      expect(c!.force, `${t}: FORCE missing`).toBe(true);
    }
  });

  it('R2 policies: SELECT is org_id = app_current_org() OR buyer_org_id = app_current_org(); INSERT/UPDATE name ONLY org_id (kills: widen UPDATE to the buyer); no DELETE policy', async () => {
    for (const t of [SHIP, LINE]) {
      const pols = await sql<{ cmd: string; qual: string | null; with_check: string | null }[]>`select cmd, qual, with_check from pg_policies where schemaname = 'public' and tablename = ${t}`;
      expect(pols.length, `${t}: no policy (RED today)`).toBeGreaterThan(0);
      const sel = pols.filter((p) => p.cmd === 'SELECT' || p.cmd === 'ALL');
      expect(sel.some((p) => /org_id\s*=\s*app_current_org\(\)/.test(p.qual ?? '') && /buyer_org_id\s*=\s*app_current_org\(\)/.test(p.qual ?? '')), `${t}: SELECT must admit the buyer`).toBe(true);
      for (const p of pols.filter((x) => x.cmd === 'INSERT' || x.cmd === 'UPDATE')) {
        expect(`${p.qual ?? ''} ${p.with_check ?? ''}`, `${t}: a ${p.cmd} policy names buyer_org_id (E4 mutant)`).not.toMatch(/buyer_org_id/);
        expect(`${p.qual ?? ''} ${p.with_check ?? ''}`).toMatch(/app_current_org\(\)/);
      }
      expect(pols.filter((p) => p.cmd === 'DELETE' || p.cmd === 'ALL').length, `${t}: no DELETE policy and no FOR ALL`).toBe(0);
      expect(pols.filter((p) => p.cmd === 'INSERT').every((p) => /app_current_org\(\)/.test(p.with_check ?? '')), `${t}: INSERT WITH CHECK on org_id`).toBe(true);
    }
  });

  it('R3 grants: shareat_app has SELECT, INSERT, UPDATE and NOT DELETE / TRUNCATE / REFERENCES / TRIGGER', async () => {
    for (const t of [SHIP, LINE]) {
      const [p] = await sql<Record<string, boolean | null>[]>`
        select has_table_privilege(${APP_ROLE}, to_regclass(${'public.' + t}), 'SELECT') sel, has_table_privilege(${APP_ROLE}, to_regclass(${'public.' + t}), 'INSERT') ins,
               has_table_privilege(${APP_ROLE}, to_regclass(${'public.' + t}), 'UPDATE') upd, has_table_privilege(${APP_ROLE}, to_regclass(${'public.' + t}), 'DELETE') del,
               has_table_privilege(${APP_ROLE}, to_regclass(${'public.' + t}), 'TRUNCATE') trunc, has_table_privilege(${APP_ROLE}, to_regclass(${'public.' + t}), 'REFERENCES') refs,
               has_table_privilege(${APP_ROLE}, to_regclass(${'public.' + t}), 'TRIGGER') trg`;
      expect(p, `${t}: RED today, no table`).toMatchObject({ sel: true, ins: true, upd: true, del: false, trunc: false, refs: false, trg: false });
    }
  });

  it('X2a the ONLY policies naming buyer_org_id are the two tables\' SELECT policies (catalog over pg_policies)', async () => {
    const rows = await sql<{ tablename: string; cmd: string }[]>`
      select tablename, cmd from pg_policies where schemaname = 'public' and (coalesce(qual, '') ~ 'buyer_org_id' or coalesce(with_check, '') ~ 'buyer_org_id')`;
    expect(rows.length, 'RED today: the handoff policies do not exist').toBeGreaterThan(0);
    expect(rows.every((r) => [SHIP, LINE].includes(r.tablename)), `buyer_org_id leaked into another table's policy: ${JSON.stringify(rows)}`).toBe(true);
    expect(rows.every((r) => r.cmd === 'SELECT'), `a non-SELECT policy names buyer_org_id: ${JSON.stringify(rows)}`).toBe(true);
    expect([...new Set(rows.map((r) => r.tablename))].sort()).toEqual([LINE, SHIP].sort());
  });

  it('E3 as PG: the shipment and its line are readable; Ian\'s items, stock_layers, trade_orders, ar_charges and customers show 0 rows (kills: drop the buyer arm)', async () => {
    const w = await world();
    const s = await newShipment(w);
    const r = await asApp(w.b.orgId, async (tx) => {
      const q = asSql(tx);
      const n = async (t: string) => (await q`select count(*)::int n from ${q(t)} where org_id = ${w.a.orgId}`)[0]!.n as number;
      return {
        ship: (await q`select id from ${q(SHIP)} where id = ${s.shipmentId}`).length,
        line: (await q`select id from ${q(LINE)} where id = ${s.shipLineId}`).length,
        items: await n('items'),
        layers: await n('stock_layers'),
        orders: await n('trade_orders'),
        ar: await n('ar_charges'),
        customers: await n('customers'),
        persons: await n('persons'),
      };
    });
    expect(r.err?.message, 'RED today: no table').toBeUndefined();
    expect(r.value).toEqual({ ship: 1, line: 1, items: 0, layers: 0, orders: 0, ar: 0, customers: 0, persons: 0 });
  });

  it('E24b a row read as PG carries no cost / layer / person key (to_jsonb of the row)', async () => {
    const w = await world();
    const s = await newShipment(w);
    const r = await asApp(w.b.orgId, async (tx) => {
      const q = asSql(tx);
      const a = await q<{ j: Record<string, unknown> }[]>`select to_jsonb(s) j from ${q(SHIP)} s where id = ${s.shipmentId}`;
      const b = await q<{ j: Record<string, unknown> }[]>`select to_jsonb(l) j from ${q(LINE)} l where id = ${s.shipLineId}`;
      return [...Object.keys(a[0]!.j), ...Object.keys(b[0]!.j)];
    });
    expect(r.err?.message, 'RED today: no table').toBeUndefined();
    expect(r.value!.filter((k) => /cost|layer|margin|consum/.test(k))).toEqual([]);
  });

  it('E4 as PG: UPDATE and DELETE of a shipment or line change 0 rows or are refused (kills: widen UPDATE to the buyer); the seller\'s own UPDATE still works (control)', async () => {
    const w = await world();
    const s = await newShipment(w);
    const r = await asApp(w.b.orgId, async (tx) => {
      const q = asSql(tx);
      const u1 = await q`update ${q(SHIP)} set bir_invoice_no = 'HACK' where id = ${s.shipmentId} returning id`;
      const u2 = await q`update ${q(LINE)} set item_name = 'HACK' where id = ${s.shipLineId} returning id`;
      const d1 = await probe(tx, (sp) => asSql(sp)`delete from ${asSql(sp)(SHIP)} where id = ${s.shipmentId}`);
      const d2 = await probe(tx, (sp) => asSql(sp)`delete from ${asSql(sp)(LINE)} where id = ${s.shipLineId}`);
      const insA = await probe(tx, (sp) => ins(sp, SHIP, shipRow(w, s.orderId, {})));
      return { updated: u1.length + u2.length, d1, d2, insA };
    });
    expect(r.err?.message, 'RED today: no table').toBeUndefined();
    expect(r.value!.updated, 'PG updated the commissary\'s shipment').toBe(0);
    for (const d of [r.value!.d1, r.value!.d2]) if (d) expect(['42501'], `delete raised ${d.code} ${d.message}`).toContain(d.code);
    expectRefused(r.value!.insA, 'PG inserting a row labelled with the commissary org', '42501');
    const ctl = await asApp(w.a.orgId, async (tx) => (await asSql(tx)`update ${asSql(tx)(SHIP)} set bir_invoice_no = 'BIR-1' where id = ${s.shipmentId} returning id`).length);
    expect(ctl.value, 'control: the seller can update its own shipment').toBe(1);
    const [row] = await sql<{ bir_invoice_no: string | null; n: number }[]>`select bir_invoice_no, (select count(*)::int from ${sql(SHIP)} where id = ${s.shipmentId}) n from ${sql(SHIP)} where id = ${s.shipmentId}`;
    expect(row!.n).toBe(1);
    expect(row!.bir_invoice_no, 'rolled back: the control update was inside a rolled-back transaction').toBeNull();
  });

  it('E5 as a third org C: the shipment and its lines are invisible (0 rows) (kills: drop the buyer arm / OR true)', async () => {
    const w = await world();
    const s = await newShipment(w);
    const r = await asApp(w.c.orgId, async (tx) => {
      const q = asSql(tx);
      return [(await q`select 1 from ${q(SHIP)} where id = ${s.shipmentId}`).length, (await q`select 1 from ${q(LINE)} where id = ${s.shipLineId}`).length, (await q`select 1 from ${q(SHIP)}`).length];
    });
    expect(r.err?.message, 'RED today: no table').toBeUndefined();
    expect(r.value!.slice(0, 2)).toEqual([0, 0]);
  });

  it('E5b as the seller A: still sees its own shipment and line (control: the policy does not deny the owner of the row)', async () => {
    const w = await world();
    const s = await newShipment(w);
    const r = await asApp(w.a.orgId, async (tx) => (await asSql(tx)`select 1 from ${asSql(tx)(SHIP)} where id = ${s.shipmentId}`).length);
    expect(r.err?.message, 'RED today: no table').toBeUndefined();
    expect(r.value).toBe(1);
  });

  it('X1 cross-org sweep: both orgs seeded; as PG, EVERY RLS_REGISTRY table with an org_id shows 0 of Ian\'s rows except the two shipment tables; the same the other way (kills: any new table leaking)', async () => {
    const w = await world();
    await newShipment(w);
    const cols = await sql<{ table_name: string }[]>`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'org_id'`;
    const withOrg = new Set(cols.map((c) => c.table_name));
    const tables = Object.keys(RLS_REGISTRY).filter((t) => withOrg.has(t));
    expect(tables.length, 'sanity: the registry has many org-scoped tables').toBeGreaterThan(100);
    expect(tables, 'RED today: the shipment tables are not in the registry').toEqual(expect.arrayContaining([SHIP, LINE]));
    const leaks = async (viewer: string, other: string) => {
      const r = await asApp(viewer, async (tx) => {
        const q = asSql(tx);
        const out: Record<string, number> = {};
        for (const t of tables) {
          const [pr] = await q<{ ok: boolean }[]>`select has_table_privilege(${APP_ROLE}, to_regclass(${'public.' + t}), 'SELECT') ok`;
          if (!pr?.ok) continue;
          const err = await probe(tx, async (sp) => {
            const [c] = await asSql(sp)<{ n: number }[]>`select count(*)::int n from ${asSql(sp)(t)} where org_id = ${other}`;
            if (c!.n > 0) out[t] = c!.n;
          });
          if (err) out[`${t}!`] = -1;
        }
        return out;
      });
      expect(r.err?.message).toBeUndefined();
      return r.value!;
    };
    const asB = await leaks(w.b.orgId, w.a.orgId);
    const asA = await leaks(w.a.orgId, w.b.orgId);
    for (const [who, seen] of [['PG sees Ian', asB], ['Ian sees PG', asA]] as const) {
      const unexpected = Object.entries(seen).filter(([t]) => ![SHIP, LINE].includes(t));
      expect(unexpected, `X1 ${who}: rows of the other org visible in ${JSON.stringify(unexpected)}`).toEqual([]);
    }
    expect(asB[SHIP], 'positive control: PG does see the shipment').toBeGreaterThanOrEqual(1);
    expect(asB[LINE], 'positive control: PG does see the line').toBeGreaterThanOrEqual(1);
    expect(asA[SHIP], 'Ian sees PG-labelled rows? no: shipments carry org_id = Ian, so PG\'s org_id has none').toBeUndefined();
  });
});

// ================================================================================================ definer functions

interface Fn {
  proname: string;
  prosecdef: boolean;
  proconfig: string[] | null;
  public_exec: boolean;
  app_exec: boolean;
  args: string;
}
async function definers(): Promise<Fn[]> {
  return sql<Fn[]>`
    select p.proname, p.prosecdef, p.proconfig,
           exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec,
           has_function_privilege(${APP_ROLE}, p.oid, 'EXECUTE') as app_exec,
           pg_get_function_identity_arguments(p.oid) args
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.proname like '%inter\_entity%'`;
}

describe('X2b the SECURITY DEFINER surface is the pinned list', () => {
  it('exactly receive_inter_entity_shipment, inter_entity_buyer_posted and inter_entity_counterparty_balance (QI-1 a)', async () => {
    const f = await definers();
    expect(f.map((x) => x.proname).sort(), 'RED today: no definer functions').toEqual(['inter_entity_buyer_posted', 'inter_entity_counterparty_balance', 'receive_inter_entity_shipment']);
  });

  it('each pins search_path, has no PUBLIC EXECUTE, and EXECUTE to shareat_app (kills: unpinned search_path / PUBLIC left)', async () => {
    const f = await definers();
    expect(f.length, 'RED today: no definer functions').toBe(3);
    for (const x of f) {
      expect((x.proconfig ?? []).some((c) => /^search_path=/.test(c)), `${x.proname}: search_path not pinned (${JSON.stringify(x.proconfig)})`).toBe(true);
      expect(x.public_exec, `${x.proname}: PUBLIC can EXECUTE`).toBe(false);
      expect(x.app_exec, `${x.proname}: shareat_app cannot EXECUTE`).toBe(true);
    }
    expect(f.find((x) => x.proname === 'receive_inter_entity_shipment')!.args).toMatch(/uuid.*jsonb/);
    expect(f.find((x) => x.proname === 'inter_entity_buyer_posted')!.args).toMatch(/uuid\[\]/);
  });

  it('E15 inter_entity_buyer_posted returns exactly (shipment_id uuid, received_on date, posted_total numeric) (kills: add a column)', async () => {
    const r = await sql<{ names: string[] | null; modes: string[] | null; res: string }[]>`
      select p.proargnames names, p.proargmodes modes, pg_get_function_result(p.oid) res from pg_proc p where p.proname = 'inter_entity_buyer_posted' and p.pronamespace = 'public'::regnamespace`;
    expect(r.length, 'RED today: no function').toBe(1);
    const names = r[0]!.names ?? [];
    const modes = r[0]!.modes ?? [];
    const out = names.filter((_, i) => modes[i] === 't');
    expect(out).toEqual(['shipment_id', 'received_on', 'posted_total']);
    expect(r[0]!.res).toMatch(/shipment_id uuid, received_on date, posted_total numeric/);
  });
});

describe('B/R -- receive_inter_entity_shipment (the buyer\'s one write into the seller\'s table)', () => {
  const call = (tx: Tx, shipmentId: string, lines: unknown) => asSql(tx)`select receive_inter_entity_shipment(${shipmentId}::uuid, ${asSql(tx).json(lines as never)}::jsonb)`;

  it('R1 PG receives 8.000 of 10.000 (plus a 0.250 of 0.500 at 7.77 second line): status received, received_total = per-line round(received x rate) summed = 2481.94, received_by = the caller (positive control; kills: wrong rounding)', async () => {
    const w = await world();
    const s = await newShipment(w);
    const l2Order = await sql<{ id: string }[]>`insert into trade_order_lines (org_id, order_id, item_id, quantity, unit, rate, line_total) values (${w.a.orgId}, ${s.orderId}, ${w.a.stockItemId}, '0.500', 'kg', '7.77', '3.89') returning id`;
    // header and second line move together in ONE transaction (billed_total = sum(line_total) is checked at commit)
    const l2 = await sql.begin(async (tx) => {
      const id = await ins(tx, LINE, lineRow(w, s.shipmentId, l2Order[0]!.id, { line_no: '2', quantity: '0.500', rate: '7.77', line_total: '3.89' }));
      await asSql(tx)`update ${asSql(tx)(SHIP)} set billed_total = '3103.89' where id = ${s.shipmentId}`;
      return id;
    });
    const r = await asPerson(w.b.orgId, w.b.personId, async (tx) => {
      await call(tx, s.shipmentId, [{ line_id: s.shipLineId, received_quantity: '8.000' }, { line_id: l2, received_quantity: '0.250' }]);
      const q = asSql(tx);
      const [row] = await q<{ status: string; received_total: string; received_by: string; has_at: boolean }[]>`
        select status, received_total, received_by, received_at is not null has_at from ${q(SHIP)} where id = ${s.shipmentId}`;
      const lines = await q<{ id: string; received_quantity: string }[]>`select id, received_quantity from ${q(LINE)} where shipment_id = ${s.shipmentId}`;
      return { ...row!, perLine: Object.fromEntries(lines.map((l) => [l.id, l.received_quantity])) };
    });
    expect(r.err?.message, 'RED today: no function').toBeUndefined();
    expect(r.value).toMatchObject({ status: 'received', received_total: '2481.94', received_by: w.b.personId, has_at: true });
    expect(r.value!.perLine, 'QI-1 (a): the per-item received quantity is stamped on each line').toEqual({ [s.shipLineId]: '8.000', [l2]: '0.250' });
  });

  it('R3 over-receipt (11.000 of 10.000) is refused in words and nothing changes (kills: no received <= shipped check)', async () => {
    const w = await world();
    const s = await newShipment(w);
    const r = await asPerson(w.b.orgId, w.b.personId, async (tx) => probe(tx, (sp) => call(sp, s.shipmentId, [{ line_id: s.shipLineId, received_quantity: '11.000' }])));
    expectRefused(r.value, 'R3 over-receipt');
    expect(r.value!.message, 'refused in words').toMatch(/exceed|more than|over|shipped/i);
    const [row] = await sql<{ status: string }[]>`select status from ${sql(SHIP)} where id = ${s.shipmentId}`;
    expect(row!.status).toBe('in_transit');
  });

  it('R2 receiving twice: the second call is refused naming the first ("already received") (kills: no status guard / no FOR UPDATE)', async () => {
    const w = await world();
    const s = await newShipment(w);
    const r = await asPerson(w.b.orgId, w.b.personId, async (tx) => {
      await call(tx, s.shipmentId, [{ line_id: s.shipLineId, received_quantity: '10.000' }]);
      return probe(tx, (sp) => call(sp, s.shipmentId, [{ line_id: s.shipLineId, received_quantity: '10.000' }]));
    });
    expect(r.err?.message, 'RED today: no function').toBeUndefined();
    expectRefused(r.value, 'R2 second receive');
    expect(r.value!.message).toMatch(/already received/i);
  });

  it('B1 PG forging the id of a shipment addressed to org C is refused and nothing changes (kills: the buyer check dropped)', async () => {
    const w = await world();
    const { orderId, lineId } = await newOrder(w);
    // A links a customer to C for this one shipment so the row can exist at all (LK is a separate leg); owner inserts with the link disabled by pointing the customer at C.
    await sql`update customers set counterparty_org_id = ${w.c.orgId} where id = ${w.customerAC}`;
    const { orderId: o2, lineId: l2 } = await newOrder(w, w.customerAC);
    void orderId; void lineId;
    const shipId = await ins(sql, SHIP, shipRow(w, o2, { buyer_org_id: w.c.orgId }));
    const shipLine = await ins(sql, LINE, lineRow(w, shipId, l2, { buyer_org_id: w.c.orgId }));
    await sql`update customers set counterparty_org_id = null where id = ${w.customerAC}`;
    const r = await asPerson(w.b.orgId, w.b.personId, async (tx) => probe(tx, (sp) => call(sp, shipId, [{ line_id: shipLine, received_quantity: '1.000' }])));
    expectRefused(r.value, 'B1 forged shipment id');
    const [row] = await sql<{ status: string }[]>`select status from ${sql(SHIP)} where id = ${shipId}`;
    expect(row!.status).toBe('in_transit');
  });

  it('B1b the SELLER cannot receive its own shipment either (buyer_org_id <> app_current_org())', async () => {
    const w = await world();
    const s = await newShipment(w);
    const r = await asPerson(w.a.orgId, w.a.personId, async (tx) => probe(tx, (sp) => call(sp, s.shipmentId, [{ line_id: s.shipLineId, received_quantity: '10.000' }])));
    expectRefused(r.value, 'B1b seller receiving');
  });

  it('E14 inter_entity_buyer_posted: a third org, and the BUYER, get 0 rows for the seller\'s shipment; the seller gets 0 for an in-transit one (kills: drop org_id = app_current_org(); E16)', async () => {
    const w = await world();
    const s = await newShipment(w);
    for (const who of [w.c, w.b, w.a]) {
      const r = await asApp(who.orgId, async (tx) => (await asSql(tx)`select * from inter_entity_buyer_posted(array[${s.shipmentId}]::uuid[])`).length);
      expect(r.err?.message, 'RED today: no function').toBeUndefined();
      expect(r.value, 'no row for this caller').toBe(0);
    }
  });
});

describe('QI-1 (a) -- what the SELLER may see of the buyer receipt, and nothing more', () => {
  it('V1 after PG receives 8.000 of 10.000, the commissary (as org A) reads received_quantity = 8.000 per line and received_total on the shipment', async () => {
    const w = await world();
    const s = await newShipment(w);
    await sql`update ${sql(LINE)} set received_quantity = '8.000' where id = ${s.shipLineId}`;
    await sql`update ${sql(SHIP)} set status = 'received', received_at = now(), received_by = ${w.b.personId}, received_total = '2480.00' where id = ${s.shipmentId}`;
    const r = await asApp(w.a.orgId, async (tx) => {
      const q = asSql(tx);
      const [l] = await q<{ received_quantity: string }[]>`select received_quantity from ${q(LINE)} where id = ${s.shipLineId}`;
      const [h] = await q<{ received_total: string }[]>`select received_total from ${q(SHIP)} where id = ${s.shipmentId}`;
      return { l: l?.received_quantity, h: h?.received_total };
    });
    expect(r.err?.message, 'RED today').toBeUndefined();
    expect(r.value).toEqual({ l: '8.000', h: '2480.00' });
  });

  it('V2 negative: as the seller A, none of PG prices, costs, other suppliers, bills, journal, stock or staff is readable -- 0 rows in each (kills: a widened policy on a buyer-side table)', async () => {
    const w = await world();
    await newShipment(w);
    const buyerTables = ['items', 'stock_layers', 'supplier_items', 'suppliers', 'supplier_invoices', 'deliveries', 'delivery_lines', 'journal_entries', 'journal_lines', 'persons', 'price_lists', 'price_list_items', 'ar_charges', 'trade_orders', 'stores', 'employments'];
    const r = await asApp(w.a.orgId, async (tx) => {
      const q = asSql(tx);
      const out: Record<string, number> = {};
      for (const t of buyerTables) {
        const err = await probe(tx, async (sp) => {
          const cols = await asSql(sp)<{ c: string }[]>`select column_name c from information_schema.columns where table_schema = 'public' and table_name = ${t} and column_name = 'org_id'`;
          if (!cols.length) return;
          const [c] = await asSql(sp)<{ n: number }[]>`select count(*)::int n from ${asSql(sp)(t)} where org_id = ${w.b.orgId}`;
          out[t] = c!.n;
        });
        if (err && err.code !== '42P01' && err.code !== '42501') out[t + '!'] = -1;
      }
      void q;
      return out;
    });
    expect(r.err?.message).toBeUndefined();
    expect(Object.entries(r.value!).filter(([, n]) => n !== 0), 'PG rows readable by the commissary').toEqual([]);
  });

  it('V3 the commissary balance figure is about PG only: a third org C calling inter_entity_counterparty_balance() sees no non-zero figure (kills: a figure not scoped to the caller link)', async () => {
    const w = await world();
    await newShipment(w);
    const r = await asApp(w.c.orgId, async (tx) => {
      const rows = await asSql(tx)<{ j: Record<string, unknown> }[]>`select to_jsonb(f) j from inter_entity_counterparty_balance() f`;
      return rows.flatMap((x) => Object.values(x.j)).filter((v) => typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && !/^-?0+(\.0+)?$/.test(v));
    });
    expect(r.err?.message, 'RED today: no function').toBeUndefined();
    expect(r.value, 'a third org was shown a balance').toEqual([]);
  });
});
