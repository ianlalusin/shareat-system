import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-143 — pooled remittance. Bible rows 144–147 and **157**.
 *
 * ⭐ The claim under test is Ian's: *"remittance is derived from sales report — they are one…
 * it must be END DAY REPORT."* So a day is owed **the cashier's net movement**, and these tests
 * put non-sales money in the till on purpose — a collection, an expense paid out of it — to prove
 * the day is not merely its sales.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import {
  closeDb,
  findingsRepo,
  moneyAccountsRepo,
  remittanceRepo,
  storesRepo,
  transaction,
  APP_ROLE,
  type Tx,
} from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { money } from '@shareat/core/money';
import {
  createRemittance,
  resolveRemittanceVariance,
  createMoneyTransfer,
  reverseRemittance,
  setStoreCashPolicy,
  setTillFloat,
} from '@shareat/domain';

const sql = postgres(url, { max: 5 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function newOrg(hint: string) {
  const code = uid(`rem-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  await seedChartOfAccounts(sql, org!.id);
  // T-346 S3: opening_date in the past (before 2026, this file's whole calendar), so once
  // `tillFloatOffTarget`'s pre-opening-AND-zero-balance suppression (R1.6) lands, these stores read
  // as already-open and till-float mismatches keep firing exactly as this file expects today.
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, opening_date) values (${org!.id}, ${uid(hint)}, ${`Store ${hint}`}, '2020-01-01') returning id
  `;
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${org!.id}, '2026-01-01', '2026-01-31', 'open')
  `;
  return { orgId: org!.id, storeId: store!.id };
}

async function person(orgId: string, storeId: string, name: string, role?: string) {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id
  `;
  if (role) {
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  }
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  return p!.id;
}

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
  const o = await newOrg(hint);
  const adminId = await person(o.orgId, o.storeId, 'Admin', 'admin');
  const [till] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${o.storeId}
      and instrument = 'cash' and custodian = 'cashier' and is_foundation
  `;
  const [safe] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${o.storeId}
      and instrument = 'cash' and custodian = 'office' and is_foundation
  `;
  return { ...o, adminId, admin: actor(o.orgId, adminId), till: till!.id, safe: safe!.id };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * Puts opening cash in the OFFICE safe, so a transfer out of it has something to draw on.
 *
 * ⚠️ Needed because the overdraft guard (bible row 154) genuinely blocks an office account going
 * negative — *"unlike a cashier drawer, this balance is complete"*. A first draft of the float
 * tests skipped this and was refused, which is the guard working, not a bug.
 */
async function officeOpening(f: Fixture, date: string, amount: string) {
  const [period] = await sql<{ id: string }[]>`
    select id from fiscal_periods where org_id = ${f.orgId} limit 1
  `;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, ${date}, ${period!.id}, 'opening_balance', ${uid('src')}, 'draft')
      returning id
    `;
    const [office] = await tx<{ id: string }[]>`
      select id from accounts where org_id = ${f.orgId} and code = '1130'
    `;
    const [equity] = await tx<{ id: string }[]>`
      select id from accounts where org_id = ${f.orgId} and code = '3900'
    `;
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 1, ${office!.id}, ${f.storeId}, ${amount}, '0')
    `;
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 2, ${equity!.id}, ${f.storeId}, '0', ${amount})
    `;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

/** Puts money into (or out of) the till on a given date, as some non-transfer document. */
async function tillMovement(f: Fixture, date: string, amount: string, sourceType = 'sale') {
  const [period] = await sql<{ id: string }[]>`
    select id from fiscal_periods where org_id = ${f.orgId} limit 1
  `;
  const positive = Number(amount) >= 0;
  const abs = Math.abs(Number(amount)).toFixed(2);
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, ${date}, ${period!.id}, ${sourceType}, ${uid('src')}, 'draft') returning id
    `;
    const [cash] = await tx<{ id: string }[]>`
      select id from accounts where org_id = ${f.orgId} and code = '1110'
    `;
    const [other] = await tx<{ id: string }[]>`
      select id from accounts where org_id = ${f.orgId} and code = ${positive ? '4100' : '6160'}
    `;
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 1, ${cash!.id}, ${f.storeId}, ${positive ? abs : '0'}, ${positive ? '0' : abs})
    `;
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 2, ${other!.id}, ${f.storeId}, ${positive ? '0' : abs}, ${positive ? abs : '0'})
    `;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

/** A verified sales day for a date — the LOCK that makes the date remittable. */
async function verifiedDay(f: Fixture, date: string) {
  const [row] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales,
                            ala_carte_sales, created_by)
    values (${f.orgId}, ${f.storeId}, ${date}, 'verified', '0', '0', '0', ${f.adminId})
    returning id
  `;
  return row!.id;
}

async function reports(f: Fixture, upTo = '2026-01-31') {
  return asOrg(f.orgId, (tx) =>
    remittanceRepo.endDayReports(tx, f.orgId, { storeId: f.storeId, upTo }),
  );
}

/**
 * T-324 §7.1 — the SEVEN tables a `createRemittance` attempt can write to, snapshotted so a
 * refusal can be proven by DELTA rather than by count. `money_transfers` cannot be asserted to
 * zero (the float-remit fixture already holds one row before any remittance is attempted), and
 * `createMoneyTransfer` posts a real ledger entry — `journal_entries` + `journal_lines` — before
 * it inserts the transfer row, so a check watching only the remittance tables could miss a
 * refusal that still left a posted entry behind.
 */
async function ledgerAndRemittanceSnapshot(f: Fixture) {
  const [row] = await sql<
    {
      remittances: string;
      lines: string;
      allocations: string;
      variances: string;
      transfers: string;
      entries: string;
      entry_lines: string;
    }[]
  >`
    select
      (select count(*)::text from remittances where store_id = ${f.storeId}) as remittances,
      (select count(*)::text from remittance_lines rl
         join remittances r on r.id = rl.remittance_id where r.store_id = ${f.storeId}) as lines,
      (select count(*)::text from remittance_allocations ra
         join remittances r on r.id = ra.remittance_id where r.store_id = ${f.storeId}) as allocations,
      (select count(*)::text from remittance_variances rv
         join remittances r on r.id = rv.remittance_id where r.store_id = ${f.storeId}) as variances,
      (select count(*)::text from money_transfers where store_id = ${f.storeId}) as transfers,
      (select count(*)::text from journal_entries where org_id = ${f.orgId}) as entries,
      (select count(*)::text from journal_lines jl
         join journal_entries je on je.id = jl.entry_id where je.org_id = ${f.orgId}) as entry_lines
  `;
  return row!;
}

async function expectLedgerUnchanged(
  f: Fixture,
  before: Awaited<ReturnType<typeof ledgerAndRemittanceSnapshot>>,
): Promise<void> {
  expect(await ledgerAndRemittanceSnapshot(f)).toEqual(before);
}

beforeAll(async () => {
  await sql`
    truncate table
      remittance_variances, remittance_allocations, remittance_lines, remittances,
      scheduler_runs, prepaid_items, money_transfers, money_accounts, sales_day_tenders,
      sales_day_channels, sales_days, sales_channels, expense_payments, expenses,
      expense_categories, person_grants, person_store_scope, person_roles,
      journal_lines, journal_entries, audit_log, fiscal_periods, accounts, fixed_assets,
      person_identities, persons, stores, organizations
    restart identity cascade
  `;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('⭐ the END-DAY REPORT is the cashier’s net movement, not the sales (row 157)', () => {
  it('includes a collection and nets off an expense paid from the till', async () => {
    const f = await fixture('endday');
    await verifiedDay(f, '2026-01-01');
    await tillMovement(f, '2026-01-01', '10000.00', 'sale');
    await tillMovement(f, '2026-01-01', '5000.00', 'ar_collection'); // money in, not a sale
    await tillMovement(f, '2026-01-01', '-2000.00', 'expense'); // paid out of the till

    const [day] = await reports(f);
    // ⭐ 10,000 + 5,000 − 2,000. A model that owed only the day's SALES would say 10,000 and leave
    // ₱3,000 of real money with no day to belong to — the gap Ian's correction closes.
    expect(day!.owed).toBe('13000.00');
    expect(day!.remittable).toBe(true);
  });

  it('⚠️ an UNVERIFIED day is not remittable — no signed count behind it', async () => {
    const f = await fixture('unverified');
    await tillMovement(f, '2026-01-01', '10000.00');
    const [day] = await reports(f);
    expect(day!.owed).toBe('10000.00');
    expect(day!.remittable).toBe(false);
  });
});

describe('⭐ Ian’s worked example, end to end', () => {
  it('five days at ₱10,000, ₱46,000 handed over: 1–4 settled, ₱4,000 short on day 5', async () => {
    const f = await fixture('worked');
    for (const d of ['01', '02', '03', '04', '05']) {
      await verifiedDay(f, `2026-01-${d}`);
      await tillMovement(f, `2026-01-${d}`, '10000.00');
    }

    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, {
        storeId: f.storeId,
        remittedOn: '2026-01-06',
        lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '46000.00' }],
      }),
    );

    expect(r.settled).toEqual([
      { businessDate: '2026-01-01', amount: '10000.00' },
      { businessDate: '2026-01-02', amount: '10000.00' },
      { businessDate: '2026-01-03', amount: '10000.00' },
      { businessDate: '2026-01-04', amount: '10000.00' },
      { businessDate: '2026-01-05', amount: '6000.00' },
    ]);
    expect(r.variance).toBe('-4000.00');

    // ⛔ The variance is OPEN and attached to NOBODY. FIFO put it on the 5th; that says nothing
    // about who was holding the money (row 144).
    const [v] = await sql<{ status: string; business_date: string; charged_to_person_id: string | null }[]>`
      select status, business_date::text, charged_to_person_id from remittance_variances
      where remittance_id = ${r.id}
    `;
    expect(v).toMatchObject({ status: 'open', business_date: '2026-01-05', charged_to_person_id: null });

    // ⭐ And the money really moved, through the ONE transfer path.
    const [line] = await sql<{ n: number }[]>`
      select count(*)::int n from remittance_lines rl
      join money_transfers mt on mt.id = rl.money_transfer_id
      where rl.remittance_id = ${r.id} and mt.status = 'posted'
    `;
    expect(line!.n).toBe(1);
  });

  it('⭐ a second batch is ADDITIVE — it settles what the first left (row 146)', async () => {
    const f = await fixture('additive');
    for (const d of ['01', '02']) {
      await verifiedDay(f, `2026-01-${d}`);
      await tillMovement(f, `2026-01-${d}`, '10000.00');
    }
    await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, {
        storeId: f.storeId,
        remittedOn: '2026-01-03',
        lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '15000.00' }],
      }),
    );

    // Day 1 fully settled, day 2 owes ₱5,000. The second handover picks up exactly that.
    const r2 = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, {
        storeId: f.storeId,
        remittedOn: '2026-01-04',
        lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '5000.00' }],
      }),
    );
    expect(r2.settled).toEqual([{ businessDate: '2026-01-02', amount: '5000.00' }]);
    expect(r2.variance).toBeNull();
  });
});

describe('the refusals', () => {
  it('⛔ a shortage cannot be charged to nobody', async () => {
    const f = await fixture('nobody');
    await verifiedDay(f, '2026-01-01');
    await tillMovement(f, '2026-01-01', '10000.00');
    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, {
        storeId: f.storeId,
        remittedOn: '2026-01-02',
        lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '9000.00' }],
      }),
    );
    expect(r.varianceId).toBeTruthy();

    // ⛔ v1's builder throws rather than infer a chargeToStaffId. Ported — and also a CHECK
    // constraint, so no code path can skip it.
    await expect(
      asOrg(f.orgId, (tx) =>
        resolveRemittanceVariance(tx, f.admin, {
          varianceId: r.varianceId!,
          action: 'charge',
          personId: '',
        }),
      ),
    ).rejects.toThrow(/needs a person/);

    // Ian, 2026-09-30: NO write-off — a shortage is always charged to staff. Refused permanently.
    await expect(
      asOrg(f.orgId, (tx) =>
        resolveRemittanceVariance(tx, f.admin, {
          varianceId: r.varianceId!,
          action: 'write_off',
          reason: '   ',
        }),
      ),
    ).rejects.toThrow(/write_off is retired/);

    // Naming a person closes it.
    const cashierId = await person(f.orgId, f.storeId, 'Cashier on duty');
    await asOrg(f.orgId, (tx) =>
      resolveRemittanceVariance(tx, f.admin, {
        varianceId: r.varianceId!,
        action: 'charge',
        personId: cashierId,
        on: '2026-01-02',
      }),
    );
    const [v] = await sql<{ status: string }[]>`
      select status from remittance_variances where id = ${r.varianceId}
    `;
    expect(v!.status).toBe('charged');
  });

  it('⛔ a remittance runs cashier → office, never the other way', async () => {
    const f = await fixture('backwards');
    await expect(
      asOrg(f.orgId, (tx) =>
        createRemittance(tx, f.admin, {
          storeId: f.storeId,
          remittedOn: '2026-01-02',
          // A float top-up wearing a remittance's name would settle days it never funded.
          lines: [{ fromMoneyAccountId: f.safe, toMoneyAccountId: f.till, amount: '1000.00' }],
        }),
      ),
    ).rejects.toThrow(/from the cashier to the office/);
  });

  it('⛔ DEF-052: accept_remittance actually denies — in v1 it enforced nothing', async () => {
    const f = await fixture('deny');
    const staffId = await person(f.orgId, f.storeId, 'Staff', 'staff');
    await expect(
      asOrg(f.orgId, (tx) =>
        createRemittance(tx, actor(f.orgId, staffId), {
          storeId: f.storeId,
          remittedOn: '2026-01-02',
          lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '100.00' }],
        }),
      ),
    ).rejects.toThrow(AuthorizationError);
  });
});

describe('reversal', () => {
  it('⭐ reversing un-settles the days, derived rather than repaired', async () => {
    const f = await fixture('reverse');
    await verifiedDay(f, '2026-01-01');
    await tillMovement(f, '2026-01-01', '10000.00');
    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, {
        storeId: f.storeId,
        remittedOn: '2026-01-02',
        lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '10000.00' }],
      }),
    );
    expect((await reports(f))[0]!.owed).toBe('0.00');

    await asOrg(f.orgId, (tx) =>
      reverseRemittance(tx, f.admin, { remittanceId: r.id, reason: 'Counted wrong' }),
    );

    // ⭐ Nothing was repaired: the allocations simply stop counting, because the remittance is no
    // longer `posted`. The day is owed its full amount again.
    expect((await reports(f))[0]!.owed).toBe('10000.00');
  });
});

// =====================================================================================
// T-152 — the cash policy: cadence and ceiling. Bible row 129.
// =====================================================================================

describe('T-152 — the cash-custody policy', () => {
  it('an admin may set a pooled cadence with a ceiling', async () => {
    const f = await fixture('policy-ok');
    await asOrg(f.orgId, (tx) =>
      setStoreCashPolicy(tx, f.admin, {
        storeId: f.storeId,
        remittanceCadence: 'weekly',
        unremittedCeiling: '20000.00',
      }),
    );
    const policy = await asOrg(f.orgId, (tx) => storesRepo.cashPolicy(tx, f.orgId, f.storeId));
    expect(policy!.remittanceCadence).toBe('weekly');
    expect(Number(policy!.unremittedCeiling)).toBe(20000);
  });

  it('⛔ STAFF may not — setting the ceiling is policy, not an operational act', async () => {
    const f = await fixture('policy-deny');
    const staffId = await person(f.orgId, f.storeId, 'Staff', 'staff');
    await expect(
      asOrg(f.orgId, (tx) =>
        setStoreCashPolicy(tx, actor(f.orgId, staffId), {
          storeId: f.storeId,
          remittanceCadence: 'weekly',
          unremittedCeiling: '20000.00',
        }),
      ),
    ).rejects.toThrow(AuthorizationError);
  });

  it('⛔ nor may a MANAGER — you cannot raise the bar you are measured against', async () => {
    const f = await fixture('policy-mgr-deny');
    const mgrId = await person(f.orgId, f.storeId, 'Manager', 'manager');
    await expect(
      asOrg(f.orgId, (tx) =>
        setStoreCashPolicy(tx, actor(f.orgId, mgrId), {
          storeId: f.storeId,
          remittanceCadence: 'weekly',
          unremittedCeiling: '20000.00',
        }),
      ),
      // ⭐ Ian, 2026-08-29: "configurable by admin". A manager holds `manage_store_settings` and
      // still cannot do this — a manager running late on remittance could otherwise raise the
      // ceiling and watch the finding disappear, the control deleting its own evidence.
    ).rejects.toThrow(AuthorizationError);
  });

  it('⭐ but an ADMIN may — the risk limit belongs to whoever carries the risk', async () => {
    const f = await fixture('policy-admin');
    await asOrg(f.orgId, (tx) =>
      setStoreCashPolicy(tx, f.admin, {
        storeId: f.storeId,
        remittanceCadence: 'every_3_days',
        unremittedCeiling: '12000.00',
      }),
    );
    const policy = await asOrg(f.orgId, (tx) => storesRepo.cashPolicy(tx, f.orgId, f.storeId));
    expect(policy!.remittanceCadence).toBe('every_3_days');
  });

  it('⛔ the DATABASE refuses pooling with no ceiling — the rule has no TypeScript copy', async () => {
    const f = await fixture('policy-noceil');
    await expect(
      asOrg(f.orgId, (tx) =>
        setStoreCashPolicy(tx, f.admin, {
          storeId: f.storeId,
          remittanceCadence: 'weekly',
          unremittedCeiling: null,
        }),
      ),
      // ⭐ The constraint's own name, not a message this layer invented. Bible §6.3: a rule
      // re-implemented in the service layer is a second source of truth, and the two drift.
    ).rejects.toThrow(/stores_pooling_requires_ceiling_check/);
  });

  it('⭐ going back to daily may clear the ceiling — daily is its own bound', async () => {
    const f = await fixture('policy-back');
    const set = (cadence: 'daily' | 'weekly', ceiling: string | null) =>
      asOrg(f.orgId, (tx) =>
        setStoreCashPolicy(tx, f.admin, {
          storeId: f.storeId,
          remittanceCadence: cadence,
          unremittedCeiling: ceiling,
        }),
      );
    await set('weekly', '5000.00');
    await set('daily', null);
    const policy = await asOrg(f.orgId, (tx) => storesRepo.cashPolicy(tx, f.orgId, f.storeId));
    expect(policy!.remittanceCadence).toBe('daily');
    expect(policy!.unremittedCeiling).toBeNull();
  });
});

// =====================================================================================
// Cash arriving by TRANSFER is custody, not takings. T-143 / T-152 / T-153.
// =====================================================================================

/**
 * ⚠️ **These tests were written for a model Ian then corrected**, and they are kept because the
 * property they prove is real and load-bearing — only the story around it changed.
 *
 * They originally argued that the till float needs no machinery: money transferred into a cashier
 * account is not takings, so remitting the day's movement leaves it sitting there. **The
 * arithmetic is right; the model was wrong.** Ian, 2026-08-29: *"you read it wrong… it's on a side
 * pocket of the cashier"* — a segregated pot with a configured target, not a residue of the
 * takings account. T-153 has the corrected design, and the float will live in its own `1115`.
 *
 * ⭐ **What these still prove, and it is worth guarding:** a transfer into a cashier account
 * NEVER becomes something the cashier must hand over. That is what stops a float top-up, an
 * office change delivery, or any other custody movement from silently inflating a day's expected
 * remittance — and it is the reason the float cannot be swept by accident.
 */
describe('cash arriving by transfer is custody, and never becomes a day’s takings', () => {
  it('⭐ a transfer IN raises the balance but leaves every day owing exactly what it did', async () => {
    const f = await fixture('float');
    await officeOpening(f, '2026-01-01', '50000.00');
    await verifiedDay(f, '2026-01-02');
    await tillMovement(f, '2026-01-02', '8000.00');

    const before = await asOrg(f.orgId, (tx) =>
      remittanceRepo.endDayReports(tx, f.orgId, { storeId: f.storeId, upTo: '2026-01-31' }),
    );
    const owedBefore = before.find((r) => r.businessDate === '2026-01-02')!.owed;

    // The float: office safe -> till, an ordinary money transfer. This is the whole feature.
    await asOrg(f.orgId, (tx) =>
      createMoneyTransfer(tx, f.admin, { requestId: crypto.randomUUID(),
        fromMoneyAccountId: f.safe,
        toMoneyAccountId: f.till,
        amountOut: '20000.00',
        amountIn: '20000.00',
        transferDate: '2026-01-02',
        notes: 'Standing till float',
      }),
    );

    const after = await asOrg(f.orgId, (tx) =>
      remittanceRepo.endDayReports(tx, f.orgId, { storeId: f.storeId, upTo: '2026-01-31' }),
    );
    const owedAfter = after.find((r) => r.businessDate === '2026-01-02')!.owed;

    // ⛔ THE POINT. The float is custody, not takings: `endDayReports` excludes
    // `source_type = 'transfer'` in both directions, so ₱20,000 landing in the till does not
    // become ₱20,000 the cashier must hand over. v1 proves the same rule from the other side —
    // its `netCashFlows` omits the float, so `computedRemittanceCash` never includes it.
    expect(Number(owedAfter)).toBeCloseTo(Number(owedBefore), 2);
    expect(Number(owedAfter)).toBeCloseTo(8000, 2);

    // ⭐ And the till's BALANCE does include it — which is what makes a daily count checkable
    // against the books instead of against everyone's memory of "there's an extra 20k".
    const balance = await asOrg(f.orgId, async (tx) => {
      const acct = await moneyAccountsRepo.getById(tx, f.orgId, f.till);
      return moneyAccountsRepo.balanceOf(tx, f.orgId, acct!);
    });
    expect(Number(balance)).toBeCloseTo(28000, 2);
  });

  it('⭐ and transferred-in cash is NOT swept by a remittance that settles the day in full', async () => {
    const f = await fixture('float-remit');
    await officeOpening(f, '2026-01-01', '50000.00');
    await verifiedDay(f, '2026-01-02');
    await tillMovement(f, '2026-01-02', '8000.00');
    await asOrg(f.orgId, (tx) =>
      createMoneyTransfer(tx, f.admin, { requestId: crypto.randomUUID(),
        fromMoneyAccountId: f.safe,
        toMoneyAccountId: f.till,
        amountOut: '20000.00',
        amountIn: '20000.00',
        transferDate: '2026-01-02',
        notes: 'Standing till float',
      }),
    );

    // Remit the day's takings — and only the takings.
    await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, {
        storeId: f.storeId,
        remittedOn: '2026-01-03',
        lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '8000.00' }],
      }),
    );

    const balance = await asOrg(f.orgId, async (tx) => {
      const acct = await moneyAccountsRepo.getById(tx, f.orgId, f.till);
      return moneyAccountsRepo.balanceOf(tx, f.orgId, acct!);
    });
    // ⭐ The transferred-in cash survives a full remittance: only the day's movement goes to the
    // office. ⚠️ Under T-153's corrected design the float is not held here at all — it sits in its
    // own `1115` pot. ⛔ T-324 spec §10 trap 10: this guards that a CORRECT amount does not sweep
    // the float — it does NOT guard that an INCORRECT one cannot. That gap WAS DEF-357: before
    // the cap landed, this same fixture's whole drawer walked out with no refusal when nothing
    // bounded it. The §7.2 case in this same describe ("cash arriving by transfer is custody…")
    // now asserts the opposite — refused, nothing written — which is what closed the gap.
    expect(Number(balance)).toBeCloseTo(20000, 2);

    const reports = await asOrg(f.orgId, (tx) =>
      remittanceRepo.endDayReports(tx, f.orgId, { storeId: f.storeId, upTo: '2026-01-31' }),
    );
    expect(Number(reports.find((r) => r.businessDate === '2026-01-02')!.owed)).toBeCloseTo(0, 2);
  });

  it('⛔⛔ T-324 §7.2 — DEF-357: the whole drawer is REFUSED when no overage is declared, and nothing is written', async () => {
    const f = await fixture('float-remit-cap');
    await officeOpening(f, '2026-01-01', '50000.00');
    await verifiedDay(f, '2026-01-02');
    await tillMovement(f, '2026-01-02', '8000.00');
    await asOrg(f.orgId, (tx) =>
      createMoneyTransfer(tx, f.admin, { requestId: crypto.randomUUID(),
        fromMoneyAccountId: f.safe,
        toMoneyAccountId: f.till,
        amountOut: '20000.00',
        amountIn: '20000.00',
        transferDate: '2026-01-02',
        notes: 'Standing till float',
      }),
    );

    const before = await ledgerAndRemittanceSnapshot(f);

    // ⭐ Same fixture shape as ':562-600' above, but the WHOLE ₱28,000 drawer — day + float — with
    // no overage declared. §7.2: this must be REJECTED, not swept through as a huge variance.
    await expect(
      asOrg(f.orgId, (tx) =>
        createRemittance(tx, f.admin, {
          storeId: f.storeId,
          remittedOn: '2026-01-03',
          lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '28000.00' }],
        }),
      ),
      // ⭐ Tightened (orchestrator, 2026-09-19): a bare `/createRemittance:/` prefix is satisfied
      // by ANY refusal in this function — the negative-declaration guard, the float guard, the
      // custodian-direction check, all of them. Matched here to the per-account cap message's own
      // distinctive fragment, captured verbatim via a throwaway scratch check against the frozen
      // source: `"Cashier cash" hands over ₱28,000.00 ..., but it only moved ₱8,000.00 over the
      // settleable dates — declare the overage to hand over more.`
    ).rejects.toThrow(/over the settleable dates/);

    await expectLedgerUnchanged(f, before);

    const balance = await asOrg(f.orgId, async (tx) => {
      const acct = await moneyAccountsRepo.getById(tx, f.orgId, f.till);
      return moneyAccountsRepo.balanceOf(tx, f.orgId, acct!);
    });
    expect(Number(balance)).toBeCloseTo(28000, 2);
  });

  it('⭐ the amount is irrelevant to the arithmetic — a different sum behaves identically', async () => {
    // ⭐ Expected remittance is the period's MOVEMENT, not the account's BALANCE (row 145), so the
    // size of a custody transfer never changes what a day owes. ⚠️ This is NOT the argument that
    // the float needs no configuration — Ian corrected that (T-153 §2); the float's target is
    // configured and checked against its own account. This only pins the remittance arithmetic.
    const f = await fixture('float-varies');
    await officeOpening(f, '2026-01-01', '50000.00');
    await verifiedDay(f, '2026-01-02');
    await tillMovement(f, '2026-01-02', '6500.00');
    await asOrg(f.orgId, (tx) =>
      createMoneyTransfer(tx, f.admin, { requestId: crypto.randomUUID(),
        fromMoneyAccountId: f.safe,
        toMoneyAccountId: f.till,
        amountOut: '15000.00', // ⭐ not 20,000 — a different store, a different number
        amountIn: '15000.00',
        transferDate: '2026-01-02',
        notes: 'Standing till float',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, {
        storeId: f.storeId,
        remittedOn: '2026-01-03',
        lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '6500.00' }],
      }),
    );
    const balance = await asOrg(f.orgId, async (tx) => {
      const acct = await moneyAccountsRepo.getById(tx, f.orgId, f.till);
      return moneyAccountsRepo.balanceOf(tx, f.orgId, acct!);
    });
    expect(Number(balance)).toBeCloseTo(15000, 2);
  });
});

// =====================================================================================
// T-153 — the till float: a side pocket with its own target
// =====================================================================================

describe('T-153 — the till float (a target on the cashier drawer, T-316)', () => {
  const potFor = async (f: Fixture, target: string) =>
    asOrg(f.orgId, (tx) => setTillFloat(tx, f.admin, { storeId: f.storeId, target }));

  it('⭐ T-316 S1: setting a target puts it on the existing Cashier cash (1110) account — it creates nothing, and the drawer starts under target, which the finding says at once', async () => {
    const f = await fixture('float-new');
    const { moneyAccountId } = await potFor(f, '20000.00');
    const acct = await asOrg(f.orgId, (tx) =>
      moneyAccountsRepo.getById(tx, f.orgId, moneyAccountId),
    );
    expect(acct!.glAccountCode).toBe('1110'); // T-316 S1 (was '1115')
    expect(acct!.isFoundation).toBe(true); // the existing Cashier cash, not a new account
    expect(acct!.custodian).toBe('cashier');
    expect(Number(acct!.floatTarget)).toBe(20000);

    // ⛔ Deliberate: a target is not money. The drawer is ₱20,000 short of its float until the office
    // funds it, and the books must not pretend any cash is there that was never transferred in.
    const found = await asOrg(f.orgId, (tx) => findingsRepo.tillFloatOffTarget(tx, f.orgId));
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toMatch(/short/);
  });

  it('⭐ funded from the office, it goes quiet', async () => {
    const f = await fixture('float-funded');
    await officeOpening(f, '2026-01-01', '50000.00');
    const { moneyAccountId } = await potFor(f, '20000.00');
    await asOrg(f.orgId, (tx) =>
      createMoneyTransfer(tx, f.admin, { requestId: crypto.randomUUID(),
        fromMoneyAccountId: f.safe,
        toMoneyAccountId: moneyAccountId,
        amountOut: '20000.00',
        amountIn: '20000.00',
        transferDate: '2026-01-02',
        notes: 'Fund the till float',
      }),
    );
    expect(await asOrg(f.orgId, (tx) => findingsRepo.tillFloatOffTarget(tx, f.orgId))).toEqual([]);
  });

  it('⭐ T-316 S2: the float-carrying drawer IS remitted — what the verified days owe goes, the float stays (the T-153 separate-pot refusal is gone)', async () => {
    // T-153 premise (gone, 0184): the float was a side pocket that a remittance must never touch.
    // The float is now a target on the cashier's own takings drawer — the remittance source — so
    // the old refusal ("a float is never remitted") would refuse EVERY cash remittance at a float
    // store. What stays true: the handover carries only what the verified days owe (T-S2 file).
    const f = await fixture('float-noremit');
    await officeOpening(f, '2026-01-01', '50000.00');
    const { moneyAccountId } = await potFor(f, '20000.00');
    expect(moneyAccountId).toBe(f.till); // the float sits on the drawer itself
    await asOrg(f.orgId, (tx) =>
      createMoneyTransfer(tx, f.admin, { requestId: crypto.randomUUID(),
        fromMoneyAccountId: f.safe,
        toMoneyAccountId: moneyAccountId,
        amountOut: '20000.00',
        amountIn: '20000.00',
        transferDate: '2026-01-02',
      }),
    );
    await verifiedDay(f, '2026-01-02');
    await tillMovement(f, '2026-01-02', '5000.00');

    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, {
        storeId: f.storeId,
        remittedOn: '2026-01-03',
        lines: [{ fromMoneyAccountId: moneyAccountId, toMoneyAccountId: f.safe, amount: '5000.00' }],
      }),
    );
    expect(r.settled).toEqual([{ businessDate: '2026-01-02', amount: '5000.00' }]);
    expect(r.variance).toBeNull();

    // ⭐ The float stayed in the drawer: 20,000 + 5,000 − 5,000.
    const balance = await asOrg(f.orgId, async (tx) => {
      const acct = await moneyAccountsRepo.getById(tx, f.orgId, moneyAccountId);
      return moneyAccountsRepo.balanceOf(tx, f.orgId, acct!);
    });
    expect(Number(balance)).toBeCloseTo(20000, 2);
  });

  it('⛔ STAFF and MANAGER may not set a float — it is a risk figure, like the ceiling', async () => {
    const f = await fixture('float-deny');
    const staffId = await person(f.orgId, f.storeId, 'Staff', 'staff');
    const mgrId = await person(f.orgId, f.storeId, 'Manager', 'manager');
    for (const id of [staffId, mgrId]) {
      await expect(
        asOrg(f.orgId, (tx) =>
          setTillFloat(tx, actor(f.orgId, id), { storeId: f.storeId, target: '20000.00' }),
        ),
      ).rejects.toThrow(AuthorizationError);
    }
  });

  it('⛔ one target per store — the database refuses a second (T-316 S1: both rows are 1110 cashier cash)', async () => {
    const f = await fixture('float-one');
    await potFor(f, '20000.00');
    // ⭐ Not tidiness: `balanceOf` scopes a non-1140 account by (gl code, store), so two pots would
    // share one balance and the detector would judge it against two targets.
    await expect(
      asOrg(f.orgId, (tx) =>
        moneyAccountsRepo.insertMoneyAccount(tx, {
          orgId: f.orgId,
          storeId: f.storeId,
          name: 'Second float',
          instrument: 'cash',
          custodian: 'cashier',
          glAccountCode: '1110', // T-316 S1 (was '1115'): the shape check now admits only 1110
          floatTarget: money('5000.00'),
        }),
      ),
    ).rejects.toThrow(/money_accounts_one_float_per_store/);
  });

  it('⛔ a float target may not sit on a wallet or an office safe', async () => {
    const f = await fixture('float-shape');
    await expect(
      asOrg(f.orgId, (tx) =>
        moneyAccountsRepo.insertMoneyAccount(tx, {
          orgId: f.orgId,
          storeId: f.storeId,
          name: 'Bogus float',
          instrument: 'ewallet',
          custodian: 'office',
          glAccountCode: '1140',
          floatTarget: money('5000.00'),
        }),
      ),
    ).rejects.toThrow(/money_accounts_float_target_shape_check/);
  });
});

describe('T-324 §3 — the cap is PER CASHIER ACCOUNT, and a declared overage is the release valve', () => {
  async function fixtureWithWallet(hint: string) {
    const f = await fixture(hint);
    const [wallet] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${f.storeId}
        and instrument = 'ewallet' and custodian = 'cashier' and is_foundation
    `;
    return { ...f, wallet: wallet!.id };
  }
  type WalletFixture = Awaited<ReturnType<typeof fixtureWithWallet>>;

  /** Puts online takings into the CASHIER WALLET, the shape `sales-days/routing.ts:265,284`
   *  posts — a 1140 leg names the wallet via `party_type='money_account'`/`party_id`, or the
   *  per-account read cannot resolve which wallet moved (1140 `requires_party`). */
  async function walletMovement(f: WalletFixture, date: string, amount: string) {
    const [period] = await sql<{ id: string }[]>`
      select id from fiscal_periods where org_id = ${f.orgId} limit 1
    `;
    await sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
        values (${f.orgId}, ${date}, ${period!.id}, 'sale', ${uid('src')}, 'draft') returning id
      `;
      const [wallet] = await tx<{ id: string }[]>`
        select id from accounts where org_id = ${f.orgId} and code = '1140'
      `;
      const [revenue] = await tx<{ id: string }[]>`
        select id from accounts where org_id = ${f.orgId} and code = '4100'
      `;
      await tx`
        insert into journal_lines
          (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
        values
          (${e!.id}, 1, ${wallet!.id}, ${f.storeId}, ${amount}, '0', 'money_account', ${f.wallet})
      `;
      await tx`
        insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
        values (${e!.id}, 2, ${revenue!.id}, ${f.storeId}, '0', ${amount})
      `;
      await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
    });
  }

  it('⛔⛔ §7.3 — a second cashier account masks the pooled cap: a till-only handover clears a wallet debt the wallet never paid', async () => {
    const f = await fixtureWithWallet('mask');
    await verifiedDay(f, '2026-01-01');
    await tillMovement(f, '2026-01-01', '5000.00');
    await walletMovement(f, '2026-01-01', '5000.00');
    await tillMovement(f, '2026-01-02', '20000.00'); // a later, UNVERIFIED day

    const rs = await reports(f);
    // ⭐ Confirms the setup: day 1 pools till + wallet into one owed figure — exactly §3.1's premise.
    expect(rs.find((r) => r.businessDate === '2026-01-01')!.owed).toBe('10000.00');

    const before = await ledgerAndRemittanceSnapshot(f);

    // Till only, wallet blank (omitted, as actions.ts:71 drops a blank amount). §3.1: this must be
    // REFUSED — check 1 bounds the till's OWN movement over settleable dates (₱5,000), and
    // ₱10,000 > ₱5,000 + ₱0. Today there is no per-account check, so the pooled cap (also absent)
    // has nothing to catch it either, and it goes through.
    await expect(
      asOrg(f.orgId, (tx) =>
        createRemittance(tx, f.admin, {
          storeId: f.storeId,
          remittedOn: '2026-01-03',
          lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '10000.00' }],
        }),
      ),
      // ⭐ Tightened, same reason as §7.2: must be the per-account cap firing on the TILL
      // specifically, not e.g. the ambiguity guard or the float guard. Captured verbatim.
    ).rejects.toThrow(/over the settleable dates/);

    await expectLedgerUnchanged(f, before);
  });
});

describe('T-324 §7.4 — the declared-overage companions (float-remit shape)', () => {
  async function floatRemitFixture(hint: string) {
    const f = await fixture(hint);
    await officeOpening(f, '2026-01-01', '50000.00');
    await verifiedDay(f, '2026-01-02');
    await tillMovement(f, '2026-01-02', '8000.00');
    await asOrg(f.orgId, (tx) =>
      createMoneyTransfer(tx, f.admin, { requestId: crypto.randomUUID(),
        fromMoneyAccountId: f.safe,
        toMoneyAccountId: f.till,
        amountOut: '20000.00',
        amountIn: '20000.00',
        transferDate: '2026-01-02',
        notes: 'Standing till float',
      }),
    );
    return f;
  }

  it('⭐ allowance works — a declared overage matching the excess is accepted, one positive variance, drawer swept to zero', async () => {
    const f = await floatRemitFixture('float-remit-allow');

    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, {
        storeId: f.storeId,
        remittedOn: '2026-01-03',
        lines: [
          {
            fromMoneyAccountId: f.till,
            toMoneyAccountId: f.safe,
            amount: '28000.00',
            declaredOverage: '20000.00',
          },
        ],
      }),
    );
    expect(r.variance).toBe('20000.00');
    expect(r.varianceId).toBeTruthy();

    const [v] = await sql<{ n: number }[]>`
      select count(*)::int n from remittance_variances where remittance_id = ${r.id}
    `;
    expect(v!.n).toBe(1);

    const balance = await asOrg(f.orgId, async (tx) => {
      const acct = await moneyAccountsRepo.getById(tx, f.orgId, f.till);
      return moneyAccountsRepo.balanceOf(tx, f.orgId, acct!);
    });
    expect(Number(balance)).toBeCloseTo(0, 2);

    // ⭐ THE POINT (orchestrator, 2026-09-18): tolerating the value is not the same as RECORDING
    // it. Nothing reads this column back anywhere in the app yet — this assertion is that first
    // reader, at test level, so a builder who writes NULL unconditionally cannot pass.
    const [line] = await sql<{ declared_overage: string | null }[]>`
      select declared_overage from remittance_lines where remittance_id = ${r.id}
    `;
    expect(line!.declared_overage).toBe('20000.00');
  });

  it('⭐ EXACT EQUALITY — a handover at exactly the declared excess, in centavo-precision arithmetic that raw floating point gets wrong, is accepted and the declaration recorded', async () => {
    const f = await floatRemitFixture('float-remit-exact');

    // ⛔⛔ DO NOT ROUND, TIDY OR "SIMPLIFY" 1024.12 TO 1000.00 OR ANYTHING ELSE (orchestrator,
    // 2026-09-18, swept every centavo from 0.01 upward at movement 8000.00): 1024.12 is the FIRST
    // value that diverges between raw `Number()` arithmetic and correct centavo comparison. Below
    // it, nothing does. A tidier number silently turns this into another green-under-both control
    // that proves nothing. Verified independently here in plain Node:
    //   8000.00 + 1024.12            === 9024.119999999999   (not 9024.12)
    //   9024.12 - 8000.00            === 1024.1200000000008  (not 1024.12)
    // So EITHER phrasing of the cap check — `amount <= movement + declared` or
    // `amount - movement <= declared` — done with raw `Number(...)`, wrongly REFUSES this exact,
    // correct handover. Proper centavo arithmetic (integers, or `compare()`/`add()` from
    // `@shareat/core/money`) accepts it, correctly.
    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, {
        storeId: f.storeId,
        remittedOn: '2026-01-03',
        lines: [
          {
            fromMoneyAccountId: f.till,
            toMoneyAccountId: f.safe,
            amount: '9024.12',
            declaredOverage: '1024.12',
          },
        ],
      }),
    );
    expect(r.variance).toBe('1024.12');

    // ⛔ LIMIT 1 (orchestrator): the acceptance alone is NOT a red today — with no cap in place,
    // any amount is accepted regardless of declaredOverage, so that half is green before and
    // after. Paired with the persistence assertion below (false today — no column — true once
    // migration 0154 and the builder's wiring land), the case fails today for a real reason, and
    // its acceptance half still catches a builder who reached for `Number(...)` on this exact pair.
    const [line] = await sql<{ declared_overage: string | null }[]>`
      select declared_overage from remittance_lines where remittance_id = ${r.id}
    `;
    expect(line!.declared_overage).toBe('1024.12');
  });

  it('⭐ no declared overage stores NULL — "nobody was ever asked", not "declared zero"', async () => {
    const f = await fixture('overage-null');
    await verifiedDay(f, '2026-01-01');
    await tillMovement(f, '2026-01-01', '5000.00');

    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, {
        storeId: f.storeId,
        remittedOn: '2026-01-02',
        lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '5000.00' }],
      }),
    );

    const [line] = await sql<{ declared_overage: string | null }[]>`
      select declared_overage from remittance_lines where remittance_id = ${r.id}
    `;
    expect(line!.declared_overage).toBeNull();
  });

  it("⭐ an explicit zero declaration stores '0', not NULL — \"I declare no overage\" is a real answer", async () => {
    const f = await fixture('overage-zero');
    await verifiedDay(f, '2026-01-01');
    await tillMovement(f, '2026-01-01', '5000.00');

    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, {
        storeId: f.storeId,
        remittedOn: '2026-01-02',
        lines: [
          {
            fromMoneyAccountId: f.till,
            toMoneyAccountId: f.safe,
            amount: '5000.00',
            declaredOverage: '0',
          },
        ],
      }),
    );

    const [line] = await sql<{ declared_overage: string | null }[]>`
      select declared_overage from remittance_lines where remittance_id = ${r.id}
    `;
    expect(line!.declared_overage).toBe('0.00');
  });

  it('⛔ one centavo short of the declared excess is refused, not merely a smaller variance', async () => {
    const f = await floatRemitFixture('float-remit-short');

    await expect(
      asOrg(f.orgId, (tx) =>
        createRemittance(tx, f.admin, {
          storeId: f.storeId,
          remittedOn: '2026-01-03',
          lines: [
            {
              fromMoneyAccountId: f.till,
              toMoneyAccountId: f.safe,
              amount: '28000.00',
              declaredOverage: '19999.99',
            },
          ],
        }),
      ),
      // ⭐ Tightened: must be the per-account cap firing (one centavo short of covering it), not
      // some other refusal that happens to also throw. Captured verbatim.
    ).rejects.toThrow(/over the settleable dates/);
  });

  it('⛔ a negative declared overage is refused', async () => {
    const f = await fixture('float-remit-negative');
    await verifiedDay(f, '2026-01-01');
    await tillMovement(f, '2026-01-01', '5000.00');

    await expect(
      asOrg(f.orgId, (tx) =>
        createRemittance(tx, f.admin, {
          storeId: f.storeId,
          remittedOn: '2026-01-02',
          lines: [
            {
              fromMoneyAccountId: f.till,
              toMoneyAccountId: f.safe,
              amount: '5000.00',
              declaredOverage: '-1.00',
            },
          ],
        }),
      ),
      // ⭐ Tightened: must be the negative-declaration guard specifically, not some other refusal
      // that happens to also throw. Captured verbatim: `a declared overage cannot be negative —
      // "-1.00" is.`
    ).rejects.toThrow(/cannot be negative/);
  });

  it('⛔ two active cashier accounts sharing one GL code cannot be attributed to a movement — refused', async () => {
    const f = await fixture('ambiguous-cashier');
    // ⛔ Bypasses createMoneyAccount's own service-layer refusal on purpose (money-accounts/index.ts
    // :88-90) — not reachable through the app today, since FOUNDATION_ACCOUNTS gives one account
    // per code (spec §3.4's parenthetical). Exactly why the READ must refuse it too.
    await sql`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_foundation)
      values (${f.orgId}, ${f.storeId}, 'Second cashier drawer', 'cash', '1110', 'cashier', false)
    `;
    await verifiedDay(f, '2026-01-01');
    await tillMovement(f, '2026-01-01', '5000.00');

    await expect(
      asOrg(f.orgId, (tx) =>
        createRemittance(tx, f.admin, {
          storeId: f.storeId,
          remittedOn: '2026-01-02',
          lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '5000.00' }],
        }),
      ),
      // ⭐ Tightened: must be the ambiguity guard specifically, not the per-account cap (this
      // fixture's amount matches its movement exactly, so the cap alone would accept it). Captured
      // verbatim: `cashierMovementByAccount: GL account 1110 accepts no party on its own lines,
      // and 2 active cashier accounts share it for this store — "Cashier cash", "Second cashier
      // drawer". A line on it cannot say which one moved; deactivate whichever of these is not
      // really in use.`
    ).rejects.toThrow(/cannot say which one moved/);
  });
});

describe('⛔⛔ DEF-358/T-319 — a remittance before anything is verified is refused', () => {
  /** Zero rows for this store in the three tables a remittance writes to. */
  async function nothingWrittenFor(f: Fixture): Promise<void> {
    const [rows] = await sql<{ remittances: string; lines: string; transfers: string }[]>`
      select
        (select count(*)::text from remittances where store_id = ${f.storeId}) as remittances,
        (select count(*)::text from remittance_lines rl
           join remittances r on r.id = rl.remittance_id where r.store_id = ${f.storeId}) as lines,
        (select count(*)::text from money_transfers where store_id = ${f.storeId}) as transfers
    `;
    expect(rows).toEqual({ remittances: '0', lines: '0', transfers: '0' });
  }

  // ⛔⛔ THE RED CONTROL — DEF-358 reproduced, not described (RULES §3.2). Run in isolation against
  // the code as committed at `d841aa0`, BEFORE any refusal existed:
  //   node it.mjs shareat_test_lanea packages/domain/tests/integration/remittance.test.ts \
  //     --reporter=verbose -t "reproduces DEF-358"
  //   ✓ ... reproduces DEF-358 ... 179ms — (1 passed | 27 skipped), 2026-09-17.
  // Observed, not inferred: `r.variance` was `'10000.00'` (the whole handed-over amount — nothing
  // was owed, since nothing is verified), `r.varianceId` was `null`, zero rows existed in
  // `remittance_variances` for this remittance, and one `money_transfers` row was `posted`. Then
  // the refusal below was added to `index.ts` and this same test was inverted in place — this
  // comment is the record of what running it actually showed, not a description of the code.
  it('no longer reproduces DEF-358 — a remittance before anything is verified is refused outright', async () => {
    const f = await fixture('def358-repro');
    // A cashier movement on a date NOBODY has verified — the exact shape the register describes.
    await tillMovement(f, '2026-01-01', '10000.00');

    await expect(
      asOrg(f.orgId, (tx) =>
        createRemittance(tx, f.admin, {
          storeId: f.storeId,
          remittedOn: '2026-01-02',
          lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '10000.00' }],
        }),
      ),
    ).rejects.toThrow(/createRemittance:/);

    await nothingWrittenFor(f);
  });

  it('refuses with no verified day at all, and the message names the verify remedy', async () => {
    const f = await fixture('def358-noverified');
    await tillMovement(f, '2026-01-01', '5000.00');

    await expect(
      asOrg(f.orgId, (tx) =>
        createRemittance(tx, f.admin, {
          storeId: f.storeId,
          remittedOn: '2026-01-02',
          lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '5000.00' }],
        }),
      ),
    ).rejects.toThrow(/verify/i);
  });

  it('refuses when verified days exist but every one already owes zero — a DIFFERENT message', async () => {
    const f = await fixture('def358-zeroowed');
    await verifiedDay(f, '2026-01-01');
    await tillMovement(f, '2026-01-01', '3000.00');

    // Settle it completely first — a normal, unrefused remittance.
    const first = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, {
        storeId: f.storeId,
        remittedOn: '2026-01-02',
        lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '3000.00' }],
      }),
    );
    expect(first.variance).toBeNull();

    // Nothing outstanding remains, but the day IS verified — a different situation from "nobody
    // verified anything", and Contract 2 says it must not send anyone to verify a day that already
    // exists and is already settled.
    await expect(
      asOrg(f.orgId, (tx) =>
        createRemittance(tx, f.admin, {
          storeId: f.storeId,
          remittedOn: '2026-01-03',
          lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '1.00' }],
        }),
      ),
    ).rejects.toThrow(/nothing to settle|owes nothing/i);
  });

  it('✅ still succeeds normally — one verified day owing something, allocated, money moved', async () => {
    const f = await fixture('def358-normal');
    await verifiedDay(f, '2026-01-01');
    await tillMovement(f, '2026-01-01', '7500.00');

    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, {
        storeId: f.storeId,
        remittedOn: '2026-01-02',
        lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '7500.00' }],
      }),
    );
    expect(r.settled).toEqual([{ businessDate: '2026-01-01', amount: '7500.00' }]);
    expect(r.variance).toBeNull();

    const [line] = await sql<{ n: number }[]>`
      select count(*)::int n from remittance_lines rl
      join money_transfers mt on mt.id = rl.money_transfer_id
      where rl.remittance_id = ${r.id} and mt.status = 'posted'
    `;
    expect(line!.n).toBe(1);
  });

  it('⛔ nothing is written on the refusal path — the row counts, not just the throw', async () => {
    const f = await fixture('def358-norows');
    await tillMovement(f, '2026-01-01', '2000.00');

    await expect(
      asOrg(f.orgId, (tx) =>
        createRemittance(tx, f.admin, {
          storeId: f.storeId,
          remittedOn: '2026-01-02',
          lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '2000.00' }],
        }),
      ),
      // ⭐ Tightened (orchestrator, 2026-09-19): T-324 quietly neutered this bare matcher. With
      // `settleable` empty, T-324's own per-account cap ALSO throws here (allowance `0.00 + 0.00`
      // against a ₱2,000 line) — so if T-319's refusal at index.ts:149-160 were ever removed,
      // T-324's cap would throw in its place and this test would stay green while DEF-358's crash
      // returned underneath it. Matched to T-319's own message so ONLY T-319 firing satisfies it.
    ).rejects.toThrow(/has been verified yet/);

    await nothingWrittenFor(f);
  });

  it('⛔⛔ T-324 §2: T-319 still refuses when a declaration would clear both caps — the cap is not a substitute for the verify gate', async () => {
    const f = await fixture('def358-norows-declared');
    await tillMovement(f, '2026-01-01', '2000.00');

    const before = await ledgerAndRemittanceSnapshot(f);

    // ⭐ The case the auditor traced: with `settleable` empty, `totalOwed` is `0`, so check 1's
    // allowance becomes `add('0.00', declared)` and check 2's becomes the same — a declared
    // overage covering the amount satisfies BOTH T-324 caps. If T-319's refusal did not fire at
    // all, `days = []` would reach `allocateFifo` — DEF-358's original crash: a non-zero variance
    // with a null `varianceDayId`, the guard skips the variance row, money moves with nothing
    // recording the gap. This proves T-324's caps do not stand in for T-319 here — it does NOT
    // prove T-319 runs BEFORE the caps (see the next case for that; the caps pass in THIS fixture
    // regardless of which runs first, so the order is unobservable here).
    // ⛔⛔ DO NOT ROUND OR "TIDY" '2000.00' — it must equal the handed-over amount exactly.
    // `compare('2000.00', add('0.00','2000.00'))` is `0`, not `> 0`, which is what makes both caps
    // pass. At '1999.99' check 1 would refuse on its own, and this case's central claim — that the
    // caps alone cannot catch DEF-358 here — would be false.
    await expect(
      asOrg(f.orgId, (tx) =>
        createRemittance(tx, f.admin, {
          storeId: f.storeId,
          remittedOn: '2026-01-02',
          lines: [
            {
              fromMoneyAccountId: f.till,
              toMoneyAccountId: f.safe,
              amount: '2000.00',
              declaredOverage: '2000.00',
            },
          ],
        }),
      ),
    ).rejects.toThrow(/has been verified yet/);

    await expectLedgerUnchanged(f, before);
    await nothingWrittenFor(f);
  });

  it('⛔⛔ T-324 §2: the ORDER is pinned — T-319 refuses before a declaration is even parsed, not merely before it would help', async () => {
    const f = await fixture('def358-norows-order');
    await tillMovement(f, '2026-01-01', '2000.00');

    // ⭐ The previous case's '2000.00' declaration satisfies both T-324 caps regardless of which
    // check runs first, so it cannot observe the ORDER — only that the caps don't substitute for
    // T-319 here. This one can: '-1.00' is refused by the negative-declaration guard (§7.4) on its
    // own, under a DIFFERENT message. `linesWithOverage` parses and validates the declaration only
    // AFTER T-319's `settleable.length === 0` refusal (spec §2). So:
    //   current order  → T-319 refuses first  → /has been verified yet/
    //   reordered      → declaration validated first → /cannot be negative/
    // If someone moves the caps above T-319's refusal, this case starts failing with the WRONG
    // message and stays failing — the other case would stay green throughout, because its
    // '2000.00' declaration is accepted by the caps either way.
    await expect(
      asOrg(f.orgId, (tx) =>
        createRemittance(tx, f.admin, {
          storeId: f.storeId,
          remittedOn: '2026-01-02',
          lines: [
            {
              fromMoneyAccountId: f.till,
              toMoneyAccountId: f.safe,
              amount: '2000.00',
              declaredOverage: '-1.00',
            },
          ],
        }),
      ),
    ).rejects.toThrow(/has been verified yet/);
  });
});
