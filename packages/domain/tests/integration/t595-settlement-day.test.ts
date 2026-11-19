import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-595 DEF-881 - a settlement can only name a sales day that is this org's, this store's, carries this channel, falls on the date being
 * settled and is verified. `docs/tasks/595-money-ar-credit-settlement-day.md`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { makeSettleableDay } from './_fixtures/sales-day-flow';
import { recordChannelSettlement } from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';

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

async function fixture(hint: string, opts: { verified?: boolean } = {}) {
  const code = uid(`cs-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;

  const mkStore = async (label: string) => {
    const [s] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid(label)}, ${`Store ${label}`}) returning id`;
    return s!.id;
  };
  const storeId = await mkStore('malvar');
  const otherStoreId = await mkStore('lipa');

  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${otherStoreId})`;

  const [bank] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeId}, 'Payout wallet', 'bank', '1140', 'office') returning id`;

  const [channel] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code,
                                destination_money_account_id)
    values (${orgId}, ${storeId}, ${`Foodpanda ${uid('c')}`}, false, '1220', ${bank!.id})
    returning id`;

  const [day] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${orgId}, ${storeId}, '2026-01-10', 0, 0, 0, ${p!.id}) returning id`;
  // DEF-881: a settlement names a verified day that carries the channel.
  if (opts.verified === false) {
    await sql`insert into sales_day_channels (sales_day_id, channel_id, amount) values (${day!.id}, ${channel!.id}, 0)`;
  } else {
    await makeSettleableDay(sql, day!.id, channel!.id, p!.id);
  }

  return {
    orgId, storeId, otherStoreId, bankId: bank!.id,
    channelId: channel!.id, salesDayId: day!.id,
    manager: actor(orgId, p!.id), personId: p!.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Raise the receivable a verified channel-day would have raised. */
async function raiseReceivable(f: Fixture, amount: string, date = '2026-01-10') {
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId,
      entryDate: date,
      sourceType: 'sales_day',
      sourceId: f.salesDayId,
      idempotencyKey: `sales_day:${f.salesDayId}:${amount}:${date}`,
      memo: 'Channel day',
      postedBy: f.personId,
      lines: [
        { accountCode: '1220', storeId: f.storeId, debit: amount, partyType: 'channel', partyId: f.channelId },
        { accountCode: '4150', storeId: f.storeId, credit: amount },
      ],
    }),
  );
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const settle = (f: Fixture, over: Partial<Parameters<typeof recordChannelSettlement>[2]> = {}) =>
  asOrg(f.orgId, (tx) =>
    recordChannelSettlement(tx, f.manager, {
      storeId: f.storeId, channelId: f.channelId, salesDayId: f.salesDayId,
      businessDate: '2026-01-10', grossAmount: '10000.00', netDeposited: '10000.00', settledOn: '2026-01-15',
      ...over,
    }),
  );

/** The sentence a refusal shows the user (`userMessage`), or the raw message of a plain error. */
async function said(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message: string; userMessage?: string };
    return err.userMessage ?? err.message;
  }
  throw new Error('NOT REFUSED');
}

const settlementRows = async (f: Fixture) =>
  (await sql<{ n: string }[]>`select count(*)::text as n from channel_settlements where org_id = ${f.orgId}`)[0]!.n;

async function extraDay(f: Fixture, storeId: string, date: string, verified: boolean) {
  const [d] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${f.orgId}, ${storeId}, ${date}, 0, 0, 0, ${f.personId}) returning id`;
  if (verified) await makeSettleableDay(sql, d!.id, f.channelId, f.personId);
  else await sql`insert into sales_day_channels (sales_day_id, channel_id, amount) values (${d!.id}, ${f.channelId}, 0)`;
  return d!.id;
}

describe('DEF-881 - the sales day a settlement names', () => {
  it('positive: a verified day of this store carrying the channel, on the settled date, posts', async () => {
    const f = await fixture('ok');
    await raiseReceivable(f, '10000.00');
    const r = await settle(f);
    expect(r.settlementId).toBeTruthy();
    expect(await settlementRows(f)).toBe('1');
  });

  it("refuses another store's day", async () => {
    const f = await fixture('otherstore');
    await raiseReceivable(f, '10000.00');
    const lipaDay = await extraDay(f, f.otherStoreId, '2026-01-10', true);
    expect(await said(settle(f, { salesDayId: lipaDay }))).toMatch(/could not be found for this store and channel/);
    expect(await settlementRows(f)).toBe('0');
  });

  it('refuses a day whose date differs from the business date', async () => {
    const f = await fixture('date');
    await raiseReceivable(f, '10000.00');
    expect(await said(settle(f, { businessDate: '2026-01-11' }))).toMatch(/That sales day is 2026-01-10, not 2026-01-11/);
    expect(await settlementRows(f)).toBe('0');
  });

  it('refuses a day that is still open', async () => {
    const f = await fixture('open', { verified: false });
    await raiseReceivable(f, '10000.00');
    expect(await said(settle(f))).toMatch(/not verified yet/);
    expect(await settlementRows(f)).toBe('0');
  });

  it('refuses a day that is submitted but not verified', async () => {
    const f = await fixture('submitted', { verified: false });
    await raiseReceivable(f, '10000.00');
    await sql`update sales_days set status = 'submitted', submitted_by = ${f.personId}, submitted_at = now() where id = ${f.salesDayId}`;
    expect(await said(settle(f))).toMatch(/not verified yet/);
    expect(await settlementRows(f)).toBe('0');
  });

  it('refuses a day with no row for this channel', async () => {
    const f = await fixture('nochannel');
    await raiseReceivable(f, '10000.00');
    await sql`delete from sales_day_channels where sales_day_id = ${f.salesDayId}`;
    expect(await said(settle(f))).toMatch(/could not be found for this store and channel/);
    expect(await settlementRows(f)).toBe('0');
  });

  it('an unreadable id is "not found", not a database cast error', async () => {
    const f = await fixture('garbage');
    await raiseReceivable(f, '10000.00');
    expect(await said(settle(f, { salesDayId: 'not-a-uuid' }))).toMatch(/could not be found for this store and channel/);
    expect(await settlementRows(f)).toBe('0');
  });
});
