import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-517 (audit sweep after T-515/T-516): `bookMissedMonth` takes the asset row's lock (FOR UPDATE) as its FIRST read, so
 * it judges status and schedule on what a concurrent dispose / retire / terms change committed. Real PostgreSQL, TWO
 * SEPARATE transactions on two pooled connections; the first is held open by a deferred promise. Fixture and race()
 * helper copied from t516-asset-lock-retire-and-in-service.test.ts.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
}
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { bookMissedMonth, createAsset, disposeAsset } from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

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
  managerId: string;
  staffId: string;
}

/** `openingDate` is the store's opening date; a date AFTER an asset's acquisition makes it a `store_opening` follower. */
async function setup(hint: string, openingDate = '2020-01-01'): Promise<Fixture> {
  const code = uid(`t517-${hint}`);
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
    insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, ${openingDate}) returning id
  `;
  const storeId = store!.id;
  const mkPerson = async (name: string, role: string) => {
    const [r] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id
    `;
    await sql`insert into person_roles (person_id, org_id, role) values (${r!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${r!.id}, ${storeId})`;
    return r!.id;
  };
  const staffId = await mkPerson(`${hint} Staff`, 'staff');
  const managerId = await mkPerson(`${hint} Manager`, 'manager');
  const adminId = await mkPerson(`${hint} Admin`, 'admin');
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01')
    returning id
  `;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: employment!.id, personId: staffId, setBy: adminId });
  return { orgId, storeId, adminId, managerId, staffId };
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
    // a refusal carries the person's sentence in userMessage ("What this would reverse has changed..."); message is the raw one
    (e: Error & { userMessage?: string }) => ({ error: e.userMessage ?? e.message }) as { value?: TB; error?: string },
  );
  void b.then(() => (done = true));
  await sleep(PAUSE_MS);
  const waited = !done;
  release();
  await a;
  return { waited, ...(await b) };
}

const admin = (f: Fixture): Actor => ({ personId: f.adminId, orgId: f.orgId });

/** 120,000 over 24 months, no salvage: 5,000 a month. Acquired 15 Jan 2026, nothing posted. January and February
 *  are then CLOSED (as legacy state, the way t381 does) so each is a "missed month"; March onward stays open. */
async function missedJanAsset(f: Fixture): Promise<string> {
  const { id } = await asPerson(f.orgId, (tx) =>
    createAsset(tx, admin(f), {
      storeId: f.storeId,
      name: 'Chest freezer',
      category: 'appliances',
      acquiredOn: '2026-01-15',
      cost: '120000.00',
      usefulLifeMonths: 24,
    } as Parameters<typeof createAsset>[2]),
  );
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = 'replica'`;
    await tx`update fiscal_periods set status = 'closed', closed_at = now(), closed_by = ${f.adminId}
      where org_id = ${f.orgId} and starts_on = any(${['2026-01-01', '2026-02-01']}::date[])`;
  });
  return id;
}

async function liveDepreciation(orgId: string, assetId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from journal_entries
    where org_id = ${orgId} and source_id = ${assetId} and source_type = 'depreciation' and status = 'posted'
      and reversal_of_entry_id is null`;
  return rows[0]?.n ?? 0;
}

async function statusOf(assetId: string): Promise<string> {
  const rows = await sql<{ status: string }[]>`select status from fixed_assets where id = ${assetId}`;
  return rows[0]!.status;
}

const book = (f: Fixture, assetId: string) => (tx: Tx) =>
  bookMissedMonth(tx, admin(f), {
    schedule: 'depreciation',
    subjectId: assetId,
    belongsToPeriod: '2026-01',
    reason: 'T-517 test: January was missed',
  });

describe('T-517: bookMissedMonth takes the asset row lock before it judges', () => {
  afterAll(async () => {
    await sql.end();
    await closeDb();
  });

  it('(a) a disposal that commits first is seen: no depreciation is booked on a disposed asset', async () => {
    const f = await setup('a');
    const assetId = await missedJanAsset(f);

    const out = await race(
      f,
      (tx) => disposeAsset(tx, admin(f), { assetId, disposedOn: '2026-03-31', reason: 'T-517 test' }),
      book(f, assetId),
    );

    expect(out.waited, 'bookMissedMonth did not wait for the disposal that holds the asset lock').toBe(true);
    expect(out.error).toMatch(/is disposed; only an active asset or item can be caught up/);
    expect(await statusOf(assetId)).toBe('disposed');
    expect(await liveDepreciation(f.orgId, assetId)).toBe(0);
  });

  it('(b) guard: with no concurrent writer the month is booked once', async () => {
    const f = await setup('b');
    const assetId = await missedJanAsset(f);

    const out = await asPerson(f.orgId, book(f, assetId));

    expect(out.amount).toBe('5000.00');
    expect(await liveDepreciation(f.orgId, assetId)).toBe(1);
    expect(await statusOf(assetId)).toBe('active');
  });
});
