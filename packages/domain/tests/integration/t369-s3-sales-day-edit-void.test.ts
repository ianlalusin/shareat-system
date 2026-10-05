import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-369 S3 (DEF-479) — edit or withdraw an unverified sales day. `docs/tasks/369-unwired-money-screens.md`
 * §S3, tests T1–T8, T10, T11 (T9, the web leg, is `apps/erp/tests/integration/t369-s3-sales-day-web.test.ts`).
 *
 * ⛔ TESTER, not BUILDER. Every red leg asserts the TARGET behaviour of the approved contract.
 *
 *   editSalesDay(tx, actor, { salesDayId, totalSales, unliSales, alaCarteSales, …the other create figures,
 *                             channels?, tenders? })      — never the store or the date (R1)
 *   voidSalesDay(tx, actor, salesDayId, reason)           — now also accepts open / submitted (R3)
 *
 * `editSalesDay` is reached as `D.editSalesDay` through a namespace import, so "not exported" reads as
 * that sentence and not as a TypeError. Fixture is `sales-days.test.ts`'s (`setup`, two channels at
 * Lipa, staff with the everyday grant, manager, admin); the gated two-connection harness is
 * `t366-s1-cash-custody-locks.test.ts`'s.
 *
 * ## Q1 (Ian, row 260): "voiding frees the date, but only a manager may re-enter it, never staff"
 * That ruling is S7's, not S3's: S3 does not touch the unique index or `createSalesDay`'s own
 * existing-day check (R1: the date is what those key on). What S3 pins is the half that IS here:
 * the create-BLOCK lifts when an unverified day is withdrawn (T5). S7's tests (void -> create the same
 * date -> succeeds as a manager, refused for staff) belong with the migration.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import * as D from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

const sql = postgres(url, { max: 10 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

// -----------------------------------------------------------------------------------------------
// Concurrency harness (verbatim shape from t366-s1-cash-custody-locks.test.ts)
// -----------------------------------------------------------------------------------------------

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
function trackPid<T>(op: (tx: Tx) => Promise<T>): { op: (tx: Tx) => Promise<T>; pid: Promise<number> } {
  const pid = deferred<number>();
  return {
    pid: pid.promise,
    op: async (tx) => {
      const rows = await tx.execute(dsql`select pg_backend_pid() as pid`);
      pid.resolve(Number((rows as unknown as { pid: number }[])[0]?.pid));
      return op(tx);
    },
  };
}
async function pollForWaitingBackend(
  bPid: Promise<number>,
  waitEvents: string[],
  settleWatch: Promise<unknown>,
  timeoutMs = 5000,
): Promise<{ pid: number; query: string } | null> {
  const settled = settleWatch.then(() => true).catch(() => true);
  const poll = (async (): Promise<{ pid: number; query: string } | null> => {
    const pid = await Promise.race([bPid, settled.then(() => 0)]);
    if (!pid) return null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await sql<{ pid: number; query: string }[]>`
        select pid, query from pg_stat_activity
        where datname = current_database() and pid = ${pid}
          and wait_event_type = 'Lock' and wait_event = any(${waitEvents})`;
      if (rows[0]) return rows[0];
      await new Promise((r) => setTimeout(r, 20));
    }
    return null;
  })();
  return Promise.race([poll, settled.then(() => null)]);
}
type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };
async function runConcurrencyLeg<TA, TB>(
  orgId: string,
  opA: (tx: Tx) => Promise<TA>,
  opB: (tx: Tx) => Promise<TB>,
  waitEvents: string[],
): Promise<{ aResult: Settled<TA>; bResult: Settled<TB>; bWaited: boolean }> {
  const aReady = deferred<void>();
  const gate = deferred<void>();
  const aPromise: Promise<Settled<TA>> = asOrg(orgId, async (tx) => {
    try {
      const value = await opA(tx);
      aReady.resolve();
      await gate.promise;
      return value;
    } catch (err) {
      aReady.resolve();
      throw err;
    }
  }).then(
    (value) => ({ status: 'fulfilled', value }) as const,
    (reason) => ({ status: 'rejected', reason }) as const,
  );
  await aReady.promise;
  const trackedB = trackPid(opB);
  const bPromise: Promise<Settled<TB>> = asOrg(orgId, trackedB.op).then(
    (value) => ({ status: 'fulfilled', value }) as const,
    (reason) => ({ status: 'rejected', reason }) as const,
  );
  const waiting = await pollForWaitingBackend(trackedB.pid, waitEvents, bPromise, 5000);
  gate.resolve();
  const [aResult, bResult] = await Promise.all([aPromise, bPromise]);
  return { aResult, bResult, bWaited: !!waiting };
}
const ROW_LOCK = ['transactionid', 'tuple'];

// -----------------------------------------------------------------------------------------------
// Fixture (sales-days.test.ts's `setup`): Lipa with Walk-in (remitted daily) and Foodpanda (1220)
// channels; staff (everyday grant), manager, admin; January 2026 open; a SECOND store with a channel.
// -----------------------------------------------------------------------------------------------

async function fixture(hint: string) {
  const code = uid(`t369s3-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const mkStore = async (h: string) => (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(h)}, ${`Store ${h}`}) returning id`)[0]!.id;
  const storeId = await mkStore(`${hint}-lipa`);
  const storeId2 = await mkStore(`${hint}-malvar`);
  const mkPerson = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const staffId = await mkPerson('Staff', 'staff');
  const managerId = await mkPerson('Manager', 'manager');
  const adminId = await mkPerson('Admin', 'admin');
  const mkChannel = async (store: string, name: string, remitted: boolean, receivable: string | null) =>
    (await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
      values (${orgId}, ${store}, ${name}, ${remitted}, ${receivable}) returning id`)[0]!.id;
  const walkIn = await mkChannel(storeId, 'Walk-in', true, null);
  const foodpanda = await mkChannel(storeId, 'Foodpanda', false, '1220');
  const otherStoreChannel = await mkChannel(storeId2, 'Malvar Walk-in', true, null);
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: emp!.id, personId: staffId, setBy: managerId });
  return {
    orgId, storeId, storeId2, walkIn, foodpanda, otherStoreChannel, staffId, managerId, adminId,
    staff: actor(orgId, staffId), manager: actor(orgId, managerId), admin: actor(orgId, adminId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const D1 = '2026-01-10';
const D2 = '2026-01-11';

/** The figures every day here shares: ₱1,000, all unli, all cash. `walkIn` is what the channel claims. */
function figures(f: Fixture, walkIn: string, extra: Record<string, unknown> = {}) {
  return {
    totalSales: '1000.00', unliSales: '1000.00', alaCarteSales: '0.00', cashCollected: '1000.00',
    channels: [{ channelId: f.walkIn, amount: walkIn }],
    ...extra,
  };
}
async function mkDay(f: Fixture, date: string, walkIn: string, opts: { submit?: boolean; by?: Actor } = {}): Promise<string> {
  const { id } = await asOrg(f.orgId, (tx) => D.createSalesDay(tx, opts.by ?? f.staff, { storeId: f.storeId, businessDate: date, ...figures(f, walkIn) }));
  if (opts.submit) await asOrg(f.orgId, (tx) => D.submitSalesDay(tx, opts.by ?? f.staff, id));
  return id;
}
/** The "Lipa shape": ₱1,000 of sales, the channel claims only ₱500. */
const lipaShapeDay = (f: Fixture, opts: { submit?: boolean } = {}) => mkDay(f, D1, '500.00', opts);

function editFn() {
  const fn = (D as unknown as { editSalesDay?: (tx: Tx, a: Actor, i: Record<string, unknown>) => Promise<unknown> }).editSalesDay;
  if (typeof fn !== 'function') throw new Error('editSalesDay is not exported from @shareat/domain (the defect this leg targets)');
  return fn;
}
const edit = (f: Fixture, who: Actor, salesDayId: string, input: Record<string, unknown>) =>
  asOrg(f.orgId, (tx) => editFn()(tx, who, { salesDayId, ...input }));
const editOp = (who: Actor, salesDayId: string, input: Record<string, unknown>) => (tx: Tx) => editFn()(tx, who, { salesDayId, ...input });
const verify = (f: Fixture, id: string, who: Actor = f.manager) => asOrg(f.orgId, (tx) => D.verifySalesDay(tx, who, id));
const withdraw = (f: Fixture, who: Actor, id: string, reason = 'Typed wrong') => asOrg(f.orgId, (tx) => D.voidSalesDay(tx, who, id, reason));

async function rejection(p: Promise<unknown>, what: string): Promise<{ message: string; userMessage?: string; err: unknown }> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; userMessage?: string };
    return { message: String(e.message ?? err), userMessage: e.userMessage, err };
  }
  throw new Error(`NOT REFUSED — ${what} succeeded instead (the defect this leg targets)`);
}

async function dayRow(id: string) {
  const [r] = await sql<{ status: string; total_sales: string; business_date: string; store_id: string; void_reason: string | null; voided_by: string | null; updated_at: Date | null; journal_entry_id: string | null }[]>`
    select status, total_sales::text, business_date::text, store_id, void_reason, voided_by, updated_at, journal_entry_id from sales_days where id = ${id}`;
  return r!;
}
async function channelAmounts(id: string): Promise<Record<string, string>> {
  const rows = await sql<{ channel_id: string; amount: string }[]>`select channel_id, amount::text from sales_day_channels where sales_day_id = ${id}`;
  return Object.fromEntries(rows.map((r) => [r.channel_id, r.amount]));
}
async function journalCount(orgId: string, sourceId: string): Promise<number> {
  return Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId} and source_id = ${sourceId}`)[0]!.n);
}

// -----------------------------------------------------------------------------------------------
// T1 — the Lipa shape: verify refused, edit the channel, verify posts
// -----------------------------------------------------------------------------------------------

describe('T1 — a ₱1,000 day whose channel claims ₱500', () => {
  it("verify is refused (\"can't be posted yet\"); edit the channel to 1,000; verify then posts exactly one entry", async () => {
    const f = await fixture('t1');
    const id = await lipaShapeDay(f);

    const refused = await rejection(verify(f, id), 'verifying a day whose channels allocate 500 of 1,000');
    expect(refused.userMessage ?? refused.message).toMatch(/can't be posted yet|cannot post/);
    expect(await journalCount(f.orgId, id)).toBe(0);

    await edit(f, f.manager, id, figures(f, '1000.00'));
    expect(await channelAmounts(id)).toEqual({ [f.walkIn]: '1000.00' });

    const posted = await verify(f, id);
    expect(posted.created).toBe(true);
    expect(await journalCount(f.orgId, id)).toBe(1);
    expect((await dayRow(id)).status).toBe('verified');
  });
});

// -----------------------------------------------------------------------------------------------
// T2 / T3 — status kept; who may edit which status
// -----------------------------------------------------------------------------------------------

describe('T2 — edit keeps the status and moves updated_at', () => {
  it('open stays open and submitted stays submitted; updated_at moves; the date and store never change (R1)', async () => {
    const f = await fixture('t2');
    // The NEWER day first: creating it after an unverified older one would trip the create-block.
    const submittedId = await mkDay(f, D2, '500.00', { submit: true });
    const openId = await mkDay(f, D1, '500.00');

    for (const id of [openId, submittedId]) {
      const before = await dayRow(id); // a never-edited day has updated_at NULL (insertSalesDay does not set it)
      const startedAt = (await sql<{ t: Date }[]>`select now() as t`)[0]!.t;
      await edit(f, f.manager, id, { ...figures(f, '1000.00'), businessDate: '2026-01-25', storeId: f.storeId2 }); // must be ignored (R1)
      const after = await dayRow(id);
      expect(after.status, 'status is unchanged by an edit (R4)').toBe(before.status);
      expect(after.updated_at, 'an edit stamps updated_at').not.toBeNull();
      expect(after.updated_at!.getTime(), 'updated_at is at or after the moment just before the edit').toBeGreaterThanOrEqual(startedAt.getTime());
      if (before.updated_at) expect(after.updated_at!.getTime(), 'and it moved').toBeGreaterThan(before.updated_at.getTime());
      expect(after.business_date, 'the date is never edited').toBe(before.business_date);
      expect(after.store_id, 'the store is never edited').toBe(before.store_id);
      expect(await channelAmounts(id)).toEqual({ [f.walkIn]: '1000.00' });
    }
  });
});

describe("T3 (✗) — staff cannot edit a SUBMITTED day (it is the verifier's); staff may edit an OPEN one", () => {
  it('staff edits a submitted day -> AuthorizationError, figures unchanged; the manager edits it (control)', async () => {
    const f = await fixture('t3');
    const id = await mkDay(f, D1, '500.00', { submit: true });

    const refused = await rejection(
      edit(f, f.staff, id, figures(f, '1000.00', { totalSales: '2000.00', unliSales: '2000.00', cashCollected: '2000.00' })),
      'a staff edit of a submitted day',
    );
    expect(refused.err).toBeInstanceOf(AuthorizationError);
    expect((await dayRow(id)).total_sales).toBe('1000.00');
    expect(await channelAmounts(id)).toEqual({ [f.walkIn]: '500.00' });

    await edit(f, f.manager, id, figures(f, '1000.00'));
    expect(await channelAmounts(id)).toEqual({ [f.walkIn]: '1000.00' });
  });

  it('control: staff edits their own OPEN day (submit_sales_day is enough)', async () => {
    const f = await fixture('t3open');
    const id = await mkDay(f, D1, '500.00');
    await edit(f, f.staff, id, figures(f, '1000.00'));
    expect(await channelAmounts(id)).toEqual({ [f.walkIn]: '1000.00' });
  });
});

// -----------------------------------------------------------------------------------------------
// T4 — a verified day cannot be edited
// -----------------------------------------------------------------------------------------------

describe('T4 — edit a VERIFIED day', () => {
  it('refused "Only an unverified sales day can be edited — this one is verified."; the journal and the figures are untouched', async () => {
    const f = await fixture('t4');
    const id = await mkDay(f, D1, '1000.00');
    await verify(f, id);
    const entries = await journalCount(f.orgId, id);

    const refused = await rejection(
      edit(f, f.manager, id, figures(f, '1000.00', { totalSales: '5000.00', unliSales: '5000.00', cashCollected: '5000.00' })),
      'an edit of a verified day',
    );
    expect(refused.userMessage).toBe('Only an unverified sales day can be edited — this one is verified.');
    expect(await journalCount(f.orgId, id)).toBe(entries);
    expect((await dayRow(id)).total_sales).toBe('1000.00');
  });
});

// -----------------------------------------------------------------------------------------------
// T5 / T6 / T7 — withdraw
// -----------------------------------------------------------------------------------------------

describe('T5 — withdraw an OPEN day', () => {
  it('manager voids it: status voided, reason stored, ZERO journal entries; staff was blocked from the newer day before, and can create it now (the block lifts)', async () => {
    const f = await fixture('t5');
    const older = await mkDay(f, D1, '500.00'); // never verified -> blocks newer days for staff

    // Positive control for the block itself: before the withdraw, it is a SalesDayBlockedError.
    const blocked = await rejection(
      asOrg(f.orgId, (tx) => D.createSalesDay(tx, f.staff, { storeId: f.storeId, businessDate: D2, ...figures(f, '1000.00') })),
      'staff creating a newer day over an unverified older one',
    );
    expect(blocked.err).toBeInstanceOf(D.SalesDayBlockedError);

    await withdraw(f, f.manager, older, 'Typed on the wrong store');
    const row = await dayRow(older);
    expect(row.status).toBe('voided');
    expect(row.void_reason).toBe('Typed on the wrong store');
    expect(row.voided_by).toBe(f.managerId);
    expect(await journalCount(f.orgId, older), 'withdrawing an unverified day writes no entry').toBe(0);

    const { id: newer } = await asOrg(f.orgId, (tx) => D.createSalesDay(tx, f.staff, { storeId: f.storeId, businessDate: D2, ...figures(f, '1000.00') }));
    expect((await dayRow(newer)).status).toBe('open');
  });

  it('a blank reason is refused; a submitted day can be withdrawn too; withdrawing twice says "already voided"', async () => {
    const f = await fixture('t5b');
    const id = await mkDay(f, D1, '500.00', { submit: true });
    const noReason = await rejection(withdraw(f, f.manager, id, '   '), 'a withdraw with no reason');
    expect(noReason.userMessage).toBe('Reason is required and cannot be empty or whitespace-only.');
    expect((await dayRow(id)).status).toBe('submitted');

    await withdraw(f, f.manager, id, 'Wrong day');
    expect((await dayRow(id)).status).toBe('voided');
    const twice = await rejection(withdraw(f, f.manager, id, 'Again'), 'a second withdraw');
    expect(twice.userMessage).toBe('This sales day is already voided.');
  });
});

describe('T6 (✗) — staff cannot withdraw', () => {
  it('AuthorizationError; the day stays open — control: the manager withdraws it (T5)', async () => {
    const f = await fixture('t6');
    const id = await mkDay(f, D1, '500.00');
    const refused = await rejection(withdraw(f, f.staff, id), 'a staff withdraw');
    expect(refused.err).toBeInstanceOf(AuthorizationError);
    expect((await dayRow(id)).status).toBe('open');
    await withdraw(f, f.manager, id);
    expect((await dayRow(id)).status).toBe('voided');
  });
});

describe('T7 — voiding a VERIFIED day is unchanged', () => {
  it('one reversal of the posting; status voided; the original entry is reversed', async () => {
    const f = await fixture('t7');
    const id = await mkDay(f, D1, '1000.00');
    const posted = await verify(f, id);
    const result = await withdraw(f, f.manager, id, 'Double entry');
    expect(result.reversalEntryId).toBeTruthy();
    const [orig] = await sql<{ status: string }[]>`select status from journal_entries where id = ${posted.journalEntryId}`;
    expect(orig!.status).toBe('reversed');
    const [rev] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where reversal_of_entry_id = ${posted.journalEntryId}`;
    expect(Number(rev!.n)).toBe(1);
    expect((await dayRow(id)).status).toBe('voided');
  });
});

// -----------------------------------------------------------------------------------------------
// T8 — all-or-nothing
// -----------------------------------------------------------------------------------------------

describe("T8 — an edit naming another store's channel changes nothing", () => {
  it('refused with the channel sentence (no id); the header figure and the channels are exactly as they were — Mutant: write the header before validating channels -> total 2,000, red', async () => {
    const f = await fixture('t8');
    const id = await mkDay(f, D1, '500.00');

    const refused = await rejection(
      edit(f, f.manager, id, {
        totalSales: '2000.00', unliSales: '2000.00', alaCarteSales: '0.00', cashCollected: '2000.00',
        channels: [{ channelId: f.otherStoreChannel, amount: '2000.00' }],
      }),
      "an edit that names another store's channel",
    );
    expect(refused.userMessage).toBe("One of the sales channels on this day isn't set up for this store. Reload the page and try again.");
    expect(refused.userMessage).not.toMatch(UUID);
    expect((await dayRow(id)).total_sales, 'the header was written before the channel check').toBe('1000.00');
    expect(await channelAmounts(id)).toEqual({ [f.walkIn]: '500.00' });
  });
});

// -----------------------------------------------------------------------------------------------
// T10 — edit and verify serialise on the day row (R5)
// -----------------------------------------------------------------------------------------------

describe('T10 (R5) — edit vs verify', () => {
  it("A holds an edit open (channel 500 -> 1,000, uncommitted); B verifies -> B waits on a row lock, then POSTS from A's committed figures — Mutant: plain getById in verify -> B never waits / is refused on stale figures", async () => {
    const f = await fixture('t10a');
    const id = await lipaShapeDay(f); // stale figures cannot post; edited figures can

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      editOp(f.manager, id, figures(f, '1000.00')),
      (tx) => D.verifySalesDay(tx, f.manager, id),
      ROW_LOCK,
    );

    expect(aResult.status, `the edit itself: ${aResult.status === 'rejected' ? String((aResult.reason as Error).message) : ''}`).toBe('fulfilled');
    expect(bWaited, 'B never waited: verify does not lock the day row').toBe(true);
    expect(bResult.status, `verify must see A's committed figures: ${bResult.status === 'rejected' ? String((bResult.reason as Error).message) : ''}`).toBe('fulfilled');
    expect(await journalCount(f.orgId, id)).toBe(1);
  });

  it('reverse order: A verifies (holds), B edits -> B waits, then is refused ("this one is verified"); the figures stay verified', async () => {
    const f = await fixture('t10b');
    const id = await mkDay(f, D1, '1000.00'); // balanced: it can post

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => D.verifySalesDay(tx, f.manager, id),
      editOp(f.manager, id, figures(f, '1000.00', { totalSales: '9000.00', unliSales: '9000.00', cashCollected: '9000.00' })),
      ROW_LOCK,
    );

    expect(aResult.status).toBe('fulfilled');
    expect(bWaited, 'B never waited: edit does not lock the day row').toBe(true);
    expect(bResult.status, 'an edit after the verify committed must be refused').toBe('rejected');
    expect(String((bResult as { reason: { userMessage?: string } }).reason.userMessage)).toBe('Only an unverified sales day can be edited — this one is verified.');
    expect((await dayRow(id)).total_sales).toBe('1000.00');
  });
});

// -----------------------------------------------------------------------------------------------
// T11 (R3) — withdraw is refused while something else hangs off the day
// -----------------------------------------------------------------------------------------------

async function stockRoom(f: Fixture): Promise<string> {
  const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${f.orgId}, 'STK', 'Stockroom') returning id`;
  const [loc] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${f.orgId}, ${f.storeId}, 'KIT', 'Kitchen', ${type!.id}, 'operating', true, ${f.managerId}) returning id`;
  return loc!.id;
}
const addPull = async (f: Fixture, dayId: string, status: string) =>
  sql`insert into pos_usage_pulls (org_id, store_id, sales_day_id, location_id, snapshot_taken_at, status, finalized_at, finalized_by,
                                   voided_at, voided_by, void_reason)
      values (${f.orgId}, ${f.storeId}, ${dayId}, ${await stockRoom(f)}, now(), ${status},
              ${status === 'finalized' ? new Date() : null}, ${status === 'finalized' ? f.managerId : null},
              ${status === 'void' ? new Date() : null}, ${status === 'void' ? f.managerId : null},
              ${status === 'void' ? 'fixture: voided pull' : null})`; // T-374 S7 (0181): a void pull records who, when, why
const addWastage = async (f: Fixture, dayId: string) =>
  sql`insert into order_wastages (org_id, store_id, sales_day_id, channel, channel_id, type_mode, amount, reason, created_by)
      values (${f.orgId}, ${f.storeId}, ${dayId}, 'Foodpanda', ${f.foodpanda}, 'instant', '50.00', 'spoiled in transit', ${f.managerId})`;
const addRemittance = async (f: Fixture, date: string, status: 'posted' | 'reversed') => {
  const [r] = await sql<{ id: string }[]>`
    insert into remittances (org_id, store_id, remitted_on, created_by, status, reversed_on, reverse_reason)
    values (${f.orgId}, ${f.storeId}, ${date}, ${f.managerId}, ${status}, ${status === 'reversed' ? date : null}, ${status === 'reversed' ? 'fixture reversal' : null}) returning id`;
  await sql`insert into remittance_allocations (remittance_id, amount, business_date) values (${r!.id}, '500.00', ${date})`;
};

describe('T11 (R3) — withdraw refused while a dependent hangs off the day; the day stays open', () => {
  const cases: { name: string; arrange: (f: Fixture, id: string) => Promise<unknown>; sentence: string; control: (f: Fixture, id: string) => Promise<unknown>; controlName: string }[] = [
    {
      name: '(i) a live POS usage pull',
      arrange: (f, id) => addPull(f, id, 'planned'),
      sentence: 'This day has a POS usage pull. Void it first under Inventory › POS usage.', // T-374 S7: the void now exists
      controlName: 'a VOID pull does not block',
      control: (f, id) => addPull(f, id, 'void'),
    },
    {
      name: '(ii) an order_wastages row',
      arrange: (f, id) => addWastage(f, id),
      sentence: "Wastage is recorded against this day, so it can't be withdrawn. Edit its figures instead.", // T-375 S4 (V13): typed day, unlinked store
      controlName: 'no dependent: the withdraw succeeds',
      control: async () => undefined,
    },
    {
      name: '(iii) a POSTED remittance allocation on its date',
      arrange: (f) => addRemittance(f, D1, 'posted'),
      sentence: 'Cash handed over has been counted against this day. Reverse that handover first.',
      controlName: 'a REVERSED remittance does not block',
      control: (f) => addRemittance(f, D1, 'reversed'),
    },
  ];

  cases.forEach((c, i) => {
    it(`${c.name} -> refused with its sentence, nothing written, day stays open; positive control: ${c.controlName}`, async () => {
      const f = await fixture(`t11-${i}`);
      const blocked = await mkDay(f, D1, '500.00');
      await c.arrange(f, blocked);
      const refused = await rejection(withdraw(f, f.manager, blocked), `a withdraw of a day with ${c.name}`);
      expect(refused.userMessage).toBe(c.sentence);
      expect(refused.userMessage).not.toMatch(UUID);
      expect((await dayRow(blocked)).status).toBe('open');
      expect(await journalCount(f.orgId, blocked)).toBe(0);

      const g = await fixture(`t11c-${i}`);
      const free = await mkDay(g, D1, '500.00');
      await c.control(g, free);
      await withdraw(g, g.manager, free, 'No dependents that count');
      expect((await dayRow(free)).status).toBe('voided');
    });
  });
});

// -----------------------------------------------------------------------------------------------
// S3 AUDIT legs (A, B, D, E and the domain half of C) — added after the auditor's findings.
// -----------------------------------------------------------------------------------------------

/** Lipa's two foundation wallets that carry online money, by name, so a test can retire one and keep the other. */
async function wallets(f: Fixture) {
  const rows = await sql<{ id: string; name: string }[]>`
    select id, name from money_accounts where store_id = ${f.storeId} and instrument = 'ewallet' and is_active order by name`;
  if (rows.length < 2) throw new Error(`fixture: expected two ewallet accounts at Lipa, found ${rows.length}`);
  return { w1: rows[0]!, w2: rows[1]! };
}
const onlineDay = (f: Fixture, tenders: { moneyAccountId: string; amount: string }[], online = '300.00') => ({
  totalSales: '1000.00', unliSales: '1000.00', alaCarteSales: '0.00', cashCollected: String(1000 - Number(online)) + '.00', onlineCollected: online,
  channels: [{ channelId: f.walkIn, amount: '1000.00' }], tenders,
});
async function tenderRows(dayId: string): Promise<Record<string, string>> {
  const rows = await sql<{ money_account_id: string; amount: string }[]>`select money_account_id, amount::text from sales_day_tenders where sales_day_id = ${dayId}`;
  return Object.fromEntries(rows.map((r) => [r.money_account_id, r.amount]));
}
async function mkOnlineDay(f: Fixture, date: string, tenders: { moneyAccountId: string; amount: string }[]): Promise<string> {
  const { id } = await asOrg(f.orgId, (tx) => D.createSalesDay(tx, f.staff, { storeId: f.storeId, businessDate: date, ...onlineDay(f, tenders) }));
  return id;
}

describe('AUDIT A — tenders: a retired wallet keeps its row; a non-positive amount is refused', () => {
  it('a day with a ₱300 tender on a wallet RETIRED since entry: an edit whose form lacks that wallet keeps the tender row (and adds the new one) — Mutant: replace semantics drop it', async () => {
    const f = await fixture('auditA1');
    const { w1, w2 } = await wallets(f);
    const id = await mkOnlineDay(f, D1, [{ moneyAccountId: w1.id, amount: '300.00' }]);
    await sql`update money_accounts set is_active = false where id = ${w1.id}`;

    // The edit form can only offer ACTIVE wallets, so it submits w2 and not the retired w1.
    await edit(f, f.manager, id, { ...onlineDay(f, [{ moneyAccountId: w2.id, amount: '50.00' }], '350.00') });
    expect(await tenderRows(id), "the retired wallet's tender row was dropped by the edit").toEqual({ [w1.id]: '300.00', [w2.id]: '50.00' });
  });

  it('an edit with NO tenders at all (an empty form section) also keeps the retired wallet\'s row', async () => {
    const f = await fixture('auditA1b');
    const { w1 } = await wallets(f);
    const id = await mkOnlineDay(f, D1, [{ moneyAccountId: w1.id, amount: '300.00' }]);
    await sql`update money_accounts set is_active = false where id = ${w1.id}`;
    await edit(f, f.manager, id, { ...onlineDay(f, [], '300.00') });
    expect(await tenderRows(id)).toEqual({ [w1.id]: '300.00' });
  });

  // S3 RE-AUDIT (2026-10-01): a tender typed "0" / "0.00" is the same as an UNTOUCHED box — it writes no row and is not an
  // error (the form submits every wallet; a person who leaves a 0 meant "nothing here"). Only a NEGATIVE amount is refused,
  // and in plain words: no "tender row", no "Omit the row" (developer talk).
  for (const blank of ['0', '0.00']) {
    it(`a tender typed "${blank}" is treated as BLANK by EDIT and by CREATE: no row, no refusal, nothing else changes`, async () => {
      const f = await fixture(`auditA2-blank-${blank}`);
      const { w1, w2 } = await wallets(f);
      const id = await mkOnlineDay(f, D1, [{ moneyAccountId: w1.id, amount: '300.00' }]);

      await edit(f, f.manager, id, { ...onlineDay(f, [{ moneyAccountId: w2.id, amount: blank }], '300.00') });
      expect(await tenderRows(id), `"${blank}" wrote a tender row or dropped the existing one`).toEqual({ [w1.id]: '300.00' });

      const created = await asOrg(f.orgId, (tx) =>
        D.createSalesDay(tx, f.staff, { storeId: f.storeId, businessDate: '2026-01-05', ...onlineDay(f, [{ moneyAccountId: w1.id, amount: '300.00' }, { moneyAccountId: w2.id, amount: blank }], '300.00') }),
      );
      expect(await tenderRows(created.id), `"${blank}" on create wrote a row`).toEqual({ [w1.id]: '300.00' });
    });
  }

  it('a tender typed "-5" is refused by EDIT and by CREATE with a PLAIN sentence (no id, no "tender row", no "Omit the row"); nothing changes — positive control: ₱50 posts', async () => {
    const f = await fixture('auditA2-neg');
    const { w1, w2 } = await wallets(f);
    const id = await mkOnlineDay(f, D1, [{ moneyAccountId: w1.id, amount: '300.00' }]);
    const before = await tenderRows(id);

    const editRefused = await rejection(edit(f, f.manager, id, { ...onlineDay(f, [{ moneyAccountId: w2.id, amount: '-5' }], '300.00') }), 'an edit with a "-5" tender');
    expect(editRefused.userMessage, `raw text leaked: ${editRefused.message}`).toBeTruthy();
    expect(editRefused.userMessage ?? '').not.toMatch(UUID);
    expect(editRefused.userMessage ?? '', 'developer wording on screen').not.toMatch(/tender row|Omit the row/i);
    expect(await tenderRows(id), 'the edit changed the tenders').toEqual(before);

    const createRefused = await rejection(
      asOrg(f.orgId, (tx) => D.createSalesDay(tx, f.staff, { storeId: f.storeId, businessDate: '2026-01-05', ...onlineDay(f, [{ moneyAccountId: w2.id, amount: '-5' }], '300.00') })),
      'a create with a "-5" tender',
    );
    expect(createRefused.userMessage, `raw text leaked: ${createRefused.message}`).toBeTruthy();
    expect(createRefused.userMessage ?? '').not.toMatch(UUID);
    expect(createRefused.userMessage ?? '', 'developer wording on screen').not.toMatch(/tender row|Omit the row/i);
    const [made] = await sql<{ n: string }[]>`select count(*)::text as n from sales_days where org_id = ${f.orgId} and business_date = '2026-01-05'`;
    expect(Number(made!.n), 'the refused create left a day behind').toBe(0);

    await edit(f, f.manager, id, { ...onlineDay(f, [{ moneyAccountId: w2.id, amount: '50.00' }], '350.00') });
    expect((await tenderRows(id))[w2.id]).toBe('50.00');
  });
});

describe('AUDIT B (domain, flipped by S7) — a withdrawn date: a MANAGER may enter it again; STAFF are told to ask one', () => {
  it('after a withdraw, the manager creates the date again; staff are refused "{date} was withdrawn earlier. Only a manager can enter that date again — ask one to do it." (no id)', async () => {
    const f = await fixture('auditB');
    const id = await mkDay(f, D1, '500.00');
    await withdraw(f, f.manager, id, 'Typed wrong');

    const staffRefused = await rejection(
      asOrg(f.orgId, (tx) => D.createSalesDay(tx, f.staff, { storeId: f.storeId, businessDate: D1, ...figures(f, '1000.00') })),
      'staff entering a withdrawn date',
    );
    expect(staffRefused.userMessage, `raw text leaked: ${staffRefused.message}`).toMatch(/was withdrawn earlier\. Only a manager can enter that date again — ask one to do it\.$/);
    expect(staffRefused.userMessage ?? '').not.toMatch(UUID);
    expect(staffRefused.userMessage ?? '', 'the old advice is wrong for a voided day').not.toMatch(/Edit that one instead/);

    const { id: again } = await asOrg(f.orgId, (tx) => D.createSalesDay(tx, f.manager, { storeId: f.storeId, businessDate: D1, ...figures(f, '1000.00') }));
    expect(again).not.toBe(id);
  });
});

describe('AUDIT D — editSalesDay leaves an audit row naming the editor, with the before/after figures', () => {
  it('one audit_log row: entity sales_days, entity_id = the day, actor = the manager, an "edit" action, before total 1000.00 -> after total 1500.00 and the channel amounts', async () => {
    const f = await fixture('auditD');
    const id = await mkDay(f, D1, '500.00');
    await edit(f, f.manager, id, figures(f, '1500.00', { totalSales: '1500.00', unliSales: '1500.00', cashCollected: '1500.00' }));

    const rows = await sql<{ action: string; actor_person_id: string | null; before: unknown; after: unknown }[]>`
      select action, actor_person_id, before, after from audit_log where entity = 'sales_days' and entity_id = ${id} and action ilike '%edit%'`;
    expect(rows, 'no audit row for the edit').toHaveLength(1);
    expect(rows[0]!.actor_person_id).toBe(f.managerId);
    expect(JSON.stringify(rows[0]!.before)).toContain('1000.00');
    expect(JSON.stringify(rows[0]!.before)).toContain('500.00');
    expect(JSON.stringify(rows[0]!.after)).toContain('1500.00');
  });
});

describe('AUDIT E — the gaps', () => {
  it('T11(iii) via the allocation\'s own sales_day_id (a DIFFERENT business_date) blocks the withdraw; an allocation for the same date at ANOTHER store does NOT', async () => {
    const f = await fixture('auditE1');
    const blocked = await mkDay(f, D1, '500.00');
    const [r] = await sql<{ id: string }[]>`
      insert into remittances (org_id, store_id, remitted_on, created_by, status) values (${f.orgId}, ${f.storeId}, ${D2}, ${f.managerId}, 'posted') returning id`;
    await sql`insert into remittance_allocations (remittance_id, sales_day_id, amount, business_date) values (${r!.id}, ${blocked}, '500.00', ${D2})`;
    const refused = await rejection(withdraw(f, f.manager, blocked), 'a withdraw of a day a posted remittance allocation points at by id');
    expect(refused.userMessage).toBe('Cash handed over has been counted against this day. Reverse that handover first.');
    expect((await dayRow(blocked)).status).toBe('open');

    const g = await fixture('auditE1b');
    const free = await mkDay(g, D1, '500.00');
    const [r2] = await sql<{ id: string }[]>`
      insert into remittances (org_id, store_id, remitted_on, created_by, status) values (${g.orgId}, ${g.storeId2}, ${D1}, ${g.managerId}, 'posted') returning id`;
    await sql`insert into remittance_allocations (remittance_id, amount, business_date) values (${r2!.id}, '500.00', ${D1})`;
    await withdraw(g, g.manager, free, 'Other store, same date, does not count');
    expect((await dayRow(free)).status, "another store's remittance must not block this store's withdraw").toBe('voided');
  });

  it('withdraw vs verify: A withdraws (holds), B verifies -> B waits on the day row, then gets a PLAIN sentence ("This sales day has been voided, so it can\'t be posted.") — no function prefix, no id', async () => {
    const f = await fixture('auditE2');
    const id = await mkDay(f, D1, '1000.00'); // balanced: it WOULD post if the withdraw had not won

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(
      f.orgId,
      (tx) => D.voidSalesDay(tx, f.manager, id, 'Wrong day'),
      (tx) => D.verifySalesDay(tx, f.manager, id),
      ROW_LOCK,
    );

    expect(aResult.status).toBe('fulfilled');
    expect(bWaited, 'B never waited: verify and withdraw do not serialise on the day row').toBe(true);
    expect(bResult.status, 'the verify must lose').toBe('rejected');
    const said = (bResult as { reason: { userMessage?: string; message: string } }).reason;
    expect(said.userMessage, `raw text leaked: ${said.message}`).toBe("This sales day has been voided, so it can't be posted.");
    expect(said.userMessage).not.toMatch(/verifySalesDay:|createSalesDay:/);
    expect(await journalCount(f.orgId, id)).toBe(0);
  });
});

describe('AUDIT D (re-audit) — what the edit audit records', () => {
  const editRows = (id: string) =>
    sql<{ before: Record<string, unknown> | null; after: Record<string, unknown> | null }[]>`
      select before, after from audit_log where entity = 'sales_days' and entity_id = ${id} and action ilike '%edit%'`;

  it('a NO-OP edit (the very same figures and channels) writes NO audit row — an audit trail of non-changes is noise; positive control: a real change writes one', async () => {
    const f = await fixture('auditD-noop');
    const id = await mkDay(f, D1, '500.00');

    await edit(f, f.manager, id, figures(f, '500.00')); // identical to what mkDay wrote
    expect(await editRows(id), 'a no-op edit wrote an audit row').toHaveLength(0);

    await edit(f, f.manager, id, figures(f, '1000.00'));
    expect(await editRows(id)).toHaveLength(1);
  });

  it('T-375 S3: the retired posSourced input changes nothing - create and edit leave pos_sourced false on a typed day, and the audit shows no provenance change', async () => {
    const f = await fixture('auditD-pos');
    // `posSourced` is no longer an input (the "From POS" box is gone): even if an old caller still passes it, it is ignored.
    const { id } = await asOrg(f.orgId, (tx) => D.createSalesDay(tx, f.staff, { storeId: f.storeId, businessDate: D1, posSourced: true, ...figures(f, '1000.00') } as never));
    await edit(f, f.manager, id, { ...figures(f, '1200.00', { totalSales: '1200.00', unliSales: '1200.00', cashCollected: '1200.00' }), posSourced: true } as never);

    const [day] = await sql<{ pos_sourced: boolean; source: string }[]>`select pos_sourced, source from sales_days where id = ${id}`;
    expect(day, 'a typed day is never POS-sourced').toEqual({ pos_sourced: false, source: 'legacy_typed' });
    const rows = await editRows(id);
    expect(rows, 'the real figure change is audited').toHaveLength(1);
    // Whether or not the snapshot still names the column, it must not claim a provenance change.
    expect((rows[0]!.before as Record<string, unknown>).posSourced ?? false).toBe((rows[0]!.after as Record<string, unknown>).posSourced ?? false);
  });
});
