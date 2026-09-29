/**
 * T-357 / DEF-490 — `docs/tasks/357-def-490-same-org-money-account-fk.md`, legs P1-P2.
 * `setChannelPayoutDestination` as the app role. Real Postgres via TEST_DATABASE_URL, `_test` name
 * guard.
 *
 * ⛔ Amendment B1 (binds): the actor holds `set_channel_payout`, not `manage_store_settings` —
 * `packages/domain/src/channel-settlements/index.ts:682-683` authorizes `set_channel_payout` (T-350).
 * A plain `admin` role holds every capability, matching `t350-channel-payout-change.test.ts`'s own
 * actor setup.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { transaction, APP_ROLE, auditLogRepo, type Tx } from '@shareat/db';
import * as schema from '@shareat/db/schema';
import { setChannelPayoutDestination } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
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

const privilegedDb = drizzle(sql, { schema });
async function asPrivileged<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return privilegedDb.transaction(fn as never) as Promise<T>;
}

/** One org, one store, one admin (holds every capability, including set_channel_payout), one
 *  active money account, one channel pointed at it. */
async function orgFixture(hint: string) {
  const code = uid(`t357p-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Store') returning id`;
  const storeId = store!.id;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const adminId = admin!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${adminId}, ${storeId})`;
  const [account] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active)
    values (${orgId}, ${storeId}, ${`Bank ${uid('m')}`}, 'bank', '1140', 'office', true) returning id`;
  const [oldAccount] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active)
    values (${orgId}, ${storeId}, ${`Old Bank ${uid('m')}`}, 'bank', '1140', 'office', true) returning id`;
  const [channel] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, destination_money_account_id)
    values (${orgId}, ${storeId}, ${`Channel ${uid('c')}`}, false, '1220', ${oldAccount!.id}) returning id`;
  return { orgId, storeId, adminId, admin: { orgId, personId: adminId }, accountId: account!.id, oldAccountId: oldAccount!.id, channelId: channel!.id };
}

describe('P1 — setChannelPayoutDestination as the app role (real actor holding set_channel_payout) to a same-org, same-store active account', () => {
  it('wrote: true; the column holds the new id; one audit row — green today, guard: the only writer still works', async () => {
    const f = await orgFixture('p1');
    const result = await asOrg(f.orgId, (tx) =>
      setChannelPayoutDestination(tx, f.admin, { channelId: f.channelId, moneyAccountId: f.accountId }),
    );
    expect(result.wrote, 'expected the change to write').toBe(true);

    const [row] = await sql<{ destination_money_account_id: string }[]>`
      select destination_money_account_id from sales_channels where id = ${f.channelId}`;
    expect(row!.destination_money_account_id).toBe(f.accountId);

    const auditRow = await asPrivileged((tx) =>
      auditLogRepo.latestForEntity(tx, f.orgId, { entity: 'sales_channels', entityId: f.channelId, action: 'set_channel_payout' }),
    );
    expect(auditRow, 'expected one audit row').toBeDefined();
  });
});

describe('P2 — setChannelPayoutDestination with a DIFFERENT org\'s account id', () => {
  it('refused by the domain\'s own "does not exist" error, before the DB is reached; the column is unchanged — green today, guard: the domain layer stays the first lock', async () => {
    const a = await orgFixture('p2a');
    const b = await orgFixture('p2b');

    let error: (Error & { message: string }) | undefined;
    try {
      await asOrg(a.orgId, (tx) => setChannelPayoutDestination(tx, a.admin, { channelId: a.channelId, moneyAccountId: b.accountId }));
    } catch (err) {
      error = err as Error & { message: string };
    }
    expect(error, 'expected a refusal').toBeDefined();
    expect(error!.message).toMatch(/does not exist/);

    const [row] = await sql<{ destination_money_account_id: string }[]>`
      select destination_money_account_id from sales_channels where id = ${a.channelId}`;
    expect(row!.destination_money_account_id, 'the column must be unchanged after the refusal').toBe(a.oldAccountId);
  });
});
