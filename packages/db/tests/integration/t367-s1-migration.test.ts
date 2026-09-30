import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-367 S1 / R2 — `ar_write_offs_journal_entry_unique` (`docs/tasks/367-ap-ar-money.md` §S1,
 * "Migration test"). The index does not exist yet (migration 0049:159 has no unique index on
 * `ar_write_offs.journal_entry_id`) — expected to fail on "no unique or exclusion constraint" until
 * the migration lands, which this file's own carve-out accepts (same convention as
 * `t366-0172-migration.test.ts`).
 *
 * ⛔ TESTER, not BUILDER.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../seed/chart-of-accounts';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function fixture(hint: string) {
  const code = uid(`t367mig-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const [customer] = await sql<{ id: string }[]>`insert into customers (org_id, name, created_by) values (${orgId}, 'Resto', ${admin!.id}) returning id`;
  const [period] = await sql<{ id: string }[]>`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2027-02-01', '2027-02-28', 'open') returning id`;
  const [charge] = await sql<{ id: string }[]>`
    insert into ar_charges (org_id, store_id, customer_id, charge_date, total_amount, revenue_account_code, status, created_by)
    values (${orgId}, ${storeId}, ${customer!.id}, '2027-02-03', '1000.00', '4150', 'posted', ${admin!.id}) returning id`;
  return { orgId, storeId, adminId: admin!.id, customerId: customer!.id, periodId: period!.id, chargeId: charge!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function postedEntry(f: Fixture, sourceId: string): Promise<string> {
  return sql.begin(async (tx) => {
    const [entry] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status, idempotency_key)
      values (${f.orgId}, '2027-02-03', ${f.periodId}, 'ar_write_off', ${sourceId}, 'draft', ${uid('key')}) returning id`;
    const [badDebt] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '6860'`;
    const [arControl] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1210'`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${entry!.id}, 1, ${badDebt!.id}, ${f.storeId}, '400.00', '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, credit, debit, party_type, party_id) values (${entry!.id}, 2, ${arControl!.id}, ${f.storeId}, '400.00', '0', 'customer', ${f.customerId})`;
    await tx`update journal_entries set status = 'posted' where id = ${entry!.id}`;
    return entry!.id;
  });
}

describe('ar_write_offs_journal_entry_unique — R2', () => {
  it('a second ar_write_offs row with an EXISTING journal_entry_id is refused with 23505', async () => {
    const f = await fixture('dup');
    const entryId = await postedEntry(f, f.chargeId);
    await sql`insert into ar_write_offs (org_id, ar_charge_id, amount, reason, journal_entry_id, written_off_by)
      values (${f.orgId}, ${f.chargeId}, '400.00', 'bad debt', ${entryId}, ${f.adminId})`;

    const err = await sql`insert into ar_write_offs (org_id, ar_charge_id, amount, reason, journal_entry_id, written_off_by)
      values (${f.orgId}, ${f.chargeId}, '400.00', 'bad debt', ${entryId}, ${f.adminId})`.catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code, 'expected 23505 unique_violation').toBe('23505');
  });

  it('a positive control: a row with a NEW journal_entry_id is accepted', async () => {
    const f = await fixture('ok');
    const entryId1 = await postedEntry(f, f.chargeId);
    const entryId2 = await postedEntry(f, f.chargeId);
    await sql`insert into ar_write_offs (org_id, ar_charge_id, amount, reason, journal_entry_id, written_off_by)
      values (${f.orgId}, ${f.chargeId}, '400.00', 'bad debt', ${entryId1}, ${f.adminId})`;
    await expect(
      sql`insert into ar_write_offs (org_id, ar_charge_id, amount, reason, journal_entry_id, written_off_by)
        values (${f.orgId}, ${f.chargeId}, '300.00', 'bad debt', ${entryId2}, ${f.adminId})`,
    ).resolves.toBeDefined();
  });
});
