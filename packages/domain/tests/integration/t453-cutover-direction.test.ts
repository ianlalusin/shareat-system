import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-453 T1/T2 (DEF-727) - the opening-figure direction is checked, never defaulted. Real PostgreSQL, real authorize().
 * The action now passes the raw form value, so the domain is the only gate: blank, 'Credit', 'xyz' must refuse with the
 * ONE rule sentence and write no journal row; 'credit' / 'debit' book exactly as before.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, RefusalError, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { addOpeningFigure } from '@shareat/domain';
import { CUTOVER_FIGURE_RULES } from '@shareat/domain/field-rules';
import { expectRuleSentence } from '../../../../tests/helpers/rule-sentence';
import { realPurge } from '../../../../tests/integration/t390-real-purge';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const DATE = '2027-01-01';

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

let orgId = '';
let storeId = '';
let admin: Actor;

beforeAll(async () => {
  const code = uid('t453-dir');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values
    (${orgId}, '2026-12-01', '2026-12-31', 'open'), (${orgId}, '2027-01-01', '2027-01-31', 'open')`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('d')}, 'Store dir') returning id`;
  storeId = store!.id;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  admin = { personId: p!.id, orgId };
  await realPurge(sql, p!.id); // T-390 R8: figures are refused until the real purge has run
}, 300_000);
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const entryCount = async () =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId}`)[0]!.n);
const figure = (accountCode: string, direction: string) =>
  asOrg(orgId, (tx) => addOpeningFigure(tx, admin, { accountCode, storeId, direction: direction as never, amount: '250.00', entryDate: DATE }));

describe('T-453 T1 a garbled direction refuses and writes nothing', () => {
  it.each(['', 'Credit', 'xyz'])('direction %j refuses with the rule sentence and posts no journal row', async (direction) => {
    const before = await entryCount();
    let err: unknown;
    try {
      await figure('1110', direction);
    } catch (e) {
      err = e;
    }
    expect(err, `direction ${JSON.stringify(direction)} was accepted`).toBeInstanceOf(RefusalError);
    expectRuleSentence((err as RefusalError).userMessage, CUTOVER_FIGURE_RULES.direction, direction);
    expect(await entryCount()).toBe(before);
  }, 30_000);
});

describe('T-453 T2 a valid direction books on the right side', () => {
  const sides = async (entryId: string) =>
    await sql<{ code: string; debit: string; credit: string }[]>`
      select a.code, l.debit::text as debit, l.credit::text as credit
      from journal_lines l join accounts a on a.id = l.account_id
      where l.entry_id = ${entryId} order by a.code`;
  it('credit credits the account and debits 3900', async () => {
    const { entryId } = await figure('1130', 'credit');
    const lines = Object.fromEntries((await sides(entryId)).map((l) => [l.code, l]));
    expect(Number(lines['1130']!.credit)).toBe(250);
    expect(Number(lines['1130']!.debit)).toBe(0);
    expect(Number(lines['3900']!.debit)).toBe(250);
    expect(Number(lines['3900']!.credit)).toBe(0);
  }, 30_000);
  it('debit debits the account and credits 3900', async () => {
    const { entryId } = await figure('1115', 'debit');
    const lines = Object.fromEntries((await sides(entryId)).map((l) => [l.code, l]));
    expect(Number(lines['1115']!.debit)).toBe(250);
    expect(Number(lines['1115']!.credit)).toBe(0);
    expect(Number(lines['3900']!.credit)).toBe(250);
    expect(Number(lines['3900']!.debit)).toBe(0);
  }, 30_000);
});
