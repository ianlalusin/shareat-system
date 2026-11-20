import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
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
if (!isTestDatabaseUrl(url)) {
  throw new Error(
    `Refusing to run against ${redactDbUrl(url)} — the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { ownersRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
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
      recordContribution(tx, f.admin, { requestId: crypto.randomUUID(),
        ownerId: id, amount: '100000.00', intoMoneyAccountId: f.till, on: '2026-01-08',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(),
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
      recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(),
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
      recordContribution(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: ana, amount: '500000.00', intoMoneyAccountId: f.till, on: '2026-01-08' }),
    );
    await asOrg(f.orgId, (tx) =>
      recordContribution(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: ben, amount: '200000.00', intoMoneyAccountId: f.till, on: '2026-01-08' }),
    );
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: ana, amount: '300000.00', fromMoneyAccountId: f.till, on: '2026-01-09' }),
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
      recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '40000.00', fromMoneyAccountId: f.till, on: '2026-01-05' }),
    );
    // v1 sets this limit, DISPLAYS it back as a live constraint, and checks only `=== 'total'`.
    await expect(
      asOrg(f.orgId, (tx) =>
        recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '15000.00', fromMoneyAccountId: f.till, on: '2026-01-20' }),
      ),
    ).rejects.toThrow(/over the ₱50000.00 monthly limit/);
  });

  it('⭐ and the NEXT month starts fresh — otherwise it is a total limit wearing the wrong name', async () => {
    const f = await fixture('nextmonth');
    const id = await owner(f, { drawingLimit: '50000.00', drawingLimitPeriod: 'monthly' });
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '50000.00', fromMoneyAccountId: f.till, on: '2026-01-05' }),
    );
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '50000.00', fromMoneyAccountId: f.till, on: '2026-02-05' }),
    );
    expect((await positionOf(f, id)).drawn).toBe('100000.00');
  });

  it('⚠️ the window is the DRAWING’s month, so back-dating cannot slip a full month', async () => {
    const f = await fixture('backdate');
    const id = await owner(f, { drawingLimit: '50000.00', drawingLimitPeriod: 'monthly' });
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '50000.00', fromMoneyAccountId: f.till, on: '2026-01-05' }),
    );
    // Measured against TODAY this would pass, because February is empty.
    await expect(
      asOrg(f.orgId, (tx) =>
        recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '1000.00', fromMoneyAccountId: f.till, on: '2026-01-31' }),
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
      recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(),
        ownerId: id, amount: '50000.00', fromMoneyAccountId: f.till, on: '2026-01-10',
      }),
    );
    expect((await positionOf(f, id)).drawn).toBe('50000.00');
  });

  it('a TOTAL limit blocks across months', async () => {
    const f = await fixture('total');
    const id = await owner(f, { drawingLimit: '60000.00', drawingLimitPeriod: 'total' });
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '50000.00', fromMoneyAccountId: f.till, on: '2026-01-05' }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '20000.00', fromMoneyAccountId: f.till, on: '2026-02-05' }),
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
      recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '12000.00', fromMoneyAccountId: f.till, on: '2026-01-10' }),
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
      recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '12000.00', fromMoneyAccountId: f.till, on: '2026-01-10' }),
    );
    await asOrg(f.orgId, (tx) =>
      closeDrawingMonth(tx, f.admin, { ownerId: id, month: '2026-01-01', on: '2026-02-01' }),
    );

    await expect(
      asOrg(f.orgId, (tx) =>
        recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '5000.00', fromMoneyAccountId: f.till, on: '2026-01-15' }),
      ),
    ).rejects.toThrow(/2026-01 is closed for this owner/);

    // ⚠️ ...and the OPEN month is unaffected. A lock that stopped everything would just be an outage.
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '5000.00', fromMoneyAccountId: f.till, on: '2026-02-03' }),
    );
    expect((await positionOf(f, id)).drawn).toBe('17000.00');
  });

  it('⭐ an adjustment POSTS — "visible and enforced" means the books move', async () => {
    const f = await fixture('adjust');
    const id = await owner(f);
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '12000.00', fromMoneyAccountId: f.till, on: '2026-01-10' }),
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
      recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '12000.00', fromMoneyAccountId: f.till, on: '2026-01-10' }),
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
      recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: ben, amount: '1000.00', fromMoneyAccountId: f.till, on: '2026-01-15' }),
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
      repayFromOwner(tx, f.admin, { requestId: crypto.randomUUID(),
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
      repayFromOwner(tx, f.admin, { requestId: crypto.randomUUID(),
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
        repayFromOwner(tx, f.admin, { requestId: crypto.randomUUID(),
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
      recoverFromPay(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '2000.00', on: '2026-01-20' }),
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
      recoverFromPay(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '2000.00', on: '2026-01-20' }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(),
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
      repayFromOwner(tx, f.admin, { requestId: crypto.randomUUID(),
        ownerId: id, amount: '2000.00', intoMoneyAccountId: f.till, on: '2026-01-20',
      }),
    );
    // Room again, because the till has the money.
    await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(),
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
        recoverFromPay(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '2000.00', on: '2026-01-20' }),
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
      writeOffReceivable(tx, f.admin, { requestId: crypto.randomUUID(),
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
        writeOffReceivable(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '2000.00', reason: '  ', on: '2026-02-05' }),
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
        recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(),
          ownerId: id, amount: '500.00', fromMoneyAccountId: f.till, on: '2026-02-05',
        }),
      ),
    ).rejects.toThrow(/over the ₱2000.00 total limit/);

    // ...but the write-off is not a NEW draw, it is the same money changing account. Blocking it
    // would leave a receivable nobody can ever clear off the books.
    await asOrg(f.orgId, (tx) =>
      writeOffReceivable(tx, f.admin, { requestId: crypto.randomUUID(),
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
        writeOffReceivable(tx, f.admin, { requestId: crypto.randomUUID(),
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
      repayFromOwner(tx, f.admin, { requestId: crypto.randomUUID(),
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
        recordContribution(tx, f.admin, { requestId: crypto.randomUUID(),
          ownerId: id, amount: '1000.00', intoMoneyAccountId: farTill!.id, on: '2026-01-08',
        }),
      ),
    ).rejects.toThrow(/another store/);
  });

  it('⛔ a cashier drawer is REFUSED past its overdraft cap, through a real posting', async () => {
    const f = await fixture('cap');
    const id = await owner(f);
    const [drawer] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${f.storeId}
        and instrument = 'cash' and custodian = 'cashier' and is_foundation
    `;
    // ⭐ Ian, 2026-08-27: "it can't be unlimited, so admin can set it."
    // ⚠️ The drawer holds ₱500,000 — fund() debits 1110, which IS this account's GL code. With a
    // ₱5,000 cap, a ₱506,000 draw lands at −₱6,000 and is refused. (My first version of this test
    // assumed an empty drawer and passed for the wrong reason.)
    await sql`update money_accounts set overdraft_limit = '5000.00' where id = ${drawer!.id}`;

    await expect(
      asOrg(f.orgId, (tx) =>
        recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(),
          ownerId: id, amount: '506000.00', fromMoneyAccountId: drawer!.id, on: '2026-01-10',
        }),
      ),
    ).rejects.toThrow(/past the 5000.00 overdraft/);
  });

  it('⚠️ and still only WARNS inside the cap — the day is unverified, not overdrawn', async () => {
    const f = await fixture('capwarn');
    const id = await owner(f);
    const [drawer] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${f.storeId}
        and instrument = 'cash' and custodian = 'cashier' and is_foundation
    `;
    await sql`update money_accounts set overdraft_limit = '5000.00' where id = ${drawer!.id}`;

    const result = await asOrg(f.orgId, (tx) =>
      recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(),
        // Lands at −₱4,000 — inside the ₱5,000 cap.
        ownerId: id, amount: '504000.00', fromMoneyAccountId: drawer!.id, on: '2026-01-10',
      }),
    );
    // It posts, and it says so — a cashier drawer running behind is expected, and blocking it would
    // stop real work on a technicality the cashier can see is wrong.
    expect(result.warning).toMatch(/Allowed down to −5000.00/);
    expect((await positionOf(f, id)).drawn).toBe('504000.00');
  });

  it('⛔ a zero or negative movement is refused', async () => {
    const f = await fixture('zero');
    const id = await owner(f);
    await expect(
      asOrg(f.orgId, (tx) =>
        recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '0.00', fromMoneyAccountId: f.till, on: '2026-01-08' }),
      ),
    ).rejects.toMatchObject({ name: 'RefusalError', userMessage: 'A drawing has to be greater than zero.' });
  });
});

describe('DEF-272 — a sub-centavo amount is refused with a written sentence, not driver text', () => {
  it('createOwner refuses "0.004" for drawingLimit — found by the shape scanner, not in the original T-260 known-sites list', async () => {
    const f = await fixture('def272-limit');
    await expect(
      asOrg(f.orgId, (tx) =>
        createOwner(tx, f.admin, {
          storeId: f.storeId, personId: f.anaId, drawingLimit: '0.004', drawingLimitPeriod: 'monthly',
        }),
      ),
    ).rejects.toMatchObject({"name":"RefusalError","message":"owners.createOwner.drawingLimit: money check failed","userMessage":"The drawing limit — \"0.004\" is not a valid amount. Use at most two decimal places."});
  });

  it('an ordinary drawing limit still works', async () => {
    const f = await fixture('def272-limit-happy');
    const id = await owner(f, { drawingLimit: '0.01', drawingLimitPeriod: 'monthly' });
    const row = await asOrg(f.orgId, (tx) => ownersRepo.getById(tx, f.orgId, id));
    expect(row!.drawingLimit).toBe('0.01');
  });

  it('recordContribution refuses "0.004"', async () => {
    const f = await fixture('def272-contribution');
    const id = await owner(f);
    await expect(
      asOrg(f.orgId, (tx) =>
        recordContribution(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '0.004', intoMoneyAccountId: f.till, on: '2026-01-08' }),
      ),
    ).rejects.toMatchObject({"name":"RefusalError","message":"owners.contribution.amount: money check failed","userMessage":"The contribution amount — \"0.004\" is not a valid amount. Use at most two decimal places."});
  });
});

// -------------------------------------------------------------------------------------------------
// T-593 S3 - DEF-871 (the owner lock on settlements) and DEF-872 (the month close on settlements)
// -------------------------------------------------------------------------------------------------

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };

/** Two real transactions at once: A runs its operation and stays OPEN; B starts and queues (if the lock exists) behind A; only then does A commit. */
async function twoAtOnce<TA, TB>(orgId: string, opA: (tx: Tx) => Promise<TA>, opB: (tx: Tx) => Promise<TB>): Promise<{ a: Settled<TA>; b: Settled<TB>; bWaited: boolean }> {
  const aReady = deferred<void>();
  const gate = deferred<void>();
  let aPid = 0;
  const a: Promise<Settled<TA>> = asOrg(orgId, async (tx) => {
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
  const b: Promise<Settled<TB>> = asOrg(orgId, opB).then(
    (value) => ({ status: 'fulfilled', value }) as const,
    (reason) => ({ status: 'rejected', reason }) as const,
  );
  // Is B waiting on A, on the OWNER row (its `select ... from owners ... for update`)? Not "any waiter in the database": B must be blocked BY A's backend,
  // and the statement it is stuck in must be the owner lock. Poll until it is, or B finishes without waiting (no lock).
  let bWaited = false;
  const deadline = Date.now() + 5000;
  const finished = b.then(() => true);
  while (Date.now() < deadline && !bWaited) {
    const rows = await sql<{ pid: number }[]>`
      select pid from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and ${aPid} = any(pg_blocking_pids(pid)) and query ilike '%from owners%' and query ilike '%for update%'`;
    if (rows.length > 0) bWaited = true;
    else if (await Promise.race([finished, new Promise<boolean>((r) => setTimeout(() => r(false), 20))])) break;
  }
  gate.resolve();
  const [ar, br] = await Promise.all([a, b]);
  return { a: ar, b: br, bWaited };
}

const entryCount = async (f: Fixture, sourceType: string, ownerId: string) =>
  Number(
    (await sql<{ n: string }[]>`
      select count(*)::text as n from journal_entries where org_id = ${f.orgId} and source_type = ${sourceType} and source_id = ${ownerId}
    `)[0]!.n,
  );
const receivable = (f: Fixture, id: string) => asOrg(f.orgId, (tx) => ownersRepo.receivableOf(tx, f.orgId, id));

describe('DEF-871 - one receivable, settled once', () => {
  it('two concurrent full repayments: one commits, the other is refused "more than the ₱", receivable 0.00 - Mutant: remove the lock in repayFromOwner -> both commit, -1000.00, red', async () => {
    const f = await fixture('def871-repay');
    const id = await owner(f);
    await owesUs(f, id, '1000.00');
    const op = (tx: Tx) =>
      repayFromOwner(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '1000.00', intoMoneyAccountId: f.till, on: '2026-01-20' });
    const { a, b, bWaited } = await twoAtOnce(f.orgId, op, op);
    expect(bWaited, 'B never waited: no lock').toBe(true);
    expect([a, b].filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = [a, b].find((r) => r.status === 'rejected') as { status: 'rejected'; reason: Error };
    expect(String(rejected.reason.message)).toMatch(/more than the ₱/);
    expect(await receivable(f, id)).toBe('0.00');
    expect(await entryCount(f, 'owner_repayment', id)).toBe(1);
  });

  it('two concurrent write-offs of the full receivable: one commits, the other is refused, receivable 0.00 - Mutant: remove the lock in writeOffReceivable -> both commit, red', async () => {
    const f = await fixture('def871-writeoff');
    const id = await owner(f);
    await owesUs(f, id, '1000.00');
    const op = (tx: Tx) =>
      writeOffReceivable(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '1000.00', reason: 'forgiven', on: '2026-01-20' });
    const { a, b, bWaited } = await twoAtOnce(f.orgId, op, op);
    expect(bWaited, 'B never waited: no lock').toBe(true);
    expect([a, b].filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(String(([a, b].find((r) => r.status === 'rejected') as { reason: Error }).reason.message)).toMatch(/more than the ₱/);
    expect(await receivable(f, id)).toBe('0.00');
    expect(await entryCount(f, 'owner_writeoff', id)).toBe(1);
  });

  it('two concurrent pay recoveries of the full receivable: one commits, the other is refused - Mutant: remove the lock in recoverFromPay -> both commit, red', async () => {
    const f = await fixture('def871-recover');
    const { id } = await asOrg(f.orgId, (tx) => createOwner(tx, f.admin, { storeId: f.storeId, personId: f.adminId, drawingLimit: null, drawingLimitPeriod: null }));
    await owesUs(f, id, '1000.00');
    const op = (tx: Tx) => recoverFromPay(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '1000.00', on: '2026-01-20' });
    const { a, b, bWaited } = await twoAtOnce(f.orgId, op, op);
    expect(bWaited, 'B never waited: no lock').toBe(true);
    expect([a, b].filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(String(([a, b].find((r) => r.status === 'rejected') as { reason: Error }).reason.message)).toMatch(/more than the ₱/);
    expect(await receivable(f, id)).toBe('0.00');
    expect(await entryCount(f, 'owner_pay_recovery', id)).toBe(1);
  });
});

describe('DEF-872 - repayment and pay recovery respect the month close', () => {
  async function closedJanuary(hint: string) {
    const f = await fixture(hint);
    // The admin is the owner so the pay-recovery "has an active role" rule is met.
    const { id } = await asOrg(f.orgId, (tx) => createOwner(tx, f.admin, { storeId: f.storeId, personId: f.adminId, drawingLimit: null, drawingLimitPeriod: null }));
    await owesUs(f, id, '2000.00', '2026-01-12');
    await asOrg(f.orgId, (tx) => closeDrawingMonth(tx, f.admin, { ownerId: id, month: '2026-01-01', on: '2026-02-01' }));
    return { f, id };
  }

  it('repaying into a closed month is refused and posts nothing; the next month works - Mutant: delete the assertMonthOpen call in repayFromOwner -> red', async () => {
    const { f, id } = await closedJanuary('def872-repay');
    await expect(
      asOrg(f.orgId, (tx) => repayFromOwner(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '500.00', intoMoneyAccountId: f.till, on: '2026-01-20' })),
    ).rejects.toThrow(/2026-01 is closed for this owner/);
    expect(await entryCount(f, 'owner_repayment', id)).toBe(0);
    await asOrg(f.orgId, (tx) => repayFromOwner(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '500.00', intoMoneyAccountId: f.till, on: '2026-02-05' }));
    expect(await entryCount(f, 'owner_repayment', id)).toBe(1);
  });

  it('recovering from pay into a closed month is refused and posts nothing; the next month works - Mutant: delete the assertMonthOpen call in recoverFromPay -> red', async () => {
    const { f, id } = await closedJanuary('def872-recover');
    await expect(
      asOrg(f.orgId, (tx) => recoverFromPay(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '500.00', on: '2026-01-20' })),
    ).rejects.toThrow(/2026-01 is closed for this owner/);
    expect(await entryCount(f, 'owner_pay_recovery', id)).toBe(0);
    await asOrg(f.orgId, (tx) => recoverFromPay(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '500.00', on: '2026-02-06' }));
    expect(await entryCount(f, 'owner_pay_recovery', id)).toBe(1);
  });
});

// -------------------------------------------------------------------------------------------------
// T-593 S4 - DEF-873: reverseOwnerEntry only reverses this owner's own postings
// -------------------------------------------------------------------------------------------------

describe('DEF-873 - reverseOwnerEntry is bound to the owner, the gate and the month', () => {
  const reversalRows = async (f: Fixture) =>
    Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${f.orgId} and reversal_of_entry_id is not null`)[0]!.n);
  const SENTENCE = 'That entry does not belong to this owner.';
  const userMessage = (p: Promise<unknown>) => p.then(() => null, (e: { userMessage?: string }) => e.userMessage ?? null);
  const reverse = (f: Fixture, ownerId: string, entryId: string, who: Actor = f.admin) =>
    asOrg(f.orgId, (tx) => reverseOwnerEntry(tx, who, { ownerId, entryId, reason: 'test' }));
  const draw = async (f: Fixture, ownerId: string, on = '2026-01-10') =>
    (await asOrg(f.orgId, (tx) => recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(), ownerId, amount: '1000.00', fromMoneyAccountId: f.till, on }))).entryId;
  const secondOwner = async (f: Fixture) =>
    (await asOrg(f.orgId, (tx) => createOwner(tx, f.admin, { storeId: f.storeId, personId: f.adminId, drawingLimit: null, drawingLimitPeriod: null }))).id;

  it("another owner's drawing is refused, and nothing is reversed - Mutant: delete the entry binding -> red", async () => {
    const f = await fixture('def873-other');
    const mine = await owner(f);
    const theirs = await secondOwner(f);
    const theirEntry = await draw(f, theirs);
    expect(await userMessage(reverse(f, mine, theirEntry))).toBe(SENTENCE);
    expect(await reversalRows(f)).toBe(0);
  });

  it('an entry that is not an owner posting (an opening balance, an expense) is refused', async () => {
    const f = await fixture('def873-foreign-type');
    const id = await owner(f);
    await owesUs(f, id, '300.00');
    const [opening] = await sql<{ id: string }[]>`select id from journal_entries where org_id = ${f.orgId} and source_type = 'opening_balance' limit 1`;
    const [expense] = await sql<{ id: string }[]>`select id from journal_entries where org_id = ${f.orgId} and source_type = 'expense' limit 1`;
    for (const entryId of [opening!.id, expense!.id]) expect(await userMessage(reverse(f, id, entryId))).toBe(SENTENCE);
    expect(await reversalRows(f)).toBe(0);
  });

  it("another organisation's owner entry is refused", async () => {
    const f = await fixture('def873-org-a');
    const g = await fixture('def873-org-b');
    const id = await owner(f);
    const foreignOwner = await owner(g);
    const foreignEntry = await draw(g, foreignOwner);
    expect(await userMessage(reverse(f, id, foreignEntry))).toBe(SENTENCE);
    expect(await reversalRows(f)).toBe(0);
    expect(await reversalRows(g)).toBe(0);
  });

  it('a person holding only transfer_funds reverses a drawing, but not a write-off (approve_expense) - Mutant: delete the second authorize -> red', async () => {
    const f = await fixture('def873-gate');
    const id = await owner(f);
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Fund Mover') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'staff')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.storeId})`;
    await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source, store_id) values (${p!.id}, 'transfer_funds', ${f.adminId}, 'grant', ${f.storeId})`;
    const mover = actor(f.orgId, p!.id);

    const drawEntry = await draw(f, id);
    await reverse(f, id, drawEntry, mover); // positive: the cap they hold
    expect(await reversalRows(f)).toBe(1);

    await owesUs(f, id, '400.00');
    const writeOff = (await asOrg(f.orgId, (tx) => writeOffReceivable(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '400.00', reason: 'forgiven', on: '2026-01-20' }))).entryId;
    await expect(reverse(f, id, writeOff, mover)).rejects.toThrow(AuthorizationError);
    expect(await reversalRows(f)).toBe(1);
    await reverse(f, id, writeOff); // the admin may
    expect(await reversalRows(f)).toBe(2);
  });

  it("a drawing in a closed month cannot be reversed; the original and the month stay as they were - Mutant: delete the month check -> red", async () => {
    const f = await fixture('def873-closed');
    const id = await owner(f);
    const entryId = await draw(f, id, '2026-01-10');
    await asOrg(f.orgId, (tx) => closeDrawingMonth(tx, f.admin, { ownerId: id, month: '2026-01-01', on: '2026-02-01' }));
    await expect(reverse(f, id, entryId)).rejects.toThrow(/2026-01 is closed for this owner/);
    expect(await reversalRows(f)).toBe(0);
  });

  it('control: the owner\'s own drawing still reverses and nets out (the existing positive case, again with the new binding)', async () => {
    const f = await fixture('def873-ok');
    const id = await owner(f);
    const entryId = await draw(f, id);
    await reverse(f, id, entryId);
    expect((await positionOf(f, id)).drawn).toBe('0.00');
  });
});

// -------------------------------------------------------------------------------------------------
// T-593 S5 - DEF-874: a retired money account takes no contribution, drawing or repayment
// -------------------------------------------------------------------------------------------------

describe('DEF-874 - retired accounts', () => {
  it('an active account posts; once retired, contribution, drawing and repayment are all refused with the sentence and post nothing - Mutant: delete each check -> red', async () => {
    const f = await fixture('def874');
    const id = await owner(f);
    await owesUs(f, id, '500.00');
    const contribute = () =>
      asOrg(f.orgId, (tx) => recordContribution(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '100.00', intoMoneyAccountId: f.till, on: '2026-01-15' }));
    const drawOut = () =>
      asOrg(f.orgId, (tx) => recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '100.00', fromMoneyAccountId: f.till, on: '2026-01-15' }));
    const repay = () =>
      asOrg(f.orgId, (tx) => repayFromOwner(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount: '100.00', intoMoneyAccountId: f.till, on: '2026-01-15' }));

    // positive: the active account takes all three
    await contribute();
    await drawOut();
    await repay();
    const count = async () =>
      Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${f.orgId} and source_id = ${id} and source_type in ('capital_contribution', 'drawing', 'owner_repayment')`)[0]!.n);
    expect(await count()).toBe(3);

    await sql`update money_accounts set is_active = false where id = ${f.till}`;
    const sentence = (p: Promise<unknown>) => p.then(() => null, (e: { userMessage?: string }) => e.userMessage ?? null);
    for (const attempt of [contribute, drawOut, repay]) {
      expect(String(await sentence(attempt()))).toMatch(/is retired\. Choose an account that is still in use\.$/);
    }
    expect(await count()).toBe(3);
  });
});

// -------------------------------------------------------------------------------------------------
// T-598 S6 - DEF-544: a drawing is judged on the owner row AFTER the lock, and refuses before it
// -------------------------------------------------------------------------------------------------

describe('DEF-544 - recordDrawing and the owner row lock', () => {
  const draw = (f: Fixture, id: string, amount: string, on = '2026-01-20') => (tx: Tx) =>
    recordDrawing(tx, f.admin, { requestId: crypto.randomUUID(), ownerId: id, amount, fromMoneyAccountId: f.till, on });

  it('a limit set while the drawing waited applies to it - Mutant: judge the row read before the lock -> the drawing posts, red', async () => {
    const f = await fixture('def544-reread');
    const id = await owner(f);
    const setLimit = (tx: Tx) => ownersRepo.updateOwner(tx, f.orgId, id, { drawingLimit: '100.00' as never, drawingLimitPeriod: 'monthly' });
    const { b, bWaited } = await twoAtOnce(f.orgId, setLimit, draw(f, id, '500.00'));
    expect(bWaited, 'B never waited on the owner lock').toBe(true);
    expect(b.status).toBe('rejected');
    expect(String((b as { reason: Error }).reason.message)).toMatch(/over the ₱100\.00 monthly limit/);
    expect(await entryCount(f, 'drawing', id)).toBe(0);
  });

  it('a closed month is refused without ever queueing on the owner row - Mutant: lock first -> B waits, red', async () => {
    const f = await fixture('def544-early');
    const id = await owner(f);
    await asOrg(f.orgId, (tx) => draw(f, id, '1000.00', '2026-01-10')(tx));
    await asOrg(f.orgId, (tx) => closeDrawingMonth(tx, f.admin, { ownerId: id, month: '2026-01-01', on: '2026-02-01' }));
    const holdLock = (tx: Tx) => tx.execute(dsql`select 1 from owners where id = ${id} for update`);
    const { b, bWaited } = await twoAtOnce(f.orgId, holdLock, draw(f, id, '500.00', '2026-01-15'));
    expect(bWaited, 'a closed-month drawing queued on the lock').toBe(false);
    expect(b.status).toBe('rejected');
    expect(String((b as { reason: Error }).reason.message)).toMatch(/2026-01 is closed for this owner/);
  });
});
