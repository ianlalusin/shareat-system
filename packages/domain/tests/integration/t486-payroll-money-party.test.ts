import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-486 (DEF-776) - payroll payouts carry the money account's party, and refuse the staff float by name.
 * `docs/tasks/486-payroll-money-account-party.md`.
 *
 * RED REASON before the fix: a payout paid from `1140 E-wallet` posts a credit with no party, and the
 * `journal_lines_party_requirement` trigger refuses it (P0001); a payout paid from `1120 Staff float` is refused only
 * by that same trigger, not by name. Runs on any *_test database, fresh ids per fixture.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedStatutoryRates } from './_fixtures/statutory-rates';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  post13thMonthRun,
  postPayRun,
  postSeparation,
  recordLeave,
  seedAttendanceConfig,
  seedCanonicalPositions,
} from '@shareat/domain';

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
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

const FLOAT_SENTENCE = /staff cash float, which belongs to one person through a cash request\. Payroll cannot be paid from it\. Choose an office or e-wallet account\./;

/** A refusal carries the person-facing sentence on `userMessage` (message stays the raw diagnostic). */
async function expectFloatRefusal(p: Promise<unknown>): Promise<void> {
  const err = (await p.then(
    () => null,
    (e: unknown) => e,
  )) as { name?: string; userMessage?: string } | null;
  expect(err?.name).toBe('RefusalError');
  expect(err?.userMessage).toMatch(FLOAT_SENTENCE);
}

async function fixture(hint: string) {
  const code = uid(`t486-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            select ${orgId}::uuid, d::date, (d + interval '1 month' - interval '1 day')::date, 'open'
            from generate_series('2025-01-01'::date, '2027-12-01'::date, '1 month') d`;
  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const [s] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = s!.id;
  await asOrg(orgId, (tx) => seedAttendanceConfig(tx, { orgId, storeId, effectiveFrom: '2025-01-01' }));
  const acct = async (instrument: string, custodian: string, gl: string) => {
    const [a] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${storeId} and instrument = ${instrument}
        and custodian = ${custodian} and gl_account_code = ${gl} and is_foundation`;
    return a!.id;
  };
  const officeId = await acct('cash', 'office', '1130');
  const ewalletId = await acct('ewallet', 'office', '1140');
  const floatId = await acct('cash', 'staff', '1120');

  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin');
  await seedStatutoryRates(orgId, actor(orgId, adminId), [storeId]);
  const managerId = await mk('Manager', 'manager');
  const workerId = await mk('Worker', 'staff');
  const [e] = await sql<{ id: string }[]>`
    insert into employments (org_id, person_id, store_id, staff_code, started_on, ended_on, employment_status, created_by)
    values (${orgId}, ${workerId}, ${storeId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`},
            '2025-01-01', '2026-06-30', 'resigned', ${adminId}) returning id`;
  const [r] = await sql<{ id: string }[]>`
    insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by)
    values (${orgId}, ${e!.id}, 'daily', '600.00', '2025-01-01', ${adminId}) returning id`;
  return {
    orgId, storeId, officeId, ewalletId, floatId, adminId, managerId, workerId, employmentId: e!.id, rateId: r!.id,
    admin: actor(orgId, adminId), mgr: actor(orgId, managerId),
  };
}
type F = Awaited<ReturnType<typeof fixture>>;

/** A posted regular period inserted as an INPUT (the 13th month and separation read it). */
async function postedPeriod(f: F, periodStart: string, periodEnd: string, basicPay: string) {
  const [run] = await sql<{ id: string }[]>`
    insert into pay_runs (org_id, store_id, period_start, period_end, status, money_account_id, posted_at, posted_by, created_by)
    values (${f.orgId}, ${f.storeId}, ${periodStart}, ${periodEnd}, 'posted', ${f.officeId}, now(), ${f.adminId}, ${f.adminId}) returning id`;
  await sql`insert into payslips (run_id, org_id, employment_id, person_id, pay_rate_id, days_worked, basic_pay, gross_pay, advance_recovered, net_pay)
            values (${run!.id}, ${f.orgId}, ${f.employmentId}, ${f.workerId}, ${f.rateId}, '1', ${basicPay}, ${basicPay}, '0', ${basicPay})`;
}

async function workedDay(f: F, shiftDay: string) {
  const [cfg] = await sql<{ id: string }[]>`select id from store_attendance_config where store_id = ${f.storeId} order by effective_from desc limit 1`;
  await sql`insert into attendance_days (org_id, store_id, person_id, employment_id, shift_day, attendance_config_id, anchor_mode, status, computed_minutes)
            values (${f.orgId}, ${f.storeId}, ${f.workerId}, ${f.employmentId}, ${shiftDay}, ${cfg!.id}, 'exact', 'verified', 540)`;
}

/** Every credit this org's ledger holds on the account (by GL code), with its party. */
const creditsOn = (orgId: string, gl: string) =>
  sql<{ party_type: string | null; party_id: string | null; credit: string; source_type: string }[]>`
    select l.party_type, l.party_id, l.credit, e.source_type from journal_lines l
    join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
    where e.org_id = ${orgId} and a.code = ${gl} and l.credit > 0`;
const count = async (table: 'journal_entries' | 'pay_runs' | 'thirteenth_month_runs' | 'separations', orgId: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from ${sql(table)} where org_id = ${orgId}`)[0]!.n);

const sepInput = (f: F, moneyAccountId: string) =>
  ({
    storeId: f.storeId, employmentId: f.employmentId, separationDate: '2026-06-30', cause: 'resignation',
    separationPayAmount: '0', moneyAccountId, clearanceConfirmedBy: f.adminId,
  }) as never;

/** Separation with an SIL balance (2 days -> unused SIL paid at final pay) and a posted period so the 13th month is > 0. */
async function separable(hint: string) {
  const f = await fixture(hint);
  await asOrg(f.orgId, (tx) =>
    recordLeave(tx, f.mgr, {
      employmentId: f.employmentId,
      leaveType: 'sil',
      days: [{ date: '2026-03-02', kind: 'leave' }, { date: '2026-03-03', kind: 'leave' }],
    } as never));
  await postedPeriod(f, '2026-01-01', '2026-01-15', '6000.00');
  return f;
}

afterAll(async () => {
  await sql.end();
  await closeDb();
});

// =====================================================================================

describe('T-486 - pay run', () => {
  const run = (f: F, moneyAccountId: string) =>
    asOrg(f.orgId, (tx) =>
      postPayRun(tx, f.admin, { storeId: f.storeId, periodStart: '2026-01-01', periodEnd: '2026-01-15', moneyAccountId } as never));

  it('paid from an e-wallet: posts, credit carries party money_account = that account', async () => {
    const f = await fixture('pr-ew');
    await workedDay(f, '2026-01-05');
    await run(f, f.ewalletId);
    expect(await creditsOn(f.orgId, '1140')).toEqual([
      expect.objectContaining({ party_type: 'money_account', party_id: f.ewalletId, credit: '600.00', source_type: 'payrollpayslip' }),
    ]);
  });

  it('paid from the staff float: refused by name, nothing written', async () => {
    const f = await fixture('pr-fl');
    await workedDay(f, '2026-01-05');
    await expectFloatRefusal(run(f, f.floatId));
    expect(await count('journal_entries', f.orgId)).toBe(0);
    expect(await count('pay_runs', f.orgId)).toBe(0);
  });

  it('paid from office cash: unchanged - posts, no party', async () => {
    const f = await fixture('pr-of');
    await workedDay(f, '2026-01-05');
    await run(f, f.officeId);
    expect(await creditsOn(f.orgId, '1130')).toEqual([
      expect.objectContaining({ party_type: null, party_id: null, credit: '600.00' }),
    ]);
  });
});

describe('T-486 - 13th month payout', () => {
  const run = (f: F, moneyAccountId: string) =>
    asOrg(f.orgId, (tx) => post13thMonthRun(tx, f.admin, { storeId: f.storeId, year: 2026, moneyAccountId }));

  it('paid from an e-wallet: posts, credit carries the party', async () => {
    const f = await fixture('tm-ew');
    await postedPeriod(f, '2026-01-01', '2026-01-15', '12000.00');
    await run(f, f.ewalletId);
    const c = await creditsOn(f.orgId, '1140');
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ party_type: 'money_account', party_id: f.ewalletId, source_type: 'thirteenthmonthpayout' });
  });

  it('paid from the staff float: refused by name, nothing written', async () => {
    const f = await fixture('tm-fl');
    await postedPeriod(f, '2026-01-01', '2026-01-15', '12000.00');
    const before = await count('journal_entries', f.orgId);
    await expectFloatRefusal(run(f, f.floatId));
    expect(await count('journal_entries', f.orgId)).toBe(before);
    expect(await count('thirteenth_month_runs', f.orgId)).toBe(0);
  });

  it('paid from office cash: unchanged - posts, no party', async () => {
    const f = await fixture('tm-of');
    await postedPeriod(f, '2026-01-01', '2026-01-15', '12000.00');
    await run(f, f.officeId);
    const c = (await creditsOn(f.orgId, '1130')).filter((x) => x.source_type === 'thirteenthmonthpayout');
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ party_type: null, party_id: null });
  });
});

describe('T-486 - separation (final pay + unused SIL)', () => {
  const run = (f: F, moneyAccountId: string) => asOrg(f.orgId, (tx) => postSeparation(tx, f.admin, sepInput(f, moneyAccountId)));

  it('paid from an e-wallet: BOTH credits (final pay and SIL) carry the party', async () => {
    const f = await separable('sp-ew');
    await run(f, f.ewalletId);
    const c = await creditsOn(f.orgId, '1140');
    expect(c).toHaveLength(2);
    expect(c.map((x) => x.source_type).sort()).toContain('separation');
    for (const l of c) expect(l).toMatchObject({ party_type: 'money_account', party_id: f.ewalletId });
  });

  it('paid from the staff float: refused by name, nothing written', async () => {
    const f = await separable('sp-fl');
    const before = await count('journal_entries', f.orgId);
    await expectFloatRefusal(run(f, f.floatId));
    expect(await count('journal_entries', f.orgId)).toBe(before);
    expect(await count('separations', f.orgId)).toBe(0);
  });

  it('paid from office cash: unchanged - posts both credits, no party', async () => {
    const f = await separable('sp-of');
    await run(f, f.officeId);
    const c = await creditsOn(f.orgId, '1130');
    expect(c).toHaveLength(2);
    for (const l of c) expect(l).toMatchObject({ party_type: null, party_id: null });
  });
});
