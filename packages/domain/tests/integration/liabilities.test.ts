import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-128 — generic liabilities. Fixes DEF-074.
 *
 * ⭐ Two tests carry the design:
 *   1. *"2500 nets to zero when it is settled"* — why no balance is stored anywhere.
 *   2. *"a statutory account is refused"* — the boundary that stops the same debt being counted
 *      twice, in two accounts, with nothing reconciling them.
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
import { liabilitiesRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  chargeLiability,
  createLiability,
  isOverdue,
  payLiability,
  retireLiability,
  reverseLiabilityEntry,
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

async function fixture(hint: string) {
  const code = uid(`liab-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id
  `;
  const storeId = store!.id;
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-01-01', '2026-01-31', 'open'),
      (${orgId}, '2026-02-01', '2026-02-28', 'open')
  `;
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id
  `;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  const [till] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId}
      and instrument = 'cash' and custodian = 'office' and is_foundation
  `;
  await fund(orgId, storeId, '200000.00');
  return { orgId, storeId, managerId: p!.id, manager: actor(orgId, p!.id), till: till!.id };
}

/** ⚠️ Credits 3900 Opening balance equity — the counterpart to putting cash on the books. */
async function fund(orgId: string, storeId: string, amount: string) {
  const [period] = await sql<{ id: string }[]>`
    select id from fiscal_periods where org_id = ${orgId} order by starts_on limit 1
  `;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-01', ${period!.id}, 'opening_balance', ${uid('ob')}, 'draft')
      returning id
    `;
    const codes = await tx<{ id: string; code: string }[]>`
      select id, code from accounts where org_id = ${orgId} and code in ('1130', '3900')
    `;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 1, ${by.get('1130')!}, ${storeId}, ${amount}, '0'),
             (${e!.id}, 2, ${by.get('3900')!}, ${storeId}, '0', ${amount})
    `;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function liability(f: Fixture, over: Record<string, unknown> = {}) {
  const created = await asOrg(f.orgId, (tx) =>
    createLiability(tx, f.manager, {
      storeId: f.storeId,
      name: 'Accrued rent — January',
      category: 'accrued_expenses',
      ...over,
    }),
  );
  return created.id;
}

const positionOf = (f: Fixture, id: string) =>
  asOrg(f.orgId, (tx) => liabilitiesRepo.positionOf(tx, f.orgId, id));

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('the position is the ledger, and there is nowhere else to look', () => {
  it('⭐ 2500 NETS TO ZERO when the obligation is settled', async () => {
    const f = await fixture('zero');
    const id = await liability(f);

    await asOrg(f.orgId, (tx) =>
      chargeLiability(tx, f.manager, {
        liabilityId: id, amount: '45000.00', againstAccountCode: '6200', on: '2026-01-31',
      }),
    );
    expect(await positionOf(f, id)).toMatchObject({
      charged: '45000.00',
      paid: '0.00',
      outstanding: '45000.00',
    });

    const result = await asOrg(f.orgId, (tx) =>
      payLiability(tx, f.manager, {
        liabilityId: id, amount: '45000.00', fromMoneyAccountId: f.till, on: '2026-02-05',
      }),
    );
    // ⭐ Settled is the LEDGER's answer, not a column.
    expect(result.settled).toBe(true);
    expect(result.outstanding).toBe('0.00');

    // ⛔ v1 stores outstandingBalance / totalCharged / totalPaid (DEF-074). If a column like that
    // existed here, this is the assertion that would have to be deleted.
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'liabilities'
    `;
    const names = cols.map((c) => c.column_name);
    for (const banned of ['outstanding_balance', 'total_charged', 'total_paid', 'status']) {
      expect(names, `liabilities.${banned} would be a second register`).not.toContain(banned);
    }
  });

  it('⭐ two obligations on one control account are told apart', async () => {
    const f = await fixture('two');
    const rent = await liability(f, { name: 'Accrued rent' });
    const permit = await liability(f, { name: 'Permit fee' });

    await asOrg(f.orgId, (tx) =>
      chargeLiability(tx, f.manager, {
        liabilityId: rent, amount: '45000.00', againstAccountCode: '6200', on: '2026-01-31',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      chargeLiability(tx, f.manager, {
        liabilityId: permit, amount: '3000.00', againstAccountCode: '6900', on: '2026-01-31',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      payLiability(tx, f.manager, {
        liabilityId: permit, amount: '3000.00', fromMoneyAccountId: f.till, on: '2026-02-02',
      }),
    );

    // Without a party this is one ₱48,000 balance and "which is still unpaid?" needs a second register.
    expect((await positionOf(f, rent)).outstanding).toBe('45000.00');
    expect((await positionOf(f, permit)).outstanding).toBe('0.00');
  });

  it('⚠️ a reversal nets out, because BOTH halves are counted', async () => {
    const f = await fixture('rev');
    const id = await liability(f);
    const { entryId } = await asOrg(f.orgId, (tx) =>
      chargeLiability(tx, f.manager, {
        liabilityId: id, amount: '5000.00', againstAccountCode: '6200', on: '2026-01-10',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      reverseLiabilityEntry(tx, f.manager, { liabilityId: id, entryId, reason: 'billed in error' }),
    );
    expect((await positionOf(f, id)).outstanding).toBe('0.00');
  });
});

describe('⛔ the boundary — obligations that already have a home', () => {
  it.each([
    ['2210', /SSS/],
    ['2240', /withholding tax/],
    // DEF-162: corrected 2026-09-04 — payroll does not accrue to 2300, it recognises and
    // disburses pay in one entry. The old message ("payroll owns them") claimed an accrual step
    // that does not exist; the charge is still refused (2300 is not a place to double-book pay),
    // just for the accurate reason.
    ['2300', /payroll recognises and disburses pay in one entry/],
    ['2400', /loan/],
    ['2110', /supplier invoice/],
  ])('⛔ charging %s is refused, naming the module that owns it', async (code, expected) => {
    const f = await fixture(`res${code}`);
    const id = await liability(f);
    // ⚠️ Recording it here AND letting payroll accrue it would put the same debt in two accounts,
    // with nothing reconciling them. Blocking beats silently double-counting.
    await expect(
      asOrg(f.orgId, (tx) =>
        chargeLiability(tx, f.manager, {
          liabilityId: id, amount: '1000.00', againstAccountCode: code, on: '2026-01-10',
        }),
      ),
    ).rejects.toThrow(expected);
  });

  it('⛔ charging ANOTHER liability account is refused even when it is not on the reserved list', async () => {
    const f = await fixture('otherliab');
    const id = await liability(f);
    // 2160 is a real liability with no dedicated module — still wrong: crediting one liability to
    // debit another moves a debt without settling it.
    await expect(
      asOrg(f.orgId, (tx) =>
        chargeLiability(tx, f.manager, {
          liabilityId: id, amount: '1000.00', againstAccountCode: '2160', on: '2026-01-10',
        }),
      ),
    ).rejects.toThrow(/is liability, and a charge records what the obligation was FOR/);
  });

  it('⛔ charging a header account is refused', async () => {
    const f = await fixture('header');
    const id = await liability(f);
    await expect(
      asOrg(f.orgId, (tx) =>
        chargeLiability(tx, f.manager, {
          liabilityId: id, amount: '1000.00', againstAccountCode: '6000', on: '2026-01-10',
        }),
      ),
    ).rejects.toThrow(/is a header/);
  });
});

describe('the refusals', () => {
  it('⛔ overpaying is refused — it would turn a debt into a receivable', async () => {
    const f = await fixture('over');
    const id = await liability(f);
    await asOrg(f.orgId, (tx) =>
      chargeLiability(tx, f.manager, {
        liabilityId: id, amount: '5000.00', againstAccountCode: '6200', on: '2026-01-10',
      }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        payLiability(tx, f.manager, {
          liabilityId: id, amount: '6000.00', fromMoneyAccountId: f.till, on: '2026-01-20',
        }),
      ),
    ).rejects.toThrow(/more than the ₱5000.00 still owed/);
  });

  it('⛔ retiring one that still owes money is refused', async () => {
    const f = await fixture('retire');
    const id = await liability(f);
    await asOrg(f.orgId, (tx) =>
      chargeLiability(tx, f.manager, {
        liabilityId: id, amount: '5000.00', againstAccountCode: '6200', on: '2026-01-10',
      }),
    );
    await expect(
      asOrg(f.orgId, (tx) => retireLiability(tx, f.manager, { liabilityId: id })),
    ).rejects.toThrow(/still owed on this obligation/);
  });

  it('a settled one retires, and drops off the register', async () => {
    const f = await fixture('retireok');
    const id = await liability(f);
    await asOrg(f.orgId, (tx) => retireLiability(tx, f.manager, { liabilityId: id }));
    const rows = await asOrg(f.orgId, (tx) => liabilitiesRepo.listLiabilities(tx, f.orgId));
    expect(rows.find((r) => r.id === id)).toBeUndefined();
  });

  it('⛔ funding a payment from another store is refused', async () => {
    const f = await fixture('crossstore');
    const id = await liability(f);
    await asOrg(f.orgId, (tx) =>
      chargeLiability(tx, f.manager, {
        liabilityId: id, amount: '5000.00', againstAccountCode: '6200', on: '2026-01-10',
      }),
    );
    const [other] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${f.orgId}, ${uid('other')}, 'Other') returning id
    `;
    const [farTill] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${other!.id}
        and instrument = 'cash' and custodian = 'office' and is_foundation
    `;
    await expect(
      asOrg(f.orgId, (tx) =>
        payLiability(tx, f.manager, {
          liabilityId: id, amount: '1000.00', fromMoneyAccountId: farTill!.id, on: '2026-01-20',
        }),
      ),
    ).rejects.toThrow(/another store/);
  });
});

describe('⭐ overdue — the thing v1 cannot report at all', () => {
  it('is computed from the due date and the balance, never stored', () => {
    // v1 has NO due date field on a liability, so it can show what is owed and never what is late.
    expect(isOverdue('2026-01-31', '45000.00', '2026-02-05')).toBe(true);
    // Paid off — a past due date on a settled obligation is history, not a finding.
    expect(isOverdue('2026-01-31', '0.00', '2026-02-05')).toBe(false);
    // Not yet due.
    expect(isOverdue('2026-03-31', '45000.00', '2026-02-05')).toBe(false);
    // ⚠️ No date at all is not overdue — it is unknowable, and saying otherwise would cry wolf.
    expect(isOverdue(null, '45000.00', '2026-02-05')).toBe(false);
  });

  it('⚠️ undated obligations sort LAST, below the ones with real dates', async () => {
    const f = await fixture('sort');
    await liability(f, { name: 'No date' });
    await liability(f, { name: 'Due January', dueOn: '2026-01-31' });
    const rows = await asOrg(f.orgId, (tx) => liabilitiesRepo.listLiabilities(tx, f.orgId));
    // Postgres sorts NULLs FIRST on ASC by default, which would put every undated obligation above
    // the overdue ones on the screen that exists to show what is late.
    expect(rows.map((r) => r.name)).toEqual(['Due January', 'No date']);
  });
});
