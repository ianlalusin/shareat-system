import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-316 S2 — the refusal. `docs/tasks/316-till-floor-on-the-cashier-account.md` §3.2–3.3, ✎S-1,
 * tests T-S2-2, -3, -7, -8, -9 (mutants M4, M9, M10, M11, M15, M18, M19).
 *
 * ⭐ THE RULE (✎S-1): at a store whose drawer carries a float, a handover may carry what the
 * verified days owe and nothing more — `REFUSE if handedOver > totalOwed`, strictly greater. The
 * refusal is a `refuse()` (a RefusalError carrying a sentence in `.userMessage`), not a raw Error.
 *
 * ✎S-5 EVERY HANDOVER LEG HAS A VERIFIED DAY WITH owed > 0, so T-319 (DEF-358) never refuses first
 * and a mutant cannot go red for the wrong reason.
 *
 * ✎R-3 ORDERING PROOF is in-transaction: `refuse` is a JS throw, so the transaction stays usable.
 * We catch the refusal INSIDE the same transaction and count the seven tables a handover writes,
 * before and after — never a post-rollback count (a rollback would hide a write made before the
 * throw).
 *
 * Fixture for rows ①–⑩ (§3.3): float ₱20,000 funded BY TRANSFER; V = 2026-01-05 verified, cash
 * ₱5,000 (owed 5,000); U = 2026-01-06 open, `cash_collected` ₱8,000 (declared, unverified), ice
 * ₱500 posted on U.
 *
 * ⭐ RED on the current tree: the T-153 raw `Error` ("a float is never remitted") fires first, so
 * (a) allowed legs reject, (b) refusal legs carry no `userMessage`. T-S2-6 (an expense below target
 * is allowed) already has its green test in expenses.test.ts ("T-316 S1: a float-carrying drawer is
 * NOT a side pocket"); M9 (refusal in `judgeDraw`) turns that one red.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, moneyAccountsRepo, remittanceRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { type Actor } from '@shareat/auth';
import { forceVerifiedSql } from './_fixtures/sales-day-flow';
import {
  createMoneyTransfer,
  createRemittance,
  resolveRemittanceVariance,
  setTillFloat,
} from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const V = '2026-01-05';
const U = '2026-01-06';

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function newFixture(hint: string) {
  const code = uid(`t316s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const storeName = `Store ${hint}`;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid(hint)}, ${storeName}, '2020-01-01') returning id`;
  const storeId = store!.id;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  const [till] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  const [safe] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  const admin: Actor = { personId: p!.id, orgId };
  return { orgId, storeId, storeName, adminId: p!.id, admin, till: till!.id, safe: safe!.id };
}
type F = Awaited<ReturnType<typeof newFixture>>;

async function officeOpening(f: F, date: string, amount: string) {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, ${date}, ${period!.id}, 'opening_balance', ${uid('src')}, 'draft') returning id`;
    const [office] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1130'`;
    const [equity] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '3900'`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${office!.id}, ${f.storeId}, ${amount}, '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${equity!.id}, ${f.storeId}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

async function tillMovement(f: F, date: string, amount: string, sourceType = 'sale') {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
  const positive = Number(amount) >= 0;
  const abs = Math.abs(Number(amount)).toFixed(2);
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, ${date}, ${period!.id}, ${sourceType}, ${uid('src')}, 'draft') returning id`;
    const [cash] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1110'`;
    const [other] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = ${positive ? '4100' : '6160'}`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${cash!.id}, ${f.storeId}, ${positive ? abs : '0'}, ${positive ? '0' : abs})`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${other!.id}, ${f.storeId}, ${positive ? '0' : abs}, ${positive ? abs : '0'})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

async function verifiedDay(f: F, date: string) {
  await sql`insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${f.orgId}, ${f.storeId}, ${date}, 'verified', '0', '0', '0', ${f.adminId})`;
}

/** An UNVERIFIED day carrying a declared cash figure (`cash_collected`, A5). Revenue identity: unli + ala carte = total. */
async function openDay(f: F, date: string, cashCollected: string) {
  await sql`insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, cash_collected, created_by)
    values (${f.orgId}, ${f.storeId}, ${date}, 'open', ${cashCollected}, '0', ${cashCollected}, ${cashCollected}, ${f.adminId})`;
}

async function fundTill(f: F, amount: string, date = '2026-01-02') {
  await asOrg(f.orgId, (tx) =>
    createMoneyTransfer(tx, f.admin, {
      fromMoneyAccountId: f.safe,
      toMoneyAccountId: f.till,
      amountOut: amount,
      amountIn: amount,
      transferDate: date,
      notes: 'Fund the till float',
    }),
  );
}

interface Scenario {
  float: boolean;
  /** Float funded into the till by transfer (default 20,000.00). */
  funded?: string;
  /** U: declared cash, unverified. Omit for no U at all. */
  uCash?: string;
  /** Post 500 of ice on U (a posted expense on today's open date). */
  ice?: boolean;
}

/** §3.3's fixture. V verified owes 5,000 (always — ✎S-5). Float 20,000 by transfer when `float`. */
async function scenario(hint: string, s: Scenario): Promise<F> {
  const f = await newFixture(hint);
  await officeOpening(f, '2026-01-01', '90000.00');
  if (s.float) {
    await asOrg(f.orgId, (tx) => setTillFloat(tx, f.admin, { storeId: f.storeId, target: '20000.00' }));
    await fundTill(f, s.funded ?? '20000.00');
  }
  await verifiedDay(f, V);
  await tillMovement(f, V, '5000.00');
  if (s.uCash !== undefined) await openDay(f, U, s.uCash);
  if (s.ice) await tillMovement(f, U, '-500.00', 'expense');
  return f;
}

type Counts = Record<string, string>;
async function counts(tx: Tx): Promise<Counts> {
  const rows = (await tx.execute(dsql`
    select (select count(*) from remittances)::text as remittances,
           (select count(*) from remittance_lines)::text as remittance_lines,
           (select count(*) from remittance_allocations)::text as allocations,
           (select count(*) from remittance_variances)::text as variances,
           (select count(*) from money_transfers)::text as transfers,
           (select count(*) from journal_entries)::text as entries,
           (select count(*) from journal_lines)::text as entry_lines`)) as unknown as Counts[];
  return rows[0]!;
}

interface Line {
  amount: string;
  declaredOverage?: string;
}

/** ✎R-3: ONE transaction — count, call, catch the refusal in it, count again. */
async function attempt(f: F, line: Line, remittedOn = U) {
  return asOrg(f.orgId, async (tx) => {
    const before = await counts(tx);
    let error: unknown = null;
    try {
      await createRemittance(tx, f.admin, {
        storeId: f.storeId,
        remittedOn,
        lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, ...line }],
      });
    } catch (e) {
      error = e;
    }
    const after = await counts(tx);
    return { error, before, after };
  });
}

function remit(f: F, line: Line, remittedOn = U) {
  return asOrg(f.orgId, (tx) =>
    createRemittance(tx, f.admin, {
      storeId: f.storeId,
      remittedOn,
      lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, ...line }],
    }),
  );
}

const esc = (s: string) => s.replace('.', '\\.');

/** The T-316 sentence (§3.3, through `refuse`), with the figures, and nothing written. */
function expectFloatRefusal(
  r: Awaited<ReturnType<typeof attempt>>,
  f: F,
  handed: string,
  owed: string,
  target = '20,000.00',
) {
  expect(r.error, 'the handover was NOT refused at all').not.toBeNull();
  const msg = (r.error as { userMessage?: string }).userMessage;
  expect(msg, 'the refusal must be a refuse() carrying a sentence in userMessage (got a raw Error)').toBeDefined();
  expect(msg).toMatch(new RegExp(`This hands over \\D*${esc(handed)}, but the verified days owe \\D*${esc(owed)}\\.`));
  expect(msg).toContain(`${f.storeName}'s till keeps a`);
  expect(msg).toMatch(new RegExp(`keeps a \\D*${esc(target)} float, so only what the verified days owe can be handed over\\.`));
  expect(msg).toContain("Cash from a day that isn't verified yet is handed over after that day is verified.");
  expect(msg).toContain('Extra float goes back to the office as a transfer.');
  // ✎R-3 — same transaction, before the rollback: not one row, entry or transfer was written.
  expect(r.after, 'a write happened before the refusal fired').toEqual(r.before);
}

async function tillBalance(f: F) {
  return asOrg(f.orgId, async (tx) =>
    moneyAccountsRepo.balanceOf(tx, f.orgId, (await moneyAccountsRepo.getById(tx, f.orgId, f.till))!),
  );
}

describe('T-S2-2 — §3.3 rows ①–⑩ at a float store (₱20,000 float, V owes 5,000)', () => {
  it('① ordinary: hand over exactly what V owes (5,000) — allowed, and the float stays in the drawer', async () => {
    const f = await scenario('r1', { float: true, uCash: '8000.00' });
    const r = await remit(f, { amount: '5000.00' });
    expect(r.settled).toEqual([{ businessDate: V, amount: '5000.00' }]);
    expect(r.variance).toBeNull();
    expect(Number(await tillBalance(f))).toBeCloseTo(20000, 2); // 20,000 + 5,000 − 5,000
  });

  it('③ early takings as overage: 13,000 with 8,000 declared on unverified U — REFUSED with the T-316 sentence (this is the task)', async () => {
    const f = await scenario('r3', { float: true, uCash: '8000.00', ice: true });
    expectFloatRefusal(await attempt(f, { amount: '13000.00', declaredOverage: '8000.00' }), f, '13,000.00', '5,000.00');
  });

  it('⑤ Ian’s case: 7am, ice ₱500 on U, U has no figure yet — handing over V’s 5,000 is allowed (the 09-14 level rule refused it)', async () => {
    const f = await scenario('r5', { float: true, uCash: '0.00', ice: true });
    const r = await remit(f, { amount: '5000.00' });
    expect(r.settled).toEqual([{ businessDate: V, amount: '5000.00' }]);
    expect(r.variance).toBeNull();
  });

  it('⑥ closed negative day D1 (−2,000), D2 verified 10,000: hand over 10,000 — allowed; the float sits at 18,000', async () => {
    const f = await newFixture('r6');
    await officeOpening(f, '2026-01-01', '90000.00');
    await asOrg(f.orgId, (tx) => setTillFloat(tx, f.admin, { storeId: f.storeId, target: '20000.00' }));
    await fundTill(f, '20000.00');
    await verifiedDay(f, '2026-01-03');
    await tillMovement(f, '2026-01-03', '-2000.00', 'expense');
    await verifiedDay(f, '2026-01-04');
    await tillMovement(f, '2026-01-04', '10000.00');
    const r = await remit(f, { amount: '10000.00' }, '2026-01-05');
    expect(r.settled).toEqual([{ businessDate: '2026-01-04', amount: '10000.00' }]);
    expect(Number(await tillBalance(f))).toBeCloseTo(18000, 2); // 20,000 − 2,000 + 10,000 − 10,000
  });

  it('⑦ overage with no unverified day: owed + 1,000 declared — REFUSED (a physical over goes to the tip box). Control: owed exactly — allowed', async () => {
    const f = await scenario('r7', { float: true });
    expectFloatRefusal(await attempt(f, { amount: '6000.00', declaredOverage: '1000.00' }), f, '6,000.00', '5,000.00');
    const ok = await remit(f, { amount: '5000.00' });
    expect(ok.settled).toEqual([{ businessDate: V, amount: '5000.00' }]);
  });

  it('⑦ with NO declaration (M19): owed + 1,000, blank overage at a float store — the T-316 sentence, NOT T-324’s "declare at least X" (float check runs first); nothing written', async () => {
    const f = await scenario('r7b', { float: true });
    const r = await attempt(f, { amount: '6000.00' });
    expectFloatRefusal(r, f, '6,000.00', '5,000.00');
    expect((r.error as Error).message, 'must not tell the cashier to declare an overage that would then be refused').not.toMatch(/declare at least/);
  });

  it('⑦ control, NO float: the same 6,000 with no declaration still gets T-324’s declare-overage sentence', async () => {
    const f = await scenario('r7c', { float: false });
    const r = await attempt(f, { amount: '6000.00' });
    expect((r.error as Error | null)?.message).toMatch(/declare at least .*1,000\.00 total overage/);
    expect((r.error as { userMessage?: string }).userMessage ?? '').not.toContain('till keeps a');
  });

  it('⑧ surplus float (funded 21,000): owed + 1,000 — REFUSED, the surplus goes back by transfer. Control: owed exactly — allowed', async () => {
    const f = await scenario('r8', { float: true, funded: '21000.00' });
    expectFloatRefusal(await attempt(f, { amount: '6000.00', declaredOverage: '1000.00' }), f, '6,000.00', '5,000.00');
    const ok = await remit(f, { amount: '5000.00' });
    expect(ok.settled).toEqual([{ businessDate: V, amount: '5000.00' }]);
  });

  it('⑩ a store WITHOUT a float: ③’s 13,000 with 8,000 declared is ALLOWED — T-324 is unchanged (control)', async () => {
    const f = await scenario('r10', { float: false, uCash: '8000.00', ice: true });
    const r = await remit(f, { amount: '13000.00', declaredOverage: '8000.00' });
    expect(r.handedOver).toBe('13000.00');
    expect(r.variance).toBe('8000.00');
  });
});

describe('T-S2-3 ⭐ the boundary — strictly greater than (✎S-1; M4 `>=` for `>`)', () => {
  it('exactly owed (5,000.00) is allowed', async () => {
    const f = await scenario('b-eq', { float: true });
    const r = await remit(f, { amount: '5000.00' });
    expect(r.settled).toEqual([{ businessDate: V, amount: '5000.00' }]);
    expect(r.variance).toBeNull();
  });

  it('owed + 0.01 (5,000.01, 0.01 declared) is refused, and the sentence names both figures', async () => {
    const f = await scenario('b-gt', { float: true });
    expectFloatRefusal(await attempt(f, { amount: '5000.01', declaredOverage: '0.01' }), f, '5,000.01', '5,000.00');
  });
});

describe('T-S2-8 ✎S-1 (1) — R1 early handover can never start at a float store', () => {
  it('float store: R1 = V’s 5,000 + U’s 7,500 declared — REFUSED, nothing written', async () => {
    const f = await scenario('s8-float', { float: true, uCash: '7500.00' });
    expectFloatRefusal(await attempt(f, { amount: '12500.00', declaredOverage: '7500.00' }), f, '12,500.00', '5,000.00');
  });

  it('control, NO float: the same R1 is ALLOWED, then U is verified and R3 of U’s 7,500 is allowed — today’s no-float behaviour is T-324’s', async () => {
    const f = await scenario('s8-nofloat', { float: false, uCash: '7500.00' });
    const r1 = await remit(f, { amount: '12500.00', declaredOverage: '7500.00' });
    expect(r1.variance, 'R1 books the 7,500 as an open overage variance').toBe('7500.00');
    // Verify U: its cash posts to the drawer and the day becomes verified.
    await tillMovement(f, U, '7500.00');
    const [uDay] = await sql<{ id: string }[]>`select id from sales_days where org_id = ${f.orgId} and store_id = ${f.storeId} and business_date = ${U}`;
    await forceVerifiedSql(sql, uDay!.id, f.adminId);
    const r3 = await remit(f, { amount: '7500.00' }, '2026-01-07');
    expect(r3.settled).toEqual([{ businessDate: U, amount: '7500.00' }]);
  });
});

describe('T-S2-9 ✎S-1 (2) — recognise_income raises the books, never the allowance', () => {
  it('an older overage recognised as income (7350) before the float existed: owed + 1 still REFUSED; control: owed exactly allowed', async () => {
    const f = await newFixture('s9');
    await officeOpening(f, '2026-01-01', '90000.00');
    // Older overage, made before any target: day 05 owes 10,000, handed over 10,080 with 80 declared.
    await verifiedDay(f, V);
    await verifiedDay(f, U);
    await tillMovement(f, V, '10000.00');
    const old = await remit(f, { amount: '10080.00', declaredOverage: '80.00' }, V);
    expect(old.variance, 'setup: 80.00 over').toBe('80.00');
    await asOrg(f.orgId, (tx) =>
      resolveRemittanceVariance(tx, f.admin, { varianceId: old.varianceId!, action: 'recognise_income', on: U }),
    );
    // NOW the float is set and funded, and a fresh verified day owes 5,000.
    await asOrg(f.orgId, (tx) => setTillFloat(tx, f.admin, { storeId: f.storeId, target: '20000.00' }));
    await fundTill(f, '20000.00', '2026-01-07');
    await verifiedDay(f, '2026-01-07');
    await tillMovement(f, '2026-01-07', '5000.00');
    // Premise: the overage really was recognised (Dr 1110 / Cr 7350 posted, variance closed to income).
    const [v] = await sql<{ status: string }[]>`select status from remittance_variances where id = ${old.varianceId!}`;
    expect(v!.status, 'premise: the older overage was recognised as income').toBe('income');
    expect(Number(await tillBalance(f))).toBeCloseTo(25000, 2); // 10,000 − 10,080 + 80 + 20,000 + 5,000

    const r = await attempt(f, { amount: '5001.00', declaredOverage: '1.00' }, '2026-01-08');
    expectFloatRefusal(r, f, '5,001.00', '5,000.00');
    const ok = await remit(f, { amount: '5000.00' }, '2026-01-08');
    expect(ok.settled).toEqual([{ businessDate: '2026-01-07', amount: '5000.00' }]);
  });
});

describe('T-S2-7 ⭐ the seam is a decision — a bare transfer of surplus float succeeds and settles nothing', () => {
  it('float funded 21,000: a cashier→office createMoneyTransfer of 1,000 works; no allocation, V still owes 5,000; the same 1,000 as a remittance overage is refused', async () => {
    const f = await scenario('s7', { float: true, funded: '21000.00' });
    await asOrg(f.orgId, (tx) =>
      createMoneyTransfer(tx, f.admin, {
        fromMoneyAccountId: f.till,
        toMoneyAccountId: f.safe,
        amountOut: '1000.00',
        amountIn: '1000.00',
        transferDate: U,
        notes: 'Surplus float back to the office',
      }),
    );
    const [alloc] = await sql<{ n: string }[]>`
      select count(*)::text n from remittance_allocations ra join remittances r on r.id = ra.remittance_id where r.store_id = ${f.storeId}`;
    expect(alloc!.n, 'a bare transfer must settle nothing').toBe('0');
    const days = await asOrg(f.orgId, (tx) => remittanceRepo.endDayReports(tx, f.orgId, { storeId: f.storeId, upTo: '2026-01-31' }));
    expect(days.find((d) => d.businessDate === V)!.owed).toBe('5000.00');
    // Contrast: the same surplus carried by a remittance overage is the refusal (⑧).
    const r = await attempt(f, { amount: '6000.00', declaredOverage: '1000.00' });
    expectFloatRefusal(r, f, '6,000.00', '5,000.00');
  });
});
