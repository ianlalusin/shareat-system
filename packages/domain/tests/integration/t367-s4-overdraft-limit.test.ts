import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-367 S4 (DEF-395) — pin the overdraft-limit fix already in place; NO source change.
 * `docs/tasks/367-ap-ar-money.md` §S4: "unless `grep -rn overdraftLimit packages/domain/tests apps/erp/tests` already
 * finds the three legs, cite the existing test and add nothing".
 *
 * WHAT ALREADY EXISTS (cited, not repeated) — `apps/erp/tests/integration/t343-s5-5s-followups.test.ts`:
 *   - a malformed value ("1,5") -> the parser's named refusal, limit unchanged (:141-157);
 *   - "-5" -> the named refusal, limit unchanged (:159-177);
 *   - blank / spaces -> the key is omitted, limit unchanged (:856-866); "0" -> stored 0.00 and "500" -> 500.00 (:868-880).
 *
 * WHAT THE GREP DID NOT FIND, and this file adds (the legs the spec lists that nothing pins):
 *   - STAFF (✗ manage_chart_of_accounts) is refused BEFORE the value is parsed — proven with a value that would
 *     otherwise be refused by the parser ('abc'): the error must be AuthorizationError, not the parser's sentence;
 *   - the literal 'abc' and '2500' (-> stored 2500.00): the existing legs use '1,5' and '500' for the same code paths,
 *     so these two are only cheap pins on the exact values the spec names.
 * Every leg here is expected GREEN today (the fix landed at 33dbd3f); a green pin is the deliverable.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { renameMoneyAccount } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
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
  const code = uid(`t367s4-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('lipa')}, 'Lipa') returning id`;
  const storeId = store!.id;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin');
  const staffId = await mk('Staff', 'staff');
  const [acct] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  return { orgId, accountId: acct!.id, admin: actor(orgId, adminId), staff: actor(orgId, staffId) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const limitOf = async (id: string) => (await sql<{ v: string | null }[]>`select overdraft_limit::text as v from money_accounts where id = ${id}`)[0]!.v;
const rename = (f: Fixture, who: Actor, overdraftLimit: string) =>
  asOrg(f.orgId, (tx) => renameMoneyAccount(tx, who, { moneyAccountId: f.accountId, name: 'Cash drawer', overdraftLimit }));

describe("T-367 S4 — renameMoneyAccount's overdraftLimit (DEF-395), the legs nothing else pins", () => {
  it("'abc' -> the parser's sentence (no raw DB error, no 23514); the limit is unchanged", async () => {
    const f = await fixture('abc');
    const before = await limitOf(f.accountId);
    let caught: unknown;
    try {
      await rename(f, f.admin, 'abc');
    } catch (err) {
      caught = err;
    }
    expect(caught, "'abc' was accepted").toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage ?? `NO userMessage — raw: ${err.message}`).toBe('The overdraft limit — "abc" is not a valid amount. Use at most two decimal places.');
    expect(err.message).not.toMatch(/23514|violates check constraint|invalid input syntax/);
    expect(await limitOf(f.accountId)).toBe(before);
  });

  it("'2500' -> stored as 2500.00 (positive control for the refusals)", async () => {
    const f = await fixture('2500');
    await rename(f, f.admin, '2500');
    expect(await limitOf(f.accountId)).toBe('2500.00');
  });

  it("staff (✗ manage_chart_of_accounts) are refused BEFORE the value is parsed: 'abc' from staff is an AuthorizationError, not the parser's sentence; the limit is unchanged", async () => {
    const f = await fixture('staff');
    const before = await limitOf(f.accountId);
    let caught: unknown;
    try {
      await rename(f, f.staff, 'abc');
    } catch (err) {
      caught = err;
    }
    expect(caught, 'authorize() must run before any parse').toBeInstanceOf(AuthorizationError);
    expect(await limitOf(f.accountId)).toBe(before);

    // And the same staff member is refused for a VALID value too — it is the capability, not the value.
    await expect(rename(f, f.staff, '2500')).rejects.toBeInstanceOf(AuthorizationError);
    expect(await limitOf(f.accountId)).toBe(before);
  });
});
