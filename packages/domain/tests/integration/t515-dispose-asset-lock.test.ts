import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-515 (audit 49th pass): disposing an asset takes the asset row's lock (FOR UPDATE) before it judges
 * anything, so it serialises with a depreciation run on the same asset. Real PostgreSQL, TWO SEPARATE
 * transactions on two pooled connections; the first is held open by a deferred promise. Fixture pattern
 * copied from t513-disposal-before-depreciation.test.ts.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
}
if (!isTestDatabaseUrl(url)) {
  throw new Error(
    `Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createAsset, depreciateAsset, disposeAsset } from '@shareat/domain';

vi.setConfig({ testTimeout: 45000 });
const PAUSE_MS = 700;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sql = postgres(url, { max: 5 });

let seq = 0;
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

interface Fixture {
  orgId: string;
  storeId: string;
  adminId: string;
}

async function setup(hint: string): Promise<Fixture> {
  const code = uid(`t515-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const last = new Date(Date.UTC(2026, m, 0)).getUTCDate();
    await sql`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      values (${orgId}, ${`2026-${mm}-01`}, ${`2026-${mm}-${last}`}, 'open')
    `;
  }
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, '2020-01-01') returning id
  `;
  const storeId = store!.id;
  const [r] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${`${hint} Admin`}) returning id
  `;
  await sql`insert into person_roles (person_id, org_id, role) values (${r!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${r!.id}, ${storeId})`;
  return { orgId, storeId, adminId: r!.id };
}

/** A lock_timeout makes a hang fail loudly instead of freezing the run. */
async function asPerson<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    await tx.execute(dsql`set local lock_timeout = '15s'`);
    return fn(tx);
  });
}

function actor(f: Fixture): Actor {
  return { personId: f.adminId, orgId: f.orgId };
}

/** Org-wide balance (credit - debit) of one account, over non-draft entries. */
async function balance(orgId: string, code: string): Promise<string> {
  const rows = await sql<{ total: string }[]>`
    select coalesce(sum(jl.credit - jl.debit), 0)::text as total
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and a.code = ${code} and je.status <> 'draft'
  `;
  return rows[0]?.total ?? '0';
}

async function entryCount(orgId: string, assetId: string, sourceType: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from journal_entries
    where org_id = ${orgId} and source_id = ${assetId} and source_type = ${sourceType}
  `;
  return rows[0]?.n ?? 0;
}

async function statusOf(assetId: string): Promise<string> {
  const rows = await sql<{ status: string }[]>`select status from fixed_assets where id = ${assetId}`;
  return rows[0]!.status;
}

/** 120,000 over 24 months, no salvage: 5,000 a month. Acquired 15 Jan 2026. Jan and Feb depreciation committed. */
async function janFebAsset(f: Fixture): Promise<string> {
  const { id } = await asPerson(f.orgId, (tx) =>
    createAsset(tx, actor(f), {
      storeId: f.storeId,
      name: 'Chest freezer',
      category: 'appliances',
      acquiredOn: '2026-01-15',
      cost: '120000.00',
      usefulLifeMonths: 24,
    } as Parameters<typeof createAsset>[2]),
  );
  await asPerson(f.orgId, (tx) => depreciateAsset(tx, actor(f), { assetId: id, through: '2026-02' }));
  return id;
}

const march = (f: Fixture, assetId: string) => (tx: Tx) =>
  depreciateAsset(tx, actor(f), { assetId, through: '2026-03' });
const dispose = (f: Fixture, assetId: string, disposedOn: string) => (tx: Tx) =>
  disposeAsset(tx, actor(f), { assetId, disposedOn, reason: 'T-515 test' });

/**
 * A runs `first`, then holds its transaction open. B starts only after A has done its work, and runs
 * `second`. B must still be pending after PAUSE_MS (that is the proof it is blocked on A's lock); then A
 * commits and B finishes (or is refused). Resolves with B's outcome and whether B waited.
 */
async function race<TB>(
  f: Fixture,
  first: (tx: Tx) => Promise<unknown>,
  second: (tx: Tx) => Promise<TB>,
): Promise<{ waited: boolean; value?: TB; error?: string }> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let didWork!: () => void;
  const worked = new Promise<void>((r) => (didWork = r));
  const a = asPerson(f.orgId, async (tx) => {
    await first(tx);
    didWork();
    await gate;
  });
  await Promise.race([worked, a]); // if A itself throws, fail here instead of hanging on the gate

  let done = false;
  const b = asPerson(f.orgId, second).then(
    (value) => ({ value }) as { value?: TB; error?: string },
    (e: Error) => ({ error: e.message }) as { value?: TB; error?: string },
  );
  void b.then(() => (done = true));
  await sleep(PAUSE_MS);
  const waited = !done;
  release();
  await a;
  return { waited, ...(await b) };
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-515 - disposal and depreciation serialise on the asset row (two transactions)', () => {
  it('(a) March run posted but uncommitted; disposal dated 28 Feb (before March) waits, then is refused; asset stays active, 1590 = Jan+Feb+Mar', async () => {
    const f = await setup('a');
    const assetId = await janFebAsset(f);

    const out = await race(f, march(f, assetId), dispose(f, assetId, '2026-02-28'));

    expect(out.waited, 'the disposal did not wait for the depreciation run (no asset row lock)').toBe(true);
    expect(out.error).toMatch(/before depreciation already posted up to 2026-03-31/);
    expect(await statusOf(assetId)).toBe('active');
    expect(await entryCount(f.orgId, assetId, 'asset_disposal')).toBe(0);
    expect(await entryCount(f.orgId, assetId, 'depreciation')).toBe(3);
    expect(await balance(f.orgId, '1590')).toBe('15000.00');
  });

  it('(b) same setup, disposal dated 31 Mar waits, then commits and clears Jan+Feb+Mar exactly (positive control)', async () => {
    const f = await setup('b');
    const assetId = await janFebAsset(f);

    const out = await race(f, march(f, assetId), dispose(f, assetId, '2026-03-31'));

    expect(out.waited, 'the disposal did not wait for the depreciation run (no asset row lock)').toBe(true);
    expect(out.error).toBeUndefined();
    expect(out.value!.accumulated).toBe('15000.00');
    expect(out.value!.loss).toBe('105000.00');
    expect(await statusOf(assetId)).toBe('disposed');
    expect(await balance(f.orgId, '1590')).toBe('0.00');
  });

  it('(c) opposite order: disposal (28 Feb) holds open; the March run waits, then posts nothing; asset disposed, 1590 net zero', async () => {
    const f = await setup('c');
    const assetId = await janFebAsset(f);

    const out = await race(f, dispose(f, assetId, '2026-02-28'), march(f, assetId));

    expect(out.waited, 'the depreciation run did not wait for the disposal (no asset row lock)').toBe(true);
    expect(out.error).toBeUndefined();
    expect(out.value).toEqual([]);
    expect(await statusOf(assetId)).toBe('disposed');
    expect(await entryCount(f.orgId, assetId, 'depreciation')).toBe(2);
    expect(await balance(f.orgId, '1590')).toBe('0.00');
  });
});
