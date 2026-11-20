import type postgres from 'postgres';

/**
 * T-597: put cash on the books of one store's account - a posted opening entry, Dr `code` / Cr 3900 at the same store - so a payout
 * from it can pass `checkDraw` (an office safe or bank account that cannot cover a payout is REFUSED, bible row 154). Moved out of
 * `t415-settle-lock.test.ts`; payroll fixtures use it too now that payroll follows the same rule (DEF-889).
 *
 * Dated on the first day of the org's EARLIEST fiscal period unless `on` is given, so it always lands in a period the fixture made.
 * `1140` (e-wallet) lines carry the account as their party, as the ledger requires; pass `accountId` for it.
 * Journal entry is written as a draft then posted, the way every raw fixture in this suite does.
 */
export async function fundAccount(
  sql: postgres.Sql,
  o: { orgId: string; storeId: string; code: string; amount: string; accountId?: string; on?: string },
): Promise<void> {
  const [period] = await sql<{ id: string; starts_on: string }[]>`
    select id, starts_on::text from fiscal_periods where org_id = ${o.orgId}
      ${o.on ? sql`and starts_on <= ${o.on}::date and ends_on >= ${o.on}::date` : sql``}
    order by starts_on limit 1`;
  if (!period) throw new Error('fundAccount: no fiscal period to date the opening entry in');
  const date = o.on ?? period.starts_on;
  if (o.code === '1140' && !o.accountId) throw new Error('fundAccount: a 1140 account needs its accountId (the line party)');
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${o.orgId}, ${date}, ${period.id}, 'opening_balance', ${`fund-${Date.now()}-${Math.random().toString(36).slice(2)}`}, 'draft') returning id`;
    const [target] = await tx<{ id: string }[]>`select id from accounts where org_id = ${o.orgId} and code = ${o.code}`;
    const [equity] = await tx<{ id: string }[]>`select id from accounts where org_id = ${o.orgId} and code = '3900'`;
    const party = o.code === '1140' ? { type: 'money_account', id: o.accountId! } : { type: null, id: null };
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
             values (${e!.id}, 1, ${target!.id}, ${o.storeId}, ${o.amount}, '0', ${party.type}, ${party.id})`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
             values (${e!.id}, 2, ${equity!.id}, ${o.storeId}, '0', ${o.amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}
