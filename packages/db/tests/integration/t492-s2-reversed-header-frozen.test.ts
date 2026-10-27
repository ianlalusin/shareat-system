/**
 * T-492 S2 / DEF-786 — a `reversed` journal_entries header is frozen and undeletable.
 *
 * Migration 0005's `journal_entries_check_posted_immutable` guarded only `OLD.status = 'posted'`,
 * so a raw-SQL client could rewrite entry_date / memo / period_id of a REVERSED header, or delete
 * it (only the lines trigger and an FK stood in the way). Migration 0219 closes it.
 *
 * Real Postgres via TEST_DATABASE_URL, `_test` name guard (matches every sibling integration file).
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { seedChartOfAccounts } from '../../seed/chart-of-accounts';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

const sql = postgres(url, { max: 3 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function fixture(hint: string, finalStatus: 'posted' | 'reversed') {
  const code = uid(`t492s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [p1] = await sql<{ id: string }[]>`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open') returning id`;
  const [p2] = await sql<{ id: string }[]>`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-02-01', '2026-02-28', 'open') returning id`;
  const [cash] = await sql<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '1110'`;
  const [opex] = await sql<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '6900'`;
  const entryId = await sql.begin(async (trx) => {
    const [e] = await trx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, memo, source_type, source_id, status)
      values (${orgId}, '2026-01-15', ${p1!.id}, 'orig', 'test', ${uid(hint)}, 'draft') returning id`;
    await trx`insert into journal_lines (entry_id, line_no, account_id, debit, credit) values (${e!.id}, 1, ${opex!.id}, '10.00', '0')`;
    await trx`insert into journal_lines (entry_id, line_no, account_id, debit, credit) values (${e!.id}, 2, ${cash!.id}, '0', '10.00')`;
    await trx`update journal_entries set status = 'posted', posted_at = now() where id = ${e!.id}`;
    return e!.id;
  });
  if (finalStatus === 'reversed') {
    await sql`update journal_entries set status = 'reversed' where id = ${entryId}`;
  }
  return { orgId, entryId, otherPeriodId: p2!.id };
}

async function fails(run: () => PromiseLike<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    return (err as Error).message;
  }
  return '';
}

describe('T-492 S2 — reversed header is frozen', () => {
  it('refuses UPDATE of entry_date', async () => {
    const { entryId } = await fixture('date', 'reversed');
    const msg = await fails(() => sql`update journal_entries set entry_date = '2026-01-20' where id = ${entryId}`);
    expect(msg, 'wanted a refusal; today the UPDATE succeeds').toMatch(/reversed journal entry .* is immutable/);
  });
  it('refuses UPDATE of memo', async () => {
    const { entryId } = await fixture('memo', 'reversed');
    const msg = await fails(() => sql`update journal_entries set memo = 'rewritten' where id = ${entryId}`);
    expect(msg).toMatch(/reversed journal entry .* is immutable/);
  });
  it('refuses UPDATE of period_id', async () => {
    const { entryId, otherPeriodId } = await fixture('period', 'reversed');
    const msg = await fails(() => sql`update journal_entries set period_id = ${otherPeriodId} where id = ${entryId}`);
    expect(msg).toMatch(/reversed journal entry .* is immutable/);
  });
  it('refuses UPDATE of status (reversed -> posted / draft)', async () => {
    const { entryId } = await fixture('status', 'reversed');
    for (const to of ['posted', 'draft']) {
      const msg = await fails(() => sql`update journal_entries set status = ${to} where id = ${entryId}`);
      expect(msg, `reversed -> ${to}`).toMatch(/reversed journal entry .* is immutable/);
    }
    const [row] = await sql<{ status: string }[]>`select status from journal_entries where id = ${entryId}`;
    expect(row!.status).toBe('reversed');
  });
  it('allows an updated_at-only UPDATE of a reversed header', async () => {
    const { entryId } = await fixture('touch', 'reversed');
    await sql`update journal_entries set updated_at = now() where id = ${entryId}`;
    const [row] = await sql<{ status: string; memo: string }[]>`select status, memo from journal_entries where id = ${entryId}`;
    expect(row).toMatchObject({ status: 'reversed', memo: 'orig' });
  });
  it('refuses DELETE of a reversed header with the trigger message (not just the FK)', async () => {
    const { entryId } = await fixture('del-rev', 'reversed');
    const msg = await fails(() => sql`delete from journal_entries where id = ${entryId}`);
    expect(msg, 'wanted the trigger refusal; today only the lines FK stops it').toMatch(/reversed journal entry .* cannot be deleted/);
    expect((await sql`select id from journal_entries where id = ${entryId}`).length).toBe(1);
  });
});

describe('T-492 S2 — posted rules unchanged', () => {
  it('posted DELETE still refused', async () => {
    const { entryId } = await fixture('del-posted', 'posted');
    expect(await fails(() => sql`delete from journal_entries where id = ${entryId}`)).toMatch(/posted journal entry .* cannot be deleted/);
  });
  it('posted memo change still refused', async () => {
    const { entryId } = await fixture('posted-memo', 'posted');
    expect(await fails(() => sql`update journal_entries set memo = 'x' where id = ${entryId}`)).toMatch(/posted journal entry .* is immutable/);
  });
  it('posted -> draft still refused; posted -> reversed still allowed', async () => {
    const { entryId } = await fixture('posted-trans', 'posted');
    expect(await fails(() => sql`update journal_entries set status = 'draft' where id = ${entryId}`)).toMatch(/may only remain posted or transition to reversed/);
    await sql`update journal_entries set status = 'reversed' where id = ${entryId}`;
    const [row] = await sql<{ status: string }[]>`select status from journal_entries where id = ${entryId}`;
    expect(row!.status).toBe('reversed');
  });
});
