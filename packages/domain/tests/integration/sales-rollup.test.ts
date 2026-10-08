import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-210 — docs/tasks/210-sales-reporting-over-the-ledger.md.
 *
 * The regression this file exists to carry: the channel/mode breakdown (sourced from
 * `sales_days`/`sales_day_channels`, `status='verified'`) must SUM to the same figure the ledger
 * total (sourced from `journal_lines`, `source_type='sale'`) computes independently — two
 * unrelated aggregation paths that must agree because the channel dimension does not exist on
 * the ledger rows themselves (see the task doc §2). Also proves an unverified day contributes to
 * NEITHER path, not just that the totals happen to match.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { mkSubmitter, submitThenVerify } from './_fixtures/sales-day-flow';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createSalesDay, getSalesRollup } from '@shareat/domain';

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

async function fixture(hint: string) {
  const code = uid(`rollup-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [store2] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint + '2')}, ${`Store ${hint} 2`}) returning id`;
  const store2Id = store2!.id;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [manager] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${manager!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${manager!.id}, ${storeId})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${manager!.id}, ${store2Id})`;

  const [walkIn] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${storeId}, 'Walk-in', true) returning id`;
  const [foodpanda] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
    values (${orgId}, ${storeId}, 'Foodpanda', false, '1220') returning id`;
  const [walkIn2] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${store2Id}, 'Walk-in', true) returning id`;
  const [foodpanda2] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
    values (${orgId}, ${store2Id}, 'Foodpanda', false, '1220') returning id`;

  const submitter = await mkSubmitter(sql, orgId, [storeId, store2Id]);
  return {
    orgId, storeId, store2Id, managerId: manager!.id, manager: { personId: manager!.id, orgId } as Actor, submitter,
    walkInChannelId: walkIn!.id, foodpandaChannelId: foodpanda!.id,
    store2WalkInChannelId: walkIn2!.id, store2FoodpandaChannelId: foodpanda2!.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A balanced sales day: unli 400 + à la carte 600 = totalSales 1000; channels 700 (walk-in,
 *  remitted) + 300 (Foodpanda, non-remitted) = 1000; collected: cash 700 + non-remitted 300 = 1000. */
async function postVerifiedDay(
  f: Fixture,
  businessDate: string,
  scale = 1,
  target: { storeId: string; walkInChannelId: string; foodpandaChannelId: string } = f,
) {
  const day = await asOrg(f.orgId, (tx) =>
    createSalesDay(tx, f.manager, {
      storeId: target.storeId,
      businessDate,
      totalSales: (1000 * scale).toFixed(2),
      unliSales: (400 * scale).toFixed(2),
      alaCarteSales: (600 * scale).toFixed(2),
      cashCollected: (700 * scale).toFixed(2),
      channels: [
        { channelId: target.walkInChannelId, amount: (700 * scale).toFixed(2) },
        { channelId: target.foodpandaChannelId, amount: (300 * scale).toFixed(2) },
      ],
    }),
  );
  await asOrg(f.orgId, (tx) => submitThenVerify(tx, f.manager, day.id, f.submitter));
  return day.id;
}

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('getSalesRollup', () => {
  it('reconciles: ledger total, channel breakdown, and mode breakdown all agree', async () => {
    const f = await fixture('basic');
    await postVerifiedDay(f, '2026-01-10');

    const result = await asOrg(f.orgId, (tx) =>
      getSalesRollup(tx, { orgId: f.orgId, fromDate: '2026-01-01', toDate: '2026-01-31', groupBy: 'day' }),
    );

    expect(result.reconciles, `ledger ${result.ledgerTotal} / channels ${result.channelTotal} / modes ${result.modeTotal}`).toBe(true);
    expect(result.ledgerTotal).toBe('1000.00');
    expect(result.channelTotal).toBe('1000.00');
    expect(result.modeTotal).toBe('1000.00');
    const foodpandaLine = result.channels.find((c) => c.channelName === 'Foodpanda');
    expect(foodpandaLine?.total).toBe('300.00');
    expect(foodpandaLine?.isRemittedDaily).toBe(false);
    const unliLine = result.modes.find((m) => m.mode === 'unli');
    expect(unliLine?.total).toBe('400.00');
  });

  it('groups by month and by store correctly', async () => {
    const f = await fixture('grouping');
    await postVerifiedDay(f, '2026-01-05');
    await postVerifiedDay(f, '2026-01-20', 2); // a second, larger day, same month

    const byDay = await asOrg(f.orgId, (tx) => getSalesRollup(tx, { orgId: f.orgId, fromDate: '2026-01-01', toDate: '2026-01-31', groupBy: 'day' }));
    expect(byDay.periods).toHaveLength(2);
    expect(byDay.ledgerTotal).toBe('3000.00'); // 1000 + 2000

    const byMonth = await asOrg(f.orgId, (tx) => getSalesRollup(tx, { orgId: f.orgId, fromDate: '2026-01-01', toDate: '2026-01-31', groupBy: 'month' }));
    expect(byMonth.periods).toHaveLength(1);
    expect(byMonth.periods[0]!.period).toBe('2026-01');
    expect(byMonth.periods[0]!.total).toBe('3000.00');

    const byStore = await asOrg(f.orgId, (tx) => getSalesRollup(tx, { orgId: f.orgId, fromDate: '2026-01-01', toDate: '2026-01-31', groupBy: 'store' }));
    expect(byStore.periods).toHaveLength(1);
    expect(byStore.periods[0]!.storeId).toBe(f.storeId);
    expect(byStore.periods[0]!.total).toBe('3000.00');
  });

  it('an unverified (open) day contributes to neither the ledger total nor the channel breakdown', async () => {
    const f = await fixture('unverified');
    await asOrg(f.orgId, (tx) =>
      createSalesDay(tx, f.manager, {
        storeId: f.storeId,
        businessDate: '2026-01-15',
        totalSales: '1000.00',
        unliSales: '400.00',
        alaCarteSales: '600.00',
        cashCollected: '700.00',
        channels: [
          { channelId: f.walkInChannelId, amount: '700.00' },
          { channelId: f.foodpandaChannelId, amount: '300.00' },
        ],
      }),
    );
    // Deliberately NOT verified — status stays 'open'.

    const result = await asOrg(f.orgId, (tx) =>
      getSalesRollup(tx, { orgId: f.orgId, fromDate: '2026-01-01', toDate: '2026-01-31', groupBy: 'day' }),
    );

    expect(result.periods).toEqual([]);
    expect(result.channels).toEqual([]);
    expect(result.ledgerTotal).toBe('0.00');
    expect(result.channelTotal).toBe('0.00');
    expect(result.reconciles).toBe(true);
  });

  it('storeId narrows the ledger total, the channel breakdown, and the mode breakdown together', async () => {
    const f = await fixture('store-scope');
    await postVerifiedDay(f, '2026-01-10');
    await postVerifiedDay(f, '2026-01-10', 1, { storeId: f.store2Id, walkInChannelId: f.store2WalkInChannelId, foodpandaChannelId: f.store2FoodpandaChannelId });

    const scoped = await asOrg(f.orgId, (tx) =>
      getSalesRollup(tx, { orgId: f.orgId, storeId: f.storeId, fromDate: '2026-01-01', toDate: '2026-01-31', groupBy: 'day' }),
    );
    expect(scoped.ledgerTotal).toBe('1000.00');
    expect(scoped.reconciles).toBe(true);

    const orgWide = await asOrg(f.orgId, (tx) =>
      getSalesRollup(tx, { orgId: f.orgId, fromDate: '2026-01-01', toDate: '2026-01-31', groupBy: 'day' }),
    );
    expect(orgWide.ledgerTotal).toBe('2000.00');
  });
});
