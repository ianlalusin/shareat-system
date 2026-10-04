import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-373 S1 (DEF-552) - the POS-usage day picker. `docs/tasks/373-money-follow-ups.md` section S1, T11.
 *
 * TESTER, not BUILDER. `listSalesDaysForStore(orgId, storeId)` (apps/erp/src/app/inventory/pos-usage/lib.ts)
 * must drop a voided day from the picker UNLESS the day carries a live (non-void) pull; that day stays
 * listed and is flagged view-only. Open and verified days stay, unflagged.
 *
 * ## What the spec leaves open, pinned so the builder has one reading
 * The spec says "flagged view-only" and labels it "(voided - view only)" but names no field. This file
 * reads the flag as a boolean `viewOnly` on the `SalesDayOption` row (true for the kept voided day,
 * absent or false for every other row). If the builder reads a different name, that is a QUESTION to the
 * tester, not a test edit.
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
import { createSalesDay, verifySalesDay, voidSalesDay } from '@shareat/domain';
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

async function fixture(hint: string) {
  const code = uid(`t373s1w-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2027-02-01', '2027-02-28', 'open')`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, 'Lipa') returning id`;
  const storeId = store!.id;
  const [mgr] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${mgr!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${mgr!.id}, ${storeId})`;
  const [ch] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${storeId}, 'Walk-in', true) returning id`;
  const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const [loc] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${orgId}, ${storeId}, 'KIT', 'Kitchen', ${type!.id}, 'operating', true, ${mgr!.id}) returning id`;
  const manager: Actor = { personId: mgr!.id, orgId };
  const mk = async (date: string, opts: { verify?: boolean } = {}) => {
    const { id } = await asOrg(orgId, (tx) =>
      createSalesDay(tx, manager, {
        storeId, businessDate: date, totalSales: '1000.00', unliSales: '1000.00', alaCarteSales: '0.00',
        cashCollected: '1000.00', channels: [{ channelId: ch!.id, amount: '1000.00' }],
      }),
    );
    if (opts.verify) await asOrg(orgId, (tx) => verifySalesDay(tx, manager, id));
    return id;
  };
  const voidIt = (id: string) => asOrg(orgId, (tx) => voidSalesDay(tx, manager, id, 'Entered wrong'));
  const pull = async (salesDayId: string, status: 'planned' | 'void' = 'planned') => {
    await sql`
      insert into pos_usage_pulls (org_id, store_id, sales_day_id, location_id, snapshot_taken_at, status,
                                   voided_at, voided_by, void_reason)
      values (${orgId}, ${storeId}, ${salesDayId}, ${loc!.id}, now(), ${status},
              ${status === 'void' ? sql`now()` : null}, ${status === 'void' ? manager.personId : null},
              ${status === 'void' ? 'fixture: voided pull' : null})`; // T-374 S7 (0181): a void pull records who, when, why
  };
  return { orgId, storeId, mk, voidIt, pull };
}

describe('T11 - the POS-usage picker', () => {
  it('omits a voided day with no pull; keeps open and verified days; keeps a voided day that carries a live pull, flagged view-only', async () => {
    const { listSalesDaysForStore } = await import('../../src/app/inventory/pos-usage/lib');
    const f = await fixture('t11');

    const open = await f.mk('2027-02-01');
    const verified = await f.mk('2027-02-02', { verify: true });
    const withdrawn = await f.mk('2027-02-03'); // voided, no pull
    await f.voidIt(withdrawn);
    const keptVoided = await f.mk('2027-02-04', { verify: true }); // voided verified day carrying a live pull
    await f.pull(keptVoided);
    await f.voidIt(keptVoided);
    const voidPullOnly = await f.mk('2027-02-05', { verify: true }); // voided day whose only pull is void
    await f.pull(voidPullOnly, 'void');
    await f.voidIt(voidPullOnly);

    const rows = await listSalesDaysForStore(f.orgId, f.storeId);
    const byId = new Map(rows.map((r) => [r.id, r as typeof r & { viewOnly?: boolean }]));

    // Positive controls: live days are still offered, and are not view-only.
    expect(byId.get(open)?.status).toBe('open');
    expect(byId.get(verified)?.status).toBe('verified');
    expect(byId.get(open)?.viewOnly ?? false).toBe(false);
    expect(byId.get(verified)?.viewOnly ?? false).toBe(false);

    // The refusals.
    expect(byId.has(withdrawn), 'a voided day with no pull must not be offered').toBe(false);
    expect(byId.has(voidPullOnly), 'a voided day whose only pull is void must not be offered').toBe(false);

    // The kept one: listed, still voided, flagged view-only.
    expect(byId.get(keptVoided)?.status).toBe('voided');
    expect(byId.get(keptVoided)?.viewOnly).toBe(true);
  });
});
