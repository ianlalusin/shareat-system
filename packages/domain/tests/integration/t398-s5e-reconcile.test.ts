import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { apRepo, arRepo, closeDb, commissaryKpisRepo, interEntityRepo, tradeDiscrepanciesRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError } from '@shareat/auth';
import { money, toCentavos } from '@shareat/core/money';
import * as domain from '@shareat/domain';
import { createCustomer, createItem, createTradeOrder, listFindings, recordCollection, recordCustomerReturn, recordPayment } from '@shareat/domain';
import { recordReturn } from '../../src/stock/supplier-returns';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import { testItemCode } from './_fixtures/item-code';
import { asOrg, buyer, dispatch, fixture, freezeClock, owed, sayOf, thawClock, uid, type Fx } from './_fixtures/t433-b2b';

/**
 * T-398 S5e (TESTER) - the 06:30 inter-entity reconciliation and the shortage credit note.
 * Lipa = the commissary / seller (org f). Padre Garcia (PG) = the franchise / buyer (org g).
 * docs/tasks/398-s5/TESTS.md "S5e" (E14 E15 E16 E7 E12 E21 C1 C2 J1), S5-REFRESH.md sections 4, 5, 7, 8, QUESTIONS.md (QI-1 a; "S5d tester
 * questions" (c): the seller-side read of received_by), POSTING-PATTERNS.md `trade_dispatch.franchise_transit_shortage`.
 * Real Postgres (TEST_DATABASE_URL, `_test` guard); runs on any `_test` DB. Clock frozen at 2026-10-16 (JS Date only; the database's now() is real).
 * The whole flow is real: Lipa dispatches (S5c), PG receives (S5d), then the S5e behaviour under test runs.
 *
 * THE CONTRACT THIS FILE PINS (the spec is silent on names and shapes; every one is flagged in the hand-back). Reached through `api`, a namespace
 * cast, so a missing export reads "is not a function", never a compile error:
 *   runInterEntityReconcile({ orgId?, trigger? }) -> { outcomes: JobOutcome[], hadFailures }   (scheduler/index.ts; the runFindingObservation shape)
 *   reconcileInterEntity(tx, orgId) -> { shipments: [{ shipmentId, gap }], pairs: [{ counterpartyOrgId, gap }] }   (trade/inter-entity-reconcile.ts)
 *       gap = signed Money string "what this side says minus what the other side recorded"; an in_transit or void shipment is NOT listed
 *   postFranchiseShortageCredit(tx, actor, { shipmentId }) -> { entryId, value, cost }   (one entry for every open franchise_credit row of the shipment)
 *   findings (listFindings) kinds inter_entity_shipment_gap and inter_entity_balance_gap, both sides.
 * The job writes ONLY trade_discrepancies rows in the SELLER's org (disposition franchise_credit, direction short); it posts nothing.
 *
 * MUTANTS (each names the leg that must turn red): drop `org_id = app_current_org()` from inter_entity_buyer_posted -> E14; add a column to its result
 *   -> E15; let reconciliation tolerate +-0.01 -> E7t; credit = round(short x rate) -> E7r2 (and E12 under it); always CR 1210 -> C1a, C1b; re-cost the credit's
 *   cost leg from today's layers -> C2; skip the in-transit exclusion -> E16, E16b; balance check ignores 1240 supplier-return credit -> E21; job writes a
 *   second row on a re-run -> E7; job aborts on the first failing org -> J1; seller read returns received_by -> RB1; blocking() keeps franchise rows -> DB1.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}
const sql = postgres(url, { max: 5 });

beforeAll(() => freezeClock());
afterAll(async () => {
  thawClock();
  await closeDb();
  await sql.end({ timeout: 5 });
});

interface JobOutcome { orgId: string; orgName: string; job: string; period: string; posted: number; skipped: number; failed: number; error?: string }
const api = domain as unknown as {
  runInterEntityReconcile: (opts?: { orgId?: string; trigger?: 'cron' | 'manual' }) => Promise<{ outcomes: JobOutcome[]; hadFailures: boolean }>;
  reconcileInterEntity: (tx: unknown, orgId: string) => Promise<{ shipments: { shipmentId: string; gap: string }[]; pairs: { counterpartyOrgId: string; gap: string }[] }>;
  postFranchiseShortageCredit: (tx: unknown, actor: unknown, input: { shipmentId: string }) => Promise<{ entryId: string; value: string; cost: string }>;
  receiveInterEntityShipment: (tx: unknown, actor: unknown, input: Record<string, unknown>) => Promise<unknown>;
};

// ------------------------------------------------------------------------------------------------ helpers
const cents = (v: string) => toCentavos(money(v)).toString();
const SHIPMENT_GAP = 'inter_entity_shipment_gap';
const BALANCE_GAP = 'inter_entity_balance_gap';

/** 2480.00 -> "₱2,480.00" with the peso sign, the way a finding prints money. */
function peso(v: string): string {
  const [whole, frac = '00'] = v.split('.');
  let out = '';
  for (let i = 0; i < whole!.length; i++) {
    if (i > 0 && (whole!.length - i) % 3 === 0) out += ',';
    out += whole![i];
  }
  return `₱${out}.${frac.padEnd(2, '0')}`;
}

/** The buyer's principal: the receive definer reads `app.person_id`. */
async function asPerson<T>(orgId: string, personId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    await tx.execute(dsql`select set_config('app.person_id', ${personId}, true)`);
    return fn(tx);
  });
}

interface World {
  f: Fx; // Lipa, the commissary
  g: Fx; // Padre Garcia
  tag: string;
  pgName: string; // the franchise's name: org name and customer name alike
  lipaName: string; // the commissary's name: org name and PG's supplier-row name alike
  pgManagerName: string;
  lipaManagerName: string;
  customerId: string; // Lipa's customer row for PG
  supplierId: string; // PG's supplier row for Lipa
}

async function world(hint: string, names: { lipa?: string } = {}): Promise<World> {
  const tag = uid(hint);
  const f = await fixture(sql, `${hint}f`);
  const g = await fixture(sql, `${hint}g`);
  const pgName = `Padre Garcia ${tag}`;
  const lipaName = names.lipa ?? `Lipa ${tag}`;
  const pgManagerName = `Pilar ${tag}`;
  const lipaManagerName = `Marco ${tag}`;
  await sql`update organizations set name = ${pgName} where id = ${g.orgId}`;
  await sql`update organizations set name = ${lipaName} where id = ${f.orgId}`;
  await sql`update persons set display_name = ${pgManagerName} where id = ${g.manager.personId}`;
  await sql`update persons set display_name = ${lipaManagerName} where id = ${f.manager.personId}`;
  const [sup] = await sql<{ id: string }[]>`
    insert into suppliers (org_id, name, status, created_by, counterparty_org_id) values (${g.orgId}, ${lipaName}, 'active', ${g.manager.personId}, ${f.orgId}) returning id`;
  const customer = await asOrg(f.orgId, (tx) =>
    createCustomer(tx, f.admin, { name: pgName, customerGroup: 'franchise', counterpartyOrgId: g.orgId, priceListId: null }),
  );
  return { f, g, tag, pgName, lipaName, pgManagerName, lipaManagerName, customerId: customer.id, supplierId: sup!.id };
}

async function mkItem(x: Fx, name: string, sellableWholesale: boolean) {
  const full = `${name} ${uid('n')}`;
  const item = await asOrg(x.orgId, (tx) =>
    createItem(tx, x.superAdmin, { code: testItemCode(), name: full, kind: 'raw_material', baseUnit: 'kg', sellableWholesale }),
  );
  return { id: item.id, name: full };
}

async function stockAt(f: Fx, itemId: string, qty: string, unitCost: string) {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${f.orgId}, ${f.storeId}, 'purchase', '2026-01-01', ${f.fileId}, ${f.superAdmin.personId}) returning id`;
  await asOrg(f.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: f.orgId, storeId: f.storeId, deliveryId: d!.id, deliveredOn: '2026-01-01',
      locations: [{ id: f.locationId, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }],
      receivedBy: f.superAdmin.personId,
      lines: [{ lineId: '1', itemId, itemKind: 'raw_material', receivedQuantity: quantity(qty), conversionFactor: '1', unitCost, locationId: f.locationId }],
    }),
  );
}

interface Sale {
  orderId: string;
  orderLineId: string;
  itemId: string;
  chargeId: string;
  shipmentId: string;
  shipmentLineId: string;
  pgItemId: string;
  qty: string;
  rate: string;
}

/** Lipa dispatches `qty` kg of one item at `rate` to PG (one line, so one shipment line). `layers` = the stock Lipa holds, oldest first: [quantity, unit cost]. */
async function sell(w: World, o: { qty?: string; rate?: string; layers?: [string, string][] } = {}): Promise<Sale> {
  const qty = o.qty ?? '10';
  const rate = o.rate ?? '310.00';
  const layers = o.layers ?? [[qty, '250.0000']];
  const item = await mkItem(w.f, 'Pork belly', true);
  for (const [q, c] of layers) await stockAt(w.f, item.id, q, c);
  const order = await asOrg(w.f.orgId, (tx) =>
    createTradeOrder(tx, w.f.manager, {
      storeId: w.f.storeId, customerId: w.customerId, orderDate: '2026-10-10', lines: [{ itemId: item.id, quantity: qty, rate }],
    }),
  );
  const r = await dispatch(w.f, w.f.manager, order.orderId);
  const ship = await asOrg(w.f.orgId, (tx) => interEntityRepo.findByTradeOrder(tx, w.f.orgId, order.orderId));
  const lines = await asOrg(w.f.orgId, (tx) => interEntityRepo.linesOf(tx, ship!.id));
  const orderLine = (await sql<{ id: string }[]>`select id from trade_order_lines where order_id = ${order.orderId}`)[0]!;
  const pgItem = await mkItem(w.g, 'Pork belly (PG)', false);
  await sql`insert into supplier_items (org_id, supplier_id, item_id, created_by) values (${w.g.orgId}, ${w.supplierId}, ${pgItem.id}, ${w.g.manager.personId})`;
  return {
    orderId: order.orderId, orderLineId: orderLine.id, itemId: item.id, chargeId: r.chargeId!, shipmentId: ship!.id,
    shipmentLineId: lines[0]!.id, pgItemId: pgItem.id, qty, rate,
  };
}

/** PG counts `received` kg at the dock and receives, in its own books (S5d). */
const pgReceives = (w: World, s: Sale, received: string) =>
  asPerson(w.g.orgId, w.g.manager.personId, (tx) =>
    api.receiveInterEntityShipment(tx, w.g.manager, {
      shipmentId: s.shipmentId, storeId: w.g.storeId, lines: [{ shipmentLineId: s.shipmentLineId, itemId: s.pgItemId, receivedQuantity: received }],
    }),
  );

/** The 06:30 job for the given orgs (one call per org: the org filter is the job's own option). */
async function runJob(...orgIds: string[]): Promise<JobOutcome[]> {
  const out: JobOutcome[] = [];
  for (const orgId of orgIds) {
    const res = await api.runInterEntityReconcile({ orgId, trigger: 'manual' });
    expect(res.hadFailures, `the job reported a failure: ${JSON.stringify(res.outcomes)}`).toBe(false);
    out.push(...res.outcomes);
  }
  return out;
}

const interEntityFindings = async (orgId: string) => {
  const feed = await asOrg(orgId, (tx) => listFindings(tx, orgId, { period: '2026-09' }));
  return feed.findings.filter((x) => x.kind.startsWith('inter_entity'));
};

/** The rows the job writes: this org's discrepancies that are about a shipment line. */
const franchiseRows = (orgId: string) =>
  sql<{ id: string; status: string; disposition: string | null; direction: string; quantity: string; value: string; store_id: string; order_id: string; order_line_id: string; line_id: string; journal_entry_id: string | null; resolved_by: string | null }[]>`
    select id, status, disposition, direction, quantity::text, value::text, store_id, order_id, order_line_id, inter_entity_shipment_line_id as line_id, journal_entry_id, resolved_by
    from trade_discrepancies where org_id = ${orgId} and inter_entity_shipment_line_id is not null order by created_at`;

const legsOfEntry = (entryId: string) =>
  sql<{ code: string; debit: string; credit: string; party_type: string | null; party_id: string | null; store_id: string | null; org_id: string }[]>`
    select a.code, jl.debit::text, jl.credit::text, jl.party_type, jl.party_id, jl.store_id, je.org_id
    from journal_entries je join journal_lines jl on jl.entry_id = je.id join accounts a on a.id = jl.account_id where je.id = ${entryId} order by a.code, jl.debit desc`;

/** PG's payable to Lipa, from the ledger: 2110 credit minus debit on its supplier row for Lipa, less any 1240 supplier credit (a return that was not netted into a bill). */
async function pgOwes(w: World): Promise<string> {
  const [r] = await sql<{ b: string }[]>`
    select coalesce(sum(case when a.code = '2110' then jl.credit - jl.debit else jl.credit - jl.debit end), 0)::text as b
    from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
    where je.org_id = ${w.g.orgId} and a.code in ('2110', '1240') and jl.party_type = 'supplier' and jl.party_id = ${w.supplierId}`;
  return r!.b;
}

const jeCount = async (orgId: string) => (await sql<{ n: number }[]>`select count(*)::int as n from journal_entries where org_id = ${orgId}`)[0]!.n;
const movementCount = async (orgId: string) => (await sql<{ n: number }[]>`select count(*)::int as n from stock_movements where org_id = ${orgId}`)[0]!.n;
const discrepancyCount = async (orgId: string) => (await sql<{ n: number }[]>`select count(*)::int as n from trade_discrepancies where org_id = ${orgId}`)[0]!.n;

/** Row counts of everything PG's books hold; the job and the credit note must never move them (nobody writes into the other company's books). */
async function bookCounts(orgId: string) {
  const [r] = await sql<Record<string, number>[]>`
    select (select count(*)::int from journal_entries where org_id = ${orgId}) as entries,
           (select count(*)::int from journal_lines jl join journal_entries je on je.id = jl.entry_id where je.org_id = ${orgId}) as lines,
           (select count(*)::int from stock_movements where org_id = ${orgId}) as movements,
           (select count(*)::int from deliveries where org_id = ${orgId}) as deliveries,
           (select count(*)::int from supplier_invoices where org_id = ${orgId}) as invoices,
           (select count(*)::int from trade_discrepancies where org_id = ${orgId}) as discrepancies`;
  return r!;
}

async function expectBalanced(entryId: string) {
  const [r] = await sql<{ d: string; c: string }[]>`select sum(debit)::text as d, sum(credit)::text as c from journal_lines where entry_id = ${entryId}`;
  expect(cents(r!.d), 'every entry balances to the centavo (M2)').toBe(cents(r!.c));
}

/** Leaks: nothing of the other company's books, costs or people in a finding's words. */
function expectNoLeakTo(side: 'lipa' | 'pg', w: World, detail: string) {
  // whole words only: a shipment id printed in the sentence may contain digits that look like an account code
  let spaced = '';
  for (const ch of detail) spaced += /[A-Za-z0-9_]/.test(ch) ? ch : ' ';
  const words = new Set(spaced.split(' ').filter((x) => x.length > 0));
  for (const code of ['1310', '2110', '2120', '1240', '4950', '5300', '5100', 'franchise_credit']) {
    expect(words.has(code), `an account / internal word (${code}) leaked into the finding: ${detail}`).toBe(false);
  }
  if (side === 'lipa') expect(detail, 'PG person').not.toContain(w.pgManagerName);
  else expect(detail, 'Lipa person').not.toContain(w.lipaManagerName);
}

// ================================================================================================ E14, E15 (definer guards)
describe('E14/E15 inter_entity_buyer_posted: a seller-only read of exactly three columns', () => {
  it('E14. the seller gets one row (shipment, receipt date, what PG posted); a THIRD org and PG itself get none (kills: drop org_id = app_current_org())', async () => {
    const w = await world('e14');
    const c = await fixture(sql, 'e14c');
    const s = await sell(w);
    await pgReceives(w, s, '8');
    const asSeller = await asOrg(w.f.orgId, (tx) => interEntityRepo.buyerPosted(tx, [s.shipmentId]));
    expect(asSeller.map((r) => [r.shipmentId, cents(r.postedTotal)])).toEqual([[s.shipmentId, '248000']]);
    const asThird = await asOrg(c.orgId, (tx) => interEntityRepo.buyerPosted(tx, [s.shipmentId]));
    expect(asThird, 'a third organisation read another pair\'s receipt').toEqual([]);
    const asBuyer = await asOrg(w.g.orgId, (tx) => interEntityRepo.buyerPosted(tx, [s.shipmentId]));
    expect(asBuyer, 'the buyer is not the seller').toEqual([]);
  });

  it('E15. the function result columns (catalog) are exactly (shipment_id, received_on, posted_total) (kills: add a column)', async () => {
    const [p] = await sql<{ names: string[]; modes: string[]; types: string }[]>`
      select proargnames as names, proargmodes::text[] as modes, pg_get_function_result(oid) as types
      from pg_proc where pronamespace = 'public'::regnamespace and proname = 'inter_entity_buyer_posted'`;
    expect(p, 'the definer exists').toBeDefined();
    const out = p!.names.filter((_, i) => p!.modes[i] === 't');
    expect(out).toEqual(['shipment_id', 'received_on', 'posted_total']);
    expect(p!.types).toBe('TABLE(shipment_id uuid, received_on date, posted_total numeric)');
  });
});

// ================================================================================================ E16
describe('E16 an in-transit (or void) shipment raises nothing and is out of the balance check', () => {
  it('E16. one shipment received in full + one still in transit: no finding on either side, the job writes nothing, the reconcile result does not list the in-transit one', async () => {
    const w = await world('e16');
    const done = await sell(w);
    const inTransit = await sell(w);
    await pgReceives(w, done, '10');
    const before = { f: await bookCounts(w.f.orgId), g: await bookCounts(w.g.orgId) };
    const out = await runJob(w.f.orgId, w.g.orgId);
    expect(out.map((o) => o.job)).toEqual(['inter_entity_reconcile', 'inter_entity_reconcile']);
    expect(await franchiseRows(w.f.orgId), 'no discrepancy for a shipment nobody short-received').toEqual([]);
    expect(await interEntityFindings(w.f.orgId), 'seller feed').toEqual([]);
    expect(await interEntityFindings(w.g.orgId), 'buyer feed').toEqual([]);
    for (const orgId of [w.f.orgId, w.g.orgId]) {
      const res = await asOrg(orgId, (tx) => api.reconcileInterEntity(tx, orgId));
      expect(res.shipments.map((x) => x.shipmentId), 'the in-transit shipment is not reconciled').not.toContain(inTransit.shipmentId);
      for (const p of res.pairs) expect(cents(p.gap), 'the pair balance excludes the in-transit billing').toBe('0');
      for (const x of res.shipments) expect(cents(x.gap)).toBe('0');
    }
    expect(await bookCounts(w.g.orgId), 'the job wrote into PG\'s books').toEqual(before.g);
    expect((await bookCounts(w.f.orgId)).entries, 'the job posts nothing').toBe(before.f.entries);
  });

  it('E16b. a shipment voided before receipt (charge reversed) also raises nothing and leaves AR = AP = 0 for the pair', async () => {
    const w = await world('e16b');
    const s = await sell(w);
    await asOrg(w.f.orgId, (tx) => domain.voidTradeOrder(tx, w.f.manager, { orderId: s.orderId, reason: 'Wrong item sent.' }));
    await runJob(w.f.orgId, w.g.orgId);
    expect(await franchiseRows(w.f.orgId)).toEqual([]);
    expect(await interEntityFindings(w.f.orgId)).toEqual([]);
    expect(await interEntityFindings(w.g.orgId)).toEqual([]);
    const res = await asOrg(w.f.orgId, (tx) => api.reconcileInterEntity(tx, w.f.orgId));
    expect(res.shipments.map((x) => x.shipmentId)).not.toContain(s.shipmentId);
  });
});

// ================================================================================================ E7
describe('E7 PG received 8 of 10: one discrepancy, one finding per side in its own words, a credit note, then clean', () => {
  it('E7. the job writes ONE franchise_credit row in Lipa (and nothing in PG); a second run writes none; each feed shows one gap finding in its own words; the credit note posts 4950/1210 620.00 + 5300/5100 500.00; the next run is clean', async () => {
    const w = await world('e7');
    const s = await sell(w);
    await pgReceives(w, s, '8');
    const before = { f: await bookCounts(w.f.orgId), g: await bookCounts(w.g.orgId) };

    // ---- the job: one row, seller side only, nothing posted
    const first = await runJob(w.f.orgId, w.g.orgId);
    const fOut = first.find((o) => o.orgId === w.f.orgId)!;
    const gOut = first.find((o) => o.orgId === w.g.orgId)!;
    expect(fOut.posted, 'the seller org\'s run recorded the one row it wrote').toBe(1);
    expect(gOut.posted, 'PG\'s org has nothing to write').toBe(0);
    const rows = await franchiseRows(w.f.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'open', disposition: 'franchise_credit', direction: 'short', quantity: '2.000',
      store_id: w.f.storeId, order_id: s.orderId, order_line_id: s.orderLineId, line_id: s.shipmentLineId, journal_entry_id: null,
    });
    expect(Number(rows[0]!.value), 'a short row\'s value is positive (trade_discrepancies_value_check)').toBeGreaterThan(0);
    expect(await franchiseRows(w.g.orgId), 'nothing is written in PG\'s organisation').toEqual([]);
    const afterJob = { f: await bookCounts(w.f.orgId), g: await bookCounts(w.g.orgId) };
    expect(afterJob.g, 'the job never touches PG\'s books').toEqual(before.g);
    expect(afterJob.f.entries, 'the job posts no entry').toBe(before.f.entries);
    expect(afterJob.f.movements, 'the job moves no stock').toBe(before.f.movements);

    // ---- idempotent: a second run writes nothing more
    const second = await runJob(w.f.orgId, w.g.orgId);
    expect(second.find((o) => o.orgId === w.f.orgId)!.posted, 'the second run writes none').toBe(0);
    expect(await franchiseRows(w.f.orgId)).toHaveLength(1);
    expect(await discrepancyCount(w.f.orgId)).toBe(1);

    // ---- the feeds: one gap finding per side, each in its own words
    const lipa = await interEntityFindings(w.f.orgId);
    expect(lipa, 'Lipa\'s feed shows exactly one inter-entity finding').toHaveLength(1);
    expect(lipa[0]!.kind).toBe(SHIPMENT_GAP);
    expect(lipa[0]!.key, 'keyed to the shipment').toContain(s.shipmentId);
    expect(lipa[0]!.storeId).toBe(w.f.storeId);
    expect(lipa[0]!.detail).toContain(`${w.pgName} has recorded ${peso('2480.00')} against the shipment of `);
    expect(lipa[0]!.detail, 'the shipment is named by its date (YYYY-MM-DD)').toContain(`against the shipment of ${(await asOrg(w.f.orgId, (tx) => interEntityRepo.findById(tx, s.shipmentId)))!.shippedOn}`);
    expectNoLeakTo('lipa', w, lipa[0]!.detail);
    expect(lipa[0]!.detail, 'no cost of Lipa\'s own goods either').not.toContain('250.00');
    const pg = await interEntityFindings(w.g.orgId);
    expect(pg, 'PG\'s feed shows exactly one inter-entity finding').toHaveLength(1);
    expect(pg[0]!.kind).toBe(SHIPMENT_GAP);
    expect(pg[0]!.key).toContain(s.shipmentId);
    expect(pg[0]!.storeId).toBe(w.g.storeId);
    expect(pg[0]!.detail, 'PG\'s words name what Lipa billed and what PG recorded').toContain(peso('3100.00'));
    expect(pg[0]!.detail).toContain(peso('2480.00'));
    expectNoLeakTo('pg', w, pg[0]!.detail);
    expect(pg[0]!.detail, 'Lipa\'s cost never reaches PG').not.toContain('250.00');
    expect(pg[0]!.detail).not.toContain('500.00');

    // ---- the credit note, posted by a human, in Lipa's organisation, store = the commissary
    const ordersBefore = await movementCount(w.f.orgId);
    const credit = await asOrg(w.f.orgId, (tx) => api.postFranchiseShortageCredit(tx, w.f.manager, { shipmentId: s.shipmentId }));
    expect(credit.value).toBe('620.00');
    expect(credit.cost).toBe('500.00');
    const legs = await legsOfEntry(credit.entryId);
    const shape = legs.map((l) => `${l.code} D${cents(l.debit)} C${cents(l.credit)} ${l.party_type ?? '-'}:${l.party_id === w.customerId ? 'PG' : l.party_id ?? '-'}`).sort();
    expect(shape).toEqual([
      '1210 D0 C62000 customer:PG',
      '4950 D62000 C0 -:-',
      '5100 D0 C50000 -:-',
      '5300 D50000 C0 -:-',
    ]);
    for (const l of legs) {
      expect(l.org_id, 'M3: the entry is entirely in Lipa\'s organisation').toBe(w.f.orgId);
      expect(l.store_id, 'A7: store = the commissary').toBe(w.f.storeId);
    }
    await expectBalanced(credit.entryId);
    expect(await movementCount(w.f.orgId), 'nothing comes back, so no stock moves and no 1310 debit').toBe(ordersBefore);
    expect(legs.map((l) => l.code)).not.toContain('1310');
    expect(legs.map((l) => l.code)).not.toContain('5400');
    const closed = await franchiseRows(w.f.orgId);
    expect(closed[0]).toMatchObject({ status: 'resolved', disposition: 'franchise_credit', journal_entry_id: credit.entryId, resolved_by: w.f.manager.personId });
    const ship = await asOrg(w.f.orgId, (tx) => interEntityRepo.findByTradeOrder(tx, w.f.orgId, s.orderId));
    expect(ship!.creditedTotal, 'the shipment note carries what was credited').toBe('620.00');

    // ---- AR for PG = AP for Lipa, to the centavo (M4), and the next run is clean on both sides
    expect(cents(await owed(sql, w.f, w.customerId))).toBe('248000');
    expect(cents(await pgOwes(w))).toBe('248000');
    const owes = await asOrg(w.f.orgId, (tx) => interEntityRepo.counterpartyBalance(tx));
    expect(owes.map((r) => [r.counterpartyOrgId, cents(r.counterpartyOwes)])).toEqual([[w.g.orgId, '248000']]);
    const third = await runJob(w.f.orgId, w.g.orgId);
    expect(third.find((o) => o.orgId === w.f.orgId)!.posted).toBe(0);
    expect(await interEntityFindings(w.f.orgId), 'Lipa clean after the credit').toEqual([]);
    expect(await interEntityFindings(w.g.orgId), 'PG clean after the credit').toEqual([]);
    expect(await franchiseRows(w.f.orgId)).toHaveLength(1);
  });

  it('E7r1. TESTS.md fixture 0.333 kg x 10.00: 1.000 kg shipped, PG counts 0.667 (books 6.67), the credit is 3.33 and the cost 1.33', async () => {
    const w = await world('e7r1');
    const s = await sell(w, { qty: '1', rate: '10.00', layers: [['1', '4.0000']] });
    await pgReceives(w, s, '0.667');
    expect(cents(await pgOwes(w))).toBe('667');
    await runJob(w.f.orgId);
    const rows = await franchiseRows(w.f.orgId);
    expect(rows.map((r) => r.quantity)).toEqual(['0.333']);
    const credit = await asOrg(w.f.orgId, (tx) => api.postFranchiseShortageCredit(tx, w.f.manager, { shipmentId: s.shipmentId }));
    expect([credit.value, credit.cost]).toEqual(['3.33', '1.33']);
    expect(cents(await owed(sql, w.f, w.customerId)), 'AR = AP exactly').toBe(cents(await pgOwes(w)));
    expect(await interEntityFindings(w.f.orgId)).toEqual([]);
    expect(await interEntityFindings(w.g.orgId)).toEqual([]);
  });

  it('E7r2. a REAL rounding fixture: 1.000 kg at 10.10, PG counts 0.250 (books 2.53); the credit is billed 10.10 - 2.53 = 7.57, never round(0.750 x 10.10) = 7.58 (kills: credit = round(short x rate))', async () => {
    const w = await world('e7r2');
    const s = await sell(w, { qty: '1', rate: '10.10', layers: [['1', '4.0000']] });
    await pgReceives(w, s, '0.25');
    expect(cents(await pgOwes(w)), 'PG booked round(0.250 x 10.10, 2) = 2.53').toBe('253');
    await runJob(w.f.orgId);
    const credit = await asOrg(w.f.orgId, (tx) => api.postFranchiseShortageCredit(tx, w.f.manager, { shipmentId: s.shipmentId }));
    expect(credit.value).toBe('7.57');
    expect(credit.cost, '0.750 of 1.000 kg at 4.00').toBe('3.00');
    const legs = await legsOfEntry(credit.entryId);
    expect(legs.find((l) => l.code === '4950')!.debit).toBe('7.57');
    expect(legs.find((l) => l.code === '1210')!.credit).toBe('7.57');
    expect(cents(await owed(sql, w.f, w.customerId)), 'AR 2.53 = AP 2.53 exactly (M4)').toBe('253');
    expect(cents(await pgOwes(w))).toBe('253');
    expect(await interEntityFindings(w.f.orgId), 'a one-centavo disagreement would still show').toEqual([]);
    expect(await interEntityFindings(w.g.orgId)).toEqual([]);
  });

  it('E7t. NO tolerance: a gap of exactly one centavo is a finding and a discrepancy (1.000 kg at 10.10, PG counts 0.999 and books 10.09) (kills: tolerate +-0.01)', async () => {
    const w = await world('e7t');
    const s = await sell(w, { qty: '1', rate: '10.10', layers: [['1', '4.0000']] });
    await pgReceives(w, s, '0.999');
    expect(cents(await pgOwes(w))).toBe('1009');
    await runJob(w.f.orgId);
    expect((await franchiseRows(w.f.orgId)).map((r) => r.quantity), 'a 0.001 kg shortage is still a row').toEqual(['0.001']);
    const lipa = await interEntityFindings(w.f.orgId);
    expect(lipa).toHaveLength(1);
    expect(lipa[0]!.detail).toContain(peso('10.09'));
    expect(await interEntityFindings(w.g.orgId)).toHaveLength(1);
    const credit = await asOrg(w.f.orgId, (tx) => api.postFranchiseShortageCredit(tx, w.f.manager, { shipmentId: s.shipmentId }));
    expect(credit.value).toBe('0.01');
    expect(cents(await owed(sql, w.f, w.customerId))).toBe('1009');
    expect(await interEntityFindings(w.f.orgId)).toEqual([]);
  });

  it('E7c. the credit note is a human act with guards: a person without the right is refused (the check), nothing to credit is refused in words, and a second post is refused with one entry only', async () => {
    const w = await world('e7c');
    const s = await sell(w);
    await pgReceives(w, s, '8');
    // before the job has raised the row: nothing to credit
    const early = await sayOf(asOrg(w.f.orgId, (tx) => api.postFranchiseShortageCredit(tx, w.f.manager, { shipmentId: s.shipmentId })));
    expect(early.said, `not a RefusalError sentence: ${early.message}`).not.toBeNull();
    expect(early.said).toMatch(/credit/i);
    await runJob(w.f.orgId);
    const entries = await jeCount(w.f.orgId);
    const denied = await sayOf(asOrg(w.f.orgId, (tx) => api.postFranchiseShortageCredit(tx, w.f.staff, { shipmentId: s.shipmentId })));
    expect(denied.err, `expected AuthorizationError, got ${denied.message}`).toBeInstanceOf(AuthorizationError);
    expect(await jeCount(w.f.orgId), 'a refused credit wrote nothing').toBe(entries);
    // a full-receipt shipment has nothing to credit either
    const full = await sell(w);
    await pgReceives(w, full, '10');
    const nothing = await sayOf(asOrg(w.f.orgId, (tx) => api.postFranchiseShortageCredit(tx, w.f.manager, { shipmentId: full.shipmentId })));
    expect(nothing.said, `not a RefusalError sentence: ${nothing.message}`).not.toBeNull();
    // once, then never again
    await asOrg(w.f.orgId, (tx) => api.postFranchiseShortageCredit(tx, w.f.manager, { shipmentId: s.shipmentId }));
    const posted = await jeCount(w.f.orgId);
    const again = await sayOf(asOrg(w.f.orgId, (tx) => api.postFranchiseShortageCredit(tx, w.f.manager, { shipmentId: s.shipmentId })));
    expect(again.said, `not a RefusalError sentence: ${again.message}`).not.toBeNull();
    expect(again.said).toMatch(/already/i);
    expect(await jeCount(w.f.orgId), 'one credit entry only').toBe(posted);
    expect(cents(await owed(sql, w.f, w.customerId)), 'AR was relieved once: 3100 + 3100 - 620').toBe('558000');
  });

  it('CT2. the app role still cannot edit credited_total by hand once a shipment is received (the credit note moves it through its own path only)', async () => {
    const w = await world('ct2');
    const s = await sell(w);
    await pgReceives(w, s, '8');
    const err = await asOrg(w.f.orgId, (tx) => tx.execute(dsql`update inter_entity_shipments set credited_total = '620.00' where id = ${s.shipmentId}`)).then(
      () => undefined,
      (e: { code?: string; cause?: { code?: string } }) => e,
    );
    expect(err, 'a hand edit of credited_total was ACCEPTED').toBeDefined();
    expect(err!.cause?.code ?? err!.code).toBe('42501');
  });
});

// ================================================================================================ C1, C2
describe('C1 a credit after the charge was collected goes to store credit for the excess, in the same entry', () => {
  const collect = (w: World, s: Sale, amount: string) =>
    asOrg(w.f.orgId, (tx) =>
      recordCollection(tx, w.f.manager, {
        storeId: w.f.storeId, customerId: w.customerId, collectionDate: '2026-10-16', amount, moneyAccountId: w.f.drawerA,
        allocations: [{ chargeId: s.chargeId, amountApplied: amount }],
      }),
    );

  it('C1a. charge fully collected (3100.00): the whole 620.00 is CR 2140 party PG, no 1210 leg; 5300/5100 500.00 as before (kills: always CR 1210)', async () => {
    const w = await world('c1a');
    const s = await sell(w);
    await pgReceives(w, s, '8');
    await collect(w, s, '3100.00');
    await runJob(w.f.orgId);
    const credit = await asOrg(w.f.orgId, (tx) => api.postFranchiseShortageCredit(tx, w.f.manager, { shipmentId: s.shipmentId }));
    const legs = await legsOfEntry(credit.entryId);
    const shape = legs.map((l) => `${l.code} D${cents(l.debit)} C${cents(l.credit)} ${l.party_type ?? '-'}:${l.party_id === w.customerId ? 'PG' : '-'}`).sort();
    expect(shape).toEqual([
      '2140 D0 C62000 customer:PG',
      '4950 D62000 C0 -:-',
      '5100 D0 C50000 -:-',
      '5300 D50000 C0 -:-',
    ]);
    await expectBalanced(credit.entryId);
    expect(cents(await owed(sql, w.f, w.customerId)), 'nothing open on the receivable').toBe('0');
    expect(cents(await asOrg(w.f.orgId, (tx) => domain.customerCreditBalance(tx, w.f.orgId, w.customerId))), 'PG holds a 620.00 store credit').toBe('62000');
  });

  it('C1b. charge 2700.00 collected (400.00 still open): CR 1210 400.00 and CR 2140 220.00 in ONE entry', async () => {
    const w = await world('c1b');
    const s = await sell(w);
    await pgReceives(w, s, '8');
    await collect(w, s, '2700.00');
    await runJob(w.f.orgId);
    const credit = await asOrg(w.f.orgId, (tx) => api.postFranchiseShortageCredit(tx, w.f.manager, { shipmentId: s.shipmentId }));
    const legs = await legsOfEntry(credit.entryId);
    const shape = legs.map((l) => `${l.code} D${cents(l.debit)} C${cents(l.credit)}`).sort();
    expect(shape).toEqual(['1210 D0 C40000', '2140 D0 C22000', '4950 D62000 C0', '5100 D0 C50000', '5300 D50000 C0']);
    for (const l of legs.filter((x) => x.code === '1210' || x.code === '2140')) {
      expect([l.party_type, l.party_id]).toEqual(['customer', w.customerId]);
    }
    await expectBalanced(credit.entryId);
    expect(cents(await owed(sql, w.f, w.customerId))).toBe('0');
  });
});

describe('C2 the credit\'s cost leg is what the dispatch consumed for the short quantity, not today\'s layers', () => {
  it('C2. two layers (6 kg at 200 + 6 kg at 300) consumed 10 kg = 2400.00; a dearer layer (400) arrives after; short 2 kg -> cost 480.00 (pro-rata by quantity), not 800.00 (kills: re-cost from today\'s layers)', async () => {
    const w = await world('c2');
    const s = await sell(w, { layers: [['6', '200.0000'], ['6', '300.0000']] });
    await stockAt(w.f, s.itemId, '10', '400.0000'); // layers changed since the dispatch
    await pgReceives(w, s, '8');
    const [consumed] = await sql<{ c: string }[]>`
      select sum(c.cost)::text as c from stock_layer_consumptions c join stock_movements m on m.id = c.movement_id
      where m.org_id = ${w.f.orgId} and m.item_id = ${s.itemId} and m.source_type = 'trade_order_dispatch'`;
    expect(cents(consumed!.c), 'fixture: the dispatch relieved 2400.00').toBe('240000');
    await runJob(w.f.orgId);
    const credit = await asOrg(w.f.orgId, (tx) => api.postFranchiseShortageCredit(tx, w.f.manager, { shipmentId: s.shipmentId }));
    expect(credit.cost).toBe('480.00');
    const legs = await legsOfEntry(credit.entryId);
    expect(legs.find((l) => l.code === '5300')!.debit).toBe('480.00');
    expect(legs.find((l) => l.code === '5100')!.credit).toBe('480.00');
    expect(legs.find((l) => l.code === '4950')!.debit).toBe('620.00');
  });
});

// ================================================================================================ E12
describe('E12 two shipments, one payment each side: AR = AP exactly; a one-sided payment shows once per side', () => {
  const lipaCollects = (w: World, chargeId: string, amount: string) =>
    asOrg(w.f.orgId, (tx) =>
      recordCollection(tx, w.f.manager, {
        storeId: w.f.storeId, customerId: w.customerId, collectionDate: '2026-10-16', amount, moneyAccountId: w.f.drawerA,
        allocations: [{ chargeId, amountApplied: amount }],
      }),
    );
  const pgPays = async (w: World, amount: string, outstanding: string) => {
    const items = await asOrg(w.g.orgId, (tx) => apRepo.openItems(tx, w.g.orgId, w.supplierId, w.g.storeId));
    const item = items.find((i) => i.outstanding === outstanding);
    expect(item, `PG has an open item of ${outstanding}: ${JSON.stringify(items.map((i) => i.outstanding))}`).toBeDefined();
    return asPerson(w.g.orgId, w.g.manager.personId, (tx) =>
      recordPayment(tx, w.g.manager, {
        storeId: w.g.storeId, supplierId: w.supplierId, businessDate: '2026-10-16', amount, moneyAccountId: w.g.drawerA,
        allocations: [{ expenseId: item!.expenseId, amountApplied: amount }],
      }),
    );
  };

  it('E12. AR = AP to the centavo after the credit and one payment each side; then PG pays 500.00 that Lipa has not recorded: exactly ONE finding per side; Lipa records it and both clear', async () => {
    const w = await world('e12');
    const s1 = await sell(w);
    const s2 = await sell(w);
    await pgReceives(w, s1, '10'); // 3100.00 billed, 3100.00 recorded
    await pgReceives(w, s2, '8'); // 3100.00 billed, 2480.00 recorded
    await runJob(w.f.orgId, w.g.orgId);
    await asOrg(w.f.orgId, (tx) => api.postFranchiseShortageCredit(tx, w.f.manager, { shipmentId: s2.shipmentId }));
    // one payment each side, the same 1000.00 against the full shipment
    await lipaCollects(w, s1.chargeId, '1000.00');
    await pgPays(w, '1000.00', '3100.00');
    const ar = cents(await owed(sql, w.f, w.customerId));
    expect(ar, 'AR 6200 - 620 - 1000').toBe('458000');
    expect(cents(await pgOwes(w)), 'AP 3100 + 2480 - 1000: equal to the centavo (M4)').toBe(ar);
    await runJob(w.f.orgId, w.g.orgId);
    expect(await interEntityFindings(w.f.orgId)).toEqual([]);
    expect(await interEntityFindings(w.g.orgId)).toEqual([]);
    const owes = await asOrg(w.f.orgId, (tx) => interEntityRepo.counterpartyBalance(tx));
    expect(owes.map((r) => cents(r.counterpartyOwes))).toEqual([ar]);

    // a one-sided payment: PG pays 500.00 more, Lipa has not recorded the money
    await pgPays(w, '500.00', '2480.00');
    expect(cents(await owed(sql, w.f, w.customerId))).toBe('458000');
    expect(cents(await pgOwes(w))).toBe('408000');
    const lipa = await interEntityFindings(w.f.orgId);
    expect(lipa, 'Lipa: exactly one finding').toHaveLength(1);
    expect(lipa[0]!.kind).toBe(BALANCE_GAP);
    expect(lipa[0]!.detail).toContain(w.pgName);
    expect(lipa[0]!.detail).toContain(peso('500.00'));
    expectNoLeakTo('lipa', w, lipa[0]!.detail);
    const pg = await interEntityFindings(w.g.orgId);
    expect(pg, 'PG: exactly one finding (needs a way to read Lipa\'s receivable for PG: see the hand-back)').toHaveLength(1);
    expect(pg[0]!.kind).toBe(BALANCE_GAP);
    expect(pg[0]!.detail).toContain(peso('500.00'));
    expectNoLeakTo('pg', w, pg[0]!.detail);

    // Lipa records the 500.00 it received: both sides clear
    await lipaCollects(w, s2.chargeId, '500.00');
    expect(cents(await owed(sql, w.f, w.customerId))).toBe(cents(await pgOwes(w)));
    expect(await interEntityFindings(w.f.orgId)).toEqual([]);
    expect(await interEntityFindings(w.g.orgId)).toEqual([]);
  });
});

// ================================================================================================ E21
describe('E21 a paired return clears the reconciliation', () => {
  it('E21. PG returns 2 kg to Lipa (its supplier return) -> a balance finding on each side until Lipa records the matching customer return; then both are clean and AR = AP', async () => {
    const w = await world('e21');
    const s = await sell(w);
    await pgReceives(w, s, '10');
    await runJob(w.f.orgId, w.g.orgId);
    expect(await interEntityFindings(w.f.orgId)).toEqual([]);
    const [d] = await sql<{ id: string }[]>`select id from deliveries where org_id = ${w.g.orgId} and inter_entity_shipment_id = ${s.shipmentId}`;
    let dl = (await sql<{ id: string }[]>`select id from delivery_lines where delivery_id = ${d!.id}`)[0];
    if (!dl) {
      dl = (await sql<{ id: string }[]>`
        insert into delivery_lines (delivery_id, line_no, item_id, ordered_quantity, received_quantity, purchase_unit, conversion_factor, unit_cost, location_id)
        values (${d!.id}, 1, ${s.pgItemId}, '10.000', '10.000', 'kg', '1', '310.0000', ${w.g.locationId}) returning id`)[0]!;
    }
    const ret = await asOrg(w.g.orgId, (tx) =>
      recordReturn(tx, {
        storeId: w.g.storeId, supplierId: w.supplierId, deliveryId: d!.id, returnedOn: '2026-10-16', reason: 'Two kilos spoiled in transit.',
        lines: [{ itemId: s.pgItemId, itemKind: 'raw_material', locationId: w.g.locationId, quantity: quantity('2.000'), deliveryLineId: dl.id }],
        actor: w.g.manager,
      }),
    );
    expect(ret.ok, JSON.stringify(ret)).toBe(true);
    // PG's return is a 620.00 credit it holds against Lipa (1240, party Lipa): one side only so far. The receipt was already billed (2120 is cleared),
    // so the return must NOT debit the goods-received control account again.
    const [grni] = await sql<{ net: string }[]>`
      select coalesce(sum(jl.debit - jl.credit), 0)::text as net from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
      where je.org_id = ${w.g.orgId} and a.code = '2120'`;
    expect(cents(grni!.net), "PG's 2120 stays at zero (a debit balance there is an impossible control account)").toBe('0');
    expect(cents(await pgOwes(w)), 'PG nets the return against what it owes: 3100 - 620').toBe('248000');
    expect(cents(await owed(sql, w.f, w.customerId)), 'Lipa has not recorded the return yet').toBe('310000');
    const lipa = await interEntityFindings(w.f.orgId);
    expect(lipa, 'Lipa sees the unmatched return').toHaveLength(1);
    expect(lipa[0]!.kind).toBe(BALANCE_GAP);
    expect(lipa[0]!.detail).toContain(peso('620.00'));
    const pg = await interEntityFindings(w.g.orgId);
    expect(pg).toHaveLength(1);
    expect(pg[0]!.kind).toBe(BALANCE_GAP);
    expect(pg[0]!.detail).toContain(peso('620.00'));

    // Lipa posts the matching customer return, in its own organisation
    const back = await asOrg(w.f.orgId, (tx) =>
      recordCustomerReturn(tx, { tradeOrderId: s.orderId, returnedOn: '2026-10-16', reason: 'Franchise returned 2 kg.', lines: [{ tradeOrderLineId: s.orderLineId, quantity: '2' }], actor: w.f.manager }),
    );
    expect(back.ok, JSON.stringify(back)).toBe(true);
    expect(cents(await owed(sql, w.f, w.customerId))).toBe('248000');
    expect(cents(await pgOwes(w))).toBe('248000');
    expect(await interEntityFindings(w.f.orgId), 'the paired return clears Lipa\'s feed').toEqual([]);
    expect(await interEntityFindings(w.g.orgId), 'the paired return clears PG\'s feed').toEqual([]);
    const owes = await asOrg(w.f.orgId, (tx) => interEntityRepo.counterpartyBalance(tx));
    expect(owes.map((r) => cents(r.counterpartyOwes)), 'the seller\'s one-figure read nets the return credit too').toEqual(['248000']);
  });
});

// ================================================================================================ QO-2 and the seller-side read
describe('DB1 the day-open block ignores a franchise credit; RB1 the seller cannot see who at PG received', () => {
  it('DB1. a franchise_credit row is on the manager\'s to-do list (unresolved) but does NOT block opening a sales day (QO-2) (kills: blocking() keeps it)', async () => {
    const w = await world('db1');
    const s = await sell(w);
    await pgReceives(w, s, '8');
    await runJob(w.f.orgId);
    expect(await franchiseRows(w.f.orgId)).toHaveLength(1);
    const todo = await asOrg(w.f.orgId, (tx) => tradeDiscrepanciesRepo.unresolved(tx, w.f.orgId, w.f.storeId));
    expect(todo.map((r) => r.disposition)).toContain('franchise_credit');
    const blocking = await asOrg(w.f.orgId, (tx) => tradeDiscrepanciesRepo.blocking(tx, w.f.orgId, w.f.storeId, '2026-10-17'));
    expect(blocking.map((r) => r.disposition), 'a franchise sale never sits in 1340; it must not stop the day').not.toContain('franchise_credit');
  });

  it('DK1. (orchestrator ruling) an OPEN franchise_credit row, even one older than 15 days, is NOT counted by the receivingDisputeOverdue finding nor by the commissary open-disputes KPI tile: shortage credits have their own reconcile findings', async () => {
    const w = await world('dk1');
    const s = await sell(w);
    await pgReceives(w, s, '8');
    await runJob(w.f.orgId);
    expect(await franchiseRows(w.f.orgId)).toHaveLength(1);
    await sql`update trade_discrepancies set created_at = now() - interval '20 days' where org_id = ${w.f.orgId}`;
    const feed = await asOrg(w.f.orgId, (tx) => listFindings(tx, w.f.orgId, { period: '2026-09' }));
    expect(feed.findings.filter((x) => x.kind === 'receivingDisputeOverdue'), 'the stale franchise credit must not read as a receiving dispute').toEqual([]);
    const tile = await asOrg(w.f.orgId, (tx) => commissaryKpisRepo.openDisputes(tx, { orgId: w.f.orgId }));
    expect(tile.count, 'the KPI tile counts commissary transfer disputes only').toBe(0);
    expect(tile.rows).toEqual([]);
  });

  it('RB1. after PG receives, the seller\'s reads of the shipment carry no received_by and nothing that names the PG person (QI-1 a; S5d ruling (c))', async () => {
    const w = await world('rb1');
    const s = await sell(w);
    await pgReceives(w, s, '8');
    const [raw] = await sql<{ received_by: string }[]>`select received_by from inter_entity_shipments where id = ${s.shipmentId}`;
    expect(raw!.received_by, 'fixture: the definer stamped PG\'s person').toBe(w.g.manager.personId);
    const byOrder = await asOrg(w.f.orgId, (tx) => interEntityRepo.findByTradeOrder(tx, w.f.orgId, s.orderId));
    const byId = await asOrg(w.f.orgId, (tx) => interEntityRepo.findById(tx, s.shipmentId));
    for (const [label, row] of [['findByTradeOrder', byOrder], ['findById', byId]] as const) {
      expect(row, label).not.toBeNull();
      expect((row as { receivedBy?: string | null }).receivedBy ?? null, `${label}: received_by reached the seller`).toBeNull();
      const text = JSON.stringify(row);
      expect(text, `${label}: PG person id`).not.toContain(w.g.manager.personId);
      expect(text, `${label}: PG person name`).not.toContain(w.pgManagerName);
      // what the seller IS allowed: that it was received, when, and for how much
      expect(row).toMatchObject({ status: 'received', receivedTotal: '2480.00' });
      expect((row as { receivedAt: Date | null }).receivedAt).not.toBeNull();
    }
    const lines = await asOrg(w.f.orgId, (tx) => interEntityRepo.linesOf(tx, s.shipmentId));
    expect(lines.map((l) => l.receivedQuantity), 'QI-1 a: per-item counts are the seller\'s to see').toEqual(['8.000']);
  });
});

// ================================================================================================ J1
describe('J1 runInterEntityReconcile: every org, one scheduler_runs row each, one org failing does not stop the next', () => {
  it('J1. one run row per org with job inter_entity_reconcile; the org whose write is refused is recorded as failed WITH the reason; the next org still gets its discrepancy', async () => {
    // names chosen so the failing seller sorts BEFORE the healthy one (listOrgsToRun orders by name)
    const bad = await world('j1a', { lipa: `AAA-J1-broken-${uid('x')}` });
    const ok = await world('j1b', { lipa: `ZZZ-J1-healthy-${uid('y')}` });
    for (const w of [bad, ok]) {
      const s = await sell(w);
      await pgReceives(w, s, '8');
    }
    await sql`create or replace function t398e_refuse() returns trigger language plpgsql as $$ begin raise exception 'T398E injected refusal: this organisation cannot write a discrepancy'; end; $$`;
    await sql.unsafe(`create trigger t398e_refuse_trg before insert on trade_discrepancies for each row when (new.org_id = '${bad.f.orgId}') execute function t398e_refuse()`);
    let res: { outcomes: JobOutcome[]; hadFailures: boolean };
    try {
      res = await api.runInterEntityReconcile({ trigger: 'cron' });
    } finally {
      await sql`drop trigger if exists t398e_refuse_trg on trade_discrepancies`;
      await sql`drop function if exists t398e_refuse()`;
    }
    expect(res.hadFailures, 'a failed org makes the whole run non-zero').toBe(true);
    const mine = [bad.f.orgId, bad.g.orgId, ok.f.orgId, ok.g.orgId];
    for (const orgId of mine) {
      const runs = await sql<{ outcome: string; period: string; j: string }[]>`
        select outcome, period, to_jsonb(r)::text as j from scheduler_runs r where org_id = ${orgId} and job = 'inter_entity_reconcile'`;
      expect(runs, `one scheduler_runs row for ${orgId}`).toHaveLength(1);
      expect(runs[0]!.period.length).toBe(7); // YYYY-MM
      if (orgId === bad.f.orgId) {
        expect(runs[0]!.outcome, 'the broken org is recorded as failed, not ok').not.toBe('ok');
        expect(runs[0]!.j, 'the reason is kept verbatim').toContain('T398E injected refusal');
      } else {
        expect(runs[0]!.outcome).toBe('ok');
      }
    }
    expect(await franchiseRows(bad.f.orgId), 'the refused write left nothing half-done').toEqual([]);
    expect(await franchiseRows(ok.f.orgId), 'the healthy org after it was still reconciled').toHaveLength(1);
    const outcomeOfBad = res.outcomes.find((o) => o.orgId === bad.f.orgId)!;
    expect(outcomeOfBad.error !== undefined || outcomeOfBad.failed > 0).toBe(true);
    expect(res.outcomes.find((o) => o.orgId === ok.f.orgId)!.posted).toBe(1);
  });
});

// ================================================================================================ S5e audit
describe('S5e audit', () => {
  /** Lipa dispatches TWO items (a kg of A, b kg of B, same rate) on two order lines; PG maps BOTH shipment lines to the SAME one of its own items. */
  async function sell2(w: World, o: { a: string; b: string; rate?: string; layersA: [string, string][]; layersB: [string, string][] }) {
    const rate = o.rate ?? '310.00';
    const itemA = await mkItem(w.f, 'Pork belly', true);
    const itemB = await mkItem(w.f, 'Pork shoulder', true);
    for (const [q, c] of o.layersA) await stockAt(w.f, itemA.id, q, c);
    for (const [q, c] of o.layersB) await stockAt(w.f, itemB.id, q, c);
    const order = await asOrg(w.f.orgId, (tx) =>
      createTradeOrder(tx, w.f.manager, {
        storeId: w.f.storeId, customerId: w.customerId, orderDate: '2026-10-10',
        lines: [{ itemId: itemA.id, quantity: o.a, rate }, { itemId: itemB.id, quantity: o.b, rate }],
      }),
    );
    const r = await dispatch(w.f, w.f.manager, order.orderId);
    const ship = await asOrg(w.f.orgId, (tx) => interEntityRepo.findByTradeOrder(tx, w.f.orgId, order.orderId));
    const lines = await asOrg(w.f.orgId, (tx) => interEntityRepo.linesOf(tx, ship!.id));
    const pgItem = await mkItem(w.g, 'Pork (PG)', false);
    const pgItem2 = await mkItem(w.g, 'Shoulder (PG)', false);
    for (const it of [pgItem, pgItem2]) {
      await sql`insert into supplier_items (org_id, supplier_id, item_id, created_by) values (${w.g.orgId}, ${w.supplierId}, ${it.id}, ${w.g.manager.personId})`;
    }
    return { orderId: order.orderId, chargeId: r.chargeId!, shipmentId: ship!.id, lines, itemIds: [itemA.id, itemB.id], pgItemId: pgItem.id, pgItemIds: [pgItem.id, pgItem2.id] };
  }
  /** `sameItem`: PG maps both shipment lines to ONE of its items; otherwise each line to its own. */
  const pgReceives2 = (w: World, x: { shipmentId: string; lines: { id: string }[]; pgItemIds: string[] }, counts: [string, string], sameItem = false) =>
    asPerson(w.g.orgId, w.g.manager.personId, (tx) =>
      api.receiveInterEntityShipment(tx, w.g.manager, {
        shipmentId: x.shipmentId, storeId: w.g.storeId,
        lines: x.lines.map((l, i) => ({ shipmentLineId: l.id, itemId: sameItem ? x.pgItemIds[0] : x.pgItemIds[i], receivedQuantity: counts[i]! })),
      }),
    );

  const ret = (w: World, s: Sale, qty: string) =>
    asOrg(w.f.orgId, (tx) =>
      recordCustomerReturn(tx, { tradeOrderId: s.orderId, returnedOn: '2026-10-16', reason: 'Franchise returned goods.', lines: [{ tradeOrderLineId: s.orderLineId, quantity: qty }], actor: w.f.manager }),
    );
  const retSnap = async (orgId: string) => ({
    ...(await bookCounts(orgId)),
    returns: (await sql<{ n: number }[]>`select count(*)::int as n from customer_returns where org_id = ${orgId}`)[0]!.n,
  });
  const refused = (r: { ok: boolean; reason?: string }) => {
    expect(r.ok, 'the return was ACCEPTED').toBe(false);
    expect(r.reason ?? '', 'refused in words, not a database sentence').not.toMatch(/SQLSTATE|violates|constraint/i);
    return r.reason ?? '';
  };
  const lipaCollects = (w: World, chargeId: string, amount: string) =>
    asOrg(w.f.orgId, (tx) =>
      recordCollection(tx, w.f.manager, {
        storeId: w.f.storeId, customerId: w.customerId, collectionDate: '2026-10-16', amount, moneyAccountId: w.f.drawerA,
        allocations: [{ chargeId, amountApplied: amount }],
      }),
    );
  const sum = (legs: { code: string; debit: string; credit: string }[], code: string, side: 'debit' | 'credit') =>
    legs.filter((l) => l.code === code).reduce((t, l) => t + Number(cents(l[side])), 0);

  it('H1a. Lipa shipped 10, PG counted 8: a return of 10 is refused in words naming 8 and writes nothing; a return of 8 is accepted (control)', async () => {
    const w = await world('h1a');
    const s = await sell(w);
    await pgReceives(w, s, '8');
    const before = await retSnap(w.f.orgId);
    const said = refused(await ret(w, s, '10'));
    expect(said, 'the sentence names what PG actually received').toContain('8');
    expect(await retSnap(w.f.orgId), 'a refused return wrote nothing').toEqual(before);
    const ok = await ret(w, s, '8');
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
  });

  it('H1b. with the shortage credit already posted the cap is still 8 (9 and 10 refused, a second return after 8 refused) and credit note + returns never exceed the billed 3100.00', async () => {
    const w = await world('h1b');
    const s = await sell(w);
    await pgReceives(w, s, '8');
    await runJob(w.f.orgId);
    const credit = await asOrg(w.f.orgId, (tx) => api.postFranchiseShortageCredit(tx, w.f.manager, { shipmentId: s.shipmentId }));
    const before = await retSnap(w.f.orgId);
    refused(await ret(w, s, '10'));
    refused(await ret(w, s, '9'));
    expect(await retSnap(w.f.orgId)).toEqual(before);
    const ok = await ret(w, s, '8');
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    const after = await retSnap(w.f.orgId);
    refused(await ret(w, s, '1'));
    expect(await retSnap(w.f.orgId), 'nothing more to return').toEqual(after);
    const total =
      sum(await legsOfEntry(credit.entryId), '4950', 'debit') + sum(await legsOfEntry((ok as { journalEntryId: string }).journalEntryId), '4950', 'debit');
    expect(total, 'credit note 620.00 + return 2480.00 = billed 3100.00, never more').toBe(310000);
  });

  it('H1c. a return on a shipment PG has not received yet (order dispatched, shipment in transit) is refused in words and writes nothing', async () => {
    const w = await world('h1c');
    const s = await sell(w);
    const before = await retSnap(w.f.orgId);
    const said = refused(await ret(w, s, '1'));
    expect(said.length).toBeGreaterThan(10);
    expect(await retSnap(w.f.orgId)).toEqual(before);
  });

  it('M2. charge 3100, PG paid 1000, credit note 620: the charge reads 1480.00 outstanding; a return of 2480 then splits 1480 to CR 1210 and 1000 to CR 2140 (never over-credits 1210)', async () => {
    const w = await world('m2');
    const s = await sell(w);
    await pgReceives(w, s, '8');
    await lipaCollects(w, s.chargeId, '1000.00');
    await runJob(w.f.orgId);
    await asOrg(w.f.orgId, (tx) => api.postFranchiseShortageCredit(tx, w.f.manager, { shipmentId: s.shipmentId }));
    expect(await asOrg(w.f.orgId, (tx) => arRepo.outstandingForCharge(tx, w.f.orgId, s.chargeId)), 'collected 1000 + credited 620').toBe('1480.00');
    const back = await ret(w, s, '8');
    expect(back.ok, JSON.stringify(back)).toBe(true);
    const legs = await legsOfEntry((back as { journalEntryId: string }).journalEntryId);
    const shape = legs.filter((l) => ['1210', '2140', '4950'].includes(l.code)).map((l) => `${l.code} D${cents(l.debit)} C${cents(l.credit)}`).sort();
    expect(shape).toEqual(['1210 D0 C148000', '2140 D0 C100000', '4950 D248000 C0']);
    expect(await asOrg(w.f.orgId, (tx) => arRepo.outstandingForCharge(tx, w.f.orgId, s.chargeId))).toBe('0.00');
  });

  it('M2b. (DEF-748, plain external customer) two returns on one charge: the second split uses the outstanding NET of the first return (1210 860.00 + 2140 380.00, not 1210 1240.00)', async () => {
    const w = await world('m2b');
    const ext = await buyer(sql, w.f);
    const item = await mkItem(w.f, 'Pork belly', true);
    await stockAt(w.f, item.id, '10', '250.0000');
    const order = await asOrg(w.f.orgId, (tx) =>
      createTradeOrder(tx, w.f.manager, { storeId: w.f.storeId, customerId: ext, orderDate: '2026-10-10', lines: [{ itemId: item.id, quantity: '10', rate: '310.00' }] }),
    );
    const r = await dispatch(w.f, w.f.manager, order.orderId);
    const lineId = (await sql<{ id: string }[]>`select id from trade_order_lines where order_id = ${order.orderId}`)[0]!.id;
    await asOrg(w.f.orgId, (tx) =>
      recordCollection(tx, w.f.manager, {
        storeId: w.f.storeId, customerId: ext, collectionDate: '2026-10-16', amount: '1000.00', moneyAccountId: w.f.drawerA,
        allocations: [{ chargeId: r.chargeId!, amountApplied: '1000.00' }],
      }),
    );
    const back = (qty: string) =>
      asOrg(w.f.orgId, (tx) =>
        recordCustomerReturn(tx, { tradeOrderId: order.orderId, returnedOn: '2026-10-16', reason: 'Returned.', lines: [{ tradeOrderLineId: lineId, quantity: qty }], actor: w.f.manager }),
      );
    const split = async (res: Awaited<ReturnType<typeof back>>) => {
      expect(res.ok, JSON.stringify(res)).toBe(true);
      const legs = await legsOfEntry((res as { journalEntryId: string }).journalEntryId);
      return legs.filter((l) => l.code === '1210' || l.code === '2140').map((l) => `${l.code} C${cents(l.credit)}`).sort();
    };
    expect(await split(await back('4'))).toEqual(['1210 C124000']);
    expect(await asOrg(w.f.orgId, (tx) => arRepo.outstandingForCharge(tx, w.f.orgId, r.chargeId!)), '3100 - 1000 - 1240').toBe('860.00');
    expect(await split(await back('4'))).toEqual(['1210 C86000', '2140 C38000']);
  });

  it("L3. two items on two order lines (6 + 4 kg) that PG maps to ONE of its items, PG counts 5 and 3: the credit note's cost legs are EXACTLY the dispatch's consumption for the 2 kg short (100.00 + 200.00 = 300.00), no drift", async () => {
    const w = await world('l3');
    const x = await sell2(w, { a: '6', b: '4', layersA: [['6', '100.0000']], layersB: [['6', '200.0000']] });
    const [consumed] = await sql<{ c: string }[]>`
      select sum(c.cost)::text as c from stock_layer_consumptions c join stock_movements m on m.id = c.movement_id
      where m.org_id = ${w.f.orgId} and m.item_id in (${x.itemIds[0]!}, ${x.itemIds[1]!}) and m.source_type = 'trade_order_dispatch'`;
    expect(cents(consumed!.c), 'fixture: 6 kg at 100 + 4 kg at 200').toBe('140000');
    await pgReceives2(w, x, ['5', '3']);
    await runJob(w.f.orgId);
    expect(await franchiseRows(w.f.orgId), 'one row per short line').toHaveLength(2);
    const credit = await asOrg(w.f.orgId, (tx) => api.postFranchiseShortageCredit(tx, w.f.manager, { shipmentId: x.shipmentId }));
    expect([credit.value, credit.cost]).toEqual(['620.00', '300.00']);
    const legs = await legsOfEntry(credit.entryId);
    expect(sum(legs, '5300', 'debit')).toBe(30000);
    expect(sum(legs, '5100', 'credit')).toBe(30000);
    await expectBalanced(credit.entryId);
  });

  it('L3a. (ruling) an order with the SAME item on two lines is REFUSED in words at create or confirm, before any dispatch ("combine them"), never a raw duplicate-key error', async () => {
    const w = await world('l3a');
    const item = await mkItem(w.f, 'Pork belly', true);
    await stockAt(w.f, item.id, '12', '100.0000');
    const before = await bookCounts(w.f.orgId);
    const made = await sayOf(
      asOrg(w.f.orgId, async (tx) => {
        const order = await createTradeOrder(tx, w.f.manager, {
          storeId: w.f.storeId, customerId: w.customerId, orderDate: '2026-10-10',
          lines: [{ itemId: item.id, quantity: '6', rate: '310.00' }, { itemId: item.id, quantity: '4', rate: '310.00' }],
        });
        await domain.confirmTradeOrder(tx, w.f.manager, { orderId: order.orderId });
      }),
    );
    expect(made.said, `not a sentence a person can read: ${made.message}`).not.toBeNull();
    expect(made.said).toMatch(/combine/i);
    expect(made.said).not.toMatch(/SQLSTATE|violates|duplicate key|constraint/i);
    expect(await bookCounts(w.f.orgId), 'nothing written').toEqual(before);
  });

  it('L4. (ruling) PG mapping two shipment lines to the SAME item of its own is REFUSED in words at receive, naming both lines ("map each line to its own item"); nothing written in either book', async () => {
    // NOTE: the per-line finalise key (each stock layer finalised with its own invoice line) stays correct by construction once one item can
    // appear on only one line of a receipt, so it is not asserted here.
    const w = await world('l4');
    const x = await sell2(w, { a: '6', b: '4', layersA: [['6', '100.0000']], layersB: [['6', '200.0000']] });
    const before = { f: await bookCounts(w.f.orgId), g: await bookCounts(w.g.orgId) };
    const r = await sayOf(pgReceives2(w, x, ['6', '4'], true));
    expect(r.said, `not a sentence a person can read: ${r.message}`).not.toBeNull();
    expect(r.said).toMatch(/own item/i);
    for (const l of x.lines) expect(r.said, 'names both lines').toContain(l.itemName);
    expect(r.said).not.toMatch(/SQLSTATE|violates|duplicate key|constraint/i);
    expect({ f: await bookCounts(w.f.orgId), g: await bookCounts(w.g.orgId) }, 'nothing written').toEqual(before);
    const ship = await asOrg(w.f.orgId, (tx) => interEntityRepo.findById(tx, x.shipmentId));
    expect(ship!.status, 'the shipment stays in transit').toBe('in_transit');
  });
});
