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
import { closeDb, remittanceRepo, storesRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  createRemittance,
  resolveRemittanceVariance,
  reverseRemittance,
  setStoreCashPolicy,
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
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${org!.id}, ${uid(hint)}, ${`Store ${hint}`}) returning id
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

    // Writing it off needs a reason instead — but it must say something.
    await expect(
      asOrg(f.orgId, (tx) =>
        resolveRemittanceVariance(tx, f.admin, {
          varianceId: r.varianceId!,
          action: 'write_off',
          reason: '   ',
        }),
      ),
    ).rejects.toThrow(/needs a reason/);

    // Naming a person closes it.
    const cashierId = await person(f.orgId, f.storeId, 'Cashier on duty');
    await asOrg(f.orgId, (tx) =>
      resolveRemittanceVariance(tx, f.admin, {
        varianceId: r.varianceId!,
        action: 'charge',
        personId: cashierId,
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
  it('a manager may set a pooled cadence with a ceiling', async () => {
    const f = await fixture('policy-ok');
    const mgrId = await person(f.orgId, f.storeId, 'Manager', 'manager');
    await asOrg(f.orgId, (tx) =>
      setStoreCashPolicy(tx, actor(f.orgId, mgrId), {
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

  it('⛔ the DATABASE refuses pooling with no ceiling — the rule has no TypeScript copy', async () => {
    const f = await fixture('policy-noceil');
    const mgrId = await person(f.orgId, f.storeId, 'Manager', 'manager');
    await expect(
      asOrg(f.orgId, (tx) =>
        setStoreCashPolicy(tx, actor(f.orgId, mgrId), {
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
    const mgrId = await person(f.orgId, f.storeId, 'Manager', 'manager');
    const set = (cadence: 'daily' | 'weekly', ceiling: string | null) =>
      asOrg(f.orgId, (tx) =>
        setStoreCashPolicy(tx, actor(f.orgId, mgrId), {
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
