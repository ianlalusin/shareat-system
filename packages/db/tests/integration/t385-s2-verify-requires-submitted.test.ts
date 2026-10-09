import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-385 S2 - `docs/tasks/385-verify-only-after-submit.md` "S2 tests" D1-D7. Migration 0188 adds the trigger
 * `sales_days_verify_requires_submitted` (BEFORE UPDATE, FOR EACH ROW, WHEN NEW.status = 'verified' AND OLD.status IS
 * DISTINCT FROM 'verified'): the function raises 23514 (CONSTRAINT = the trigger's name) unless OLD.status = 'submitted'
 * AND OLD.submitted_by IS NOT NULL. Ian 2026-10-09: "verify and post must be blocked until submitted".
 *
 * Each statement runs in a transaction that is ALWAYS rolled back, as the app role with the org set (D6: the owner
 * connection, which no RLS or role filters - the rule has no bypass branch).
 *
 * ## State at HEAD (red first)
 * Red: migration 0188 does not exist, so nothing refuses a jump into 'verified'. D1, D3, D5, D6 and D7 fail (the UPDATE
 * succeeds / the trigger is absent). D2 (the legal path) and D4 (history is untouched) are controls and pass today.
 * D8 - the sentence `errorMessage` returns for D1's error - lives in `apps/erp/tests/integration/constraint-message-lookup.test.ts`
 * (it needs the app's lookup table, which a db-package test must not import).
 *
 * Mutants (spec): WHEN drops `OLD.status IS DISTINCT FROM 'verified'` -> D4 red; the function drops the check -> D1 red;
 * drops the `submitted_by IS NULL` arm -> D3 red; a bypass branch for the owner role -> D6 red.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE } from '../../src/rls/registry';
import { seedChartOfAccounts } from '../../seed/chart-of-accounts';
import { closeDb } from '@shareat/db';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const TRIGGER = 'sales_days_verify_requires_submitted';

type Tx = postgres.TransactionSql;
type PgErr = { code?: string; constraint_name?: string; message?: string } | null;
class Rollback extends Error {}

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

/** Runs `fn` in a transaction that is ALWAYS rolled back; returns the error the body raised, or null. */
async function attempt(orgId: string, fn: (t: Tx) => Promise<unknown>, o: { app?: boolean } = {}): Promise<PgErr> {
  const app = o.app !== false;
  let caught: unknown = null;
  try {
    await sql.begin(async (t) => {
      if (app) {
        await t.unsafe(`set local role ${APP_ROLE}`);
        await t`select set_config('app.principal_kind', 'staff', true)`;
        await t`select set_config('app.org_id', ${orgId}, true)`;
      }
      try {
        await fn(t);
      } catch (e) {
        caught = e;
      }
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return caught as PgErr;
}

async function mkOrg(hint: string) {
  const code = uid(`t385s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Person') returning id`;
  const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, 'Store') returning id`;
  return { orgId, personId: p!.id, storeId: st!.id };
}
type Org = Awaited<ReturnType<typeof mkOrg>>;

/** A committed TYPED day (raw insert, the column defaults) in the given status; `submittedBy` null = a submitter-less row. */
async function day(o: Org, date: string, status: 'open' | 'submitted' | 'verified' | 'voided', opts: { submittedBy?: boolean } = {}): Promise<string> {
  const by = status === 'open' ? null : opts.submittedBy === false ? null : o.personId;
  const [d] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, cash_collected, created_by,
                            submitted_by, submitted_at, verified_by, verified_at)
    values (${o.orgId}, ${o.storeId}, ${date}, ${status}, 100, 0, 100, 100, ${o.personId},
            ${by}, ${by ? new Date().toISOString() : null},
            ${status === 'verified' ? o.personId : null}, ${status === 'verified' ? new Date().toISOString() : null}) returning id`;
  return d!.id;
}

const toVerified = (t: Tx, id: string) =>
  t`update sales_days set status = 'verified', verified_by = ${null}, verified_at = now(), updated_at = now() where id = ${id}`;

function expectRefusedBy0188(err: PgErr, what: string) {
  expect(err, `${what}: expected the UPDATE to be refused, but it succeeded`).not.toBeNull();
  expect({ what, code: err!.code, constraint: err!.constraint_name }).toEqual({ what, code: '23514', constraint: TRIGGER });
}

describe('T-385 S2 - 0188: a sales day reaches verified only from submitted', () => {
  it('D1: an UPDATE to verified on an OPEN row (as the app role) is refused: 23514, constraint sales_days_verify_requires_submitted', async () => {
    const o = await mkOrg('d1');
    const id = await day(o, '2027-02-01', 'open');
    expectRefusedBy0188(await attempt(o.orgId, (t) => toVerified(t, id)), 'open -> verified');
  });

  it('D2: a SUBMITTED row with a submitter -> verified is allowed (control: the legal path, open -> submitted -> verified, too)', async () => {
    const o = await mkOrg('d2');
    const submitted = await day(o, '2027-02-01', 'submitted');
    expect(await attempt(o.orgId, (t) => toVerified(t, submitted)), 'submitted -> verified').toBeNull();
    const open = await day(o, '2027-02-02', 'open');
    expect(
      await attempt(o.orgId, async (t) => {
        await t`update sales_days set status = 'submitted', submitted_by = ${o.personId}, submitted_at = now(), updated_at = now() where id = ${open}`;
        await toVerified(t, open);
      }),
      'open -> submitted -> verified in one transaction',
    ).toBeNull();
  });

  it('D3: a SUBMITTED row with NO submitter (inserted raw) -> verified is refused', async () => {
    const o = await mkOrg('d3');
    const id = await day(o, '2027-02-01', 'submitted', { submittedBy: false });
    expectRefusedBy0188(await attempt(o.orgId, (t) => toVerified(t, id)), 'submitted without submitted_by -> verified');
  });

  it('D4: a day INSERTED as verified with no submit (history) still voids and still takes other updates (the WHEN excludes verified rows)', async () => {
    const o = await mkOrg('d4');
    const id = await day(o, '2027-02-01', 'verified', { submittedBy: false });
    const [row] = await sql<{ submitted_at: string | null }[]>`select submitted_at from sales_days where id = ${id}`;
    expect(row!.submitted_at, 'the fixture is history: verified without a submit').toBeNull();
    expect(
      await attempt(o.orgId, (t) => t`update sales_days set updated_at = now() where id = ${id}`),
      'a column update on historic verified row',
    ).toBeNull();
    expect(
      await attempt(
        o.orgId,
        (t) => t`update sales_days set status = 'voided', voided_by = ${o.personId}, voided_at = now(), void_reason = 'test', updated_at = now() where id = ${id}`,
      ),
      'verified -> voided on a historic row',
    ).toBeNull();
    // and a verified -> verified rewrite (OLD is already verified) is not this trigger's business
    expect(await attempt(o.orgId, (t) => toVerified(t, id)), 'verified -> verified').toBeNull();
  });

  it('D5: voided -> verified is refused', async () => {
    const o = await mkOrg('d5');
    const id = await day(o, '2027-02-01', 'voided');
    expectRefusedBy0188(await attempt(o.orgId, (t) => toVerified(t, id)), 'voided -> verified');
  });

  it('D6: the same open -> verified under the OWNER connection (no role filter) is refused too - no bypass', async () => {
    const o = await mkOrg('d6');
    const id = await day(o, '2027-02-01', 'open');
    expectRefusedBy0188(await attempt(o.orgId, (t) => toVerified(t, id), { app: false }), 'open -> verified as the owner');
  });

  it('D7: the trigger exists on sales_days, is enabled (tgenabled = O, origin), BEFORE UPDATE FOR EACH ROW', async () => {
    const rows = await sql<{ tgenabled: string; tgtype: number; relname: string }[]>`
      select t.tgenabled, t.tgtype, c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where t.tgname = ${TRIGGER} and not t.tgisinternal`;
    expect(rows.length, `trigger ${TRIGGER} is missing (migration 0188 not applied)`).toBe(1);
    expect(rows[0]!.relname).toBe('sales_days');
    expect(rows[0]!.tgenabled).toBe('O');
    // tgtype bits: 1 = ROW, 2 = BEFORE, 16 = UPDATE
    expect(rows[0]!.tgtype & 1, 'FOR EACH ROW').toBe(1);
    expect(rows[0]!.tgtype & 2, 'BEFORE').toBe(2);
    expect(rows[0]!.tgtype & 16, 'UPDATE').toBe(16);
  });
});
