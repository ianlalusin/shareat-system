import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-210 — docs/tasks/210-sales-reporting-over-the-ledger.md.
 *
 * Every outcome POS or the fetch itself can produce must be a named, non-throwing result state —
 * this file is the proof, using an injected fetcher rather than a live POS (POS_API_URL/KEY are
 * unset in this dev environment, matching T-177's own live pull).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createSalesDay, verifySalesDay, getPosDayReconciliation, type FetchPosDaySales } from '@shareat/domain';

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
  const code = uid(`posrecon-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [manager] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${manager!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${manager!.id}, ${storeId})`;
  const [walkIn] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${storeId}, 'Walk-in', true) returning id`;

  return { orgId, storeId, manager: { personId: manager!.id, orgId } as Actor, walkInChannelId: walkIn!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function postVerifiedDay(f: Fixture, businessDate: string, totalSales: string) {
  const day = await asOrg(f.orgId, (tx) =>
    createSalesDay(tx, f.manager, {
      storeId: f.storeId,
      businessDate,
      totalSales,
      unliSales: '0.00',
      alaCarteSales: totalSales,
      cashCollected: totalSales,
      channels: [{ channelId: f.walkInChannelId, amount: totalSales }],
    }),
  );
  await asOrg(f.orgId, (tx) => verifySalesDay(tx, f.manager, day.id));
  return day.id;
}

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('getPosDayReconciliation', () => {
  it('matches when POS and the ledger agree', async () => {
    const f = await fixture('match');
    await postVerifiedDay(f, '2026-01-10', '1000.00');
    const fetchPos: FetchPosDaySales = async () => ({ found: true, totalSales: '1000.00', totalSessions: 42 });

    const result = await asOrg(f.orgId, (tx) => getPosDayReconciliation(tx, fetchPos, { orgId: f.orgId, storeId: f.storeId, businessDate: '2026-01-10' }));

    expect(result.pos).toEqual({ status: 'ok', totalSales: '1000.00', totalSessions: 42 });
    expect(result.ledger).toMatchObject({ exists: true, status: 'verified', totalSales: '1000.00' });
    expect(result.matches).toBe(true);
    expect(result.delta).toBe('0.00');
  });

  it('reports a mismatch with a signed delta when POS and the ledger disagree', async () => {
    const f = await fixture('mismatch');
    await postVerifiedDay(f, '2026-01-10', '1000.00');
    const fetchPos: FetchPosDaySales = async () => ({ found: true, totalSales: '1200.00', totalSessions: 50 });

    const result = await asOrg(f.orgId, (tx) => getPosDayReconciliation(tx, fetchPos, { orgId: f.orgId, storeId: f.storeId, businessDate: '2026-01-10' }));

    expect(result.matches).toBe(false);
    expect(result.delta).toBe('200.00');
  });

  it('POS found:false becomes not_found, never a crash', async () => {
    const f = await fixture('not-found');
    const fetchPos: FetchPosDaySales = async () => ({ found: false, totalSales: '0', totalSessions: 0 });

    const result = await asOrg(f.orgId, (tx) => getPosDayReconciliation(tx, fetchPos, { orgId: f.orgId, storeId: f.storeId, businessDate: '2026-01-10' }));

    expect(result.pos.status).toBe('not_found');
    expect(result.ledger).toEqual({ exists: false });
    expect(result.matches).toBeNull();
    expect(result.delta).toBeNull();
  });

  it('a fetcher throwing the "not configured" error becomes posStatus not_configured, never a crash', async () => {
    const f = await fixture('not-configured');
    const fetchPos: FetchPosDaySales = async () => {
      throw new Error('fetchPosSalesLive: POS_API_URL or POS_API_KEY is not configured — see .env.example');
    };

    const result = await asOrg(f.orgId, (tx) => getPosDayReconciliation(tx, fetchPos, { orgId: f.orgId, storeId: f.storeId, businessDate: '2026-01-10' }));

    expect(result.pos.status).toBe('not_configured');
  });

  it('a fetcher rejecting with a network error becomes unreachable, never a crash', async () => {
    const f = await fixture('unreachable');
    const fetchPos: FetchPosDaySales = async () => {
      throw new Error('fetch failed: ECONNREFUSED');
    };

    const result = await asOrg(f.orgId, (tx) => getPosDayReconciliation(tx, fetchPos, { orgId: f.orgId, storeId: f.storeId, businessDate: '2026-01-10' }));

    expect(result.pos.status).toBe('unreachable');
  });

  it('no Shareat System sales day for that store/date still renders the POS side alone', async () => {
    const f = await fixture('no-ledger-row');
    const fetchPos: FetchPosDaySales = async () => ({ found: true, totalSales: '500.00', totalSessions: 10 });

    const result = await asOrg(f.orgId, (tx) => getPosDayReconciliation(tx, fetchPos, { orgId: f.orgId, storeId: f.storeId, businessDate: '2026-01-10' }));

    expect(result.pos).toEqual({ status: 'ok', totalSales: '500.00', totalSessions: 10 });
    expect(result.ledger).toEqual({ exists: false });
    expect(result.matches).toBeNull();
    expect(result.delta).toBeNull();
  });
});
