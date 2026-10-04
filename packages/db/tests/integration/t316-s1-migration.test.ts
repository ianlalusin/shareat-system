/**
 * T-316 S1 — migration 0184. `docs/tasks/316-till-floor-on-the-cashier-account.md` §4, "S1" tests
 * T-S1-2 and T-S1-3 (mutant M2).
 *
 * `money_accounts_float_target_shape_check` moves from `1115` to `1110`ONLY. The one-float-per-
 * store index is untouched.
 *
 * RED on a 0183-era database: the CHECK still demands `gl_account_code = '1115'`, so
 *   - a target on the `1115` cashier cash row is ACCEPTED (the refusal assertion fails: nothing throws),
 *   - a target on the foundation `1110` cashier cash row is REFUSED (the acceptance assertion fails).
 * Controls: the office `1130` row is refused before and after; another store's `1110` target is
 * accepted after.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** One org, one store. The foundation trigger seeds Cashier cash (1110), Office cash (1130), etc. */
async function fixture(hint: string): Promise<{ orgId: string; storeId: string; newStore: () => Promise<string> }> {
  const code = uid(`t316s1-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const newStore = async () => {
    const [s] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid('S')}, ${`Store ${uid('n')}`}) returning id`;
    return s!.id;
  };
  return { orgId, storeId: await newStore(), newStore };
}

async function foundationId(storeId: string, custodian: string, code: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select id from money_accounts
    where store_id = ${storeId} and custodian = ${custodian} and gl_account_code = ${code} and is_foundation`;
  if (!row) throw new Error(`fixture: no foundation ${custodian}/${code} account`);
  return row.id;
}

async function insertCashierCash(f: { orgId: string }, storeId: string, name: string, glCode: string, target: string | null) {
  await sql`
    insert into money_accounts (org_id, store_id, name, instrument, custodian, gl_account_code, float_target)
    values (${f.orgId}, ${storeId}, ${name}, 'cash', 'cashier', ${glCode}, ${target})`;
}

async function setTarget(id: string, target: string | null) {
  await sql`update money_accounts set float_target = ${target} where id = ${id}`;
}

describe('T-316 S1 / 0184 — float_target shape: 1110 cashier cash only', () => {
  it('T-S1-2: a float_target on the foundation 1110 Cashier cash row is ACCEPTED (positive control for the refusals)', async () => {
    const f = await fixture('ok1110');
    const id = await foundationId(f.storeId, 'cashier', '1110');
    await setTarget(id, '20000.00');
    const [row] = await sql<{ float_target: string }[]>`select float_target from money_accounts where id = ${id}`;
    expect(row!.float_target).toBe('20000.00');
  });

  it('T-S1-2 / M2: a float_target on a 1115 cashier cash row is REFUSED naming money_accounts_float_target_shape_check', async () => {
    const f = await fixture('no1115');
    await expect(insertCashierCash(f, f.storeId, 'Till float', '1115', '20000.00')).rejects.toThrow(
      /money_accounts_float_target_shape_check/,
    );
    // The same 1115 row WITHOUT a target is still a legal money account (history may name 1115):
    // proves the refusal above is about the target, not about the row.
    await insertCashierCash(f, f.storeId, 'Till float', '1115', null);
    const rows = await sql`select id from money_accounts where store_id = ${f.storeId} and gl_account_code = '1115'`;
    expect(rows.length).toBe(1);
  });

  it('T-S1-2: a float_target on an office 1130 row is REFUSED (unchanged control)', async () => {
    const f = await fixture('office');
    const id = await foundationId(f.storeId, 'office', '1130');
    await expect(setTarget(id, '20000.00')).rejects.toThrow(/money_accounts_float_target_shape_check/);
  });

  it('T-S1-2: the stored constraint definition names 1110 and not 1115', async () => {
    const [row] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(c.oid) as def
      from pg_constraint c join pg_class t on t.oid = c.conrelid
      where t.relname = 'money_accounts' and c.conname = 'money_accounts_float_target_shape_check'`;
    expect(row!.def).toContain("'1110'");
    expect(row!.def).not.toContain("'1115'");
  });

  it('T-S1-3: a SECOND float_target at the same store is REFUSED naming money_accounts_one_float_per_store', async () => {
    const f = await fixture('second');
    const id = await foundationId(f.storeId, 'cashier', '1110');
    await setTarget(id, '20000.00'); // first target at the store: accepted
    await expect(insertCashierCash(f, f.storeId, 'Cashier cash 2', '1110', '5000.00')).rejects.toThrow(
      /money_accounts_one_float_per_store/,
    );
  });

  it('T-S1-3 control: a float_target at ANOTHER store is accepted while the first store holds one', async () => {
    const f = await fixture('other');
    const first = await foundationId(f.storeId, 'cashier', '1110');
    await setTarget(first, '20000.00');
    const other = await f.newStore();
    const second = await foundationId(other, 'cashier', '1110');
    await setTarget(second, '15000.00');
    const rows = await sql<{ float_target: string }[]>`
      select float_target from money_accounts where id = ${second}`;
    expect(rows[0]!.float_target).toBe('15000.00');
  });
});
