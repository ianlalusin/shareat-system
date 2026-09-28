/**
 * T-350 S3 (bible §13 row 238, DEF-169) — every payout-account change is recorded in `audit_log`.
 * `docs/tasks/350-def-477-change-channel-payout-account.md` §S3, legs C9/C9b/C10/C11/C12.
 *
 * ⛔ TESTER, not BUILDER. `setChannelPayoutDestination` never writes `audit_log` at all yet (B6),
 * and the table has no `org_id` column (migration 0167, B1/B2). Every leg is run through `asOrg` —
 * the restricted app role, never the owner connection, which bypasses RLS.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { setChannelPayoutDestination } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

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
  const code = uid(`t350s3-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('a')}, 'Store A') returning id`;
  const storeId = store!.id;
  const [otherStore] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('b')}, 'Store B') returning id`;
  const otherStoreId = otherStore!.id;

  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${storeId})`;

  const [manager] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${manager!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${manager!.id}, ${storeId})`;

  const mkAccount = async (label: string, storeIdFor: string, isActive = true) => {
    const [acc] = await sql<{ id: string; name: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active)
      values (${orgId}, ${storeIdFor}, ${label}, 'bank', '1140', 'office', ${isActive}) returning id, name`;
    return acc!;
  };
  const bankA = await mkAccount(`Bank A ${uid('m')}`, storeId);
  const bankB = await mkAccount(`Bank B ${uid('m')}`, storeId);
  const otherStoreAccount = await mkAccount(`Other store account ${uid('m')}`, otherStoreId);
  const retiredAccount = await mkAccount(`Retired account ${uid('m')}`, storeId, false);

  const [channel] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, destination_money_account_id)
    values (${orgId}, ${storeId}, ${`Foodpanda ${uid('c')}`}, false, '1220', ${bankA.id}) returning id`;
  const [unwiredChannel] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
    values (${orgId}, ${storeId}, ${`GrabFood ${uid('c')}`}, false, '1220') returning id`;

  return {
    orgId, storeId, otherStoreId,
    admin: actor(orgId, admin!.id), adminId: admin!.id,
    manager: actor(orgId, manager!.id),
    channelId: channel!.id, unwiredChannelId: unwiredChannel!.id,
    bankA, bankB, otherStoreAccount, retiredAccount,
  };
}

async function auditRows(entityId: string) {
  return sql<{ org_id: string; actor_person_id: string | null; action: string; entity: string; before: unknown; after: unknown; source: string }[]>`
    select org_id, actor_person_id, action, entity, before, after, source from audit_log where entity_id = ${entityId}`;
}

async function caught(p: Promise<unknown>): Promise<Error | undefined> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  return undefined;
}

afterAll(async () => {
  await sql.end();
  await closeDb();
});

describe('C9 — admin changes A → B: exactly one audit_log row', () => {
  it('org/actor/action/entity/source/before/after all named correctly — was red today: nothing writes the table; the app role cannot insert (42501, zero policies)', async () => {
    const f = await fixture('c9');
    const err = await caught(
      asOrg(f.orgId, (tx) => setChannelPayoutDestination(tx, f.admin, { channelId: f.channelId, moneyAccountId: f.bankB.id })),
    );
    expect(err, 'the change itself should succeed').toBeUndefined();

    const rows = await auditRows(f.channelId);
    expect(rows.length, 'was red: nothing writes the table').toBe(1);
    const row = rows[0]!;
    expect(row.org_id).toBe(f.orgId);
    expect(row.actor_person_id, 'never null').toBe(f.adminId);
    expect(row.action).toBe('set_channel_payout');
    expect(row.entity).toBe('sales_channels');
    expect(row.source).toBe('web');
    expect(row.before).toEqual({ moneyAccountId: f.bankA.id, moneyAccountName: f.bankA.name });
    expect(row.after).toEqual({ moneyAccountId: f.bankB.id, moneyAccountName: f.bankB.name });
  });
});

describe('C9b — a first set, none → A: one row, before {null, null}', () => {
  it('was red today: nothing writes the table', async () => {
    const f = await fixture('c9b');
    await asOrg(f.orgId, (tx) => setChannelPayoutDestination(tx, f.admin, { channelId: f.unwiredChannelId, moneyAccountId: f.bankA.id }));
    const rows = await auditRows(f.unwiredChannelId);
    expect(rows.length, 'was red: nothing writes the table').toBe(1);
    expect(rows[0]!.before).toEqual({ moneyAccountId: null, moneyAccountName: null });
    expect(rows[0]!.after).toEqual({ moneyAccountId: f.bankA.id, moneyAccountName: f.bankA.name });
  });
});

describe('C10 (green today, a guard — report it, do not force it) — choosing the same account again: zero new rows', () => {
  it('nothing writes the table today either way, so this cannot distinguish the fix from the gap yet', async () => {
    const f = await fixture('c10');
    await asOrg(f.orgId, (tx) => setChannelPayoutDestination(tx, f.admin, { channelId: f.channelId, moneyAccountId: f.bankA.id }));
    const rows = await auditRows(f.channelId);
    expect(rows.length).toBe(0);
  });
});

describe('C11 (green today, a guard) — refused changes write zero audit rows', () => {
  it('a manager, another store\'s account, a retired account, and a cross-store actor all write nothing', async () => {
    const f = await fixture('c11');
    await expect(
      asOrg(f.orgId, (tx) => setChannelPayoutDestination(tx, f.manager, { channelId: f.channelId, moneyAccountId: f.bankB.id })),
    ).rejects.toThrow();
    await expect(
      asOrg(f.orgId, (tx) => setChannelPayoutDestination(tx, f.admin, { channelId: f.channelId, moneyAccountId: f.otherStoreAccount.id })),
    ).rejects.toThrow();
    await expect(
      asOrg(f.orgId, (tx) => setChannelPayoutDestination(tx, f.admin, { channelId: f.channelId, moneyAccountId: f.retiredAccount.id })),
    ).rejects.toThrow();

    // S2-C8's cross-store actor: an account belonging to another store, requested by the admin —
    // already covered above; additionally, an admin acting on a channel in a store they hold no
    // scope for (reusing the fixture's own otherStoreId with no scope granted there).
    const [crossStoreChannel] = await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, destination_money_account_id)
      values (${f.orgId}, ${f.otherStoreId}, ${`Foodpanda B ${uid('c')}`}, false, '1220', ${f.otherStoreAccount.id}) returning id`;
    await expect(
      asOrg(f.orgId, (tx) => setChannelPayoutDestination(tx, f.admin, { channelId: crossStoreChannel!.id, moneyAccountId: f.otherStoreAccount.id })),
    ).rejects.toThrow();

    const rows = await auditRows(f.channelId);
    const crossRows = await auditRows(crossStoreChannel!.id);
    expect(rows.length + crossRows.length).toBe(0);
  });
});

describe('C12 (green today, vacuously — report it) — atomicity: a tx that throws after the change writes neither row', () => {
  it('neither the channel\'s new account nor an audit row persists', async () => {
    const f = await fixture('c12');
    await expect(
      transaction(async (tx) => {
        await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
        await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
        await tx.execute(dsql`select set_config('app.org_id', ${f.orgId}, true)`);
        await setChannelPayoutDestination(tx, f.admin, { channelId: f.channelId, moneyAccountId: f.bankB.id });
        throw new Error('forced rollback after the change');
      }),
    ).rejects.toThrow('forced rollback');

    const [row] = await sql<{ destination_money_account_id: string | null }[]>`
      select destination_money_account_id from sales_channels where id = ${f.channelId}`;
    expect(row!.destination_money_account_id, 'the channel change rolled back too').toBe(f.bankA.id);
    const rows = await auditRows(f.channelId);
    expect(rows.length).toBe(0);
  });
});
