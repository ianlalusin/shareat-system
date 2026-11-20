import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-613 F (DEF-939, from the T-596 audit): `bookMissedMonth` on a PREPAID item takes the item row's lock BEFORE it reads the status, as the asset branch does, so a write-off
 * that commits while a catch-up month waits is seen and refused instead of booked past cost. Real PostgreSQL, TWO SEPARATE transactions; fixture and race() copied from t517-missed-month-asset-lock.test.ts.
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
import { bookMissedMonth, createPrepaidItem } from '@shareat/domain';
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
  const code = uid(`t613f-${hint}`);
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

/** 24,000 over 24 months, covering from 15 Jan 2026, nothing posted. January and February are CLOSED (legacy state), so January is a "missed month". */
async function missedJanItem(f: Fixture): Promise<string> {
  const { id } = await asPerson(f.orgId, (tx) =>
    createPrepaidItem(tx, admin(f), {
      storeId: f.storeId, name: 'Fire insurance 2026', category: 'insurance', coverageStartDate: '2026-01-15', coverageMonths: 24, totalCost: '24000.00',
    } as Parameters<typeof createPrepaidItem>[2]),
  );
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = 'replica'`;
    await tx`update fiscal_periods set status = 'closed', closed_at = now(), closed_by = ${f.adminId}
      where org_id = ${f.orgId} and starts_on = any(${['2026-01-01', '2026-02-01']}::date[])`;
  });
  return id;
}

const liveAmortisation = async (orgId: string, itemId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from journal_entries where org_id = ${orgId} and idempotency_key like ${`prepaid:${itemId}:amortisation:%`} and status = 'posted'`)[0]?.n ?? 0;

const book = (f: Fixture, itemId: string) => (tx: Tx) =>
  bookMissedMonth(tx, admin(f), { schedule: 'amortisation', subjectId: itemId, belongsToPeriod: '2026-01', reason: 'T-613 test: January was missed' });

describe('T-613 F: bookMissedMonth takes the prepaid item lock before it judges', () => {
  afterAll(async () => {
    await sql.end();
    await closeDb();
  });

  it('a write-off that commits first is seen: the catch-up month is refused, nothing is booked [kills: reading the status before the lock]', async () => {
    const f = await setup('a');
    const itemId = await missedJanItem(f);
    const out = await race(
      f,
      (tx) => tx.execute(dsql`update prepaid_items set status = 'written_off', written_off_on = '2026-03-31', write_off_reason = 'T-613 test' where id = ${itemId}`),
      book(f, itemId),
    );
    expect(out.waited, 'bookMissedMonth did not wait for the write-off that holds the item lock').toBe(true);
    expect(out.error).toMatch(/is written_off; only an active asset or item can be caught up/);
    expect(await liveAmortisation(f.orgId, itemId)).toBe(0);
  });

  it('guard: with no concurrent writer the month is booked once', async () => {
    const f = await setup('b');
    const itemId = await missedJanItem(f);
    await asPerson(f.orgId, book(f, itemId));
    expect(await liveAmortisation(f.orgId, itemId)).toBe(1);
  });
});
