import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-127 — owner equity. Fixes DEF-071 and DEF-072.
 *
 * ⭐ Two tests carry the design:
 *   1. *"a monthly limit blocks"* — DEF-071's whole point. v1 shows the cap and enforces nothing.
 *   2. *"a closed month refuses a back-dated drawing"* — without that, a cut-off is a report.
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
import { ownersRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  closeDrawingMonth,
  createOwner,
  previewDrawingClose,
  recordContribution,
  recordDrawing,
  recoverFromPay,
  repayFromOwner,
  writeOffReceivable,
  reverseOwnerEntry,
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

async function person(orgId: string, storeId: string, name: string, role: string) {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id
  `;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  return p!.id;
}

async function fixture(hint: string) {
  const code = uid(`own-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id
  `;
  const storeId = store!.id;
  // ⚠️ Two months open — the close tests need a finished month AND a live one.
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-01-01', '2026-01-31', 'open'),
      (${orgId}, '2026-02-01', '2026-02-28', 'open')
  `;
  const adminId = await person(orgId, storeId, 'Admin', 'admin');
  const anaId = await person(orgId, storeId, 'Ana', 'staff');
  const [till] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId}
      and instrument = 'cash' and custodian = 'cashier' and is_foundation
  `;
  // Cash to draw against, so the overdraft guard is not the thing under test.
  await fund(orgId, storeId, '500000.00');
  return { orgId, storeId, adminId, anaId, admin: actor(orgId, adminId), till: till!.id };
}

/** ⚠️ Credits 3900 Opening balance equity — NOT 3200, which is debit-normal contra-equity. */
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
      select id, code from accounts where org_id = ${orgId} and code in ('1110', '3900')
    `;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 1, ${by.get('1110')!}, ${storeId}, ${amount}, '0'),
             (${e!.id}, 2, ${by.get('3900')!}, ${storeId}, '0', ${amount})
    `;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function owner(f: Fixture, over: Record<string, unknown> = {}) {
  const created = await asOrg(f.orgId, (tx) =>
    createOwner(tx, f.admin, {
      storeId: f.storeId,
      personId: f.anaId,
      role: 'Managing Partner',
      ...over,
    }),
  );
  return created.id;
}

/** A repayable personal expense, posted straight to the ledger so the expense module is not
 *  what is under test here. */
async function owesUs(f: Fixture, ownerId: string, amount: string, on = '2026-01-12') {
  const [period] = await sql<{ id: string }[]>`
    select id from fiscal_periods where org_id = ${f.orgId} and starts_on <= ${on} and ends_on >= ${on}
  `;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, ${on}, ${period!.id}, 'expense', ${uid('pe')}, 'draft') returning id
    `;
    const codes = await tx<{ id: string; code: string }[]>`
      select id, code from accounts where org_id = ${f.orgId} and code in ('1260', '1110')
    `;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
      values (${e!.id}, 1, ${by.get('1260')!}, ${f.storeId}, ${amount}, '0', 'owner', ${ownerId})
    `;
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 2, ${by.get('1110')!}, ${f.storeId}, '0', ${amount})
    `;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

const positionOf = (f: Fixture, id: string) =>
  asOrg(f.orgId, (tx) => ownersRepo.positionOf(tx, f.orgId, id));

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('the position is the ledger, and there is nowhere else to look', () => {
  it('⭐ contributed − drawn = net, and no column holds any of the three', async () => {
    const f = await fixture('pos');
    const id = await owner(f);

    await asOrg(f.orgId, (tx) =>
      recordContribution(tx, f.admin, {
        ownerId: id, amount: '100000.00', intoMoneyAccountId: f.till, on: '2026-01-08',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, {
        ownerId: id, amount: '25000.00', fromMoneyAccountId: f.till, on: '2026-01-09',
      }),
    );

    expect(await positionOf(f, id)).toMatchObject({
      contributed: '100000.00',
      drawn: '25000.00',
      net: '75000.00',
    });

    // ⛔ v1 keeps totalCapital / totalDrawings / netEquity on the owner document (DEF-072). If a
    // column like that existed here, this is the assertion that would have to be deleted.
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'owners'
    `;
    const names = cols.map((c) => c.column_name);
    for (const banned of ['total_capital', 'total_drawings', 'net_equity']) {
      expect(names, `owners.${banned} would be a second register`).not.toContain(banned);
    }
  });

  it('⚠️ a reversal nets out, because BOTH halves are counted', async () => {
    const f = await fixture('rev');
    const id = await owner(f);
    const { entryId } = await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, {
        ownerId: id, amount: '5000.00', fromMoneyAccountId: f.till, on: '2026-01-10',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      reverseOwnerEntry(tx, f.admin, { ownerId: id, entryId, reason: 'wrong owner' }),
    );
    // Counting only the original, or only the mirror, is the mistake T-126's own tests caught.
    expect((await positionOf(f, id)).drawn).toBe('0.00');
  });

  it('⭐ two partners on one store are told apart', async () => {
    const f = await fixture('two');
    const benId = await person(f.orgId, f.storeId, 'Ben', 'staff');
    const ana = await owner(f);
    const ben = await owner(f, { personId: benId, role: 'Silent Partner' });

    await asOrg(f.orgId, (tx) =>
      recordContribution(tx, f.admin, { ownerId: ana, amount: '500000.00', intoMoneyAccountId: f.till, on: '2026-01-08' }),
    );
    await asOrg(f.orgId, (tx) =>
      recordContribution(tx, f.admin, { ownerId: ben, amount: '200000.00', intoMoneyAccountId: f.till, on: '2026-01-08' }),
    );
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, { ownerId: ana, amount: '300000.00', fromMoneyAccountId: f.till, on: '2026-01-09' }),
    );

    // ⛔ v1 nets drawings into capital, which makes these two indistinguishable at ₱200,000 each.
    expect(await positionOf(f, ana)).toMatchObject({ contributed: '500000.00', drawn: '300000.00', net: '200000.00' });
    expect(await positionOf(f, ben)).toMatchObject({ contributed: '200000.00', drawn: '0.00', net: '200000.00' });
  });
});

describe('⭐ the drawing limit — DEF-071', () => {
  it('⭐ a MONTHLY limit blocks, which is the whole defect', async () => {
    const f = await fixture('monthly');
    const id = await owner(f, { drawingLimit: '50000.00', drawingLimitPeriod: 'monthly' });

    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, { ownerId: id, amount: '40000.00', fromMoneyAccountId: f.till, on: '2026-01-05' }),
    );
    // v1 sets this limit, DISPLAYS it back as a live constraint, and checks only `=== 'total'`.
    await expect(
      asOrg(f.orgId, (tx) =>
        recordDrawing(tx, f.admin, { ownerId: id, amount: '15000.00', fromMoneyAccountId: f.till, on: '2026-01-20' }),
      ),
    ).rejects.toThrow(/over the ₱50000.00 monthly limit/);
  });

  it('⭐ and the NEXT month starts fresh — otherwise it is a total limit wearing the wrong name', async () => {
    const f = await fixture('nextmonth');
    const id = await owner(f, { drawingLimit: '50000.00', drawingLimitPeriod: 'monthly' });
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, { ownerId: id, amount: '50000.00', fromMoneyAccountId: f.till, on: '2026-01-05' }),
    );
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, { ownerId: id, amount: '50000.00', fromMoneyAccountId: f.till, on: '2026-02-05' }),
    );
    expect((await positionOf(f, id)).drawn).toBe('100000.00');
  });

  it('⚠️ the window is the DRAWING’s month, so back-dating cannot slip a full month', async () => {
    const f = await fixture('backdate');
    const id = await owner(f, { drawingLimit: '50000.00', drawingLimitPeriod: 'monthly' });
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, { ownerId: id, amount: '50000.00', fromMoneyAccountId: f.till, on: '2026-01-05' }),
    );
    // Measured against TODAY this would pass, because February is empty.
    await expect(
      asOrg(f.orgId, (tx) =>
        recordDrawing(tx, f.admin, { ownerId: id, amount: '1000.00', fromMoneyAccountId: f.till, on: '2026-01-31' }),
      ),
    ).rejects.toThrow(/over the ₱50000.00 monthly limit/);
  });

  it('⛔ an UNRELATED staff advance does not consume the owner’s drawing limit', async () => {
    const f = await fixture('unrelated');
    const id = await owner(f, { drawingLimit: '50000.00', drawingLimitPeriod: 'monthly' });

    // ⚠️ A float shortage from a cash request: same human, different role, its own source document.
    // 1230 holds ordinary staff advances too, and charging one against an OWNERSHIP cap conflates
    // an operational debt with a distribution. A browser check caught exactly this.
    const [period] = await sql<{ id: string }[]>`
      select id from fiscal_periods where org_id = ${f.orgId} order by starts_on limit 1
    `;
    await sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
        values (${f.orgId}, '2026-01-06', ${period!.id}, 'cash_request_shortage', ${uid('cr')}, 'draft')
        returning id
      `;
      const codes = await tx<{ id: string; code: string }[]>`
        select id, code from accounts where org_id = ${f.orgId} and code in ('1230', '1110')
      `;
      const by = new Map(codes.map((c) => [c.code, c.id]));
      await tx`
        insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
        values (${e!.id}, 1, ${by.get('1230')!}, ${f.storeId}, '600.00', '0', 'employee', ${f.anaId})
      `;
      await tx`
        insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
        values (${e!.id}, 2, ${by.get('1110')!}, ${f.storeId}, '0', '600.00')
      `;
      await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
    });

    // The whole ₱50,000 must still be available — the shortage is not a drawing.
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, {
        ownerId: id, amount: '50000.00', fromMoneyAccountId: f.till, on: '2026-01-10',
      }),
    );
    expect((await positionOf(f, id)).drawn).toBe('50000.00');
  });

  it('a TOTAL limit blocks across months', async () => {
    const f = await fixture('total');
    const id = await owner(f, { drawingLimit: '60000.00', drawingLimitPeriod: 'total' });
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, { ownerId: id, amount: '50000.00', fromMoneyAccountId: f.till, on: '2026-01-05' }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        recordDrawing(tx, f.admin, { ownerId: id, amount: '20000.00', fromMoneyAccountId: f.till, on: '2026-02-05' }),
      ),
    ).rejects.toThrow(/over the ₱60000.00 total limit/);
  });

  it('⛔ a limit with no period is refused at creation — half a rule is not a rule', async () => {
    const f = await fixture('halfrule');
    await expect(owner(f, { drawingLimit: '50000.00' })).rejects.toThrow(/needs a period/);
    await expect(owner(f, { drawingLimitPeriod: 'monthly' })).rejects.toThrow(/needs a limit/);
  });
});

describe('⭐ the monthly drawings close', () => {
  it('agreeing with the ledger posts nothing and records what was agreed', async () => {
    const f = await fixture('close');
    const id = await owner(f);
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, { ownerId: id, amount: '12000.00', fromMoneyAccountId: f.till, on: '2026-01-10' }),
    );

    const preview = await asOrg(f.orgId, (tx) =>
      previewDrawingClose(tx, f.admin, { ownerId: id, month: '2026-01-01' }),
    );
    expect(preview).toMatchObject({ ledgerAmount: '12000.00', alreadyClosed: false });

    const result = await asOrg(f.orgId, (tx) =>
      closeDrawingMonth(tx, f.admin, { ownerId: id, month: '2026-01-01', on: '2026-02-01' }),
    );
    expect(result).toMatchObject({ acknowledgedAmount: '12000.00', adjustmentAmount: null });
  });

  it('⛔ a CLOSED month refuses a back-dated drawing — without this, a cut-off is a report', async () => {
    const f = await fixture('lock');
    const id = await owner(f);
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, { ownerId: id, amount: '12000.00', fromMoneyAccountId: f.till, on: '2026-01-10' }),
    );
    await asOrg(f.orgId, (tx) =>
      closeDrawingMonth(tx, f.admin, { ownerId: id, month: '2026-01-01', on: '2026-02-01' }),
    );

    await expect(
      asOrg(f.orgId, (tx) =>
        recordDrawing(tx, f.admin, { ownerId: id, amount: '5000.00', fromMoneyAccountId: f.till, on: '2026-01-15' }),
      ),
    ).rejects.toThrow(/2026-01 is closed for this owner/);

    // ⚠️ ...and the OPEN month is unaffected. A lock that stopped everything would just be an outage.
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, { ownerId: id, amount: '5000.00', fromMoneyAccountId: f.till, on: '2026-02-03' }),
    );
    expect((await positionOf(f, id)).drawn).toBe('17000.00');
  });

  it('⭐ an adjustment POSTS — "visible and enforced" means the books move', async () => {
    const f = await fixture('adjust');
    const id = await owner(f);
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, { ownerId: id, amount: '12000.00', fromMoneyAccountId: f.till, on: '2026-01-10' }),
    );

    const result = await asOrg(f.orgId, (tx) =>
      closeDrawingMonth(tx, f.admin, {
        ownerId: id,
        month: '2026-01-01',
        acknowledgedAmount: '15000.00',
        adjustmentReason: 'unrecorded cash taken on the 22nd',
        on: '2026-02-01',
      }),
    );
    expect(result.adjustmentAmount).toBe('3000.00');

    // The agreed figure is now what the ledger says — that is the point of posting it.
    const after = await positionOf(f, id);
    expect(after.drawn).toBe('15000.00');
    // ⭐ And the other side landed on the owner receivable, not in thin air.
    expect(after.receivable).toBe('-3000.00');

    const [close] = await sql<{ adjustment_entry_id: string | null }[]>`
      select adjustment_entry_id from owner_drawing_closes where owner_id = ${id}
    `;
    expect(close!.adjustment_entry_id).not.toBeNull();
  });

  it('⛔ an UNEXPLAINED difference cannot be closed', async () => {
    const f = await fixture('noreason');
    const id = await owner(f);
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, { ownerId: id, amount: '12000.00', fromMoneyAccountId: f.till, on: '2026-01-10' }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        closeDrawingMonth(tx, f.admin, {
          ownerId: id, month: '2026-01-01', acknowledgedAmount: '15000.00', on: '2026-02-01',
        }),
      ),
    ).rejects.toThrow(/say why/);
  });

  it('⛔ a month cannot be closed before it has ended', async () => {
    const f = await fixture('early');
    const id = await owner(f);
    await expect(
      asOrg(f.orgId, (tx) =>
        closeDrawingMonth(tx, f.admin, { ownerId: id, month: '2026-01-01', on: '2026-01-20' }),
      ),
    ).rejects.toThrow(/has not ended yet/);
  });

  it('⛔ closing twice is refused', async () => {
    const f = await fixture('twice');
    const id = await owner(f);
    await asOrg(f.orgId, (tx) =>
      closeDrawingMonth(tx, f.admin, { ownerId: id, month: '2026-01-01', on: '2026-02-01' }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        closeDrawingMonth(tx, f.admin, { ownerId: id, month: '2026-01-01', on: '2026-02-02' }),
      ),
    ).rejects.toThrow(/already closed/);
  });

  it('⚠️ the lock is per OWNER — one partner closing does not stop the other', async () => {
    const f = await fixture('perowner');
    const benId = await person(f.orgId, f.storeId, 'Ben', 'staff');
    const ana = await owner(f);
    const ben = await owner(f, { personId: benId });
    await asOrg(f.orgId, (tx) =>
      closeDrawingMonth(tx, f.admin, { ownerId: ana, month: '2026-01-01', on: '2026-02-01' }),
    );
    // Ben has not signed off; blocking him would make the control something people route around.
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, { ownerId: ben, amount: '1000.00', fromMoneyAccountId: f.till, on: '2026-01-15' }),
    );
    expect((await positionOf(f, ben)).drawn).toBe('1000.00');
  });
});

describe('⭐ clearing a 1260 receivable', () => {
  it('⭐ cash repayment clears it, and equity never moved', async () => {
    const f = await fixture('repay');
    const id = await owner(f);
    await owesUs(f, id, '2000.00');
    expect((await positionOf(f, id)).receivable).toBe('2000.00');

    const result = await asOrg(f.orgId, (tx) =>
      repayFromOwner(tx, f.admin, {
        ownerId: id, amount: '2000.00', intoMoneyAccountId: f.till, on: '2026-01-20',
      }),
    );
    expect(result.outstanding).toBe('0.00');

    // ⭐ The whole point of routing it to 1260 rather than 3200: this was never a drawing.
    const after = await positionOf(f, id);
    expect(after.receivable).toBe('0.00');
    expect(after.drawn).toBe('0.00');
    expect(after.net).toBe('0.00');
  });

  it('a partial repayment leaves the rest outstanding', async () => {
    const f = await fixture('partial');
    const id = await owner(f);
    await owesUs(f, id, '2000.00');
    const result = await asOrg(f.orgId, (tx) =>
      repayFromOwner(tx, f.admin, {
        ownerId: id, amount: '750.00', intoMoneyAccountId: f.till, on: '2026-01-20',
      }),
    );
    expect(result.outstanding).toBe('1250.00');
  });

  it('⛔ settling more than is owed is refused', async () => {
    const f = await fixture('over');
    const id = await owner(f);
    await owesUs(f, id, '2000.00');
    await expect(
      asOrg(f.orgId, (tx) =>
        repayFromOwner(tx, f.admin, {
          ownerId: id, amount: '2500.00', intoMoneyAccountId: f.till, on: '2026-01-20',
        }),
      ),
    ).rejects.toThrow(/more than the ₱2000.00 this owner still owes/);
  });

  it('⭐ pay recovery moves it to 1230 against the PERSON, not the owner', async () => {
    const f = await fixture('recover');
    const id = await owner(f);
    await owesUs(f, id, '2000.00');

    const result = await asOrg(f.orgId, (tx) =>
      recoverFromPay(tx, f.admin, { ownerId: id, amount: '2000.00', on: '2026-01-20' }),
    );
    expect(result.outstanding).toBe('0.00');

    // ⚠️ 1230's party_type is `employee`, so the party changes with the account.
    const [row] = await sql<{ n: string }[]>`
      select coalesce(sum(jl.debit - jl.credit), 0)::text as n
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      where je.org_id = ${f.orgId} and a.code = '1230'
        and jl.party_type = 'employee' and jl.party_id = ${f.anaId}
        and je.status <> 'draft'
    `;
    expect(row!.n).toBe('2000.00');
  });

  it('⛔ pay recovery does NOT free the drawing limit — no cash has come back', async () => {
    const f = await fixture('nobypass');
    const id = await owner(f, { drawingLimit: '3000.00', drawingLimitPeriod: 'monthly' });
    await owesUs(f, id, '2000.00');

    // Reclassifying is not repaying. If 1230 were not counted, this would wrongly succeed.
    await asOrg(f.orgId, (tx) =>
      recoverFromPay(tx, f.admin, { ownerId: id, amount: '2000.00', on: '2026-01-20' }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        recordDrawing(tx, f.admin, {
          ownerId: id, amount: '1500.00', fromMoneyAccountId: f.till, on: '2026-01-25',
        }),
      ),
    ).rejects.toThrow(/over the ₱3000.00 monthly limit/);
  });

  it('⭐ but CASH repayment DOES free it — the money is really back', async () => {
    const f = await fixture('freed');
    const id = await owner(f, { drawingLimit: '3000.00', drawingLimitPeriod: 'monthly' });
    await owesUs(f, id, '2000.00');
    await asOrg(f.orgId, (tx) =>
      repayFromOwner(tx, f.admin, {
        ownerId: id, amount: '2000.00', intoMoneyAccountId: f.till, on: '2026-01-20',
      }),
    );
    // Room again, because the till has the money.
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, {
        ownerId: id, amount: '2500.00', fromMoneyAccountId: f.till, on: '2026-01-25',
      }),
    );
    expect((await positionOf(f, id)).drawn).toBe('2500.00');
  });

  it('⛔ pay recovery is refused for an owner who holds no role — no pay to recover from', async () => {
    const f = await fixture('norole');
    const [outsider] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${f.orgId}, 'Silent Partner') returning id
    `;
    const id = await owner(f, { personId: outsider!.id });
    await owesUs(f, id, '2000.00');
    await expect(
      asOrg(f.orgId, (tx) =>
        recoverFromPay(tx, f.admin, { ownerId: id, amount: '2000.00', on: '2026-01-20' }),
      ),
    ).rejects.toThrow(/no active role, so there is no pay to recover from/);
  });
});

describe('⭐ writing a receivable off — when it stops being one', () => {
  it('⭐ moves it to 3200, so it finally reduces equity', async () => {
    const f = await fixture('writeoff');
    const id = await owner(f);
    await owesUs(f, id, '2000.00');

    const result = await asOrg(f.orgId, (tx) =>
      writeOffReceivable(tx, f.admin, {
        ownerId: id, amount: '2000.00', reason: 'not collectible, agreed with the partners',
        on: '2026-02-05',
      }),
    );
    expect(result.outstanding).toBe('0.00');

    const after = await positionOf(f, id);
    expect(after.receivable).toBe('0.00');
    // ⭐ Equity moves now, and only now — this is the moment it became a distribution.
    expect(after.drawn).toBe('2000.00');
    expect(after.net).toBe('-2000.00');
  });

  it('⛔ needs a reason — otherwise it is indistinguishable from nobody bothering to collect', async () => {
    const f = await fixture('woreason');
    const id = await owner(f);
    await owesUs(f, id, '2000.00');
    await expect(
      asOrg(f.orgId, (tx) =>
        writeOffReceivable(tx, f.admin, { ownerId: id, amount: '2000.00', reason: '  ', on: '2026-02-05' }),
      ),
    ).rejects.toThrow(/say why/);
  });

  it('⭐ is allowed even AT the drawing limit, because the money already counted', async () => {
    const f = await fixture('woatcap');
    const id = await owner(f, { drawingLimit: '2000.00', drawingLimitPeriod: 'total' });
    await owesUs(f, id, '2000.00');

    // The receivable already consumes the whole cap. A drawing is refused...
    await expect(
      asOrg(f.orgId, (tx) =>
        recordDrawing(tx, f.admin, {
          ownerId: id, amount: '500.00', fromMoneyAccountId: f.till, on: '2026-02-05',
        }),
      ),
    ).rejects.toThrow(/over the ₱2000.00 total limit/);

    // ...but the write-off is not a NEW draw, it is the same money changing account. Blocking it
    // would leave a receivable nobody can ever clear off the books.
    await asOrg(f.orgId, (tx) =>
      writeOffReceivable(tx, f.admin, {
        ownerId: id, amount: '2000.00', reason: 'forgiven', on: '2026-02-05',
      }),
    );
    expect((await positionOf(f, id)).drawn).toBe('2000.00');
  });

  it('⛔ respects the monthly close — it IS a drawing', async () => {
    const f = await fixture('wolock');
    const id = await owner(f);
    await owesUs(f, id, '2000.00');
    await asOrg(f.orgId, (tx) =>
      closeDrawingMonth(tx, f.admin, { ownerId: id, month: '2026-01-01', on: '2026-02-01' }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        writeOffReceivable(tx, f.admin, {
          ownerId: id, amount: '2000.00', reason: 'forgiven', on: '2026-01-20',
        }),
      ),
    ).rejects.toThrow(/2026-01 is closed for this owner/);
  });

  it('⭐ an aged receivable surfaces with its age, measured from the OLDEST charge', async () => {
    const f = await fixture('aged');
    const id = await owner(f);
    await owesUs(f, id, '1000.00', '2026-01-05');
    await owesUs(f, id, '500.00', '2026-01-28');

    const aged = await asOrg(f.orgId, (tx) => ownersRepo.agedReceivables(tx, f.orgId));
    const mine = aged.find((a) => a.ownerId === id)!;
    expect(mine.outstanding).toBe('1500.00');
    // ⚠️ The oldest, not the newest and not an average — it is the one an examiner asks about.
    expect(mine.oldestOn).toBe('2026-01-05');
    expect(mine.daysOutstanding).toBeGreaterThan(0);
  });

  it('a fully settled owner drops off the aged list entirely', async () => {
    const f = await fixture('agedclear');
    const id = await owner(f);
    await owesUs(f, id, '1000.00');
    await asOrg(f.orgId, (tx) =>
      repayFromOwner(tx, f.admin, {
        ownerId: id, amount: '1000.00', intoMoneyAccountId: f.till, on: '2026-01-20',
      }),
    );
    const aged = await asOrg(f.orgId, (tx) => ownersRepo.agedReceivables(tx, f.orgId));
    expect(aged.find((a) => a.ownerId === id)).toBeUndefined();
  });
});

describe('the refusals', () => {
  it('⛔ funding from another store is refused', async () => {
    const f = await fixture('crossstore');
    const id = await owner(f);
    const [other] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${f.orgId}, ${uid('other')}, 'Other') returning id
    `;
    const [farTill] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${other!.id}
        and instrument = 'cash' and custodian = 'cashier' and is_foundation
    `;
    await expect(
      asOrg(f.orgId, (tx) =>
        recordContribution(tx, f.admin, {
          ownerId: id, amount: '1000.00', intoMoneyAccountId: farTill!.id, on: '2026-01-08',
        }),
      ),
    ).rejects.toThrow(/another store/);
  });

  it('⛔ a zero or negative movement is refused', async () => {
    const f = await fixture('zero');
    const id = await owner(f);
    await expect(
      asOrg(f.orgId, (tx) =>
        recordDrawing(tx, f.admin, { ownerId: id, amount: '0.00', fromMoneyAccountId: f.till, on: '2026-01-08' }),
      ),
    ).rejects.toThrow(/greater than zero/);
  });
});
