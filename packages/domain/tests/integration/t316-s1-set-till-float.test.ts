import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-316 S1 — `setTillFloat` sets `float_target` on the store's existing `Cashier cash` (1110)
 * account and never inserts. `docs/tasks/316-till-floor-on-the-cashier-account.md` §1.4 / A4,
 * tests T-S1-4 and T-S1-5 (mutant M3).
 *
 * RED on HEAD: `setTillFloat` finds no pot and INSERTS a `Till float` 1115 account — the target
 * lands on a new row (account count +1, target not on the 1110 row) and the two refusals never fire.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { type Actor } from '@shareat/auth';
import { setTillFloat } from '@shareat/domain';

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
  const code = uid(`t316s1-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const storeName = `Lipa ${code}`;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('S')}, ${storeName}) returning id`;
  const storeId = store!.id;
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  const [drawer] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId}
      and instrument = 'cash' and custodian = 'cashier' and gl_account_code = '1110' and is_foundation`;
  return { orgId, storeId, storeName, admin: actor(orgId, p!.id), drawerId: drawer!.id };
}

const countAccounts = async (storeId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from money_accounts where store_id = ${storeId}`)[0]!.n;

/** The sentence a person reads: RefusalError.userMessage, or null if nothing was thrown. */
async function refusalOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as { userMessage?: string }).userMessage ?? `RAW: ${(e as Error).message}`;
  }
}

describe('T-316 S1 — setTillFloat sets the target on the existing Cashier cash account', () => {
  it('T-S1-4: the target lands on the 1110 Cashier cash id, and the store account count is unchanged', async () => {
    const f = await fixture('set');
    const before = await countAccounts(f.storeId);
    const res = await asOrg(f.orgId, (tx) => setTillFloat(tx, f.admin, { storeId: f.storeId, target: '20000.00' }));
    expect(res.moneyAccountId).toBe(f.drawerId);
    expect(await countAccounts(f.storeId)).toBe(before);
    const rows = await sql<{ id: string; float_target: string }[]>`
      select id, float_target from money_accounts where store_id = ${f.storeId} and float_target is not null`;
    expect(rows).toEqual([{ id: f.drawerId, float_target: '20000.00' }]);
    // no 1115 account was minted
    expect((await sql`select 1 from money_accounts where store_id = ${f.storeId} and gl_account_code = '1115'`).length).toBe(0);
  });

  it('T-S1-4 control: clearing returns the same id with float_target null, count still unchanged', async () => {
    const f = await fixture('clear');
    await asOrg(f.orgId, (tx) => setTillFloat(tx, f.admin, { storeId: f.storeId, target: '20000.00' }));
    const before = await countAccounts(f.storeId);
    const res = await asOrg(f.orgId, (tx) => setTillFloat(tx, f.admin, { storeId: f.storeId, target: null }));
    expect(res.moneyAccountId).toBe(f.drawerId);
    const [row] = await sql<{ float_target: string | null }[]>`select float_target from money_accounts where id = ${f.drawerId}`;
    expect(row!.float_target).toBeNull();
    expect(await countAccounts(f.storeId)).toBe(before);
  });

  it('T-S1-4: clearing an account that has no target is a no-op returning its id (no insert, no refusal)', async () => {
    const f = await fixture('noop');
    const before = await countAccounts(f.storeId);
    const res = await asOrg(f.orgId, (tx) => setTillFloat(tx, f.admin, { storeId: f.storeId, target: null }));
    expect(res.moneyAccountId).toBe(f.drawerId);
    expect(await countAccounts(f.storeId)).toBe(before);
  });

  it('T-S1-4: resizing an existing target moves the same row (one target per store, same id)', async () => {
    const f = await fixture('resize');
    await asOrg(f.orgId, (tx) => setTillFloat(tx, f.admin, { storeId: f.storeId, target: '20000.00' }));
    const res = await asOrg(f.orgId, (tx) => setTillFloat(tx, f.admin, { storeId: f.storeId, target: '25000.00' }));
    expect(res.moneyAccountId).toBe(f.drawerId);
    const [row] = await sql<{ float_target: string }[]>`select float_target from money_accounts where id = ${f.drawerId}`;
    expect(row!.float_target).toBe('25000.00');
  });

  it('T-S1-5: a store with no cashier cash account is refused with the section 1.4 sentence, and nothing is inserted', async () => {
    const f = await fixture('none');
    await sql`delete from money_accounts where id = ${f.drawerId}`;
    const before = await countAccounts(f.storeId);
    const sentence = await refusalOf(() => asOrg(f.orgId, (tx) => setTillFloat(tx, f.admin, { storeId: f.storeId, target: '20000.00' })));
    expect(sentence).toBe(`${f.storeName} has no cashier cash account to hold a float.`);
    expect(await countAccounts(f.storeId)).toBe(before);
  });

  it('T-S1-5: a store with two cashier cash accounts is refused with the other sentence, and no target is set', async () => {
    const f = await fixture('two');
    await sql`
      insert into money_accounts (org_id, store_id, name, instrument, custodian, gl_account_code)
      values (${f.orgId}, ${f.storeId}, 'Cashier cash 2', 'cash', 'cashier', '1110')`;
    const sentence = await refusalOf(() => asOrg(f.orgId, (tx) => setTillFloat(tx, f.admin, { storeId: f.storeId, target: '20000.00' })));
    expect(sentence).toBe(`${f.storeName} has more than one cashier cash account; the float needs exactly one.`);
    expect((await sql`select 1 from money_accounts where store_id = ${f.storeId} and float_target is not null`).length).toBe(0);
  });

  it('T-S1-5 control: the exactly-one store succeeds (the refusals above are about the count, not the call)', async () => {
    const f = await fixture('one');
    expect(await refusalOf(() => asOrg(f.orgId, (tx) => setTillFloat(tx, f.admin, { storeId: f.storeId, target: '20000.00' })))).toBeNull();
  });
});
