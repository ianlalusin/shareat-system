import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-327 slice 2, change 1. Guards that `recordIfUnmappedConstraint` and `errorMessage` agree
 * about what "mapped" means, for a `_finite_check` name — the screen and the refusal-recorder
 * must reach the same answer for the same constraint, or the register T-252/DEF-246 built to
 * surface constraints that STILL need a sentence fills with the 160 that already have one, on
 * every screen that routes through `apps/erp/src/app/expenses/lib.ts`'s refusal-counter
 * chokepoint. Both functions now share one `mappedMessage` resolver, which is what makes the two
 * questions structurally the same question rather than two implementations that can drift.
 *
 * A PAIR, deliberately, not one test: `recordConstraintRefusal`
 * (`packages/domain/src/shared/constraint-refusals.ts`) wraps its body in try/catch BY DESIGN, so
 * "no row appeared" alone is satisfied both by the mapping being correct AND by the recording
 * path being broken for an unrelated reason (RLS, a missing table, a lock timeout) — a negative
 * assertion on its own cannot tell those apart.
 *   1. The NEGATIVE half — a `_finite_check` name must NOT be recorded as unmapped.
 *   2. The POSITIVE half — a genuinely UNMAPPED constraint (`pay_rates_basis_check` — absent from
 *      `CONSTRAINT_MESSAGES`, absent from `LOCALLY_MAPPED_CONSTRAINT_NAMES`, does not end
 *      `_finite_check`; confirmed by reading the file, never by importing the map to decide) MUST
 *      still be recorded. Both `it`s drive the SAME insert path — one `pay_rates` statement
 *      shape, one `provoke`/`recordIfUnmappedConstraint` call sequence — differing only in which
 *      column carries the bad value, so the only variable between them is the constraint name
 *      itself. The pair can only both pass if the recorder is alive AND suffix-aware; either half
 *      alone could pass for the wrong reason.
 *
 * ⛔ Asserts on the OUTCOME — whether a row actually lands in `prerequisite_refusals` — never on an
 * internal. ⭐ Provokes REAL Postgres violations (same fixture shape as test 1's
 * `t327-nan-passes-positive-check.test.ts`) rather than synthetic error objects, so a red here is
 * because a refusal IS (or is not) recorded, not because the fixture cannot reach the function.
 * Cleanup (the negative half's insert can succeed pre-migration, and did once, in this lane DB)
 * deletes by the real returned id, strictly after the write is observed — the same discipline as
 * test 1 and test 3.
 *
 * ⭐ History: this was a real defect (T-327 slice 2 audit, 2026-09-19) — `recordIfUnmappedConstraint`
 * used to check only `constraintName in CONSTRAINT_MESSAGES`, with no suffix awareness, so every
 * `_finite_check` name read as unmapped here while `errorMessage` already treated it as mapped.
 * The builder's fix is what this file now guards, not what it still finds.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { recordIfUnmappedConstraint } from '../../src/lib/constraint-messages';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/**
 * Runs `fn`, expecting it to throw a real error. Fails loudly if it does not — but first, if
 * `cleanupOnSuccess` is given, hands it the real result so the row(s) the call actually wrote can
 * be deleted by explicit key before this throws. The write already happened and is fully
 * observable (the caller has `ok`, proof it was real) before cleanup ever runs.
 */
async function provoke<T>(fn: () => Promise<T>, cleanupOnSuccess?: (ok: T) => Promise<void>): Promise<unknown> {
  let ok: T;
  try {
    ok = await fn();
  } catch (err) {
    return err;
  }
  if (cleanupOnSuccess) {
    try {
      await cleanupOnSuccess(ok);
    } catch (cleanupErr) {
      throw new Error(`expected a real constraint violation, but the call succeeded (cleanup also failed: ${cleanupErr})`);
    }
  }
  throw new Error('expected a real constraint violation, but the call succeeded');
}

async function fixture() {
  const code = uid('t327b');
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
  return { orgId, storeId, personId, employmentId };
}

async function refusalCount(orgId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from prerequisite_refusals where org_id = ${orgId}`;
  return rows[0]!.n;
}

describe('T-327b — recordIfUnmappedConstraint agrees with errorMessage on what is mapped', () => {
  it('⛔ a real _finite_check violation is MAPPED (via the suffix rule) and must not be recorded as unmapped', async () => {
    const { orgId, storeId, personId, employmentId } = await fixture();

    const err = await provoke(
      () =>
        sql<{ id: string }[]>`
          insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by)
          values (${orgId}, ${employmentId}, 'daily', 'NaN', '2026-01-01', ${personId})
          returning id`,
      // T-498 S1: no cleanup. pay_rates is append-only (0221), so a stray row cannot be deleted; the row is
      // scoped to this test's own fresh org, and the assertion below fails loudly if the insert ever succeeds.
      async () => {},
    );
    const constraintName = (err as { constraint_name?: unknown } | null)?.constraint_name;
    expect(constraintName).toMatch(/_finite_check$/);

    const before = await refusalCount(orgId);
    expect(before).toBe(0);

    await recordIfUnmappedConstraint(err, { orgId, storeId, actorPersonId: personId });

    const after = await refusalCount(orgId);
    expect(after).toBe(before);
  });

  it('⭐ a genuinely UNMAPPED constraint (pay_rates_basis_check) IS recorded — the differential half of the pair', async () => {
    const { orgId, storeId, personId, employmentId } = await fixture();

    // ⛔ Hard-coded, read from constraint-messages.ts by hand, never decided by importing
    // CONSTRAINT_MESSAGES: absent from that map, absent from LOCALLY_MAPPED_CONSTRAINT_NAMES, and
    // does not end `_finite_check`. Unlike the finite check, this CHECK is pre-existing — the
    // insert fails regardless of migration state, so there is nothing for `provoke` to clean up
    // on a success branch that cannot occur; no `cleanupOnSuccess` is passed.
    const err = await provoke(
      () =>
        sql<{ id: string }[]>`
          insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by)
          values (${orgId}, ${employmentId}, 'bogus-basis', '100.00', '2026-01-01', ${personId})
          returning id`,
    );
    const constraintName = (err as { constraint_name?: unknown } | null)?.constraint_name;
    expect(constraintName).toBe('pay_rates_basis_check');

    const before = await refusalCount(orgId);
    expect(before).toBe(0);

    await recordIfUnmappedConstraint(err, { orgId, storeId, actorPersonId: personId });

    const after = await refusalCount(orgId);
    expect(after).toBe(before + 1);
  });
});
