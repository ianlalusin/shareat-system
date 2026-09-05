import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-209b — docs/tasks/209-reporting-read-model-and-statements.md. Mirrors ap-aging.test.ts
 * pointed the other way (customers, not suppliers) — see that file's top comment.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createCustomer, recordCharge, recordCollection, getArAgingReport } from '@shareat/domain';

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
  const code = uid(`araging-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [store2] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint + '2')}, ${`Store ${hint} 2`}) returning id`;
  const store2Id = store2!.id;
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;
  const [manager] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  const [admin] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${manager!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  for (const s of [storeId, store2Id]) {
    await sql`insert into person_store_scope (person_id, store_id) values (${manager!.id}, ${s})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${s})`;
  }
  const [drawer] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId}
      and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  // manage_chart_of_accounts is admin-only (CAPABILITY-MATRIX.md row 155) — createCustomer needs it.
  const customer = await asOrg(orgId, (tx) => createCustomer(tx, actor(orgId, admin!.id), { name: `${hint} Resto` }));

  return {
    orgId, storeId, store2Id, managerId: manager!.id, manager: actor(orgId, manager!.id),
    drawerId: drawer!.id, customerId: customer.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function chargeAt(
  f: Fixture,
  storeId: string,
  amount: string,
  opts: { chargeDate?: string; dueDate?: string | null } = {},
) {
  return asOrg(f.orgId, (tx) =>
    recordCharge(tx, f.manager, {
      storeId,
      customerId: f.customerId,
      chargeDate: opts.chargeDate ?? '2026-01-10',
      dueDate: opts.dueDate ?? null,
      totalAmount: amount,
      revenueAccountCode: '4150',
    }),
  );
}

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('getArAgingReport', () => {
  it('reconciles to the control account after an ordinary charge', async () => {
    const f = await fixture('basic');
    await chargeAt(f, f.storeId, '900.00', { chargeDate: '2026-01-01', dueDate: '2026-01-01' });

    const report = await asOrg(f.orgId, (tx) => getArAgingReport(tx, { orgId: f.orgId, asOfDate: '2026-02-15' }));

    expect(report.reconciles, `total (${report.totals.total}) must equal control balance (${report.controlBalance})`).toBe(true);
    expect(report.controlBalance).toBe('900.00');
    expect(report.totals.total).toBe('900.00');
  });

  it('places a 45-day-old item in the 31-60 bucket, matching arRepo.aging()', async () => {
    const f = await fixture('bucket');
    await chargeAt(f, f.storeId, '900.00', { chargeDate: '2026-01-01', dueDate: '2026-01-01' });

    const report = await asOrg(f.orgId, (tx) => getArAgingReport(tx, { orgId: f.orgId, asOfDate: '2026-02-15' }));

    const row = report.rows.find((r) => r.customerId === f.customerId);
    expect(row?.d31to60).toBe('900.00');
    expect(row?.current).toBe('0.00');
    expect(row?.total).toBe('900.00');
  });

  it('totals.total equals the sum of every row and every bucket column', async () => {
    const f = await fixture('sum');
    await chargeAt(f, f.storeId, '900.00', { chargeDate: '2026-01-01', dueDate: '2026-01-01' });
    await chargeAt(f, f.storeId, '400.00', { chargeDate: '2026-02-10', dueDate: '2026-02-10' });

    const report = await asOrg(f.orgId, (tx) => getArAgingReport(tx, { orgId: f.orgId, asOfDate: '2026-02-15' }));

    const rowSum = report.rows.reduce((t, r) => t + Number(r.total), 0).toFixed(2);
    const bucketSum = (
      Number(report.totals.current) +
      Number(report.totals.d1to30) +
      Number(report.totals.d31to60) +
      Number(report.totals.d61to90) +
      Number(report.totals.d90plus)
    ).toFixed(2);
    expect(report.totals.total).toBe('1300.00');
    expect(report.totals.total).toBe(rowSum);
    expect(report.totals.total).toBe(bucketSum);
  });

  it('a partial collection reduces totals.total and controlBalance together', async () => {
    const f = await fixture('partial');
    const { chargeId } = await chargeAt(f, f.storeId, '1000.00', { chargeDate: '2026-01-01' });

    const before = await asOrg(f.orgId, (tx) => getArAgingReport(tx, { orgId: f.orgId, asOfDate: '2026-02-15' }));
    expect(before.totals.total).toBe('1000.00');
    expect(before.reconciles).toBe(true);

    await asOrg(f.orgId, (tx) =>
      recordCollection(tx, f.manager, {
        storeId: f.storeId,
        customerId: f.customerId,
        collectionDate: '2026-02-01',
        amount: '400.00',
        moneyAccountId: f.drawerId,
        allocations: [{ chargeId, amountApplied: '400.00' }],
      }),
    );

    const after = await asOrg(f.orgId, (tx) => getArAgingReport(tx, { orgId: f.orgId, asOfDate: '2026-02-15' }));
    expect(after.totals.total).toBe('600.00');
    expect(after.controlBalance).toBe('600.00');
    expect(after.reconciles, 'both independent paths must move together, not just agree at zero').toBe(true);
  });

  it('storeId narrows both the rows and the control balance to that store alone', async () => {
    const f = await fixture('store');
    await chargeAt(f, f.storeId, '500.00', { chargeDate: '2026-01-01' });
    await chargeAt(f, f.store2Id, '300.00', { chargeDate: '2026-01-01' });

    const store1Report = await asOrg(f.orgId, (tx) =>
      getArAgingReport(tx, { orgId: f.orgId, storeId: f.storeId, asOfDate: '2026-02-15' }),
    );
    const orgReport = await asOrg(f.orgId, (tx) => getArAgingReport(tx, { orgId: f.orgId, asOfDate: '2026-02-15' }));

    expect(store1Report.totals.total).toBe('500.00');
    expect(store1Report.controlBalance).toBe('500.00');
    expect(store1Report.reconciles).toBe(true);
    expect(store1Report.rows.every((r) => r.storeId === f.storeId)).toBe(true);
    expect(orgReport.totals.total).toBe('800.00');
    expect(orgReport.controlBalance).toBe('800.00');
  });

  it('no open charges produces a reconciling empty report, not a crash', async () => {
    const f = await fixture('empty');
    const report = await asOrg(f.orgId, (tx) => getArAgingReport(tx, { orgId: f.orgId, asOfDate: '2026-02-15' }));
    expect(report.rows).toEqual([]);
    expect(report.totals.total).toBe('0.00');
    expect(report.controlBalance).toBe('0.00');
    expect(report.reconciles).toBe(true);
  });
});
