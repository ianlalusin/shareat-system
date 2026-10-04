import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-373 S4 (DEF-547) T8 — the remittance screen's loaders agree with the repo: a reversed
 * handover's uncharged variance is neither in `openVariances` nor in `openVarianceCountForOrg`
 * (`apps/erp/src/app/remittance/lib.ts`), and a posted handover's still is (positive control).
 * `docs/tasks/373-money-follow-ups.md` §S4, R6.
 *
 * ⛔ TESTER, not BUILDER. Red on HEAD: the loaders still list/count the reversed handover.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => {
    throw new Error('requireActor is not used by the loaders under test');
  }),
}));
vi.mock('@/lib/constraint-messages', async () => {
  return await import('../../src/lib/constraint-messages');
});

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createRemittance, reverseRemittance } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { openVariances, openVarianceCountForOrg } from '../../src/app/remittance/lib';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

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

async function addStore(orgId: string, hint: string) {
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, '2020-01-01') returning id`;
  const [till] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${store!.id} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  const [safe] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${store!.id} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  return { storeId: store!.id, till: till!.id, safe: safe!.id };
}
type Store = Awaited<ReturnType<typeof addStore>>;

async function fixture(hint: string) {
  const code = uid(`t373s4w-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const s1 = await addStore(orgId, `${hint}a`);
  const s2 = await addStore(orgId, `${hint}b`);
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  for (const s of [s1, s2]) await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${s.storeId})`;
  return { orgId, s1, s2, adminId: admin!.id, admin: actor(orgId, admin!.id) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function shortHandover(f: Fixture, s: Store, date: string) {
  await sql`insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${f.orgId}, ${s.storeId}, ${date}, 'verified', '0', '0', '0', ${f.adminId})`;
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, ${date}, ${period!.id}, 'sale', ${uid('src')}, 'draft') returning id`;
    const [cash] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1110'`;
    const [rev] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '4100'`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${cash!.id}, ${s.storeId}, '1000.00', '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${rev!.id}, ${s.storeId}, '0', '1000.00')`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
  const r = await asOrg(f.orgId, (tx) =>
    createRemittance(tx, f.admin, {
      storeId: s.storeId,
      remittedOn: date,
      lines: [{ fromMoneyAccountId: s.till, toMoneyAccountId: s.safe, amount: '950.00' }],
    }),
  );
  expect(r.variance, 'setup: a 50.00 shortage').toBe('-50.00');
  return r;
}
const reverse = (f: Fixture, remittanceId: string) =>
  asOrg(f.orgId, (tx) => reverseRemittance(tx, f.admin, { remittanceId, reason: 'T-373 S4 loader' }));

describe('T-373 S4 T8 — the remittance loaders agree with the derived "open"', () => {
  it('a posted handover is listed and counted (control); reversed, the store list and the org-wide count drop it; another store\'s posted variance still counts', async () => {
    const f = await fixture('t8');
    const a = await shortHandover(f, f.s1, '2026-01-05');
    const b = await shortHandover(f, f.s2, '2026-01-05');

    // positive control: both open, both counted, each store lists its own
    expect((await openVariances(f.orgId, f.s1.storeId)).map((v) => v.id)).toEqual([a.varianceId]);
    expect((await openVariances(f.orgId, f.s2.storeId)).map((v) => v.id)).toEqual([b.varianceId]);
    expect(await openVarianceCountForOrg(f.orgId)).toBe(2);

    await reverse(f, a.id);

    expect((await openVariances(f.orgId, f.s1.storeId)).map((v) => v.id), 'store 1 list after its reversal').toEqual([]);
    expect((await openVariances(f.orgId)).map((v) => v.id), 'org-wide list').toEqual([b.varianceId]);
    expect(await openVarianceCountForOrg(f.orgId), 'org-wide count').toBe(1);
    expect((await openVariances(f.orgId, f.s2.storeId)).map((v) => v.id), 'store 2 unaffected').toEqual([b.varianceId]);
  });
});
