import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

import { seedChartOfAccounts } from '../../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../db/seed/expense-categories';
import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createCustomer, createSalesDay, recordChannelSettlement, recordCharge } from '../../../src';
import { postEntry } from '../../../src/ledger/post-entry';
import { mkSubmitter, submitThenVerify } from './sales-day-flow';

/**
 * T-507 (TESTER) - the shared world for the platform-receivables tests (domain + ERP page). Real flow: typed sales days are
 * created, submitted and verified, so 1220 / 1250 is raised exactly as production raises it (routing.ts receivableLines).
 *
 * Two UNLINKED (typed-day) stores. Dates are chosen so asOf 2027-03-31 puts one item in every bucket (aged by entry date):
 *   current  = date >= asOf          1-30 = [03-01, 03-31)      31-60 = [01-30, 03-01)
 *   61-90    = [12-31, 01-30)        90+  = before 12-31
 *
 *   Lipa  Foodpanda (1220)  12-15 1000 -> fully settled by a REAL channel settlement
 *                           01-05 2000 (a 500 credit also lands, so FIFO leaves 1,500)   02-10 3000   03-20 4000   03-31 500
 *                           => current 500 | 1-30 4000 | 31-60 3000 | 61-90 1500 | 90+ 0 | total 9000
 *   Lipa  GrabFood  (1220)  03-10 2500 => 1-30 2500
 *   Batangas Foodpanda (1220) 02-20 700 => 31-60 700
 *   Batangas Shopee (1250, NOT 1220) 03-25 900 => 1-30 900
 *   Customer (1210) charged 650 at Lipa on 03-15.
 *   UNVERIFIED (never post): Lipa open day 03-28 Foodpanda 800; Batangas open day 03-27 Foodpanda 100;
 *   Batangas open day 03-26 with Walk-in only (not counted - no platform amount).
 */
export const ASOF = '2027-03-31';
export const EXPECT = {
  lipaFoodpanda: { current: '500.00', d1to30: '4000.00', d31to60: '3000.00', d61to90: '1500.00', d90plus: '0.00', total: '9000.00' },
  lipaGrab: { current: '0.00', d1to30: '2500.00', d31to60: '0.00', d61to90: '0.00', d90plus: '0.00', total: '2500.00' },
  batFoodpanda: { current: '0.00', d1to30: '0.00', d31to60: '700.00', d61to90: '0.00', d90plus: '0.00', total: '700.00' },
  batShopee: { current: '0.00', d1to30: '900.00', d31to60: '0.00', d61to90: '0.00', d90plus: '0.00', total: '900.00' },
  platformTotal: '13100.00',
  lipaPlatformTotal: '11500.00',
  batPlatformTotal: '1600.00',
  customerTotal: '650.00',
} as const;

let seq = 0;
export const uid = (p: string) => `${p}-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 6)}`;

export async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

export async function buildPlatformWorld(sql: postgres.Sql) {
  const code = uid('t507');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  for (const [a, b] of [['2026-12-01', '2026-12-31'], ['2027-01-01', '2027-01-31'], ['2027-02-01', '2027-02-28'], ['2027-03-01', '2027-03-31']]) {
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, ${a!}, ${b!}, 'open')`;
  }
  const mkStore = async (name: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, ${name}) returning id`)[0]!.id;
  const lipa = await mkStore('T507 Lipa Branch');
  const bat = await mkStore('T507 Batangas Branch');

  const mkPerson = async (name: string, role: string, stores: string[]): Promise<Actor> => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return { personId: p!.id, orgId };
  };
  const admin = await mkPerson('T507 Admin', 'admin', [lipa, bat]);
  const mgrLipa = await mkPerson('T507 Manager Lipa', 'manager', [lipa]);
  const mgrBat = await mkPerson('T507 Manager Batangas', 'manager', [bat]);
  const submitter = await mkSubmitter(sql, orgId, [lipa, bat], 'T507 Submitter');

  const [bank] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${lipa}, 'Payout bank', 'bank', '1140', 'office') returning id`;
  const mkChannel = async (storeId: string, name: string, remitted: boolean, receivable: string | null) =>
    (await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, destination_money_account_id)
      values (${orgId}, ${storeId}, ${name}, ${remitted}, ${receivable}, ${remitted ? null : bank!.id}) returning id`)[0]!.id;
  const ch = {
    lipaWalk: await mkChannel(lipa, 'Walk-in', true, null),
    lipaFp: await mkChannel(lipa, 'Foodpanda', false, '1220'),
    lipaGrab: await mkChannel(lipa, 'GrabFood', false, '1220'),
    batWalk: await mkChannel(bat, 'Walk-in', true, null),
    batFp: await mkChannel(bat, 'Foodpanda', false, '1220'),
    batShopee: await mkChannel(bat, 'Shopee', false, '1250'),
  };

  /** A typed day: Walk-in cash 1,000 plus the platform amounts given; created OPEN. */
  const mkDay = async (storeId: string, walkId: string, date: string, platform: Array<{ channelId: string; amount: string }>) => {
    const total = (1000 + platform.reduce((s, p) => s + Number(p.amount), 0)).toFixed(2);
    const { id } = await asOrg(orgId, (tx) =>
      createSalesDay(tx, submitter, {
        storeId, businessDate: date, totalSales: total, unliSales: total, alaCarteSales: '0.00', cashCollected: '1000.00',
        channels: [{ channelId: walkId, amount: '1000.00' }, ...platform],
      }),
    );
    return id;
  };
  const verified = async (storeId: string, walkId: string, date: string, platform: Array<{ channelId: string; amount: string }>) => {
    const id = await mkDay(storeId, walkId, date, platform);
    await asOrg(orgId, (tx) => submitThenVerify(tx, admin, id, submitter));
    return id;
  };

  const dayDec15 = await verified(lipa, ch.lipaWalk, '2026-12-15', [{ channelId: ch.lipaFp, amount: '1000.00' }]);
  await verified(lipa, ch.lipaWalk, '2027-01-05', [{ channelId: ch.lipaFp, amount: '2000.00' }]);
  await verified(lipa, ch.lipaWalk, '2027-02-10', [{ channelId: ch.lipaFp, amount: '3000.00' }]);
  await verified(lipa, ch.lipaWalk, '2027-03-20', [{ channelId: ch.lipaFp, amount: '4000.00' }]);
  await verified(lipa, ch.lipaWalk, '2027-03-31', [{ channelId: ch.lipaFp, amount: '500.00' }]);
  await verified(lipa, ch.lipaWalk, '2027-03-10', [{ channelId: ch.lipaGrab, amount: '2500.00' }]);
  await verified(bat, ch.batWalk, '2027-02-20', [{ channelId: ch.batFp, amount: '700.00' }]);
  await verified(bat, ch.batWalk, '2027-03-25', [{ channelId: ch.batShopee, amount: '900.00' }]);

  // A REAL settlement clears the 12-15 day (credit 1,000 on 1220); a further 500 credit lands (a platform fee adjustment).
  await asOrg(orgId, (tx) =>
    recordChannelSettlement(tx, admin, {
      storeId: lipa, channelId: ch.lipaFp, salesDayId: dayDec15, businessDate: '2026-12-15',
      grossAmount: '1000.00', netDeposited: '1000.00', settledOn: '2026-12-20',
    }),
  );
  await asOrg(orgId, (tx) =>
    postEntry(tx, {
      orgId, entryDate: '2027-01-20', sourceType: 'sales_day', sourceId: dayDec15, idempotencyKey: uid('t507-credit'),
      memo: 'T507 partial platform credit', postedBy: admin.personId,
      lines: [
        { accountCode: '6420', storeId: lipa, debit: '500.00' },
        { accountCode: '1220', storeId: lipa, credit: '500.00', partyType: 'channel', partyId: ch.lipaFp },
      ],
    }),
  );

  // The customer section: a 650 charge at Lipa.
  const customer = await asOrg(orgId, (tx) => createCustomer(tx, admin, { name: 'T507 Customer Resto' }));
  await asOrg(orgId, (tx) =>
    recordCharge(tx, admin, {
      storeId: lipa, customerId: customer.id, chargeDate: '2027-03-15', dueDate: null, totalAmount: '650.00', revenueAccountCode: '4150',
    }),
  );

  // Unverified days: they post nothing.
  await mkDay(lipa, ch.lipaWalk, '2027-03-28', [{ channelId: ch.lipaFp, amount: '800.00' }]);
  await mkDay(bat, ch.batWalk, '2027-03-27', [{ channelId: ch.batFp, amount: '100.00' }]);
  await mkDay(bat, ch.batWalk, '2027-03-26', []);

  return { orgId, lipa, bat, ch, admin, mgrLipa, mgrBat, submitter, customerId: customer.id, bank: bank!.id };
}
export type PlatformWorld = Awaited<ReturnType<typeof buildPlatformWorld>>;

/** The ledger's own balance per channel on its receivable account, for the tie-out (independent of any report code). */
export async function ledgerBalanceByChannel(sql: postgres.Sql, orgId: string): Promise<Map<string, string>> {
  const rows = await sql<{ party_id: string; bal: string }[]>`
    select jl.party_id, sum(jl.debit - jl.credit)::numeric(14,2)::text as bal
    from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft' and jl.party_type = 'channel' and a.code in ('1220', '1250')
    group by jl.party_id`;
  return new Map(rows.map((r) => [r.party_id, r.bal]));
}
export async function ledgerBalance1210(sql: postgres.Sql, orgId: string): Promise<string> {
  const [r] = await sql<{ bal: string }[]>`
    select coalesce(sum(jl.debit - jl.credit), 0)::numeric(14,2)::text as bal
    from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft' and a.code = '1210'`;
  return r!.bal;
}
