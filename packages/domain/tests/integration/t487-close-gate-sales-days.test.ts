import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-487 / DEF-779 - `docs/tasks/487-close-gate-unposted-sales-days.md`.
 *  1. A month cannot close while a sales day dated in it is still `open` or `submitted` (POS-sourced or typed).
 *     `voided` and `verified` days never block.
 *  2. Verifying a day whose month is closed refuses in plain words and writes nothing; an admin's `periodOverride` posts it
 *     (one `period_overrides` row); a non-admin's override is refused; a LOCKED month refuses even with an override.
 * Real Postgres; fresh ids per test.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import { AuthorizationError } from '@shareat/auth';
import * as D from '@shareat/domain';
import { importTestDay } from './_fixtures/pos-day';
import { asOrgOn, s6Fixture, type S6F } from './_fixtures/pos-s6';
import { mkSubmitter, mkTypedDay } from './_fixtures/sales-day-flow';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const M = '2026-12';
const DAY_IN_M = '2026-12-18';
const OVERRIDE = { reason: 'data_entry_error' as const, note: 'Day was submitted late' };
const CLOSED_SENTENCE = 'December 2026 is closed. Ask an administrator to post this one entry into it.';

const userMessage = (e: unknown): string => String((e as { userMessage?: string }).userMessage ?? (e as Error).message);
const rejection = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('NOT REFUSED - the call succeeded (the defect this leg targets)');
};

// verifySalesDay's 4th parameter (the closed-month override) does not exist on HEAD; it is passed loosely so this file compiles either way.
type VerifyFn = (...a: unknown[]) => Promise<{ journalEntryId: string }>;

const posDay = async (f: S6F, date: string): Promise<string> =>
  (await asOrgOn(f.orgId, (tx) => importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: date }))).id;
const typedDay = async (f: S6F, date: string): Promise<string> => (await mkTypedDay(sql, f, [f.managerId, f.adminId], date)).id;
const submit = (f: S6F, dayId: string) => asOrgOn(f.orgId, (tx) => D.submitSalesDay(tx, f.manager, dayId));
const verify = (f: S6F, dayId: string, options?: { periodOverride?: typeof OVERRIDE }) =>
  asOrgOn(f.orgId, (tx) => (D.verifySalesDay as unknown as VerifyFn)(tx, f.admin, dayId, options));
const close = (f: S6F, period = M) => asOrgOn(f.orgId, (tx) => D.closePeriod(tx, f.admin, { period }));
const statusOf = async (dayId: string) => (await sql<{ status: string }[]>`select status from sales_days where id = ${dayId}`)[0]!.status;
const periodStatus = async (f: S6F, startsOn: string) =>
  (await sql<{ status: string }[]>`select status from fiscal_periods where org_id = ${f.orgId} and starts_on = ${startsOn}`)[0]!.status;
const entryCount = async (dayId: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where source_id = ${dayId} and source_type = 'sale'`)[0]!.n);
const overrideRows = (orgId: string) =>
  sql<{ reason: string; period_status_at_post: string }[]>`select reason, period_status_at_post from period_overrides where org_id = ${orgId}`;
const forceStatus = (f: S6F, status: 'closed' | 'locked') =>
  sql`update fiscal_periods set status = ${status}, closed_at = now(), closed_by = ${f.adminId} where org_id = ${f.orgId} and starts_on = '2026-12-01'`;

describe('T-487 R1 - closePeriod is blocked by an unposted sales day', () => {
  it('a SUBMITTED POS-sourced day dated in the month blocks the close, naming the sales day; withdrawn, it closes', async () => {
    const f = await s6Fixture(sql, 't487-pos');
    const id = await posDay(f, DAY_IN_M);
    await submit(f, id);
    const err = await rejection(close(f));
    expect(userMessage(err)).toMatch(/1 sales day/);
    expect(userMessage(err)).toMatch(/Verify or void/);
    expect(await periodStatus(f, '2026-12-01')).toBe('open');

    // (a verified POS day is held by a different gate - its usage must be pulled - so this leg clears the gate by withdrawing the day)
    await asOrgOn(f.orgId, (tx) => D.voidSalesDay(tx, f.admin, id, 'imported by mistake'));
    await close(f);
    expect(await periodStatus(f, '2026-12-01')).toBe('closed');
  });

  it('a SUBMITTED typed day blocks the close; verified, the sales-day gate no longer fires', async () => {
    const f = await s6Fixture(sql, 't487-typed-verified');
    const id = await typedDay(f, DAY_IN_M);
    await submit(f, id);
    expect(userMessage(await rejection(close(f)))).toMatch(/1 sales day/);
    expect(await periodStatus(f, '2026-12-01')).toBe('open');
    await verify(f, id);
    // (a verified day with sales is then held by the usage gate - a different, older rule - so the proof is that THIS gate stops naming it)
    const after = await rejection(close(f));
    expect(userMessage(after)).not.toMatch(/sales day/);
    expect(userMessage(after)).toMatch(/usageRecordMissing/);
  });

  it('an OPEN typed day dated in the month blocks the close; withdrawn (voided), it closes', async () => {
    const f = await s6Fixture(sql, 't487-typed');
    const id = await typedDay(f, DAY_IN_M);
    expect(await statusOf(id)).toBe('open');
    const err = await rejection(close(f));
    expect(userMessage(err)).toMatch(/1 sales day/);
    expect(await periodStatus(f, '2026-12-01')).toBe('open');

    await asOrgOn(f.orgId, (tx) => D.voidSalesDay(tx, f.admin, id, 'entered by mistake'));
    await close(f);
    expect(await periodStatus(f, '2026-12-01')).toBe('closed');
  });

  it('counts several days, and a day in ANOTHER month never blocks', async () => {
    const f = await s6Fixture(sql, 't487-count');
    await typedDay(f, '2026-12-10');
    await typedDay(f, '2026-12-11');
    await typedDay(f, '2027-01-12');
    const err = await rejection(close(f));
    expect(userMessage(err)).toMatch(/2 sales days/);
  });
});

describe('T-487 R2 - verifying a day into a closed month', () => {
  async function submittedTyped(hint: string) {
    const f = await s6Fixture(sql, `t487-${hint}`);
    const id = await typedDay(f, DAY_IN_M);
    await submit(f, id);
    return { f, id };
  }

  it('closed + no override: the plain sentence, nothing written, the day still submitted', async () => {
    const { f, id } = await submittedTyped('closed');
    await forceStatus(f, 'closed');
    const err = await rejection(verify(f, id));
    expect(userMessage(err)).toBe(CLOSED_SENTENCE);
    expect(await statusOf(id)).toBe('submitted');
    expect(await entryCount(id)).toBe(0);
  });

  it('closed + an admin override: posts, day verified, one period_overrides row', async () => {
    const { f, id } = await submittedTyped('override');
    await forceStatus(f, 'closed');
    const res = await verify(f, id, { periodOverride: OVERRIDE });
    expect(res.journalEntryId).toBeTruthy();
    expect(await statusOf(id)).toBe('verified');
    expect(await entryCount(id)).toBe(1);
    const rows = await overrideRows(f.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'data_entry_error', period_status_at_post: 'closed' });
  });

  it('closed + an override from a NON-admin: refused (capability); nothing written', async () => {
    const { f, id } = await submittedTyped('nonadmin');
    await forceStatus(f, 'closed');
    const other = await mkSubmitter(sql, f.orgId, [f.storeId], 'Second manager');
    // the day is on the typed day's own store; give the verifying manager scope there
    const [d] = await sql<{ store_id: string }[]>`select store_id from sales_days where id = ${id}`;
    await sql`insert into person_store_scope (person_id, store_id) values (${other.personId}, ${d!.store_id}) on conflict do nothing`;
    const err = await rejection(asOrgOn(f.orgId, (tx) => (D.verifySalesDay as unknown as VerifyFn)(tx, other, id, { periodOverride: OVERRIDE })));
    expect(err).toBeInstanceOf(AuthorizationError);
    expect(await statusOf(id)).toBe('submitted');
    expect(await entryCount(id)).toBe(0);
    expect(await overrideRows(f.orgId)).toHaveLength(0);
  });

  it('LOCKED month: refused with the locked sentence even with an override', async () => {
    const { f, id } = await submittedTyped('locked');
    await forceStatus(f, 'locked');
    const err = await rejection(verify(f, id, { periodOverride: OVERRIDE }));
    expect(userMessage(err)).toMatch(/December 2026 is locked/);
    expect(await statusOf(id)).toBe('submitted');
    expect(await entryCount(id)).toBe(0);
  });

  it('an OPEN month with an override given leaves no audit row (the override is ignored)', async () => {
    const { f, id } = await submittedTyped('openignored');
    await verify(f, id, { periodOverride: OVERRIDE });
    expect(await statusOf(id)).toBe('verified');
    expect(await overrideRows(f.orgId)).toHaveLength(0);
  });
});
