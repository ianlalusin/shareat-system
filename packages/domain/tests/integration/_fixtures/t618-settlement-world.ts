/**
 * T-618 - the world the lock-order tests of hand-recorded channel settlements run in (NOT a test file). Copied from t511-s6a-loan-legs.test.ts: an org with two stores, a
 * manager scoped to both, a payout bank, and one settleable verified day at the paying store that any number of channels can be attached to.
 */
import type postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { seedChartOfAccounts } from '../../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../db/seed/expense-categories';
import { postEntry } from '../../../src/ledger/post-entry';
import { makeSettleableDay } from './sales-day-flow';

let seq = 0;
export const uid = (p: string): string => `${p}-${Date.now()}-${++seq}`;

export async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

export const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });

export async function world(sql: postgres.Sql, hint: string) {
  const code = uid(`t618-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;
  const mkStore = async (label: string) => {
    const [s] = await sql<{ id: string; code: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(label)}, ${`Store ${label}`}) returning id, code`;
    return { id: s!.id, code: s!.code };
  };
  const paying = await mkStore('malvar');
  const other = await mkStore('lipa');
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'manager')`;
  for (const s of [paying, other]) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s.id})`;
  const [bank] = await sql<{ id: string }[]>`insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian) values (${orgId}, ${paying.id}, 'Payout wallet', 'bank', '1140', 'office') returning id`;
  const [day] = await sql<{ id: string }[]>`insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by) values (${orgId}, ${paying.id}, '2026-01-10', 0, 0, 0, ${p!.id}) returning id`;
  const channel = async (name: string): Promise<string> => {
    const [c] = await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, destination_money_account_id)
      values (${orgId}, ${paying.id}, ${`${name} ${uid('c')}`}, false, '1220', ${bank!.id}) returning id`;
    await makeSettleableDay(sql, day!.id, c!.id, p!.id); // DEF-881: a settlement names a verified day carrying the channel
    return c!.id;
  };
  return { orgId, paying, other, bankId: bank!.id, salesDayId: day!.id, manager: actorOf(orgId, p!.id), personId: p!.id, channel };
}
export type World = Awaited<ReturnType<typeof world>>;

export async function raiseReceivable(f: World, channelId: string, amount: string, date = '2026-01-10'): Promise<void> {
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId, entryDate: date, sourceType: 'sales_day', sourceId: f.salesDayId, idempotencyKey: `sales_day:${channelId}:${amount}:${date}`,
      memo: 'Channel day', postedBy: f.personId,
      lines: [
        { accountCode: '1220', storeId: f.paying.id, debit: amount, partyType: 'channel', partyId: channelId },
        { accountCode: '4150', storeId: f.paying.id, credit: amount },
      ],
    }),
  );
}

/** A loan owned by `store`, disbursed 5,000.00 (so a repayment moves a real position). */
export async function loanOf(sql: postgres.Sql, f: World, store: { id: string }, name: string): Promise<string> {
  const [loan] = await sql<{ id: string }[]>`
    insert into loans (org_id, store_id, lender_name, name, principal_amount, interest_rate, rate_period, interest_method, payment_frequency, term_periods, start_date, created_by)
    values (${f.orgId}, ${store.id}, 'Grab', ${uid(name)}, 5000, 0, 'month', 'straight', 'monthly', 6, '2026-01-01', ${f.personId}) returning id`;
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId, entryDate: '2026-01-02', sourceType: 'loan_disbursement', sourceId: loan!.id, idempotencyKey: `loan_disbursement:${loan!.id}`, memo: 'Draw', postedBy: f.personId,
      lines: [
        { accountCode: '1130', storeId: store.id, debit: '5000.00' },
        { accountCode: '2400', storeId: store.id, credit: '5000.00', partyType: 'loan', partyId: loan!.id },
      ],
    }),
  );
  return loan!.id;
}

/** The input of a hand-recorded 20,000 payout with 2,360 docked to loans (same figures as t511-s6a-loan-legs). */
export const settleInput = (f: World, channelId: string, loanLegs: { loanId: string; amount: string; ownerStoreId?: string }[]) =>
  ({ storeId: f.paying.id, channelId, salesDayId: f.salesDayId, businessDate: '2026-01-10', grossAmount: '20000.00', netDeposited: '17640.00', settledOn: '2026-01-15', loanLegs }) as never;
