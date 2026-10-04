import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-371 S0 — money-accounts module: `overdraftLimit` on `renameMoneyAccount` (DEF-395's spelling #1). §S0 + ✎R13: the column is
 * NOT NULL DEFAULT '20000.00', so a BLANK on update leaves it UNCHANGED and a blank on insert takes the database default; it is never a guessed '0'.
 * `renameMoneyAccount` already parses with `parseMoneyInput`, so the typed-garbage legs are GUARDS (green today) that must stay green once the
 * writer is branded (S1) — the writer's own `...(limit !== undefined ? { overdraftLimit: limit } : {})` spread is what the guard (G1) censuses.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run against a database whose name does not contain "_test".');

import { closeDb } from '@shareat/db';
import { createMoneyAccount, renameMoneyAccount } from '@shareat/domain';
import { NAN_INPUTS, asOrg, bootstrap, expectPlainRefusal, refusalOf, uid } from './_fixtures/t371-nan';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const limitOf = async (id: string) => (await sql<{ l: string }[]>`select overdraft_limit::text as l from money_accounts where id = ${id}`)[0]!.l;
async function cashier(k: Awaited<ReturnType<typeof bootstrap>>) {
  const [a] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${k.storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  return a!.id;
}

describe('money-accounts — overdraftLimit', () => {
  for (const typed of NAN_INPUTS) {
    it(`${JSON.stringify(typed)}: a plain sentence quoting it and naming the overdraft limit; the stored limit is unchanged; a later valid call succeeds`, async () => {
      const k = await bootstrap(sql, `ma-${typed}`);
      const id = await cashier(k);
      const before = await limitOf(id);
      const got = await refusalOf(asOrg(k.orgId, (tx) => renameMoneyAccount(tx, k.admin, { moneyAccountId: id, name: 'Cashier drawer', overdraftLimit: typed })));
      expectPlainRefusal(got, typed, /overdraft/i, 'renameMoneyAccount.overdraftLimit');
      expect(await limitOf(id), 'a refused rename changed the limit').toBe(before);
      const ok = await refusalOf(asOrg(k.orgId, (tx) => renameMoneyAccount(tx, k.admin, { moneyAccountId: id, name: 'Cashier drawer', overdraftLimit: '5000.00' })));
      expect(ok.text, `the control was refused: ${ok.text}`).toBeNull();
      expect(await limitOf(id), 'a valid limit reads back byte-identical').toBe('5000.00');
    });
  }

  it('a BLANK limit on update leaves the stored limit UNCHANGED (never a guessed zero)', async () => {
    const k = await bootstrap(sql, 'ma-blank-update');
    const id = await cashier(k);
    await asOrg(k.orgId, (tx) => renameMoneyAccount(tx, k.admin, { moneyAccountId: id, name: 'Cashier drawer', overdraftLimit: '7500.00' }));
    const out = await refusalOf(asOrg(k.orgId, (tx) => renameMoneyAccount(tx, k.admin, { moneyAccountId: id, name: 'Cashier drawer 2', overdraftLimit: '' })));
    expect(out.text, `a blank limit was refused: ${out.text}`).toBeNull();
    expect(await limitOf(id), 'a blank on update changed the limit').toBe('7500.00');
  });

  it('a new account created without a limit takes the column default 20000.00 (a blank on insert is the default, not zero)', async () => {
    const k = await bootstrap(sql, 'ma-blank-insert');
    const created = await asOrg(k.orgId, (tx) => createMoneyAccount(tx, k.admin, { storeId: k.storeId, name: uid('Wallet'), instrument: 'ewallet', custodian: 'office' }));
    expect(await limitOf(created.id)).toBe('20000.00');
  });
});
