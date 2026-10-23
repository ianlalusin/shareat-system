import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-370 S1 (DEF-108 + DEF-516) — a payroll recovery must free an owner's drawing cap exactly as a
 * cash repayment of the same amount on the same date would (FIFO across the person's whole 1230
 * ledger), and two concurrent drawings must not both pass one cap.
 * `docs/tasks/370-owner-cap-dates.md` §S1, legs O1-O8, X1/X1c. Fixture merges the shapes of
 * `owners.test.ts` (owner/`owesUs`/staff-shortage raw inserts) and `payroll.test.ts`
 * (`store_attendance_config`/`employments`/`setPayRate`/`attendance_days` — copied in, per the
 * task doc's "no lane edits a shared test helper").
 *
 * ⛔ TESTER, not BUILDER. `drawnInWindow` (`packages/db/src/repo/owners.ts`) today only sums 1230
 * lines whose `je.source_id = owner.id` — `recoverFromPay`'s OWN charge line matches that (so it
 * already counts as drawn, correctly), but the LATER payroll credit that actually recovers it is
 * posted with `sourceId = payslipId`, which never matches — so the recovery is invisible and the
 * cap never frees. Every O-leg below picks a pay rate so `postPayRun`'s gross pay for the one
 * attendance day equals exactly the figure the leg needs recovered (`advanceToRecover` = `min(gross,
 * outstanding)`), so the recovered amount is controlled precisely, independent of the person's
 * total outstanding 1230 balance.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedStatutoryRates } from './_fixtures/statutory-rates';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, ownersRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createOwner, recoverFromPay, repayFromOwner, recordDrawing, closeDrawingMonth, postPayRun, voidPayRun, setPayRate } from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';

const sql = postgres(url, { max: 10 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

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
// Fixture
// -----------------------------------------------------------------------------------------------

async function fixture(hint: string, opts: { drawingLimit?: string; drawingLimitPeriod?: 'monthly' | 'total' } = {}) {
  const code = uid(`t370-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [storeA] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = storeA!.id;
  const [storeB] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(`${hint}-b`)}, ${`Store2 ${hint}`}) returning id`;
  const storeId2 = storeB!.id;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;

  const mk = async (name: string, role: string, atStoreId: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${atStoreId})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin', storeId);
  await sql`insert into person_store_scope (person_id, store_id) values (${adminId}, ${storeId2})`;
  const anaId = await mk('Ana', 'staff', storeId);
  const admin = actor(orgId, adminId);
  const ana = actor(orgId, anaId);
  await seedStatutoryRates(orgId, admin, [storeId, storeId2]);

  const [office] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  await asOrg(orgId, (tx) =>
    postEntry(tx, {
      orgId,
      entryDate: '2026-01-01',
      sourceType: 'manual_journal',
      sourceId: uid('fund'),
      idempotencyKey: uid('fund'),
      memo: 'fixture funding',
      postedBy: adminId,
      lines: [
        { accountCode: '1130', storeId, debit: '1000000.00' },
        { accountCode: '3900', storeId, credit: '1000000.00' },
      ],
    }),
  );

  const { id: ownerId } = await asOrg(orgId, (tx) =>
    createOwner(tx, admin, { storeId, personId: anaId, drawingLimit: opts.drawingLimit ?? null, drawingLimitPeriod: opts.drawingLimitPeriod ?? null }),
  );

  const [config] = await sql<{ id: string }[]>`
    insert into store_attendance_config (org_id, store_id, effective_from, required_hours_per_shift, overtime_multiplier, night_diff_multiplier, overtime_mode)
    values (${orgId}, ${storeId}, '2026-01-01', '9', '1.25', '1.10', 'multiplier') returning id`;
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
    values (${orgId}, ${anaId}, ${storeId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, '2026-01-01', 'regular', ${adminId}) returning id`;

  return { orgId, storeId, storeId2, admin, adminId, ana, anaId, ownerId, officeAccountId: office!.id, configId: config!.id, employmentId: emp!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A second owner row, same person, a different store (O6). */
async function secondOwner(f: Fixture, opts: { drawingLimit?: string; drawingLimitPeriod?: 'monthly' | 'total' } = {}) {
  const { id } = await asOrg(f.orgId, (tx) =>
    createOwner(tx, f.admin, { storeId: f.storeId2, personId: f.anaId, drawingLimit: opts.drawingLimit ?? null, drawingLimitPeriod: opts.drawingLimitPeriod ?? null }),
  );
  return id;
}

const drawn = (f: Fixture, ownerId: string, window: { since?: string; until?: string } = {}) =>
  asOrg(f.orgId, (tx) => ownersRepo.drawnInWindow(tx, f.orgId, { id: ownerId, personId: f.anaId }, window));
const receivable = (f: Fixture, ownerId: string) => asOrg(f.orgId, (tx) => ownersRepo.receivableOf(tx, f.orgId, ownerId));
const outstandingAdvance = (f: Fixture) =>
  asOrg(f.orgId, (tx) => tx.execute(dsql`select coalesce(sum(jl.debit-jl.credit),0)::text as total from journal_lines jl
    join journal_entries je on je.id=jl.entry_id join accounts a on a.id=jl.account_id
    where je.org_id=${f.orgId} and je.status<>'draft' and a.code='1230' and jl.party_type='employee' and jl.party_id=${f.anaId}`))
    .then((r) => Number((r as unknown as { total: string }[])[0]?.total ?? 0).toFixed(2));

/** A repayable owner charge — Dr 1260 (party owner) / Cr 1110 — `owners.test.ts`'s `owesUs` shape. */
async function owesUs(f: Fixture, ownerId: string, amount: string, on: string) {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} order by starts_on limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, ${on}, ${period!.id}, 'expense', ${uid('exp')}, 'draft') returning id`;
    const codes = await tx<{ id: string; code: string }[]>`select id, code from accounts where org_id = ${f.orgId} and code in ('1260', '1110')`;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id) values (${e!.id}, 1, ${by.get('1260')!}, ${f.storeId}, ${amount}, '0', 'owner', ${ownerId})`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${by.get('1110')!}, ${f.storeId}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

/** A staff (non-owner-origin) advance — Dr 1230 (party employee) / Cr 1110, random source_id.
 * `owners.test.ts:279-308`'s shape, verbatim. */
async function staffShortage(f: Fixture, amount: string, on: string) {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} order by starts_on limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, ${on}, ${period!.id}, 'cash_request_shortage', ${uid('cr')}, 'draft') returning id`;
    const codes = await tx<{ id: string; code: string }[]>`select id, code from accounts where org_id = ${f.orgId} and code in ('1230', '1110')`;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id) values (${e!.id}, 1, ${by.get('1230')!}, ${f.storeId}, ${amount}, '0', 'employee', ${f.anaId})`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${by.get('1110')!}, ${f.storeId}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

async function addDay(f: Fixture, shiftDay: string) {
  await sql`insert into attendance_days
      (org_id, store_id, person_id, employment_id, shift_day, attendance_config_id, anchor_mode, status, computed_minutes, is_half_day, pending_ot_minutes, night_diff_minutes, holiday_minutes, is_holiday)
    values (${f.orgId}, ${f.storeId}, ${f.anaId}, ${f.employmentId}, ${shiftDay}, ${f.configId}, 'exact', 'verified', 540, false, 0, 0, 0, false)`;
}

/** One payroll run recovering EXACTLY `recoverAmount` (a daily rate = the desired recovery, one
 * 540-minute day = exactly `requiredHoursPerShift`, no OT — so gross === the rate, and
 * `advanceToRecover = min(gross, outstanding)` is controlled by the rate alone). */
async function payrollRecovers(f: Fixture, recoverAmount: string, workDay: string, entryDate: string) {
  await asOrg(f.orgId, (tx) => setPayRate(tx, f.admin, { employmentId: f.employmentId, storeId: f.storeId, basis: 'daily', amount: recoverAmount, effectiveFrom: '2026-01-01' }));
  await addDay(f, workDay);
  return asOrg(f.orgId, (tx) =>
    postPayRun(tx, f.admin, { storeId: f.storeId, periodStart: '2026-01-01', periodEnd: '2026-01-31', moneyAccountId: f.officeAccountId, entryDate }),
  );
}

// -----------------------------------------------------------------------------------------------
// O1 — the shape, and its cash-repayment twin
// -----------------------------------------------------------------------------------------------

describe('O1 — a payroll recovery frees the cap exactly as a cash repayment would', () => {
  it('total 0.00, Jan 2000.00, Feb 0.00 (monthly floor) — Mutant: restore the source_id-only scope, red; drop the monthly floor, Feb -2000.00, red', async () => {
    const f = await fixture('o1', { drawingLimit: '5000.00', drawingLimitPeriod: 'monthly' });
    await owesUs(f, f.ownerId, '2000.00', '2026-01-10');
    await asOrg(f.orgId, (tx) => recoverFromPay(tx, f.admin, { ownerId: f.ownerId, amount: '2000.00', on: '2026-01-20' }));
    await payrollRecovers(f, '2000.00', '2026-01-05', '2026-02-05');

    expect(await drawn(f, f.ownerId)).toBe('0.00');
    expect(await drawn(f, f.ownerId, { until: '2026-02-01' })).toBe('2000.00');
    // Orchestrator ruling (default pending Ian): the overall figure is freed, but a MONTHLY window never
    // reports below zero — a negative month would refuse closeDrawingMonth and grant extra headroom.
    expect(await drawn(f, f.ownerId, { since: '2026-02-01', until: '2026-03-01' })).toBe('0.00');

    // The reclass already cleared what was owed directly — nothing left to also repay in cash.
    expect(await receivable(f, f.ownerId)).toBe('0.00');
    await expect(
      asOrg(f.orgId, (tx) => repayFromOwner(tx, f.admin, { ownerId: f.ownerId, amount: '1.00', intoMoneyAccountId: f.officeAccountId, on: '2026-01-21' })),
    ).rejects.toThrow(/more than the/);
  });

  it('twin (monthly floor applies here too): the same three numbers from a pure cash repayment, no recoverFromPay/payroll at all', async () => {
    const g = await fixture('o1twin', { drawingLimit: '5000.00', drawingLimitPeriod: 'monthly' });
    await owesUs(g, g.ownerId, '2000.00', '2026-01-10');
    await asOrg(g.orgId, (tx) => repayFromOwner(tx, g.admin, { ownerId: g.ownerId, amount: '2000.00', intoMoneyAccountId: g.officeAccountId, on: '2026-02-05' }));

    expect(await drawn(g, g.ownerId)).toBe('0.00');
    expect(await drawn(g, g.ownerId, { until: '2026-02-01' })).toBe('2000.00');
    expect(await drawn(g, g.ownerId, { since: '2026-02-01', until: '2026-03-01' })).toBe('0.00'); // monthly floor applies to a cash repayment too
  });
});

describe('M-floor — a payroll recovery larger than the month\'s drawings never drives the MONTHLY figure below zero', () => {
  it('M-close: closeDrawingMonth with no acknowledgedAmount agrees 0.00 and posts no adjustment — Mutant: no monthly floor, "The agreed amount cannot be negative", red', async () => {
    const f = await fixture('mclose', { drawingLimit: '5000.00', drawingLimitPeriod: 'monthly' });
    await owesUs(f, f.ownerId, '2000.00', '2026-01-10');
    await asOrg(f.orgId, (tx) => recoverFromPay(tx, f.admin, { ownerId: f.ownerId, amount: '2000.00', on: '2026-01-20' }));
    await payrollRecovers(f, '2000.00', '2026-01-05', '2026-02-05'); // Feb: no drawings, 2000 recovered

    const result = await asOrg(f.orgId, (tx) => closeDrawingMonth(tx, f.admin, { ownerId: f.ownerId, month: '2026-02-01', on: '2026-03-01' }));
    expect(result.acknowledgedAmount).toBe('0.00');
    expect(result.adjustmentAmount).toBeNull();
    const [adj] = await sql<{ n: number }[]>`select count(*)::int as n from journal_entries where org_id = ${f.orgId} and source_type = 'drawing_close_adjustment'`;
    expect(adj!.n, 'no spurious 3200/1260 adjustment').toBe(0);
  });

  it('M-headroom: cap 10000/month, 5000 prior-month debt recovered by payroll this month — a 15000 drawing is REFUSED, 10000 passes — Mutant: no monthly floor (already = -5000), 15000 passes, red', async () => {
    const f = await fixture('mhead', { drawingLimit: '10000.00', drawingLimitPeriod: 'monthly' });
    await owesUs(f, f.ownerId, '5000.00', '2026-01-10');
    await asOrg(f.orgId, (tx) => recoverFromPay(tx, f.admin, { ownerId: f.ownerId, amount: '5000.00', on: '2026-01-20' }));
    await payrollRecovers(f, '5000.00', '2026-01-05', '2026-02-05');

    await expect(asOrg(f.orgId, drawOp(f, '15000.00', '2026-02-10'))).rejects.toThrow(/over the ₱10000\.00 monthly limit/);
    await asOrg(f.orgId, drawOp(f, '10000.00', '2026-02-11'));
    expect(await drawn(f, f.ownerId, { since: '2026-02-01', until: '2026-03-01' })).toBe('10000.00');
  });

  it('positive control (green now and after): drawings above the recovery leave the plain positive net — Feb 1000.00, total 3000.00', async () => {
    const f = await fixture('mpos', { drawingLimit: '10000.00', drawingLimitPeriod: 'monthly' });
    await owesUs(f, f.ownerId, '2000.00', '2026-01-10');
    await asOrg(f.orgId, (tx) => recoverFromPay(tx, f.admin, { ownerId: f.ownerId, amount: '2000.00', on: '2026-01-20' }));
    await asOrg(f.orgId, drawOp(f, '3000.00', '2026-02-02'));
    await payrollRecovers(f, '2000.00', '2026-01-05', '2026-02-05');

    expect(await drawn(f, f.ownerId, { since: '2026-02-01', until: '2026-03-01' })).toBe('1000.00');
    expect(await drawn(f, f.ownerId)).toBe('3000.00');
  });
});

describe('O2 — voidPayRun restores the cap it freed', () => {
  it('total back to 2000.00 — Mutant: ignore reversal_of_entry_id, red', async () => {
    const f = await fixture('o2', { drawingLimit: '5000.00', drawingLimitPeriod: 'monthly' });
    await owesUs(f, f.ownerId, '2000.00', '2026-01-10');
    await asOrg(f.orgId, (tx) => recoverFromPay(tx, f.admin, { ownerId: f.ownerId, amount: '2000.00', on: '2026-01-20' }));
    const run = await payrollRecovers(f, '2000.00', '2026-01-05', '2026-02-05');
    expect(await drawn(f, f.ownerId)).toBe('0.00');

    await asOrg(f.orgId, (tx) => voidPayRun(tx, f.admin, { runId: run.runId, reason: 'T-370 O2', on: '2026-02-10' }));
    expect(await drawn(f, f.ownerId)).toBe('2000.00');
  });
});

describe('O3 — FIFO: the older owner-origin charge is consumed first', () => {
  it('reclass 1000 (01-10) older than a staff shortage 600 (01-15); recovery 1000 -> owner 0.00 — Mutant: staff-first min(ownerOrigin,balance) gives 600.00, red', async () => {
    const f = await fixture('o3', { drawingLimit: '5000.00', drawingLimitPeriod: 'monthly' });
    await owesUs(f, f.ownerId, '1000.00', '2026-01-10');
    await asOrg(f.orgId, (tx) => recoverFromPay(tx, f.admin, { ownerId: f.ownerId, amount: '1000.00', on: '2026-01-10' }));
    await staffShortage(f, '600.00', '2026-01-15');
    await payrollRecovers(f, '1000.00', '2026-01-20', '2026-02-05');

    expect(await drawn(f, f.ownerId)).toBe('0.00');
  });
});

describe('O4 — FIFO in the other order: the older non-owner charge is consumed first', () => {
  it('shortage 600 (01-05) older than reclass 1000 (01-10); recovery 1000 -> owner 600.00 — Mutant: owner-first gives 0.00, red', async () => {
    const f = await fixture('o4', { drawingLimit: '5000.00', drawingLimitPeriod: 'monthly' });
    await staffShortage(f, '600.00', '2026-01-05');
    await owesUs(f, f.ownerId, '1000.00', '2026-01-10');
    await asOrg(f.orgId, (tx) => recoverFromPay(tx, f.admin, { ownerId: f.ownerId, amount: '1000.00', on: '2026-01-10' }));
    await payrollRecovers(f, '1000.00', '2026-01-20', '2026-02-05');

    expect(await drawn(f, f.ownerId)).toBe('600.00');
  });
});

describe('O5 — a partial recovery leaves the remainder outstanding', () => {
  it('500 of a 2000 reclass -> 1500.00 — Mutant: pool applied all-or-nothing, red', async () => {
    const f = await fixture('o5', { drawingLimit: '5000.00', drawingLimitPeriod: 'monthly' });
    await owesUs(f, f.ownerId, '2000.00', '2026-01-10');
    await asOrg(f.orgId, (tx) => recoverFromPay(tx, f.admin, { ownerId: f.ownerId, amount: '2000.00', on: '2026-01-10' }));
    await payrollRecovers(f, '500.00', '2026-01-20', '2026-02-05');

    expect(await drawn(f, f.ownerId)).toBe('1500.00');
  });
});

describe('O6 — one person owns two stores; each owner row sees only its own remainder', () => {
  it('A 1000 (01-10), B 700 (01-12); recovery 1200 -> A 0.00, B 500.00, sum = the person\'s 1230 balance — Mutant: whole-balance-per-owner gives A 500/B 500 or the sum exceeds the balance, red', async () => {
    const f = await fixture('o6', { drawingLimit: '5000.00', drawingLimitPeriod: 'monthly' });
    const ownerB = await secondOwner(f, { drawingLimit: '5000.00', drawingLimitPeriod: 'monthly' });
    await owesUs(f, f.ownerId, '1000.00', '2026-01-10');
    await asOrg(f.orgId, (tx) => recoverFromPay(tx, f.admin, { ownerId: f.ownerId, amount: '1000.00', on: '2026-01-10' }));
    await owesUs(f, ownerB, '700.00', '2026-01-12');
    await asOrg(f.orgId, (tx) => recoverFromPay(tx, f.admin, { ownerId: ownerB, amount: '700.00', on: '2026-01-12' }));
    await payrollRecovers(f, '1200.00', '2026-01-20', '2026-02-05');

    const a = await drawn(f, f.ownerId);
    const b = await drawn(f, ownerB);
    expect(a).toBe('0.00');
    expect(b).toBe('500.00');
    expect((Number(a) + Number(b)).toFixed(2)).toBe(await outstandingAdvance(f));
  });
});

describe('O7 (control, green now and after) — a staff advance with no owner-origin charge never changes drawnInWindow', () => {
  it('0.00 before and after', async () => {
    const f = await fixture('o7', { drawingLimit: '5000.00', drawingLimitPeriod: 'monthly' });
    expect(await drawn(f, f.ownerId)).toBe('0.00');
    await staffShortage(f, '600.00', '2026-01-05');
    expect(await drawn(f, f.ownerId)).toBe('0.00');
    await payrollRecovers(f, '600.00', '2026-01-10', '2026-01-25');
    expect(await drawn(f, f.ownerId)).toBe('0.00');
  });
});

describe('O8 (control, green now and after) — recoverFromPay alone still frees nothing', () => {
  it('still 2000.00, not freed', async () => {
    const f = await fixture('o8', { drawingLimit: '5000.00', drawingLimitPeriod: 'monthly' });
    await owesUs(f, f.ownerId, '2000.00', '2026-01-10');
    await asOrg(f.orgId, (tx) => recoverFromPay(tx, f.admin, { ownerId: f.ownerId, amount: '2000.00', on: '2026-01-20' }));
    expect(await drawn(f, f.ownerId)).toBe('2000.00');
  });
});

// -----------------------------------------------------------------------------------------------
// X1 / X1c — DEF-516, two concurrent drawings against one cap
// -----------------------------------------------------------------------------------------------

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function pollForWaitingBackend(excludePid: number, waitEvents: string[], settleWatch: Promise<unknown>, timeoutMs = 5000): Promise<{ pid: number; query: string } | null> {
  const settled = settleWatch.then(() => true).catch(() => true);
  const poll = (async (): Promise<{ pid: number; query: string } | null> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await sql<{ pid: number; query: string }[]>`
        select pid, query from pg_stat_activity
        where datname = current_database() and pid <> ${excludePid}
          and wait_event_type = 'Lock' and wait_event = any(${waitEvents})`;
      if (rows.length > 1) throw new Error(`expected at most one waiting backend, found ${rows.length}: ${JSON.stringify(rows)}`);
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
  let aPid = 0;

  const aPromise: Promise<Settled<TA>> = asOrg(orgId, async (tx) => {
    const pidRows = await tx.execute(dsql`select pg_backend_pid() as pid`);
    aPid = Number((pidRows as unknown as { pid: number }[])[0]?.pid);
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
  const bPromise: Promise<Settled<TB>> = asOrg(orgId, opB).then(
    (value) => ({ status: 'fulfilled', value }) as const,
    (reason) => ({ status: 'rejected', reason }) as const,
  );

  const waiting = await pollForWaitingBackend(aPid, waitEvents, bPromise, 5000);
  gate.resolve();
  const [aResult, bResult] = await Promise.all([aPromise, bPromise]);
  return { aResult, bResult, bWaited: !!waiting };
}
function settledError(s: Settled<unknown>): unknown {
  if (s.status === 'fulfilled') throw new Error('expected rejected, got fulfilled');
  return s.reason;
}

const ROW_LOCK = ['transactionid', 'tuple'];
const drawOp = (f: Fixture, amount: string, on: string) => (tx: Tx) =>
  recordDrawing(tx, f.admin, { ownerId: f.ownerId, amount, fromMoneyAccountId: f.officeAccountId, on });

describe('X1 — two concurrent drawings cannot both pass one monthly cap', () => {
  it('exactly one commits; the other is refused with the limit sentence; drawn = 4500.00 — Mutant: remove lockOwnerForUpdate -> both commit, 6000.00, red', async () => {
    const f = await fixture('x1', { drawingLimit: '5000.00', drawingLimitPeriod: 'monthly' });
    await asOrg(f.orgId, drawOp(f, '3000.00', '2026-01-05'));
    expect(await drawn(f, f.ownerId)).toBe('3000.00');

    const { aResult, bResult, bWaited } = await runConcurrencyLeg(f.orgId, drawOp(f, '1500.00', '2026-01-10'), drawOp(f, '1500.00', '2026-01-11'), ROW_LOCK);

    expect(bWaited, 'B never waited: no lock').toBe(true);
    const outcomes = [aResult, bResult];
    expect(outcomes.filter((o) => o.status === 'fulfilled').length, 'exactly one fulfilled').toBe(1);
    const rejected = outcomes.find((o) => o.status === 'rejected')!;
    expect(String((settledError(rejected) as Error).message)).toMatch(/over the ₱5000\.00 monthly limit/);
    expect(await drawn(f, f.ownerId)).toBe('4500.00');
  });
});

describe('X1c (control) — sequential drawings both commit; the app role still holds UPDATE on owners', () => {
  it('3000 then 1500 then 500 all commit; has_table_privilege is true', async () => {
    const f = await fixture('x1c', { drawingLimit: '5000.00', drawingLimitPeriod: 'monthly' });
    await asOrg(f.orgId, drawOp(f, '3000.00', '2026-01-05'));
    await asOrg(f.orgId, drawOp(f, '1500.00', '2026-01-10'));
    await asOrg(f.orgId, drawOp(f, '500.00', '2026-01-15'));
    expect(await drawn(f, f.ownerId)).toBe('5000.00');

    const [row] = await sql<{ ok: boolean }[]>`select has_table_privilege('shareat_app', 'owners', 'UPDATE') as ok`;
    expect(row!.ok, 'the app role must keep UPDATE on owners for lockOwnerForUpdate to work at all').toBe(true);
  });
});

describe('L — a drawing that lands EXACTLY on the cap is accepted (money compared in centavos, not floats)', () => {
  it('L1: monthly 1016.14, 1016.07 already drawn -> a 0.07 drawing is ACCEPTED (1016.07 + 0.07 = 1016.1400000000001 in Number) — Mutant: compare in Number -> L1 red', async () => {
    const f = await fixture('l1', { drawingLimit: '1016.14', drawingLimitPeriod: 'monthly' });
    await asOrg(f.orgId, drawOp(f, '1016.07', '2026-01-05'));
    await asOrg(f.orgId, drawOp(f, '0.07', '2026-01-10'));
    expect(await drawn(f, f.ownerId)).toBe('1016.14');
  });

  it('L2: monthly 0.06, 0.05 already drawn -> a 0.01 drawing is ACCEPTED (0.05 + 0.01 = 0.060000000000000005 in Number) — Mutant: compare in Number -> L2 red', async () => {
    const f = await fixture('l2', { drawingLimit: '0.06', drawingLimitPeriod: 'monthly' });
    await asOrg(f.orgId, drawOp(f, '0.05', '2026-01-05'));
    await asOrg(f.orgId, drawOp(f, '0.01', '2026-01-10'));
    expect(await drawn(f, f.ownerId)).toBe('0.06');
  });

  it('L3 (control, green now and after): monthly 1016.14, 1016.07 drawn -> 0.08 is REFUSED, one centavo over — Mutant: compare in Number -> still green (control)', async () => {
    const f = await fixture('l3', { drawingLimit: '1016.14', drawingLimitPeriod: 'monthly' });
    await asOrg(f.orgId, drawOp(f, '1016.07', '2026-01-05'));
    await expect(asOrg(f.orgId, drawOp(f, '0.08', '2026-01-10'))).rejects.toThrow(/over the ₱1016\.14 monthly limit/);
    expect(await drawn(f, f.ownerId)).toBe('1016.07');
  });
});
