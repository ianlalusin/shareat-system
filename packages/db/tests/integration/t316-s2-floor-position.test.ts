import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-316 S2 — `tillFloorPosition(tx, orgId, { storeId, upTo })` in `repo/remittance.ts`.
 * `docs/tasks/316-till-floor-on-the-cashier-account.md` §2.1, ✎S-1, test T-S2-1 (+ M7's repo leg).
 *
 * ⭐ Fixture = §3.3's: float 20,000 funded BY TRANSFER; V (2026-01-05) verified, cash 5,000; U
 * (2026-01-06) open, declared cash 8,000, ice 500 posted on it. So:
 *   cashierBalance = 20,000 + 5,000 − 500 = 24,500
 *   onLoanMovement = −500 (U is open)           closedOwed = max(5,000, 0) = 5,000
 *   floatPosition  = 24,500 − (−500) − 5,000 = 20,000  — ordinary trading cannot move it.
 * ✎S-1: NO `unverifiedNetCash` field is built.
 *
 * RED on the current tree: `remittanceRepo.tillFloorPosition` does not exist (the first assertion).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../seed/chart-of-accounts';
import { closeDb, remittanceRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

interface Position {
  floatTarget: string | null;
  cashierBalance: string;
  floatPosition: string;
  [k: string]: unknown;
}
type PositionFn = (tx: Tx, orgId: string, input: { storeId: string; upTo: string }) => Promise<Position>;
const positionFn = (): PositionFn => {
  const fn = (remittanceRepo as unknown as { tillFloorPosition?: PositionFn }).tillFloorPosition;
  expect(fn, 'remittanceRepo.tillFloorPosition does not exist yet (T-316 S2 builder)').toBeTypeOf('function');
  return fn!;
};

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function newStore(hint: string) {
  const code = uid(`t316s2db-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, '2020-01-01') returning id`;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const [till] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${store!.id} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  return { orgId, storeId: store!.id, adminId: p!.id, till: till!.id };
}
type S = Awaited<ReturnType<typeof newStore>>;

/** A balanced posted entry touching 1110 (Dr when amount > 0) against `otherCode`. */
async function postTill(s: S, date: string, amount: string, sourceType: string, otherCode: string) {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${s.orgId} limit 1`;
  const positive = Number(amount) >= 0;
  const abs = Math.abs(Number(amount)).toFixed(2);
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${s.orgId}, ${date}, ${period!.id}, ${sourceType}, ${uid('src')}, 'draft') returning id`;
    const [cash] = await tx<{ id: string }[]>`select id from accounts where org_id = ${s.orgId} and code = '1110'`;
    const [other] = await tx<{ id: string }[]>`select id from accounts where org_id = ${s.orgId} and code = ${otherCode}`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${cash!.id}, ${s.storeId}, ${positive ? abs : '0'}, ${positive ? '0' : abs})`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${other!.id}, ${s.storeId}, ${positive ? '0' : abs}, ${positive ? abs : '0'})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}
const sale = (s: S, date: string, amount: string) => postTill(s, date, amount, 'sale', amount.startsWith('-') ? '6160' : '4100');
/** Float funding is custody: source_type 'transfer' (excluded from `movement`). */
const fund = (s: S, date: string, amount: string) => postTill(s, date, amount, 'transfer', '1130');

async function day(s: S, date: string, status: 'verified' | 'open', cash = '0.00') {
  await sql`insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, cash_collected, created_by)
    values (${s.orgId}, ${s.storeId}, ${date}, ${status}, ${cash}, '0', ${cash}, ${cash}, ${s.adminId})`;
}
const setTarget = (s: S, target: string) => sql`update money_accounts set float_target = ${target} where id = ${s.till}`;

describe('T-S2-1 — tillFloorPosition returns the §3.3 figures', () => {
  it('float 20,000; V verified 5,000; U open (declared 8,000, ice 500): floatPosition 20000.00, cashierBalance 24500.00, floatTarget 20000.00, and NO unverifiedNetCash field', async () => {
    const s = await newStore('t1');
    await setTarget(s, '20000.00');
    await fund(s, '2026-01-02', '20000.00');
    await day(s, '2026-01-05', 'verified');
    await sale(s, '2026-01-05', '5000.00');
    await day(s, '2026-01-06', 'open', '8000.00');
    await sale(s, '2026-01-06', '-500.00');

    const fn = positionFn();
    const p = await asOrg(s.orgId, (tx) => fn(tx, s.orgId, { storeId: s.storeId, upTo: '2026-01-06' }));
    expect(Number(p.floatPosition)).toBeCloseTo(20000, 2);
    expect(Number(p.cashierBalance)).toBeCloseTo(24500, 2);
    expect(Number(p.floatTarget)).toBeCloseTo(20000, 2);
    expect(Object.keys(p), '✎S-1: unverifiedNetCash is NOT built under option (a)').not.toContain('unverifiedNetCash');
  });

  it('M7 repo leg: a closed negative day counts as 0 owed, not −2,000 (D1 −2,000 verified, D2 +10,000 verified, nothing remitted) — floatPosition 18000.00', async () => {
    const s = await newStore('t1-m7');
    await setTarget(s, '20000.00');
    await fund(s, '2026-01-02', '20000.00');
    await day(s, '2026-01-03', 'verified');
    await sale(s, '2026-01-03', '-2000.00');
    await day(s, '2026-01-04', 'verified');
    await sale(s, '2026-01-04', '10000.00');
    const fn = positionFn();
    const p = await asOrg(s.orgId, (tx) => fn(tx, s.orgId, { storeId: s.storeId, upTo: '2026-01-05' }));
    // cashierBalance 28,000; closedOwed = max(−2,000,0) + 10,000 = 10,000 ⇒ 18,000.
    expect(Number(p.cashierBalance)).toBeCloseTo(28000, 2);
    expect(Number(p.floatPosition)).toBeCloseTo(18000, 2);
  });

  it('control: a store with NO float target reports floatTarget null', async () => {
    const s = await newStore('t1-nofloat');
    await day(s, '2026-01-05', 'verified');
    await sale(s, '2026-01-05', '5000.00');
    const fn = positionFn();
    const p = await asOrg(s.orgId, (tx) => fn(tx, s.orgId, { storeId: s.storeId, upTo: '2026-01-06' }));
    expect(p.floatTarget).toBeNull();
  });

  it('a float target on an INACTIVE 1110 cashier cash account is ignored (floatTarget null) — matches the refusal, which reads active accounts only. Control: the same target on an active account is reported', async () => {
    const s = await newStore('t1-inactive');
    await sql`insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, float_target, is_active)
      values (${s.orgId}, ${s.storeId}, 'Retired drawer', 'cash', '1110', 'cashier', '20000.00', false)`;
    const fn = positionFn();
    const p = await asOrg(s.orgId, (tx) => fn(tx, s.orgId, { storeId: s.storeId, upTo: '2026-01-06' }));
    expect(p.floatTarget, 'an inactive account’s target must not make this a float store').toBeNull();

    const a = await newStore('t1-active');
    await setTarget(a, '20000.00');
    const pa = await asOrg(a.orgId, (tx) => fn(tx, a.orgId, { storeId: a.storeId, upTo: '2026-01-06' }));
    expect(Number(pa.floatTarget)).toBeCloseTo(20000, 2);
  });
});
