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
  await tx.execute(dsql`analyze ar_collection_allocations`);
  await tx.execute(dsql`analyze ar_write_offs`);
  await tx.execute(dsql`set local enable_seqscan = off`);
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

// Narrowed, each of the two index probes carries an Index Cond on ar_charge_id (a constant or the semi-join's id); un-narrowed they are walked end to end.
const probes = (plan: string) => {
  expect(plan).toMatch(/Index Scan using ar_collection_allocations_charge_idx on ar_collection_allocations a[^\n]*\n\s+Index Cond: \(ar_charge_id /);
  expect(plan).toMatch(/Index Scan using ar_write_offs_charge_idx on ar_write_offs[^\n]*\n\s+Index Cond: \(ar_charge_id /);
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
