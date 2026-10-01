import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-366 S3 (DEF-386 overage half) — `resolveRemittanceVariance(..., { action: 'recognise_income' })`
 * posts Dr <cashier account> / Cr 7350 for a POSITIVE variance, sets status 'income', and is
 * refused on a shortage / a non-open row / for staff. `docs/tasks/366-remittance-floats.md` §S3,
 * legs O1-O4 (R5 account, R6 date, R7 manager action; Q3 -> manager confirms, Amendment A1).
 *
 * ⛔ TESTER, not BUILDER. Ledger assertions come first in each leg so the red is "nothing posted /
 * action refused", not a type error.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, remittanceRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { createRemittance, resolveRemittanceVariance, reverseRemittance } from '@shareat/domain';

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
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

// -----------------------------------------------------------------------------------------------
// Fixture — copied shape, remittance.test.ts
// -----------------------------------------------------------------------------------------------

async function newOrg(hint: string) {
  const code = uid(`t366s3-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  await seedChartOfAccounts(sql, org!.id);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, opening_date) values (${org!.id}, ${uid(hint)}, ${`Store ${hint}`}, '2020-01-01') returning id`;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${org!.id}, '2026-01-01', '2026-01-31', 'open')`;
  return { orgId: org!.id, storeId: store!.id };
}
async function person(orgId: string, storeId: string, name: string, role?: string): Promise<string> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  if (role) await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  return p!.id;
}
async function fixture(hint: string) {
  const o = await newOrg(hint);
  const adminId = await person(o.orgId, o.storeId, 'Admin', 'admin');
  const staffId = await person(o.orgId, o.storeId, 'Staff', 'staff');
  const cashierId = await person(o.orgId, o.storeId, 'Cashier');
  const [till] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${o.storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  const [safe] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${o.storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  return { ...o, adminId, admin: actor(o.orgId, adminId), staff: actor(o.orgId, staffId), cashierId, till: till!.id, safe: safe!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function verifiedDay(f: Fixture, date: string) {
  await sql`insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${f.orgId}, ${f.storeId}, ${date}, 'verified', '0', '0', '0', ${f.adminId})`;
}
async function tillMovement(f: Fixture, date: string, amount: string, sourceType = 'sale') {
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
async function reports(f: Fixture, upTo = '2026-01-31') {
  return asOrg(f.orgId, (tx) => remittanceRepo.endDayReports(tx, f.orgId, { storeId: f.storeId, upTo }));
}

async function chargeEntryLines(orgId: string, varianceId: string) {
  return sql<{ code: string; debit: string; credit: string; party_type: string | null; party_id: string | null }[]>`
    select a.code, l.debit, l.credit, l.party_type, l.party_id
    from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
    where e.org_id = ${orgId} and e.source_type = 'remittance_variance' and e.source_id = ${varianceId} order by a.code`;
}
async function chargeEntryDate(orgId: string, varianceId: string): Promise<string | undefined> {
  const [row] = await sql<{ entry_date: string }[]>`select entry_date::text from journal_entries where org_id = ${orgId} and source_type = 'remittance_variance' and source_id = ${varianceId}`;
  return row?.entry_date;
}
async function varianceRow(varianceId: string) {
  const [v] = await sql<{ status: string; business_date: string; charged_to_person_id: string | null }[]>`
    select status, business_date::text, charged_to_person_id from remittance_variances where id = ${varianceId}`;
  return v!;
}
async function partyBalance(orgId: string, code: string, partyType: string, partyId: string): Promise<string> {
  const [row] = await sql<{ total: string }[]>`
    select coalesce(sum(l.debit - l.credit), 0)::text as total
    from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
    where e.org_id = ${orgId} and e.status <> 'draft' and a.code = ${code} and l.party_type = ${partyType} and l.party_id = ${partyId}`;
  return Number(row!.total).toFixed(2);
}
async function storeBalance(orgId: string, code: string, storeId: string): Promise<string> {
  const [row] = await sql<{ total: string }[]>`
    select coalesce(sum(l.debit - l.credit), 0)::text as total
    from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
    where e.org_id = ${orgId} and e.status <> 'draft' and a.code = ${code} and l.store_id = ${storeId}`;
  return Number(row!.total).toFixed(2);
}
/** Migration-dependent (0172's new column) — kept separate so it's the LAST thing a leg checks. */
async function varianceJournalEntryId(varianceId: string): Promise<string | null> {
  const [row] = await sql<{ journal_entry_id: string | null }[]>`select journal_entry_id from remittance_variances where id = ${varianceId}`;
  return row?.journal_entry_id ?? null;
}
async function allocationsFor(remittanceId: string) {
  return sql<{ business_date: string; amount: string; source: string }[]>`
    select business_date::text as business_date, amount, source from remittance_allocations where remittance_id = ${remittanceId} order by business_date, source`;
}
async function ledgerSnapshot(f: Fixture) {
  const [row] = await sql<{ entries: string; lines: string }[]>`
    select (select count(*)::text from journal_entries where org_id = ${f.orgId}) as entries,
           (select count(*)::text from journal_lines jl join journal_entries je on je.id = jl.entry_id where je.org_id = ${f.orgId}) as lines`;
  return row!;
}

function recognise(f: Fixture, varianceId: string, who: Actor = f.admin, extra: { fromMoneyAccountId?: string | null; on?: string } = {}) {
  return asOrg(f.orgId, (tx) =>
    resolveRemittanceVariance(tx, who, { varianceId, action: 'recognise_income', ...extra }),
  );
}
async function overage(hint: string) {
  const f = await fixture(hint);
  await verifiedDay(f, '2026-01-05');
  await verifiedDay(f, '2026-01-06');
  await tillMovement(f, '2026-01-05', '10000.00');
  const r = await asOrg(f.orgId, (tx) =>
    createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-05', lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '10080.00', declaredOverage: '80.00' }] }),
  );
  expect(r.variance, 'setup: 80.00 over').toBe('80.00');
  return { f, r, varianceId: r.varianceId! };
}
async function shortage(hint: string) {
  const f = await fixture(hint);
  await verifiedDay(f, '2026-01-05');
  await tillMovement(f, '2026-01-05', '10000.00');
  const r = await asOrg(f.orgId, (tx) =>
    createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-05', lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '9850.00' }] }),
  );
  return { f, r, varianceId: r.varianceId! };
}
async function varianceEntryCount(orgId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId} and source_type = 'remittance_variance'`;
  return Number(row!.n);
}

describe('O1 — a recognised overage posts Dr cashier account / Cr 7350', () => {
  it('one entry: 1110 debit 80.00, 7350 credit 80.00, no parties; status income; 1110 = 0.00; net with transfer = remittance.overage; no new owed row — Mutant: debit 1130 / credit another account / not excluding the source type', async () => {
    const { f, r, varianceId } = await overage('o1');
    await recognise(f, varianceId, f.admin, { on: '2026-01-06' });

    const legs = await chargeEntryLines(f.orgId, varianceId);
    expect(legs.length, 'exactly 2 lines on the income entry').toBe(2);
    expect(legs.map((l) => l.code)).toEqual(['1110', '7350']);
    expect(legs[0]!.debit).toBe('80.00');
    expect(legs[0]!.credit).toBe('0.00');
    expect(legs[0]!.party_type).toBeNull();
    expect(legs[1]!.credit).toBe('80.00');
    expect(legs[1]!.debit).toBe('0.00');
    expect(legs[1]!.party_type).toBeNull();
    expect(await chargeEntryDate(f.orgId, varianceId)).toBe('2026-01-06');

    expect((await varianceRow(varianceId)).status).toBe('income');
    expect(await storeBalance(f.orgId, '1110', f.storeId)).toBe('0.00');
    // net with the transfer = remittance.overage: Dr 1130 10,080 · Cr 1110 10,000 · Cr 7350 80
    expect(await storeBalance(f.orgId, '1130', f.storeId)).toBe('10080.00');
    expect(await storeBalance(f.orgId, '7350', f.storeId)).toBe('-80.00');

    // the custody entry is not activity of its date: nothing new is owed
    const rows = await reports(f, '2026-01-31');
    for (const row of rows) expect(row.owed, 'owed on ' + row.businessDate).toBe('0.00');

    // migration-dependent, last
    expect(await varianceJournalEntryId(varianceId)).not.toBeNull();
    const alloc = await allocationsFor(r.id);
    expect(alloc.map((a) => a.business_date + ':' + a.source + ':' + a.amount), 'no settlement rows — the days were already fully allocated').toEqual(['2026-01-05:cash:10000.00']);
  });
});

/** Copied shape, remittance.test.ts `fixtureWithWallet` / `walletMovement` (T-324 §3). */
async function fixtureWithWallet(hint: string) {
  const f = await fixture(hint);
  const [wallet] = await sql<{ id: string; name: string }[]>`
    select id, name from money_accounts where store_id = ${f.storeId}
      and instrument = 'ewallet' and custodian = 'cashier' and is_foundation`;
  const [till] = await sql<{ name: string }[]>`select name from money_accounts where id = ${f.till}`;
  return { ...f, wallet: wallet!.id, walletName: wallet!.name, tillName: till!.name };
}
type WalletFixture = Awaited<ReturnType<typeof fixtureWithWallet>>;

async function walletMovement(f: WalletFixture, date: string, amount: string) {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, ${date}, ${period!.id}, 'sale', ${uid('src')}, 'draft') returning id`;
    const [w] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1140'`;
    const [rev] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '4100'`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
      values (${e!.id}, 1, ${w!.id}, ${f.storeId}, ${amount}, '0', 'money_account', ${f.wallet})`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 2, ${rev!.id}, ${f.storeId}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}


describe('O1 (wallet variant) — the 1140 debit leg carries the wallet party', () => {
  it('from-account is an e-wallet: Dr 1140 80.00 WITH party money_account = wallet, Cr 7350 80.00 no party, status income — Mutant: dropping the 1140 party conditional -> the requires-party check refuses', async () => {
    const f = await fixtureWithWallet('o1w');
    await verifiedDay(f, '2026-01-05');
    await verifiedDay(f, '2026-01-06');
    await walletMovement(f, '2026-01-05', '5000.00');
    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-05', lines: [{ fromMoneyAccountId: f.wallet, toMoneyAccountId: f.safe, amount: '5080.00', declaredOverage: '80.00' }] }),
    );
    expect(r.variance, 'setup: 80.00 over').toBe('80.00');
    const varianceId = r.varianceId!;

    await recognise(f, varianceId, f.admin, { on: '2026-01-06' });

    const legs = await chargeEntryLines(f.orgId, varianceId);
    expect(legs.map((l) => l.code)).toEqual(['1140', '7350']);
    expect(legs[0]!.debit).toBe('80.00');
    expect(legs[0]!.party_type).toBe('money_account');
    expect(legs[0]!.party_id).toBe(f.wallet);
    expect(legs[1]!.credit).toBe('80.00');
    expect(legs[1]!.party_type).toBeNull();
    expect((await varianceRow(varianceId)).status).toBe('income');
  });
});

describe('O2 — refusals, each with its positive control', () => {
  it('charge and write_off on a positive variance are refused, nothing written; recognise_income on the SAME row succeeds', async () => {
    const { f, varianceId } = await overage('o2a');
    const before = await ledgerSnapshot(f);
    await expect(asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId, action: 'charge', personId: f.cashierId, on: '2026-01-06' }))).rejects.toThrow();
    await expect(asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId, action: 'write_off', reason: 'x' }))).rejects.toThrow();
    expect(await ledgerSnapshot(f)).toEqual(before);
    expect((await varianceRow(varianceId)).status).toBe('open');

    await recognise(f, varianceId, f.admin, { on: '2026-01-06' });
    expect((await chargeEntryLines(f.orgId, varianceId)).length, 'control: recognise_income on the same row posts').toBe(2);
    expect((await varianceRow(varianceId)).status).toBe('income');
  });

  it('recognise_income on a NEGATIVE variance is refused, nothing written; charge on it succeeds', async () => {
    const { f, varianceId } = await shortage('o2b');
    const before = await ledgerSnapshot(f);
    await expect(recognise(f, varianceId, f.admin, { on: '2026-01-06' })).rejects.toThrow();
    expect(await ledgerSnapshot(f)).toEqual(before);
    expect((await varianceRow(varianceId)).status).toBe('open');

    await asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId, action: 'charge', personId: f.cashierId, on: '2026-01-06' }));
    expect((await varianceRow(varianceId)).status, 'control: charge on the shortage').toBe('charged');
  });

  it('staff is refused (AuthorizationError), nothing written; the manager then succeeds', async () => {
    const { f, varianceId } = await overage('o2c');
    const before = await ledgerSnapshot(f);
    await expect(recognise(f, varianceId, f.staff, { on: '2026-01-06' })).rejects.toBeInstanceOf(AuthorizationError);
    expect(await ledgerSnapshot(f)).toEqual(before);
    expect((await varianceRow(varianceId)).status).toBe('open');

    await recognise(f, varianceId, f.admin, { on: '2026-01-06' });
    expect((await varianceRow(varianceId)).status).toBe('income');
  });

  it('a second recognise_income is refused and there is still exactly one entry', async () => {
    const { f, varianceId } = await overage('o2d');
    await recognise(f, varianceId, f.admin, { on: '2026-01-06' });
    expect(await varianceEntryCount(f.orgId), 'first call posted one entry').toBe(1);
    await expect(recognise(f, varianceId, f.admin, { on: '2026-01-07' })).rejects.toThrow();
    expect(await varianceEntryCount(f.orgId)).toBe(1);
    expect(await storeBalance(f.orgId, '7350', f.storeId)).toBe('-80.00');
  });

  it('`on` before the remittance date is refused (R6); nothing written', async () => {
    const { f, varianceId } = await overage('o2e');
    const before = await ledgerSnapshot(f);
    await expect(recognise(f, varianceId, f.admin, { on: '2026-01-04' })).rejects.toThrow();
    expect(await ledgerSnapshot(f)).toEqual(before);
  });
});

describe('O3 — an exact remittance (the neither-leg control)', () => {
  it('no variance row and no remittance_variance entry', async () => {
    const f = await fixture('o3');
    await verifiedDay(f, '2026-01-05');
    await tillMovement(f, '2026-01-05', '10000.00');
    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-05', lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '10000.00' }] }),
    );
    expect(r.variance).toBeNull();
    expect(r.varianceId).toBeNull();
    const [v] = await sql<{ n: string }[]>`select count(*)::text as n from remittance_variances where remittance_id = ${r.id}`;
    expect(v!.n).toBe('0');
    expect(await varianceEntryCount(f.orgId)).toBe(0);
    expect(await storeBalance(f.orgId, '7350', f.storeId)).toBe('0.00');
  });
});

describe('O4 — reversing the remittance reverses the 7350 entry', () => {
  it('7350 back to 0.00 and 1110 back to 10,000.00 — Mutant: reversal skipping the variance entry leaves 7350 at -80.00', async () => {
    const { f, r, varianceId } = await overage('o4');
    await recognise(f, varianceId, f.admin, { on: '2026-01-06' });
    await asOrg(f.orgId, (tx) => reverseRemittance(tx, f.admin, { remittanceId: r.id, reason: 'T-366 S3 O4' }));
    expect(await storeBalance(f.orgId, '7350', f.storeId)).toBe('0.00');
    expect(await storeBalance(f.orgId, '1110', f.storeId)).toBe('10000.00');
  });
});
