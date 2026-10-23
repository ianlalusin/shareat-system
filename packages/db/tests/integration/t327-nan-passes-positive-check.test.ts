import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-327 test 1 — docs/tasks/327-a-poison-value-that-passes-every-guard.md §Tests item 1.
 *
 * P1 (spec, executed): `'NaN'::numeric > 0` is `true` in Postgres, so `'NaN'` passes a real
 * `numeric(14,2) CHECK (amount > 0)` today. `pay_rates_amount_positive_check` is exactly that
 * shape (`packages/db/schema/payroll.ts`). RED until migration `0155` adds
 * `pay_rates_amount_finite_check` — the migration is the only thing that can turn this green.
 *
 * ⛔ STRENGTHENED — orchestrator, 2026-09-19, DEF-115's shape: `.rejects.toThrow()` alone proves
 * only that SOMETHING threw, never which constraint. The day migration `0156` adds a NOT NULL
 * column to `pay_rates` (or renames one this fixture inserts), the insert would die earlier for an
 * unrelated reason, `.rejects.toThrow()` would stay satisfied, and this test would stay green
 * forever with the one behavioural proof it exists for — that the finite check specifically is
 * what rejects `NaN` — silently gone. Asserting the caught error's `constraint_name` (the same
 * `constraintNameOf` technique test 3 uses) closes that: it fails loudly if rejection ever comes
 * from anywhere else.
 *
 * ⛔ CLEANUP — orchestrator, 2026-09-19: before migration `0155` exists this insert actually
 * SUCCEEDS and actually WRITES a poisoned row — measured live, three such rows from earlier runs
 * blocked `0155` from applying to this lane DB. Deleted by explicit primary key (`returning id`,
 * captured below), strictly in a `finally` AFTER the row is fully written and the assertions have
 * run against the real caught value — never before, so this stays exactly as red as it was.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('T-327 test 1 — the finite check refuses a raw NaN', () => {
  it('⛔ NaN reaches pay_rates.amount past its existing > 0 CHECK; only the finite check stops it', async () => {
    const code = uid('t327');
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const orgId = org!.id;
    const [store] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid('store')}, 'Store') returning id`;
    const storeId = store!.id;
    const [person] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, 'Worker') returning id`;
    const personId = person!.id;
    const [emp] = await sql<{ id: string }[]>`
      insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
      values (${orgId}, ${personId}, ${storeId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, '2026-01-01', 'regular', ${personId}) returning id`;
    const employmentId = emp!.id;

    let caught: unknown;
    let insertedId: string | undefined;
    try {
      const [row] = await sql<{ id: string }[]>`
        insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by)
        values (${orgId}, ${employmentId}, 'daily', 'NaN', '2026-01-01', ${personId})
        returning id`;
      insertedId = row?.id;
    } catch (err) {
      caught = err;
    }
    try {
      expect(caught, 'expected the insert to be rejected, but it succeeded').toBeDefined();

      // ⛔ WHICH constraint, not merely that something threw — see the strengthening note above.
      const constraintName = (caught as { constraint_name?: unknown } | null)?.constraint_name;
      expect(constraintName).toMatch(/_finite_check$/);
    } finally {
      if (insertedId) await sql`delete from pay_rates where id = ${insertedId}`;
    }
  });
});
