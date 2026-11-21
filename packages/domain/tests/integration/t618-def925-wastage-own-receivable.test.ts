import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-618 / DEF-925 - order wastage credits the channel's OWN receivable account, not 1220 for every channel.
 * Fixture copied from order-wastage.test.ts (T-178).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { makeSettleableDay } from './_fixtures/sales-day-flow';
import { recordOrderWastage, resolveOrderWastage } from '../../src/wastage/orders';

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

const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`ow-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  // A generous open window so a backstop `now` weeks after the original businessDate still
  // resolves to a covering period, except where a test deliberately closes one (test 12).
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-01-01', '2026-01-31', 'open'),
      (${orgId}, '2026-02-01', '2026-02-28', 'open'),
      (${orgId}, '2026-03-01', '2026-03-31', 'open')`;

  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, 'Store A') returning id`;
  const storeId = store!.id;

  const [manager] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${manager!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${manager!.id}, ${storeId})`;

  const [monitor] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Wastage Monitor') returning id`;
  const [staffA] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Staff A') returning id`;
  const [staffB] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Staff B') returning id`;

  const [bank] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeId}, 'Payout wallet', 'bank', '1140', 'office') returning id`;

  const [channel] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code,
                                destination_money_account_id)
    values (${orgId}, ${storeId}, 'Foodpanda', false, '1220', ${bank!.id}) returning id`;

  const [day] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${orgId}, ${storeId}, '2026-01-10', 0, 0, 0, ${manager!.id}) returning id`;
  await makeSettleableDay(sql, day!.id, channel!.id, manager!.id); // DEF-881: a settlement names a verified day carrying the channel

  return {
    orgId, storeId, channelId: channel!.id, salesDayId: day!.id, bankId: bank!.id,
    managerId: manager!.id, monitorId: monitor!.id, staffAId: staffA!.id, staffBId: staffB!.id,
    manager: actorOf(orgId, manager!.id),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;


afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function legsOf(entryId: string) {
  return sql<{ code: string; debit: string; credit: string; party_type: string | null }[]>`
    select a.code, jl.debit::text, jl.credit::text, jl.party_type
    from journal_lines jl join accounts a on a.id = jl.account_id
    where jl.entry_id = ${entryId} order by a.code`;
}

const record = (f: Fixture) =>
  asOrg(f.orgId, (tx) =>
    recordOrderWastage(tx, f.manager, {
      storeId: f.storeId, salesDayId: f.salesDayId, channel: 'Foodpanda',
      amount: '100.00', reason: 'remade order', openedOn: '2026-01-10', disposition: 'absorbed',
    }),
  );

describe('DEF-925 - the wastage credit goes to the channel own receivable', () => {
  it('a channel on 1210 is credited on 1210, not 1220 - Mutant: credit CHANNEL_RECEIVABLE_CODE always -> 1220 is credited, red', async () => {
    const f = await fixture('own1210');
    await sql`update sales_channels set receivable_account_code = '1210', wastage_type_mode = 'instant' where id = ${f.channelId}`;
    const rec = await record(f);
    const credit = (await legsOf(rec.journalEntryId!)).filter((l) => Number(l.credit) > 0);
    expect(credit.map((l) => [l.code, l.party_type])).toEqual([['1210', 'channel']]);
  });

  it('positive: a channel on the channel receivable is still credited on 1220', async () => {
    const f = await fixture('own1220');
    await sql`update sales_channels set wastage_type_mode = 'instant' where id = ${f.channelId}`;
    const rec = await record(f);
    const credit = (await legsOf(rec.journalEntryId!)).filter((l) => Number(l.credit) > 0);
    expect(credit.map((l) => l.code)).toEqual(['1220']);
  });

  const PAID_DAILY = "This channel is paid daily, so there's nothing owed to adjust. Record the loss as an expense instead.";
  const payDaily = (f: Fixture) => sql`update sales_channels set is_remitted_daily = true, receivable_account_code = null where id = ${f.channelId}`;

  it('a channel paid daily (no receivable) refuses a new wastage in words - Mutant: drop the null-receivable check in recordOrderWastage -> it records, red', async () => {
    const f = await fixture('daily-rec');
    await payDaily(f);
    const err = await record(f).then(() => null, (e: { userMessage?: string }) => e);
    expect(err?.userMessage).toBe(PAID_DAILY);
  });

  it('and refuses to resolve one opened before - Mutant: drop the check in resolveOrderWastage -> it posts to 1220, red', async () => {
    const f = await fixture('daily-res');
    const rec = await asOrg(f.orgId, (tx) =>
      recordOrderWastage(tx, f.manager, { storeId: f.storeId, salesDayId: f.salesDayId, channel: 'Foodpanda', amount: '100.00', reason: 'remade order', openedOn: '2026-01-10' }),
    );
    await payDaily(f);
    const out = await asOrg(f.orgId, (tx) =>
      resolveOrderWastage(tx, f.manager, { wastageId: rec.id, storeId: f.storeId, disposition: 'absorbed', resolvedOn: '2026-01-11' }),
    );
    expect(out).toEqual({ ok: false, reason: PAID_DAILY });
  });
});
