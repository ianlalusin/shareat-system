import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-186 — the till custody shift.
 *
 * ⭐ The claim under test is the one T-143 already assumed and could not guarantee: *"once the till
 * is counted daily and signed, a batch shortage cannot be a counting error."* These tests prove
 * the count exists, that it names a person, and that the two variances which look identical as a
 * number behave in opposite ways — one charges somebody, the other posts nothing at all.
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
  tillShiftsRepo,
  transaction,
  APP_ROLE,
  type Tx,
} from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import {
  chargeTillShortage,
  closeTillShift,
  openTillShift,
  recordTillCount,
  setTillFloat,
} from '@shareat/domain';

const sql = postgres(url, { max: 5 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

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
  const code = uid(`till-${hint}`);
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
  const orgId = org!.id;
  const storeId = store!.id;
  const adminId = await person(orgId, storeId, 'Admin', 'admin');
  const cashierId = await person(orgId, storeId, 'Cashier', 'staff');
  const [drawer] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId}
      and instrument = 'cash' and custodian = 'cashier' and is_foundation
  `;
  const [cashierEmployment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${cashierId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01')
    returning id
  `;
  await grantEverydayPositionAccess(sql, {
    orgId, storeId, employmentId: cashierEmployment!.id, personId: cashierId, setBy: adminId,
  });
  return {
    orgId,
    storeId,
    adminId,
    cashierId,
    admin: actor(orgId, adminId),
    cashier: actor(orgId, cashierId),
    drawer: drawer!.id,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Puts money into the till on a date, as an ordinary posted document. */
async function tillMovement(f: Fixture, date: string, amount: string) {
  const [period] = await sql<{ id: string }[]>`
    select id from fiscal_periods where org_id = ${f.orgId} limit 1
  `;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, ${date}, ${period!.id}, 'sale', ${uid('src')}, 'draft') returning id
    `;
    const [cash] = await tx<{ id: string }[]>`
      select id from accounts where org_id = ${f.orgId} and code = '1110'
    `;
    const [rev] = await tx<{ id: string }[]>`
      select id from accounts where org_id = ${f.orgId} and code = '4100'
    `;
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 1, ${cash!.id}, ${f.storeId}, ${amount}, '0')
    `;
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 2, ${rev!.id}, ${f.storeId}, '0', ${amount})
    `;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

afterAll(async () => {
  await sql.end();
  await closeDb();
});

// =====================================================================================

describe('T-186 — a custody period, from open to handover', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture('chain');
  });

  it('⭐ opens, counts, closes — and the person is a REFERENCE, not a name', async () => {
    await tillMovement(f, '2026-01-10', '5000.00');

    const { shiftId, shiftNo } = await asOrg(f.orgId, (tx) =>
      openTillShift(tx, f.cashier, { storeId: f.storeId, businessDate: '2026-01-10' }),
    );
    expect(shiftNo).toBe(1);

    await asOrg(f.orgId, (tx) =>
      recordTillCount(tx, f.cashier, {
        shiftId,
        moment: 'open',
        counts: [{ moneyAccountId: f.drawer, counted: '5000.00' }],
      }),
    );
    await asOrg(f.orgId, (tx) =>
      recordTillCount(tx, f.cashier, {
        shiftId,
        moment: 'close',
        counts: [{ moneyAccountId: f.drawer, counted: '5000.00' }],
      }),
    );
    await asOrg(f.orgId, (tx) => closeTillShift(tx, f.cashier, { shiftId }));

    const shift = await asOrg(f.orgId, (tx) => tillShiftsRepo.getShift(tx, f.orgId, shiftId));
    expect(shift!.status).toBe('closed');
    // ⛔ v1 records this as `cashierName: z.string().optional().nullable()`. Here it is an FK, and
    // NOT NULL — which is the whole reason a shortage can name somebody.
    expect(shift!.openedBy).toBe(f.cashierId);
    expect(shift!.closedBy).toBe(f.cashierId);

    const counts = await asOrg(f.orgId, (tx) => tillShiftsRepo.countsFor(tx, shiftId));
    expect(counts).toHaveLength(2);
    expect(counts.every((c) => c.variance === '0.00')).toBe(true);
  });

  it('⭐ the next shift takes over, and the chain records whose custody it left', async () => {
    const prev = await asOrg(f.orgId, (tx) =>
      tillShiftsRepo.listShifts(tx, f.orgId, { storeId: f.storeId, status: 'closed' }),
    );
    const { shiftId, shiftNo } = await asOrg(f.orgId, (tx) =>
      openTillShift(tx, f.admin, {
        storeId: f.storeId,
        businessDate: '2026-01-10',
        prevShiftId: prev[0]!.id,
      }),
    );
    expect(shiftNo).toBe(2);
    const shift = await asOrg(f.orgId, (tx) => tillShiftsRepo.getShift(tx, f.orgId, shiftId));
    expect(shift!.prevShiftId).toBe(prev[0]!.id);
  });

  it('⛔ a SECOND open shift on the same store is refused', async () => {
    await expect(
      asOrg(f.orgId, (tx) =>
        openTillShift(tx, f.admin, { storeId: f.storeId, businessDate: '2026-01-11' }),
      ),
    ).rejects.toThrow(/already has an open shift/i);
  });

  it('⛔ and the DATABASE refuses it too — the guard is not only in code', async () => {
    // ⚠️ Raw SQL, bypassing the service entirely. Two open shifts means two people believe they
    // hold the same cash, so this must be unrepresentable, not merely discouraged.
    await expect(
      sql`
        insert into till_custody_shifts (org_id, store_id, business_date, shift_no, opened_by)
        values (${f.orgId}, ${f.storeId}, '2026-01-12', 9, ${f.adminId})
      `,
    ).rejects.toThrow(/till_custody_shifts_one_open_per_store/);
  });

  it('⛔ a shift cannot be handed over twice — a branching chain would double-charge', async () => {
    const closed = await asOrg(f.orgId, (tx) =>
      tillShiftsRepo.listShifts(tx, f.orgId, { storeId: f.storeId, status: 'closed' }),
    );
    // The open shift already inherited this one; a second successor must be refused.
    await expect(
      asOrg(f.orgId, (tx) =>
        openTillShift(tx, f.admin, {
          storeId: f.storeId,
          businessDate: '2026-01-11',
          prevShiftId: closed[0]!.id,
        }),
      ),
    ).rejects.toThrow(/already has an open shift|already been handed over/i);
  });

  it('⛔ closing without a closing count is refused', async () => {
    const open = await asOrg(f.orgId, (tx) =>
      tillShiftsRepo.openShiftFor(tx, f.orgId, f.storeId),
    );
    await expect(
      asOrg(f.orgId, (tx) => closeTillShift(tx, f.admin, { shiftId: open!.id })),
    ).rejects.toThrow(/record the closing count first/i);
  });
});

// =====================================================================================

describe('T-186 §6.3 — ⭐ `expected` is frozen at the moment of counting', () => {
  it('⛔ a BACKDATED entry does not move a closed shift’s variance', async () => {
    const f = await fixture('backdate');
    await tillMovement(f, '2026-01-05', '3000.00');

    const { shiftId } = await asOrg(f.orgId, (tx) =>
      openTillShift(tx, f.admin, { storeId: f.storeId, businessDate: '2026-01-05' }),
    );
    await asOrg(f.orgId, (tx) =>
      recordTillCount(tx, f.admin, {
        shiftId,
        moment: 'close',
        counts: [{ moneyAccountId: f.drawer, counted: '3000.00' }],
      }),
    );
    await asOrg(f.orgId, (tx) => closeTillShift(tx, f.admin, { shiftId }));

    const before = await asOrg(f.orgId, (tx) => tillShiftsRepo.countsFor(tx, shiftId));
    expect(before[0]!.variance).toBe('0.00');

    // ⚠️ Posted AFTER the count, dated BEFORE it. If `expected` were re-derived on read, this
    // would silently rewrite a variance somebody may already have been charged for.
    await tillMovement(f, '2026-01-05', '900.00');

    const after = await asOrg(f.orgId, (tx) => tillShiftsRepo.countsFor(tx, shiftId));
    expect(after[0]!.expected).toBe(before[0]!.expected);
    expect(after[0]!.variance).toBe('0.00');
  });
});

// =====================================================================================

describe('T-186 §7 — what a counted variance posts, and what it must not', () => {
  it('⭐ a SHORT charges 1230 to a named person, and credits the account that came up short', async () => {
    const f = await fixture('short');
    await tillMovement(f, '2026-01-06', '10000.00');

    const { shiftId } = await asOrg(f.orgId, (tx) =>
      openTillShift(tx, f.admin, { storeId: f.storeId, businessDate: '2026-01-06' }),
    );
    await asOrg(f.orgId, (tx) =>
      recordTillCount(tx, f.admin, {
        shiftId,
        moment: 'close',
        counts: [{ moneyAccountId: f.drawer, counted: '9850.00' }],
      }),
    );
    await asOrg(f.orgId, (tx) => closeTillShift(tx, f.admin, { shiftId }));

    const [line] = await asOrg(f.orgId, (tx) => tillShiftsRepo.countsFor(tx, shiftId));
    expect(line!.variance).toBe('-150.00');

    const out = await asOrg(f.orgId, (tx) =>
      chargeTillShortage(tx, f.admin, { countLineId: line!.id, personId: f.cashierId }),
    );
    expect(out.posted).toBe(true);

    const legs = await sql<{ code: string; debit: string; credit: string; party_id: string | null }[]>`
      select a.code, l.debit, l.credit, l.party_id
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
      where e.org_id = ${f.orgId} and e.source_type = 'tillcountshortage'
      order by a.code
    `;
    expect(legs.map((l) => l.code)).toEqual(['1110', '1230']);
    // ⭐ 1230, never P&L — and it names the person, which is the point of the whole table.
    expect(legs[1]!.debit).toBe('150.00');
    expect(legs[1]!.party_id).toBe(f.cashierId);
    expect(legs[0]!.credit).toBe('150.00');
  });

  it('⛔ an OVER posts NOTHING AT ALL — it is tip-box money that was never in the books', async () => {
    const f = await fixture('over');
    await tillMovement(f, '2026-01-07', '4000.00');

    const { shiftId } = await asOrg(f.orgId, (tx) =>
      openTillShift(tx, f.admin, { storeId: f.storeId, businessDate: '2026-01-07' }),
    );
    await asOrg(f.orgId, (tx) =>
      recordTillCount(tx, f.admin, {
        shiftId,
        moment: 'close',
        counts: [{ moneyAccountId: f.drawer, counted: '4300.00' }],
      }),
    );
    await asOrg(f.orgId, (tx) => closeTillShift(tx, f.admin, { shiftId }));

    const [line] = await asOrg(f.orgId, (tx) => tillShiftsRepo.countsFor(tx, shiftId));
    expect(line!.variance).toBe('300.00');

    const out = await asOrg(f.orgId, (tx) =>
      chargeTillShortage(tx, f.admin, { countLineId: line!.id, personId: f.cashierId }),
    );
    expect(out.posted).toBe(false);
    expect(out.reason).toMatch(/tip box/i);

    // ⛔ ZERO entries. "It posts nothing" is exactly the rule a later helpful edit breaks.
    const [countRow] = await sql<{ n: number }[]>`
      select count(*)::int n from journal_entries
      where org_id = ${f.orgId} and source_type = 'tillcountshortage'
    `;
    expect(countRow!.n).toBe(0);

    // ⛔ And specifically NOT 7350 — that account is for a REMITTANCE variance, where the money
    // genuinely was the business's. Tip money never was.
    const [lineRow] = await sql<{ m: number }[]>`
      select count(*)::int m from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
      where e.org_id = ${f.orgId} and a.code = '7350'
    `;
    expect(lineRow!.m).toBe(0);
  });

  it('⛔ charging a shortage to NOBODY is refused', async () => {
    const f = await fixture('nobody');
    await tillMovement(f, '2026-01-08', '2000.00');
    const { shiftId } = await asOrg(f.orgId, (tx) =>
      openTillShift(tx, f.admin, { storeId: f.storeId, businessDate: '2026-01-08' }),
    );
    await asOrg(f.orgId, (tx) =>
      recordTillCount(tx, f.admin, {
        shiftId,
        moment: 'close',
        counts: [{ moneyAccountId: f.drawer, counted: '1900.00' }],
      }),
    );
    await asOrg(f.orgId, (tx) => closeTillShift(tx, f.admin, { shiftId }));
    const [line] = await asOrg(f.orgId, (tx) => tillShiftsRepo.countsFor(tx, shiftId));

    await expect(
      asOrg(f.orgId, (tx) =>
        chargeTillShortage(tx, f.admin, { countLineId: line!.id, personId: '' }),
      ),
    ).rejects.toThrow(/needs a person/i);
  });
});

// =====================================================================================

describe('T-186 §8 — the capability asymmetry IS the control', () => {
  it('⭐ a CASHIER may record a count — the person holding the drawer is the cashier', async () => {
    const f = await fixture('gate-record');
    await expect(
      asOrg(f.orgId, (tx) =>
        openTillShift(tx, f.cashier, { storeId: f.storeId, businessDate: '2026-01-09' }),
      ),
    ).resolves.toBeTruthy();
  });

  it('⛔ but a CASHIER may NOT charge the shortage their own count revealed', async () => {
    const f = await fixture('gate-charge');
    await tillMovement(f, '2026-01-09', '1000.00');
    const { shiftId } = await asOrg(f.orgId, (tx) =>
      openTillShift(tx, f.cashier, { storeId: f.storeId, businessDate: '2026-01-09' }),
    );
    await asOrg(f.orgId, (tx) =>
      recordTillCount(tx, f.cashier, {
        shiftId,
        moment: 'close',
        counts: [{ moneyAccountId: f.drawer, counted: '900.00' }],
      }),
    );
    await asOrg(f.orgId, (tx) => closeTillShift(tx, f.cashier, { shiftId }));
    const [line] = await asOrg(f.orgId, (tx) => tillShiftsRepo.countsFor(tx, shiftId));

    await expect(
      asOrg(f.orgId, (tx) =>
        chargeTillShortage(tx, f.cashier, { countLineId: line!.id, personId: f.cashierId }),
      ),
    ).rejects.toThrow(AuthorizationError);
  });
});

// =====================================================================================

describe('T-186 §9 — the twelfth finding, and the wording that keeps it apart from the eleventh', () => {
  it('⭐ fires on a closed shift with a counted variance, and says COUNTED in as many words', async () => {
    const f = await fixture('finding');
    await tillMovement(f, '2026-01-13', '7000.00');
    const { shiftId } = await asOrg(f.orgId, (tx) =>
      openTillShift(tx, f.admin, { storeId: f.storeId, businessDate: '2026-01-13' }),
    );
    await asOrg(f.orgId, (tx) =>
      recordTillCount(tx, f.admin, {
        shiftId,
        moment: 'close',
        counts: [{ moneyAccountId: f.drawer, counted: '6500.00' }],
      }),
    );
    await asOrg(f.orgId, (tx) => closeTillShift(tx, f.admin, { shiftId }));

    const found = await asOrg(f.orgId, (tx) =>
      findingsRepo.tillCountVarianceOpen(tx, f.orgId),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('soft');

    const detail = found[0]!.detail;
    // ⭐ The guard T-153 §13.4 asked for: this one IS chargeable, its sibling is not, and only
    // the wording keeps a reader from charging somebody for a delivery they paid for correctly.
    expect(detail).toMatch(/PHYSICAL COUNT/);
    expect(detail).toMatch(/chargeable to the cashier/i);
    // ⛔ ₱-500.00 — the sign-placement bug this codebase has shipped three times.
    expect(detail).not.toMatch(/₱-/);
    expect(detail).toContain('₱500.00');
  });

  it('⛔ and it CLEARS once the shortage is charged — a settled debt is not an open question', async () => {
    const f = await fixture('finding-clears');
    await tillMovement(f, '2026-01-14', '7000.00');
    const { shiftId } = await asOrg(f.orgId, (tx) =>
      openTillShift(tx, f.admin, { storeId: f.storeId, businessDate: '2026-01-14' }),
    );
    await asOrg(f.orgId, (tx) =>
      recordTillCount(tx, f.admin, {
        shiftId,
        moment: 'close',
        counts: [{ moneyAccountId: f.drawer, counted: '6800.00' }],
      }),
    );
    await asOrg(f.orgId, (tx) => closeTillShift(tx, f.admin, { shiftId }));
    const [line] = await asOrg(f.orgId, (tx) => tillShiftsRepo.countsFor(tx, shiftId));

    expect(await asOrg(f.orgId, (tx) => findingsRepo.tillCountVarianceOpen(tx, f.orgId))).toHaveLength(1);
    await asOrg(f.orgId, (tx) =>
      chargeTillShortage(tx, f.admin, { countLineId: line!.id, personId: f.cashierId }),
    );
    expect(await asOrg(f.orgId, (tx) => findingsRepo.tillCountVarianceOpen(tx, f.orgId))).toEqual([]);
  });

  it('⚠️ an OPEN shift is never reported — the count is not finished until it is closed', async () => {
    const f = await fixture('finding-open');
    await tillMovement(f, '2026-01-15', '1000.00');
    const { shiftId } = await asOrg(f.orgId, (tx) =>
      openTillShift(tx, f.admin, { storeId: f.storeId, businessDate: '2026-01-15' }),
    );
    await asOrg(f.orgId, (tx) =>
      recordTillCount(tx, f.admin, {
        shiftId,
        moment: 'close',
        counts: [{ moneyAccountId: f.drawer, counted: '400.00' }],
      }),
    );
    expect(await asOrg(f.orgId, (tx) => findingsRepo.tillCountVarianceOpen(tx, f.orgId))).toEqual([]);
  });
});

// =====================================================================================

describe('T-186 — what a till may be counted against', () => {
  it('⛔ an e-wallet balance is not something a person counts in a drawer', async () => {
    const f = await fixture('ewallet');
    const [wallet] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${f.storeId}
        and instrument = 'ewallet' and custodian = 'cashier' and is_foundation
    `;
    const { shiftId } = await asOrg(f.orgId, (tx) =>
      openTillShift(tx, f.admin, { storeId: f.storeId, businessDate: '2026-01-16' }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        recordTillCount(tx, f.admin, {
          shiftId,
          moment: 'open',
          counts: [{ moneyAccountId: wallet!.id, counted: '100.00' }],
        }),
      ),
    ).rejects.toThrow(/not a cashier cash account/i);
  });

  it('⭐ T-316 S1: the float is a target on the ONE countable cashier drawer (1110), visible there', async () => {
    const f = await fixture('float');
    await asOrg(f.orgId, (tx) =>
      setTillFloat(tx, f.admin, { storeId: f.storeId, target: '20000.00' }),
    );
    const accounts = await asOrg(f.orgId, (tx) =>
      tillShiftsRepo.countableAccounts(tx, f.orgId, f.storeId),
    );
    // T-316 S1: one line instead of two (was ['1110', '1115']); the target sits on the 1110 drawer.
    expect(accounts.map((a) => a.glAccountCode)).toEqual(['1110']);
    expect(accounts[0]!.floatTarget).toBe('20000.00');
  });
});
