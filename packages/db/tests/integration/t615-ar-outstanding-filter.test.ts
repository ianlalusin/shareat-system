/**
 * T-615 item 3 - AR `outstandingForCharge` and `listChargesForCustomer` narrow their allocated / written-off sums to the charge (or the customer's charges)
 * instead of aggregating the whole tables. Behaviour is unchanged (F1: the figures on a fixture with another customer's rows beside them) and the plan proves
 * the narrowing (F2: both index probes carry an Index Cond on ar_charge_id; MUTANT: delete the filter -> red).
 *
 * Rows are inserted raw in a transaction that is ALWAYS rolled back, with session_replication_role = replica (the test role is a superuser).
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { sql as dsql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);

import { arRepo, type Tx } from '@shareat/db';
import { pinPlan } from './_fixtures/plan-pins';

const pg = postgres(url, { max: 1 });
const db = drizzle(pg);
afterAll(async () => {
  await pg.end({ timeout: 5 });
});

class Rollback extends Error {}
async function rolledBack<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let value: T | undefined;
  try {
    await db.transaction(async (dtx) => {
      const tx = dtx as unknown as Tx;
      await tx.execute(dsql`set local session_replication_role = replica`);
      value = await fn(tx);
      throw new Rollback('rollback');
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return value as T;
}

const id = () => randomUUID();

async function charge(tx: Tx, orgId: string, store: string, customer: string, total: string): Promise<string> {
  const ch = id();
  await tx.execute(dsql`
    insert into ar_charges (id, org_id, store_id, customer_id, charge_date, due_date, total_amount, revenue_account_code, created_by, status)
    values (${ch}, ${orgId}, ${store}, ${customer}, '2026-02-01', null, ${total}, '4150', ${id()}, 'posted')`);
  return ch;
}
async function collection(tx: Tx, orgId: string, store: string, customer: string, status: string, chargeId: string, applied: string): Promise<void> {
  const col = id();
  await tx.execute(dsql`
    insert into ar_collections (id, org_id, store_id, customer_id, collection_date, amount, money_account_id, created_by, status)
    values (${col}, ${orgId}, ${store}, ${customer}, '2026-02-02', ${applied}, ${id()}, ${id()}, ${status})`);
  await tx.execute(dsql`insert into ar_collection_allocations (ar_collection_id, ar_charge_id, amount_applied) values (${col}, ${chargeId}, ${applied})`);
}
async function writeOff(tx: Tx, orgId: string, chargeId: string, amount: string): Promise<void> {
  await tx.execute(dsql`insert into ar_write_offs (org_id, ar_charge_id, amount, reason, journal_entry_id, written_off_by) values (${orgId}, ${chargeId}, ${amount}, 'test', ${id()}, ${id()})`);
}

/** Customer C1 (target): 1000 charge, 300 posted + 100 non-posted collection, 50 written off -> 650 outstanding. C2 (other): the same shapes beside it. */
async function seed(tx: Tx) {
  const orgId = id();
  const store = id();
  const c1 = id();
  const c2 = id();
  const target = await charge(tx, orgId, store, c1, '1000.00');
  await collection(tx, orgId, store, c1, 'posted', target, '300.00');
  await collection(tx, orgId, store, c1, 'draft', target, '100.00');
  await writeOff(tx, orgId, target, '50.00');
  const second = await charge(tx, orgId, store, c1, '200.00');
  const other = await charge(tx, orgId, store, c2, '500.00');
  await collection(tx, orgId, store, c2, 'posted', other, '500.00');
  await writeOff(tx, orgId, other, '1.00');
  return { orgId, store, c1, target, second, other };
}

/** The exact text the repo runs, EXPLAINed, captured by wrapping the executor so the test cannot drift from the repo. */
async function planOf(tx: Tx, run: (spy: Tx) => Promise<unknown>): Promise<string> {
  // T-624: 1,000 OTHER customers' charges, each with a posted collection, an allocation and a write-off (foreign keys are off in this tx), so walking any of these
  // tables end to end is decisively dearer than probing it per charge. Without them every table holds a handful of rows and the planner's choice among
  // equally valid plans is a coin toss that moves with the rows CI's other tests leave in the shared database.
  await tx.execute(dsql`
    with n as (select gen_random_uuid() as ch, gen_random_uuid() as col, gen_random_uuid() as org, gen_random_uuid() as cust from generate_series(1, 1000)),
    c1 as (insert into ar_charges (id, org_id, store_id, customer_id, charge_date, due_date, total_amount, revenue_account_code, created_by, status)
           select ch, org, gen_random_uuid(), cust, '2026-02-01', null, 10.00, '4150', gen_random_uuid(), 'posted' from n returning 1),
    c2 as (insert into ar_collections (id, org_id, store_id, customer_id, collection_date, amount, money_account_id, created_by, status)
           select col, org, gen_random_uuid(), cust, '2026-02-02', 5.00, gen_random_uuid(), gen_random_uuid(), 'posted' from n returning 1),
    c3 as (insert into ar_collection_allocations (ar_collection_id, ar_charge_id, amount_applied) select col, ch, 5.00 from n returning 1)
    insert into ar_write_offs (org_id, ar_charge_id, amount, reason, journal_entry_id, written_off_by)
    select org, ch, 1.00, 'noise', gen_random_uuid(), gen_random_uuid() from n`);
  await pinPlan((s) => tx.execute(dsql.raw(s)), ['ar_collection_allocations', 'ar_write_offs', 'ar_charges', 'ar_collections']);
  const seen: string[] = [];
  const spy = new Proxy(tx, {
    get(target, prop, recv) {
      if (prop === 'execute') {
        return (q: SQL) => {
          const { sql: text, params } = (target as unknown as { dialect: { sqlToQuery(q: SQL): { sql: string; params: unknown[] } } }).dialect.sqlToQuery(q);
          seen.push(`${text}\u0000${JSON.stringify(params)}`);
          return target.execute(q);
        };
      }
      return Reflect.get(target, prop, recv);
    },
  }) as Tx;
  await run(spy);
  expect(seen).toHaveLength(1);
  const [text, params] = seen[0]!.split('\u0000');
  const literal = (JSON.parse(params!) as unknown[]).map((p) => (typeof p === 'string' ? `'${p.replace(/'/g, "''")}'` : String(p)));
  const inlined = text!.replace(/\$(\d+)/g, (_m, n) => literal[Number(n) - 1]!);
  return ((await tx.execute(dsql.raw(`explain ${inlined}`))) as unknown as Record<string, string>[]).map((r) => r['QUERY PLAN']).join('\n');
}

// Narrowed, each of the two index probes (whichever scan type or index the planner picks: Index or Bitmap, any index) carries an Index Cond on ar_charge_id (a constant or the semi-join's id); un-narrowed they are walked end to end.
const probes = (plan: string) => {
  expect(plan).toMatch(/ on ar_collection_allocations\b[^\n]*\n\s+(?:Index|Recheck) Cond: \(ar_charge_id /);
  expect(plan).toMatch(/ on ar_write_offs\b[^\n]*\n\s+(?:Index|Recheck) Cond: \(ar_charge_id /);
};

describe('T-615 item 3: AR outstanding queries are narrowed to the charge / the customer', () => {
  it("F1: the figures are unchanged beside another customer's allocations and write-offs", async () => {
    await rolledBack(async (tx) => {
      const s = await seed(tx);
      expect(await arRepo.outstandingForCharge(tx, s.orgId, s.target)).toBe('650.00');
      expect(await arRepo.outstandingForCharge(tx, s.orgId, s.second)).toBe('200.00');
      expect(await arRepo.outstandingForCharge(tx, s.orgId, s.other)).toBe('-1.00'); // 500 - 500 - 1: raw arithmetic, as before
      const rows = await arRepo.listChargesForCustomer(tx, s.orgId, s.c1);
      const t = rows.find((r) => r.chargeId === s.target)!;
      expect([t.allocatedAmount, t.writtenOffAmount, t.outstanding]).toEqual(['300.00', '50.00', '650.00']);
      expect(rows.map((r) => r.chargeId).sort()).toEqual([s.target, s.second].sort());
      const one = await arRepo.listChargesForCustomer(tx, s.orgId, s.c1, { storeIds: [s.store] });
      expect(one.find((r) => r.chargeId === s.target)!.outstanding).toBe('650.00');
      expect(await arRepo.listChargesForCustomer(tx, s.orgId, s.c1, { storeIds: [] })).toEqual([]);
    });
  });

  it('F2a: outstandingForCharge probes both indexes by the charge id (mutant: drop the filter)', async () => {
    await rolledBack(async (tx) => {
      const s = await seed(tx);
      probes(await planOf(tx, (spy) => arRepo.outstandingForCharge(spy, s.orgId, s.target)));
    });
  });

  it("F2b: listChargesForCustomer probes both indexes through the customer's charges (mutant: drop the semi-join)", async () => {
    await rolledBack(async (tx) => {
      const s = await seed(tx);
      probes(await planOf(tx, (spy) => arRepo.listChargesForCustomer(spy, s.orgId, s.c1)));
    });
  });
});
