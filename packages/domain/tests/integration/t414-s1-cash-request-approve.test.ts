import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-414 S1 - approve re-checks every cash-request leg against LIVE outstanding, inside the approve transaction;
 * a float posts with no staff account. `docs/tasks/414-expense-cash-request-source.md` I4, I6-I9.
 *
 * MUTANTS (each turns a NAMED test red; none is planted in the tree):
 *   M4 routing drops the party on the null-account path ... I4 (party / float arithmetic)
 *   M6 delete the approve check ................ I6 (second draft is refused), I7, I9 (all three)
 *   M7 compare per leg, not summed per request .. I7 (600 + 600 on a 1,000 float); the 600 + 400 control stays green
 *   M8 drop FOR UPDATE ........................ I8 (two REAL transactions; B reads before A commits)
 *   M9 drop the status check .................. I9 (liquidated, cancelled-never-released, wrong store)
 *
 * I8 note: the two drafts sit on TWO DIFFERENT invoices. On one invoice `approveExpense` already serialises through
 * `lockInvoiceForRecording`, which would mask M8 - the request-row lock must be the thing that serialises them.
 * Every other leg uses the staff-float account that every store is seeded with; I4 deletes it first.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { cashRequestsRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  approveExpense,
  createExpense,
  createCashRequest,
  decideCashRequest,
  releaseCashRequest,
  settleCashRequest,
  cancelCashRequest,
} from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end();
  await closeDb();
});

async function asPerson<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actorOf = (orgId: string, personId: string): Actor => ({ orgId, personId });

async function fundAccount(orgId: string, storeId: string, code: string, amount: string): Promise<void> {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-02', ${period!.id}, 'opening_balance', ${uid('open')}, 'draft') returning id`;
    const [target] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = ${code}`;
    const [equity] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '3900'`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
             values (${e!.id}, 1, ${target!.id}, ${storeId}, ${amount}, '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
             values (${e!.id}, 2, ${equity!.id}, ${storeId}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

interface Fixture {
  orgId: string;
  storeId: string;
  otherStoreId: string;
  staffId: string;
  managerId: string;
  staffFloatId: string | null;
  officeSafeId: string;
  otherOfficeSafeId: string;
  categoryId: string;
  supplierId: string;
  fileId: string;
}

async function setup(hint: string, o: { noStaffAccount?: boolean } = {}): Promise<Fixture> {
  // `noStaffAccount` deletes the seeded staff account BEFORE any release (R-AUTO: the release must then create one).
  const code = uid(`t414-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const mkStore = async (name: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(name)}, ${`${name} ${hint}`}) returning id`)[0]!.id;
  const storeId = await mkStore('A');
  const otherStoreId = await mkStore('B');

  const person = async (name: string, role: 'staff' | 'manager') => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${otherStoreId})`;
    return p!.id;
  };
  const staffId = await person(`${hint} Ana`, 'staff');
  const managerId = await person(`${hint} Manager`, 'manager');
  const grant = async (sid: string) => {
    const [employment] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${orgId}, ${sid}, ${staffId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
    await grantEverydayPositionAccess(sql, { orgId, storeId: sid, employmentId: employment!.id, personId: staffId, setBy: managerId });
  };
  await grant(storeId);
  await grant(otherStoreId);

  const account = async (sid: string, custodian: 'staff' | 'office') => {
    const [row] = await sql<{ id: string }[]>`
      select id from money_accounts where org_id = ${orgId} and store_id = ${sid} and custodian = ${custodian} and instrument = 'cash'`;
    return row?.id ?? null;
  };
  const officeSafeId = (await account(storeId, 'office'))!;
  const otherOfficeSafeId = (await account(otherStoreId, 'office'))!;
  let staffFloatId = await account(storeId, 'staff');
  if (o.noStaffAccount) {
    // Nothing is posted yet, so the row is unreferenced; release never needs it (it debits 1120 directly).
    await sql`delete from money_accounts where org_id = ${orgId} and custodian = 'staff'`;
    staffFloatId = null;
  }
  await fundAccount(orgId, storeId, '1130', '500000.00');
  await fundAccount(orgId, otherStoreId, '1130', '500000.00');

  const [category] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${orgId} and account_code is not null limit 1`;
  const [supplier] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgId}, ${`${hint} Supplier`}, ${staffId}) returning id`;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/${hint}.jpg`}, 'image/jpeg', 1024, ${`sum-${code}`}, ${staffId}) returning id`;
  return {
    orgId, storeId, otherStoreId, staffId, managerId, staffFloatId, officeSafeId, otherOfficeSafeId,
    categoryId: category!.id, supplierId: supplier!.id, fileId: file!.id,
  };
}

/** A verified invoice with room for any test amount. One per draft where the drafts must not share a lock. */
async function invoice(f: Fixture, storeId = f.storeId): Promise<string> {
  const [inv] = await sql<{ id: string }[]>`
    insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, status, receipt_file_id, verified_by, verified_at, created_by,
      attested_supplier, attested_invoice, attested_items, attested_price)
    values (${f.orgId}, ${storeId}, ${f.supplierId}, '2026-01-05', '99999999.00', 'verified', ${f.fileId}, ${f.managerId}, now(), ${f.staffId}, true, true, true, true)
    returning id`;
  return inv!.id;
}

/** Request -> approve -> release (from a safe) through the real domain functions. */
async function releasedFloat(f: Fixture, amount: string, storeId = f.storeId, fromSafe = f.officeSafeId, holderId = f.staffId): Promise<string> {
  const manager = actorOf(f.orgId, f.managerId);
  const { id } = await asPerson(f.orgId, (tx) =>
    createCashRequest(tx, manager, { storeId, requestedFor: holderId, purpose: 'Market run', amount, on: '2026-01-05' }),
  );
  await asPerson(f.orgId, (tx) => decideCashRequest(tx, manager, { requestId: id, decision: 'approve', amount, on: '2026-01-05' }));
  await asPerson(f.orgId, (tx) => releaseCashRequest(tx, manager, { requestId: id, amount, fromMoneyAccountId: fromSafe, on: '2026-01-05' }));
  return id;
}

/** A second person, so a second float can sit on the same store's staff-float account. */
async function otherHolder(f: Fixture, name: string): Promise<string> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.storeId})`;
  return p!.id;
}
/** An unrelated 5,000 float at store A. The store's staff-float account then holds enough in AGGREGATE to cover small
 *  draws, so only the per-request check (not the per-account `checkDraw`) can refuse - the red reason is the right one. */
async function coverFloat(f: Fixture): Promise<void> {
  await releasedFloat(f, '5000.00', f.storeId, f.officeSafeId, await otherHolder(f, 'Cover Holder'));
}

type Leg = { amount: string; cashRequestId: string; moneyAccountId?: string | null };
async function draft(f: Fixture, legs: Leg[], o: { invoiceId?: string; storeId?: string } = {}): Promise<string> {
  const invoiceId = o.invoiceId ?? (await invoice(f, o.storeId));
  const { id } = await asPerson(f.orgId, (tx) =>
    createExpense(tx, actorOf(f.orgId, f.staffId), {
      storeId: o.storeId ?? f.storeId,
      businessDate: '2026-01-05',
      categoryId: f.categoryId,
      supplierId: f.supplierId,
      supplierInvoiceId: invoiceId,
      particulars: `T-414 draw ${uid('p')}`,
      payments: legs.map((l) => ({
        method: 'cash' as const,
        amount: l.amount,
        cashRequestId: l.cashRequestId,
        moneyAccountId: l.moneyAccountId === undefined ? f.staffFloatId : l.moneyAccountId,
      })),
    }),
  );
  return id;
}

const approve = (f: Fixture, expenseId: string) => asPerson(f.orgId, (tx) => approveExpense(tx, actorOf(f.orgId, f.managerId), expenseId));
const outstandingOf = async (f: Fixture, id: string) =>
  (await asPerson(f.orgId, (tx) => cashRequestsRepo.floatPositionOf(tx, f.orgId, id))).outstanding;
const statusOf = async (expenseId: string) => (await sql<{ status: string }[]>`select status from expenses where id = ${expenseId}`)[0]!.status;
const postingsFor = async (expenseId: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text n from journal_entries where source_id = ${expenseId} and source_type = 'expense_payment'`)[0]!.n);

/** The refusal's `userMessage` (the sentence a person reads); a marker string when the promise RESOLVED (no refusal). */
async function userMessageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { userMessage?: string }).userMessage ?? `NO userMessage: ${(err as Error).message}`;
  }
  return '<<APPROVE SUCCEEDED - NO REFUSAL>>';
}
// The spec fixes the sentence's words, not the peso format: "₱400" and "₱400.00" both pass.
const peso = (n: string) => `₱${n.replace(/\./g, '\\.').replace(/\\\.00$/, '')}(\\.00)?`;
const overSpend = (holder: string, left: string, drawn: string) =>
  new RegExp(`^${holder}'s cash request has ${peso(left)} left — this expense draws ${peso(drawn)} from it\\. Lower the amount or pay the rest another way\\.$`);

describe('I4 (legacy) - a float released before R-AUTO posts with NO staff account: credit 1120, party = the request, at the expense store', () => {
  it('draft with cashRequestId and no money account approves; the ledger names the request; the float falls', async () => {
    // LEGACY shape (R-AUTO): a request released BEFORE the auto-create existed, at a store with no staff account.
    const f = await setup('i4');
    const req = await releasedFloat(f, '1000.00');
    await sql`delete from money_accounts where org_id = ${f.orgId} and custodian = 'staff'`;
    const id = await draft(f, [{ amount: '600.00', cashRequestId: req, moneyAccountId: null }]);

    const res = await approve(f, id);
    expect(res.created).toBe(true);
    expect(await statusOf(id)).toBe('posted');

    const [credit] = await sql<{ code: string; party_type: string | null; party_id: string | null; store_id: string; credit: string }[]>`
      select a.code, jl.party_type, jl.party_id, jl.store_id, jl.credit::text from journal_lines jl
      join accounts a on a.id = jl.account_id
      join expenses e on e.journal_entry_id = jl.entry_id
      where e.id = ${id} and jl.credit > 0`;
    expect(credit).toEqual({ code: '1120', party_type: 'cash_request', party_id: req, store_id: f.storeId, credit: '600.00' });
    // The arithmetic, not just "it saved": a dropped party leaves outstanding at 1,000 (M4).
    expect(await outstandingOf(f, req)).toBe('400.00');
  });
});

const staffCashAccounts = (orgId: string, storeId: string) => sql<{ id: string; name: string; gl_account_code: string; is_active: boolean }[]>`
  select id, name, gl_account_code, is_active from money_accounts
  where org_id = ${orgId} and store_id = ${storeId} and custodian = 'staff' and instrument = 'cash'`;

describe('R-AUTO - releasing a request creates the store staff cash account when there is none', () => {
  it('(a) no account -> release creates exactly one: staff / cash / 1120 / "Staff cash — <store>", audited with the releasing actor', async () => {
    const f = await setup('ra', { noStaffAccount: true });
    expect(await staffCashAccounts(f.orgId, f.storeId)).toHaveLength(0);
    const req = await releasedFloat(f, '1000.00');
    const rows = await staffCashAccounts(f.orgId, f.storeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Staff cash — A ra', gl_account_code: '1120', is_active: true });
    const audit = await sql<{ actor_person_id: string; entity_id: string }[]>`
      select actor_person_id, entity_id from audit_log where org_id = ${f.orgId} and action = 'money_account.created'`;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_person_id: f.managerId, entity_id: rows[0]!.id });
    // The float itself is unharmed.
    expect(await outstandingOf(f, req)).toBe('1000.00');
  });

  it('(c) an existing account is reused, never duplicated, and no creation is audited', async () => {
    const f = await setup('rc');
    const before = await staffCashAccounts(f.orgId, f.storeId);
    expect(before).toHaveLength(1);
    await releasedFloat(f, '500.00');
    await releasedFloat(f, '700.00', f.storeId, f.officeSafeId, await otherHolder(f, 'Second Holder'));
    const after = await staffCashAccounts(f.orgId, f.storeId);
    expect(after.map((r) => r.id)).toEqual([before[0]!.id]);
    const audit = await sql`select 1 from audit_log where org_id = ${f.orgId} and action = 'money_account.created'`;
    expect(audit).toHaveLength(0);
  });

  it('(b) four releases at once at a store with no account create exactly ONE account, and every release succeeds', async () => {
    const f = await setup('rb', { noStaffAccount: true });
    const manager = actorOf(f.orgId, f.managerId);
    // Four holders, four approved requests, then all four released concurrently (each its own real transaction).
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const holder = await otherHolder(f, `Holder ${i}`);
      const { id } = await asPerson(f.orgId, (tx) =>
        createCashRequest(tx, manager, { storeId: f.storeId, requestedFor: holder, purpose: 'Run', amount: '100.00', on: '2026-01-05' }),
      );
      await asPerson(f.orgId, (tx) => decideCashRequest(tx, manager, { requestId: id, decision: 'approve', amount: '100.00', on: '2026-01-05' }));
      ids.push(id);
    }
    const results = await Promise.allSettled(
      ids.map((id) =>
        asPerson(f.orgId, (tx) => releaseCashRequest(tx, manager, { requestId: id, amount: '100.00', fromMoneyAccountId: f.officeSafeId, on: '2026-01-05' })),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
    expect(await staffCashAccounts(f.orgId, f.storeId)).toHaveLength(1);
    const audit = await sql`select 1 from audit_log where org_id = ${f.orgId} and action = 'money_account.created'`;
    expect(audit).toHaveLength(1);
  });
});

describe('I6 - two drafts of 600 on one 1,000 float: the first approves, the second is refused with the over-spend sentence', () => {
  it('second approve refuses, names the holder, what is left and what is drawn; draft stays; nothing posted', async () => {
    const f = await setup('i6');
    const req = await releasedFloat(f, '1000.00');
    const first = await draft(f, [{ amount: '600.00', cashRequestId: req }]);
    const second = await draft(f, [{ amount: '600.00', cashRequestId: req }]);

    await approve(f, first);
    expect(await outstandingOf(f, req)).toBe('400.00');

    const msg = await userMessageOf(approve(f, second));
    expect(msg, 'the second approve must be refused').toMatch(overSpend('i6 Ana', '400', '600'));
    expect(await statusOf(second)).toBe('draft');
    expect(await postingsFor(second)).toBe(0);
    expect(await outstandingOf(f, req)).toBe('400.00');
  });

  it('boundary: drawing exactly what is left (600 then 400) is allowed and drains the float to zero', async () => {
    const f = await setup('i6b');
    const req = await releasedFloat(f, '1000.00');
    await approve(f, await draft(f, [{ amount: '600.00', cashRequestId: req }]));
    await approve(f, await draft(f, [{ amount: '400.00', cashRequestId: req }]));
    expect(await outstandingOf(f, req)).toBe('0.00');
  });

  it('one centavo over what is left is refused (exact centavos, no rounding slack)', async () => {
    const f = await setup('i6c');
    const req = await releasedFloat(f, '1000.00');
    await approve(f, await draft(f, [{ amount: '999.99', cashRequestId: req }]));
    const second = await draft(f, [{ amount: '0.02', cashRequestId: req }]);
    expect(await userMessageOf(approve(f, second))).toMatch(overSpend('i6c Ana', '0.01', '0.02'));
  });
});

describe('I7 - two legs of 600 on one float in ONE expense are refused at approve', () => {
  it('summed per request, not compared per leg', async () => {
    const f = await setup('i7');
    const req = await releasedFloat(f, '1000.00');
    const id = await draft(f, [
      { amount: '600.00', cashRequestId: req },
      { amount: '600.00', cashRequestId: req },
    ]);
    expect(await userMessageOf(approve(f, id))).toMatch(overSpend('i7 Ana', '1,000', '1,200'));
    expect(await statusOf(id)).toBe('draft');
    expect(await postingsFor(id)).toBe(0);
  });

  it('control: 600 + 400 on the same 1,000 float is exactly affordable and posts', async () => {
    const f = await setup('i7c');
    const req = await releasedFloat(f, '1000.00');
    const id = await draft(f, [
      { amount: '600.00', cashRequestId: req },
      { amount: '400.00', cashRequestId: req },
    ]);
    await approve(f, id);
    expect(await statusOf(id)).toBe('posted');
    expect(await outstandingOf(f, req)).toBe('0.00');
  });
});

describe('I7b - another holder float on the same account must not hide an over-spend', () => {
  it('Ana holds 1,000 and Ben 1,000: an expense drawing 1,200 from Ana is refused although the account holds 2,000', async () => {
    const f = await setup('i7b');
    const ana = await releasedFloat(f, '1000.00');
    await releasedFloat(f, '1000.00', f.storeId, f.officeSafeId, await otherHolder(f, 'Ben Holder'));
    const id = await draft(f, [{ amount: '1200.00', cashRequestId: ana }]);
    expect(await userMessageOf(approve(f, id))).toMatch(overSpend('i7b Ana', '1,000', '1,200'));
    expect(await statusOf(id)).toBe('draft');
    expect(await outstandingOf(f, ana)).toBe('1000.00');
  });
});

describe('I8 - concurrent approves of the two drafts (two REAL transactions): exactly one posts', () => {
  it('the second transaction waits on the request row and, once the first commits, is refused', async () => {
    const f = await setup('i8');
    const req = await releasedFloat(f, '1000.00');
    // Two DIFFERENT invoices, so the invoice lock cannot be what serialises them (see header).
    const a = await draft(f, [{ amount: '600.00', cashRequestId: req }]);
    const b = await draft(f, [{ amount: '600.00', cashRequestId: req }]);

    let aApproved!: () => void;
    const aHasApproved = new Promise<void>((r) => (aApproved = r));
    let releaseA!: () => void;
    const gate = new Promise<void>((r) => (releaseA = r));

    // A approves and then HOLDS its transaction open: its posting is uncommitted, invisible to B.
    const txA = asPerson(f.orgId, async (tx) => {
      const res = await approveExpense(tx, actorOf(f.orgId, f.managerId), a);
      aApproved();
      await gate;
      return res;
    });
    await aHasApproved;

    // B starts while A is open. Without a row lock on the request, B reads outstanding 1,000, passes and posts.
    const txB = approve(f, b).then(
      () => ({ ok: true as const, userMessage: undefined as string | undefined }),
      (err: unknown) => ({ ok: false as const, userMessage: (err as { userMessage?: string }).userMessage }),
    );
    const early = await Promise.race([txB, new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 2500))]);
    if (early !== 'blocked') {
      releaseA(); // never leave A's transaction hanging when the assertion below fails
      await txA;
    }
    expect(early, 'B must be blocked on the request lock while A is uncommitted, not already finished').toBe('blocked');

    releaseA();
    await txA;
    const outcomeB = await txB;

    expect(outcomeB.ok).toBe(false);
    expect(outcomeB.userMessage).toMatch(overSpend('i8 Ana', '400', '600'));
    expect(await statusOf(a)).toBe('posted');
    expect(await statusOf(b)).toBe('draft');
    expect((await postingsFor(a)) + (await postingsFor(b))).toBe(1);
    expect(await outstandingOf(f, req)).toBe('400.00');
  });
});

describe('I9 - a request that is not released, or is at another store, refuses at approve', () => {
  it('liquidated: refuses with the "no longer open" sentence', async () => {
    const f = await setup('i9a');
    await coverFloat(f);
    const req = await releasedFloat(f, '1000.00');
    await asPerson(f.orgId, (tx) =>
      settleCashRequest(tx, actorOf(f.orgId, f.managerId), { requestId: req, returnedAmount: '1000.00', toMoneyAccountId: f.officeSafeId, on: '2026-01-08' }),
    );
    const id = await draft(f, [{ amount: '100.00', cashRequestId: req }]);
    expect(await userMessageOf(approve(f, id))).toBe("i9a Ana's cash request is no longer open (liquidated). Pick another source.");
    expect(await statusOf(id)).toBe('draft');
    expect(await postingsFor(id)).toBe(0);
  });

  it('cancelled (never released): refuses with the "no longer open" sentence', async () => {
    const f = await setup('i9b');
    await coverFloat(f);
    const { id: req } = await asPerson(f.orgId, (tx) =>
      createCashRequest(tx, actorOf(f.orgId, f.staffId), { storeId: f.storeId, requestedFor: f.staffId, purpose: 'Run', amount: '500.00', on: '2026-01-05' }),
    );
    await asPerson(f.orgId, (tx) => cancelCashRequest(tx, actorOf(f.orgId, f.staffId), { requestId: req }));
    const id = await draft(f, [{ amount: '100.00', cashRequestId: req }]);
    expect(await userMessageOf(approve(f, id))).toBe("i9b Ana's cash request is no longer open (cancelled). Pick another source.");
    expect(await statusOf(id)).toBe('draft');
  });

  it("a float released at ANOTHER store cannot be drawn by this store's expense", async () => {
    const f = await setup('i9c');
    await coverFloat(f);
    const req = await releasedFloat(f, '1000.00', f.otherStoreId, f.otherOfficeSafeId);
    const id = await draft(f, [{ amount: '100.00', cashRequestId: req }]);
    // The spec fixes no sentence for this branch (spec gap); it must refuse and leave the draft.
    await expect(approve(f, id)).rejects.toThrow();
    expect(await statusOf(id)).toBe('draft');
    expect(await postingsFor(id)).toBe(0);
    expect(await outstandingOf(f, req)).toBe('1000.00');
  });
});
