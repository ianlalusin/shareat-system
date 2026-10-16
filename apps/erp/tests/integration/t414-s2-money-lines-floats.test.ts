import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-414 S2 - the loader behind the expense "Paid from" list. `docs/tasks/414-expense-cash-request-source.md` I3, I5, R-AUTO (d).
 *
 *   (d)  a store with no staff account: after a release (which now creates the account) the float is offered, carrying that account
 *   I3   LEGACY: a request released before R-AUTO at a store with no account is still offered (moneyAccountId null)
 *   I5   a drained float (outstanding 0, status still released) is not offered; another store's float is not offered; A-Z by holder
 *
 * MUTANTS: M3 restore `if (!floatAccount) return []` -> the I3 legacy leg goes red. M5 `> 0` -> `>= 0` -> the I5 drained leg goes red.
 * (d) is red until the release creates the account (builder, S1). The label text (I10) is in `apps/erp/tests/t353-money-lines-first-paint-render.test.ts`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound() called - fixture is broken');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createCashRequest, decideCashRequest, releaseCashRequest } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
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
const actor = (orgId: string, personId: string): Actor => ({ orgId, personId });

async function fixture(hint: string, o: { noStaffAccount?: boolean } = {}) {
  const code = uid(`t414s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const mkStore = async (name: string) => (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(name)}, ${name}) returning id`)[0]!.id;
  const storeId = await mkStore('Store A');
  const otherStoreId = await mkStore('Store B');
  const [mgr] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${mgr!.id}, ${orgId}, 'manager')`;
  for (const s of [storeId, otherStoreId]) await sql`insert into person_store_scope (person_id, store_id) values (${mgr!.id}, ${s})`;
  const safe = async (sid: string) =>
    (await sql<{ id: string }[]>`select id from money_accounts where store_id = ${sid} and custodian = 'office' and instrument = 'cash'`)[0]!.id;
  const officeSafeId = await safe(storeId);
  const otherOfficeSafeId = await safe(otherStoreId);
  if (o.noStaffAccount) await sql`delete from money_accounts where org_id = ${orgId} and store_id = ${storeId} and custodian = 'staff'`;
  // Both safes hold cash to release from.
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} limit 1`;
  for (const sid of [storeId, otherStoreId]) {
    await sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
        values (${orgId}, '2026-01-02', ${period!.id}, 'opening_balance', ${uid('open')}, 'draft') returning id`;
      const [t] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '1130'`;
      const [q] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '3900'`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${t!.id}, ${sid}, '500000.00', '0')`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${q!.id}, ${sid}, '0', '500000.00')`;
      await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
    });
  }
  return { orgId, storeId, otherStoreId, managerId: mgr!.id, manager: actor(orgId, mgr!.id), officeSafeId, otherOfficeSafeId };
}
type F = Awaited<ReturnType<typeof fixture>>;

async function holder(f: F, name: string): Promise<string> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, ${name}) returning id`;
  return p!.id;
}
async function release(f: F, holderName: string, amount: string, storeId = f.storeId, safe = f.officeSafeId): Promise<string> {
  const holderId = await holder(f, holderName);
  const { id } = await asOrg(f.orgId, (tx) => createCashRequest(tx, f.manager, { storeId, requestedFor: holderId, purpose: 'Run', amount, on: '2026-01-05' }));
  await asOrg(f.orgId, (tx) => decideCashRequest(tx, f.manager, { requestId: id, decision: 'approve', amount, on: '2026-01-05' }));
  await asOrg(f.orgId, (tx) => releaseCashRequest(tx, f.manager, { requestId: id, amount, fromMoneyAccountId: safe, on: '2026-01-05' }));
  return id;
}
/** A spend leg posted straight against the request (the shape an approved expense leaves): drains the float, status stays `released`. */
async function spend(f: F, requestId: string, amount: string, storeId = f.storeId): Promise<void> {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, '2026-01-07', ${period!.id}, 'expense_payment', ${uid('exp')}, 'draft') returning id`;
    const [x] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '6160'`;
    const [fl] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1120'`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${x!.id}, ${storeId}, ${amount}, '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
             values (${e!.id}, 2, ${fl!.id}, ${storeId}, '0', ${amount}, 'cash_request', ${requestId})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

async function floatsOf(f: F, storeId = f.storeId) {
  const { loadMoneyLines } = await import('../../src/lib/money-lines/load');
  const data = await loadMoneyLines(f.orgId, storeId, f.manager);
  return data.sources.filter((s) => s.kind === 'float') as Array<{ kind: 'float'; cashRequestId: string; holderName: string; outstanding: string; moneyAccountId: string | null; storeId: string }>;
}

describe('R-AUTO (d) - after a release at a store that had no staff account, the float is offered, with the new account', () => {
  it('the store had none; the release created one; the loader offers the float carrying that account id', async () => {
    const f = await fixture('d', { noStaffAccount: true });
    const req = await release(f, 'Ana Holder', '1000.00');
    const [acct] = await sql<{ id: string }[]>`select id from money_accounts where org_id = ${f.orgId} and store_id = ${f.storeId} and custodian = 'staff' and instrument = 'cash'`;
    expect(acct, 'the release must have created the staff cash account').toBeDefined();
    const floats = await floatsOf(f);
    expect(floats).toHaveLength(1);
    expect(floats[0]).toMatchObject({ cashRequestId: req, holderName: 'Ana Holder', outstanding: '1000.00', moneyAccountId: acct!.id, storeId: f.storeId });
  });
});

describe('I3 (legacy) - a request released BEFORE R-AUTO at a store with no staff account is still offered', () => {
  it('account gone after the release: the float still shows, moneyAccountId null', async () => {
    const f = await fixture('i3');
    const req = await release(f, 'Ana Holder', '1000.00');
    await sql`delete from money_accounts where org_id = ${f.orgId} and store_id = ${f.storeId} and custodian = 'staff'`;
    const floats = await floatsOf(f);
    expect(floats).toHaveLength(1);
    expect(floats[0]).toMatchObject({ cashRequestId: req, outstanding: '1000.00', moneyAccountId: null });
  });
});

describe('I5 - which floats are offered, and in what order', () => {
  it('a drained float (outstanding 0, still released) is not offered; the others are, A-Z by holder', async () => {
    const f = await fixture('i5');
    await release(f, 'Zed', '300.00');
    const drained = await release(f, 'Mid', '500.00');
    await release(f, 'Amy', '700.00');
    await spend(f, drained, '500.00');
    const floats = await floatsOf(f);
    expect(floats.map((x) => [x.holderName, x.outstanding])).toEqual([
      ['Amy', '700.00'],
      ['Zed', '300.00'],
    ]);
  });

  it("another store's float is not offered at this store (and is at its own)", async () => {
    const f = await fixture('i5s');
    await release(f, 'Here', '100.00');
    await release(f, 'There', '200.00', f.otherStoreId, f.otherOfficeSafeId);
    expect((await floatsOf(f)).map((x) => x.holderName)).toEqual(['Here']);
    expect((await floatsOf(f, f.otherStoreId)).map((x) => x.holderName)).toEqual(['There']);
  });
});
