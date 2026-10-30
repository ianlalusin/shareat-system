import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, moneyAccountsRepo, transaction, APP_ROLE, RefusalError, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { money } from '@shareat/core/money';
import { approveExpense, createExpense, createMoneyTransfer } from '@shareat/domain';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { checkDraw, judgeDraw } from '../../src/money-accounts/overdraft';

/**
 * T-501 (DEF-802) - TESTER. docs/tasks/501-def802-draw-lock.md section 3.
 * `checkDraw` (money-accounts/overdraft.ts) must (R1) refuse in words through `refuse()`, and (R2) lock the money account row
 * before reading its balance, so two draws on one account cannot both pass. Real Postgres (TEST_DATABASE_URL, `_test` guard).
 * The real caller used throughout is `createMoneyTransfer`; the drawn account is the store's foundation office safe or cashier drawer.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

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

async function foundation(storeId: string, instrument: string, custodian: string) {
  const [row] = await sql<{ id: string; name: string }[]>`
    select id, name from money_accounts
    where store_id = ${storeId} and instrument = ${instrument} and custodian = ${custodian} and is_foundation`;
  if (!row) throw new Error(`fixture: no foundation ${custodian}/${instrument} for store ${storeId}`);
  return row;
}

async function fixture(hint: string) {
  const code = uid(`dl-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  const admin: Actor = { personId: p!.id, orgId };
  const drawer = await foundation(storeId, 'cash', 'cashier');
  const safe = await foundation(storeId, 'cash', 'office');
  // Roomy overdraft so the cashier leg (D3) tests the warn path, not the cap.
  await sql`update money_accounts set overdraft_limit = '20000.00' where id = ${drawer.id}`;
  return { orgId, storeId, admin, drawer, safe };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

/** Puts money straight into the ledger (not through any service) so the guard reads a balance it did not write. */
async function postCash(f: Fx, debitCode: string, amount: string) {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, '2026-01-05', ${period!.id}, 'test', ${uid('src')}, 'draft') returning id`;
    let n = 0;
    for (const [code, dr, cr] of [[debitCode, amount, '0'], ['4100', '0', amount]] as const) {
      const [acct] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = ${code}`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
               values (${e!.id}, ${++n}, ${acct!.id}, ${f.storeId}, ${dr}, ${cr})`;
    }
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

const draw = (f: Fx, tx: Tx, from: string, to: string, amount: string) =>
  createMoneyTransfer(tx, f.admin, { requestId: crypto.randomUUID(), fromMoneyAccountId: from, toMoneyAccountId: to, amountOut: amount, amountIn: amount, transferDate: '2026-01-10' });

/** Net committed ledger balance of a store's GL cash code (1130 office safe, 1110 cashier drawer). */
async function ledgerBalance(f: Fx, code: string): Promise<number> {
  const [r] = await sql<{ b: string }[]>`
    select coalesce(sum(jl.debit - jl.credit), 0)::text as b
    from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
    where je.org_id = ${f.orgId} and je.status <> 'draft' and a.code = ${code} and jl.store_id = ${f.storeId}`;
  return Number(r!.b);
}

// ------------------------------------------------------------------------------------------------ two-connection harness
type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then((value) => ({ status: 'fulfilled', value }) as const, (reason) => ({ status: 'rejected', reason }) as const);

/**
 * Connection A draws and HOLDS its transaction open (nothing committed). Connection B then draws the same account concurrently.
 * A third connection watches B's backend: with a row lock it is seen WAITING (wait_event_type Lock); without one B runs straight past.
 * Only then is A released to commit. Not a bare Promise.all race: B's read of the balance happens while A is uncommitted, always.
 */
async function raceTwoOps<T>(f: Fx, opA: (tx: Tx) => Promise<T>, opB: (tx: Tx) => Promise<T>) {
  const aReady = deferred<void>();
  const gate = deferred<void>();
  const bPid = deferred<number>();

  const a = settle(asOrg(f.orgId, async (tx) => {
    try {
      const v = await opA(tx);
      aReady.resolve();
      await gate.promise;
      return v;
    } catch (err) {
      aReady.resolve();
      throw err;
    }
  }));
  await aReady.promise;

  const b = settle(asOrg(f.orgId, async (tx) => {
    const rows = await tx.execute(dsql`select pg_backend_pid() as pid`);
    bPid.resolve(Number((rows as unknown as { pid: number }[])[0]?.pid));
    return opB(tx);
  }));

  let bDoneFlag = false;
  void b.then(() => { bDoneFlag = true; });
  let bWaited = false;
  const pid = await Promise.race([bPid.promise, b.then(() => 0)]);
  const deadline = Date.now() + 5000;
  while (pid && !bDoneFlag && Date.now() < deadline) {
    const waiting = await sql`select 1 from pg_stat_activity where pid = ${pid} and wait_event_type = 'Lock'`;
    if (waiting.length) { bWaited = true; break; }
    await new Promise((r) => setTimeout(r, 20));
  }
  gate.resolve();
  const results = await Promise.all([a, b]);
  return { results, bWaited };
}

const raceTwoDraws = (f: Fx, from: string, to: string, amount: string, fromB: string = from) =>
  raceTwoOps(f, (tx) => draw(f, tx, from, to, amount), (tx) => draw(f, tx, fromB, to, amount));

describe('T-501 draw lock (DEF-802)', () => {
  // D1 - kills: checkDraw keeps `throw new Error(`${context}: ${message}`)` (a plain Error, developer text, outside the refusal plumbing).
  it("D1: a blocked draw is a RefusalError whose user sentence is judgeDraw's message, with no developer context in it", async () => {
    const f = await fixture('d1');
    await postCash(f, '1130', '1000.00');
    const expected = judgeDraw({ name: f.safe.name, custodian: 'office', overdraftLimit: '0.00', floatTarget: null }, money('1000.00'), money('1200.00')).message;
    expect(expected).toBeTruthy();

    const err = await asOrg(f.orgId, (tx) => draw(f, tx, f.safe.id, f.drawer.id, '1200.00')).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RefusalError);
    const r = err as RefusalError;
    expect(r.userMessage).toBe(expected);
    expect(r.userMessage).not.toContain('createMoneyTransfer');
  });

  // D2 - kills: no `SELECT ... FOR UPDATE` on the money account row before the balance read.
  it('D2: two connections drawing 700 from a 1,000 office safe - exactly one passes, the other is refused in words, balance ends 300', async () => {
    const f = await fixture('d2');
    await postCash(f, '1130', '1000.00');
    const { results, bWaited } = await raceTwoDraws(f, f.safe.id, f.drawer.id, '700.00');

    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r): r is Extract<typeof r, { status: 'rejected' }> => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.reason).toBeInstanceOf(RefusalError);
    expect((bad[0]!.reason as RefusalError).userMessage).toMatch(/balance is complete/);
    expect(await ledgerBalance(f, '1130')).toBe(300);
    expect(bWaited).toBe(true); // B was seen waiting on A's row lock, not merely lucky on ordering.
  });

  // D3 - kills: the lock being made to block cashier draws, or R4 (cashier shortfall = warning, never refusal) being lost.
  // NB today (no lock) both read 1,000, so NEITHER warns: red on the warning assertion. With the lock the second reads 300 and warns.
  it('D3: the same race on a CASHIER drawer - both succeed, the second carries the warning, nothing is refused', async () => {
    const f = await fixture('d3');
    await postCash(f, '1110', '1000.00');
    const { results, bWaited } = await raceTwoDraws(f, f.drawer.id, f.safe.id, '700.00');

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const warnings = results.map((r) => (r as { value: { warning?: string } }).value.warning).filter(Boolean);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/is short/);
    expect(await ledgerBalance(f, '1110')).toBe(-400);
    expect(bWaited).toBe(true);
  });

  // D4 - GUARD (no caller draws from two accounts in one transaction today: createMoneyTransfer/settle read only `from`).
  // It pins the deadlock-free ordering R3 requires if a helper ever locks both ends: kills "lock taken in caller order, not ascending id order".
  it('D4: A->B and B->A at once both complete, no deadlock', async () => {
    const f = await fixture('d4');
    await postCash(f, '1130', '1000.00');
    await postCash(f, '1110', '1000.00');
    const [x, y] = await Promise.all([
      settle(asOrg(f.orgId, (tx) => draw(f, tx, f.safe.id, f.drawer.id, '100.00'))),
      settle(asOrg(f.orgId, (tx) => draw(f, tx, f.drawer.id, f.safe.id, '100.00'))),
    ]);
    expect([x.status, y.status]).toEqual(['fulfilled', 'fulfilled']);
  });

  // ----------------------------------------------------------------------------------------- audit round (spec section 7)

  /** A verified invoice + a draft expense paying `amount` out of `accountId`; created and approved as the org's admin. */
  async function draftExpense(f: Fx, amount: string, accountId: string): Promise<string> {
    await seedExpenseCategories(sql, f.orgId);
    const [cat] = await sql<{ id: string }[]>`select id from expense_categories where org_id = ${f.orgId} and category = 'Cost of Goods Sold — General'`;
    const [ver] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Verifier') returning id`;
    const [sup] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${f.orgId}, ${uid('sup')}, ${f.admin.personId}) returning id`;
    const [file] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
      values (${f.orgId}, ${f.storeId}, 'receipt_photo', ${`orgs/${f.orgId}/stores/${f.storeId}/receipt_photo/${uid('f')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${f.admin.personId})
      returning id`;
    const [inv] = await sql<{ id: string }[]>`
      insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, status, receipt_file_id, verified_by, verified_at, created_by,
        attested_supplier, attested_invoice, attested_items, attested_price)
      values (${f.orgId}, ${f.storeId}, ${sup!.id}, '2026-01-01', '99999999.00', 'verified', ${file!.id}, ${ver!.id}, now(), ${f.admin.personId}, true, true, true, true)
      returning id`;
    const made = await asOrg(f.orgId, (tx) =>
      createExpense(tx, f.admin, {
        storeId: f.storeId, supplierId: sup!.id, supplierInvoiceId: inv!.id, businessDate: '2026-01-15', categoryId: cat!.id,
        particulars: 'T-501 draw', payments: [{ method: 'cash', amount, moneyAccountId: accountId }],
      }),
    );
    return made.id;
  }

  // D6 - kills: approveExpense reading balanceOf + judgeDraw WITHOUT locking the account it draws from (A1).
  it('D6: two approveExpense calls on one 1,000 office safe, 700 each - one posts, one is refused, balance ends 300', async () => {
    const f = await fixture('d6');
    await postCash(f, '1130', '1000.00');
    const e1 = await draftExpense(f, '700.00', f.safe.id);
    const e2 = await draftExpense(f, '700.00', f.safe.id);
    const { results, bWaited } = await raceTwoOps(f, (tx) => approveExpense(tx, f.admin, e1), (tx) => approveExpense(tx, f.admin, e2));

    const bad = results.filter((r): r is Extract<typeof r, { status: 'rejected' }> => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.reason).toBeInstanceOf(RefusalError);
    expect(await ledgerBalance(f, '1130')).toBe(300);
    expect(bWaited).toBe(true);
  });

  // D7 - kills: a lock on the account ROW only. balanceOf sums (GL code, store), so two 1130 safes in one store share ONE pool (A2).
  it('D7: two office safes in the same store pooling 1,000 - 700 from each at once - one is refused', async () => {
    const f = await fixture('d7');
    const [safe2] = await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
      values (${f.orgId}, ${f.storeId}, 'Second safe', 'cash', '1130', 'office') returning id`;
    await postCash(f, '1130', '1000.00');
    const { results, bWaited } = await raceTwoDraws(f, f.safe.id, f.drawer.id, '700.00', safe2!.id);

    const bad = results.filter((r): r is Extract<typeof r, { status: 'rejected' }> => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.reason).toBeInstanceOf(RefusalError);
    expect(await ledgerBalance(f, '1130')).toBe(300);
    expect(bWaited).toBe(true);
  });

  // D8 - kills: lockForDraw returning silently (no lock, no error) when the row is missing or belongs to another org (A3).
  it('D8: lockForDraw on a missing or other-org account id refuses "no longer exists"', async () => {
    const f = await fixture('d8');
    const other = await fixture('d8b');
    for (const id of ['00000000-0000-4000-8000-000000000501', other.safe.id]) {
      const err = await asOrg(f.orgId, (tx) => moneyAccountsRepo.lockForDraw(tx, f.orgId, id)).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(RefusalError);
      expect((err as RefusalError).userMessage).toMatch(/no longer exists/);
    }
  });

  // A4 - kills: checkDraw judging the caller's stale MoneyAccountRow instead of the row re-read under the lock.
  it('A4: overdraft_limit lowered (committed) after the caller loaded the row - checkDraw judges the re-read limit', async () => {
    const f = await fixture('a4');
    await postCash(f, '1110', '1000.00'); // drawer holds 1,000; limit 20,000, so a 5,000 draw is only a warning ...
    const err = await asOrg(f.orgId, async (tx) => {
      const stale = await moneyAccountsRepo.getById(tx, f.orgId, f.drawer.id);
      expect(stale!.overdraftLimit).toBe('20000.00');
      await sql`update money_accounts set overdraft_limit = '100.00' where id = ${f.drawer.id}`; // ... until another transaction commits a 100 limit.
      return checkDraw(tx, f.orgId, stale!, money('5000.00'), 'a4');
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).userMessage).toMatch(/past the/);
  });
});
