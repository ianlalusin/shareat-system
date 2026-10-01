import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-369 S7 (DEF-479; Ian Q1, row 260) — "voiding frees the date, but only a MANAGER may re-enter it, never staff".
 * `docs/tasks/369-unwired-money-screens.md` §S7 and the ruling-log line of 2026-10-01 (S3 RED).
 *
 *   void a day (unverified: withdrawn; or verified: reversed) -> `createSalesDay` for the SAME store/date:
 *     - a MANAGER succeeds, as a NEW day (a new id; the old one stays voided);
 *     - STAFF is refused, with a written sentence (no id) — and the refusal writes nothing.
 *
 * ⛔ TESTER, not BUILDER. The DB half (the unique index no longer counts voided rows) is
 * `packages/db/tests/integration/t369-s7-migration.test.ts`. The spec does not say WHICH error staff get; this
 * file requires a written sentence (`userMessage`, no uuid) and does not care whether it is an
 * AuthorizationError or a refuse(). Fixture is `t369-s3-sales-day-edit-void.test.ts`'s.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, salesDaysRepo, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import * as D from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DATE = '2026-01-10';

afterAll(async () => {
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
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`t369s7-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('lipa')}, 'Lipa') returning id`;
  const storeId = store!.id;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const staffId = await mk('Staff', 'staff');
  const managerId = await mk('Manager', 'manager');
  const [channel] = await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${storeId}, 'Walk-in', true) returning id`;
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: emp!.id, personId: staffId, setBy: managerId });
  return { orgId, storeId, channelId: channel!.id, staff: actor(orgId, staffId), manager: actor(orgId, managerId) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const figures = (f: Fixture) => ({
  totalSales: '1000.00', unliSales: '1000.00', alaCarteSales: '0.00', cashCollected: '1000.00', channels: [{ channelId: f.channelId, amount: '1000.00' }],
});
const create = (f: Fixture, who: Actor, date = DATE) => asOrg(f.orgId, (tx) => D.createSalesDay(tx, who, { storeId: f.storeId, businessDate: date, ...figures(f) }));
const withdraw = (f: Fixture, id: string) => asOrg(f.orgId, (tx) => D.voidSalesDay(tx, f.manager, id, 'Typed wrong'));
const rowsOn = (f: Fixture, date = DATE) => sql<{ id: string; status: string }[]>`select id, status from sales_days where org_id = ${f.orgId} and store_id = ${f.storeId} and business_date = ${date} order by created_at`;

async function rejection(p: Promise<unknown>, what: string): Promise<{ message: string; userMessage?: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; userMessage?: string };
    return { message: String(e.message ?? err), userMessage: e.userMessage };
  }
  throw new Error(`NOT REFUSED — ${what} succeeded instead (the defect this leg targets)`);
}

describe('S7 — void, then create the same date', () => {
  for (const kind of ['an UNVERIFIED day (withdrawn)', 'a VERIFIED day (reversed)'] as const) {
    it(`${kind}: a MANAGER creates the date again as a NEW day; the old day stays voided; the date holds one live day`, async () => {
      const f = await fixture(`mgr-${kind.startsWith('an UN') ? 'unv' : 'ver'}`);
      const { id: first } = await create(f, f.staff);
      if (kind.includes('VERIFIED')) await asOrg(f.orgId, (tx) => D.verifySalesDay(tx, f.manager, first));
      await withdraw(f, first);

      const { id: second } = await create(f, f.manager);
      expect(second).not.toBe(first);
      const rows = await rowsOn(f);
      expect(rows.map((r) => r.status).sort()).toEqual(['open', 'voided']);
      expect(rows.find((r) => r.id === first)!.status).toBe('voided');
      expect(rows.find((r) => r.id === second)!.status).toBe('open');
    });
  }

  it('STAFF is refused re-entering a voided date, with a written sentence (no id); nothing is written — positive control: the manager (above) and staff on a FRESH date', async () => {
    const f = await fixture('staff');
    const { id: first } = await create(f, f.staff);
    await withdraw(f, first);

    const refused = await rejection(create(f, f.staff), 'staff re-entering a withdrawn date');
    expect(refused.userMessage, `raw text leaked: ${refused.message}`).toBeTruthy();
    expect(refused.userMessage ?? '').not.toMatch(UUID);
    expect((await rowsOn(f)).map((r) => r.status), 'the refused create left a row behind').toEqual(['voided']);

    // Staff are not locked out of the store: a date nobody voided is theirs to create.
    const fresh = await create(f, f.staff, '2026-01-11');
    expect(fresh.id).toBeTruthy();
  });

  it('the rule is about the DATE, not the person who voided it: staff are refused even when the voided day was THEIR OWN', async () => {
    const f = await fixture('own');
    const { id } = await create(f, f.staff); // the staff member entered it
    await withdraw(f, id);
    const refused = await rejection(create(f, f.staff), "staff re-entering their own withdrawn day's date");
    expect(refused.userMessage).toBeTruthy();
  });

  it('while a LIVE day exists the date is taken again: a second create (manager OR staff) is refused as "already has a sales day"', async () => {
    const f = await fixture('live');
    const { id } = await create(f, f.staff);
    await withdraw(f, id);
    await create(f, f.manager); // the manager's re-entry is live now

    for (const who of [f.manager, f.staff]) {
      const refused = await rejection(create(f, who), 'a third day for a date that already has a live one');
      expect(refused.userMessage, `raw text leaked: ${refused.message}`).toMatch(/already has a sales day/);
    }
    expect((await rowsOn(f)).filter((r) => r.status !== 'voided')).toHaveLength(1);
  });

  it('findByBusinessDate returns the LIVE day, never the voided one (the lookup the create path and the screens use)', async () => {
    const f = await fixture('lookup');
    const { id: first } = await create(f, f.staff);
    await withdraw(f, first);
    const gone = await asOrg(f.orgId, (tx) => salesDaysRepo.findByBusinessDate(tx, f.orgId, f.storeId, DATE));
    expect(gone, 'a voided day is returned as the date\'s day').toBeUndefined();

    const { id: second } = await create(f, f.manager);
    const live = await asOrg(f.orgId, (tx) => salesDaysRepo.findByBusinessDate(tx, f.orgId, f.storeId, DATE));
    expect(live?.id).toBe(second);
  });

  it('the re-entered day is a normal day: it can be edited, submitted and verified, and posts exactly one entry for ITSELF', async () => {
    const f = await fixture('flow');
    const { id: first } = await create(f, f.staff);
    await withdraw(f, first);
    const { id: second } = await create(f, f.manager);
    await asOrg(f.orgId, (tx) => D.submitSalesDay(tx, f.manager, second));
    const posted = await asOrg(f.orgId, (tx) => D.verifySalesDay(tx, f.manager, second));
    expect(posted.created).toBe(true);
    const [e] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${f.orgId} and source_id = ${second}`;
    expect(Number(e!.n)).toBe(1);
    const [old] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${f.orgId} and source_id = ${first}`;
    expect(Number(old!.n), 'the withdrawn day never posted').toBe(0);
  });
});
