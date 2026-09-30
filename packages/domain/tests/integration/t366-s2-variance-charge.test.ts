import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-366 S2 (DEF-386 + DEF-105) — charging a remittance shortage to a person must post the
 * receivable (it posts nothing today) and complete the day it was charged against.
 * `docs/tasks/366-remittance-floats.md` §S2, legs C1-C8 (C9 and the migration test are their own
 * files; T4 lives in `t366-s1-cash-custody-locks.test.ts`, per that file's own note). Amendment A1
 * (2026-09-30): no write-off — a shortage is ALWAYS charged to staff, `write_off` is retired.
 *
 * ⛔ TESTER, not BUILDER. `resolveRemittanceVariance` (`packages/domain/src/remittance/
 * index.ts:432-489`) already has the `action: 'charge' | 'write_off'` shape (an earlier slice) but
 * the `'charge'` branch only updates `remittance_variances.status`/`chargedToPersonId` — it never
 * calls `postEntry`. Every assertion on `journal_lines`/`journal_entries` below is ordered FIRST in
 * each leg, so the reported red is "nothing posted," not a missing-column error; assertions that
 * inherently need migration 0172's new `remittance_allocations.source` or
 * `remittance_variances.journal_entry_id` columns are ordered LAST and labelled — those may fail on
 * the missing column until the migration lands, which the orchestrator accepted for exactly this
 * shape of leg.
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
import { createRemittance, resolveRemittanceVariance } from '@shareat/domain';

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
  const code = uid(`t366s2-${hint}`);
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

// -----------------------------------------------------------------------------------------------
// C1 — Ian's shape
// -----------------------------------------------------------------------------------------------

describe('C1 — a shortage charged to a person posts the receivable and completes the day', () => {
  it('exactly one 2-line entry (1230 debit party=P / 1110 credit), variance charged with journal_entry_id, 1230=150/1110=0, D owed 0.00 — Mutant: posting nothing (HEAD) / crediting 1130 / debiting 7350 / no settlement row / no source-type exclusion', async () => {
    const f = await fixture('c1');
    await verifiedDay(f, '2026-01-05');
    await tillMovement(f, '2026-01-05', '10000.00');
    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-05', lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '9850.00' }] }),
    );
    expect(r.variance).toBe('-150.00');
    expect(r.varianceId).not.toBeNull();
    const varianceId = r.varianceId!;

    await asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId, action: 'charge', personId: f.cashierId, on: '2026-01-06' }));

    // --- core: the charge entry itself ---
    const legs = await chargeEntryLines(f.orgId, varianceId);
    expect(legs.length, 'exactly 2 lines on the charge entry').toBe(2);
    expect(legs.map((l) => l.code)).toEqual(['1110', '1230']);
    expect(legs[0]!.credit).toBe('150.00');
    expect(legs[0]!.party_type).toBeNull();
    expect(legs[1]!.debit).toBe('150.00');
    expect(legs[1]!.party_type).toBe('employee');
    expect(legs[1]!.party_id).toBe(f.cashierId);
    expect(await chargeEntryDate(f.orgId, varianceId)).toBe('2026-01-06');

    // --- core: balances ---
    expect(await partyBalance(f.orgId, '1230', 'employee', f.cashierId)).toBe('150.00');
    expect(await storeBalance(f.orgId, '1110', f.storeId)).toBe('0.00');

    // --- core: the day is complete (schema-independent — endDayReports doesn't touch `source`) ---
    const [dayReport] = await reports(f, '2026-01-10');
    expect(dayReport!.owed).toBe('0.00');
    expect(dayReport!.allocated).toBe('10000.00');
    const rows = await reports(f, '2026-01-10');
    expect(rows.length, 'no separate report row for the charge date').toBe(1);

    // --- variance row updated ---
    const v = await varianceRow(varianceId);
    expect(v.status).toBe('charged');
    expect(v.charged_to_person_id).toBe(f.cashierId);

    // --- migration-dependent, last: journal_entry_id linkage + allocation source ---
    const entryId = await varianceJournalEntryId(varianceId);
    expect(entryId, 'variance.journal_entry_id must equal the charge entry').not.toBeNull();
    const allocations = await allocationsFor(r.id);
    expect(allocations.map((a) => `${a.business_date}:${a.source}:${a.amount}`).sort()).toEqual(['2026-01-05:cash:9850.00', '2026-01-05:charge:150.00']);
  });
});

// -----------------------------------------------------------------------------------------------
// C2 — partial cash after the shortage
// -----------------------------------------------------------------------------------------------

describe('C2 — a later cash remittance shrinks the chargeable amount', () => {
  it('the charge is capped at 50.00 (not the full 150.00) — Mutant: charging the full |variance| gives 1230=150.00', async () => {
    const f = await fixture('c2');
    await verifiedDay(f, '2026-01-05');
    await tillMovement(f, '2026-01-05', '10000.00');
    const r1 = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-05', lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '9850.00' }] }),
    );
    const r2 = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-06', lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '100.00' }] }),
    );
    expect(r2.variance).toBe('-50.00');

    await asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId: r1.varianceId!, action: 'charge', personId: f.cashierId, on: '2026-01-07' }));

    const legs = await chargeEntryLines(f.orgId, r1.varianceId!);
    expect(legs.length, 'the charge entry must exist at all').toBe(2);
    expect(legs.find((l) => l.code === '1230')!.debit).toBe('50.00');
    expect(await partyBalance(f.orgId, '1230', 'employee', f.cashierId)).toBe('50.00');

    const [dayReport] = await reports(f, '2026-01-10');
    expect(dayReport!.owed).toBe('0.00');

    // charging the SECOND remittance's own -50 variance is now refused (cap zero)
    await expect(
      asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId: r2.varianceId!, action: 'charge', personId: f.cashierId, on: '2026-01-08' })),
    ).rejects.toThrow(/has since been remitted in cash|nothing is left to charge/);
  });
});

// -----------------------------------------------------------------------------------------------
// C3 — fully paid in cash
// -----------------------------------------------------------------------------------------------

describe('C3 (positive control: C1) — fully covered by a later cash remittance', () => {
  it('the charge is refused; the ledger is unchanged', async () => {
    const f = await fixture('c3');
    await verifiedDay(f, '2026-01-05');
    await tillMovement(f, '2026-01-05', '10000.00');
    const r1 = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-05', lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '9850.00' }] }),
    );
    await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-06', lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '150.00' }] }),
    );
    const before = await ledgerSnapshot(f);

    await expect(asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId: r1.varianceId!, action: 'charge', personId: f.cashierId, on: '2026-01-07' }))).rejects.toThrow();
    expect(await ledgerSnapshot(f)).toEqual(before);
  });
});

// -----------------------------------------------------------------------------------------------
// C4 — two from-accounts: the cashier account is NAMED, never guessed (R5)
// -----------------------------------------------------------------------------------------------

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

/** Till 5,000 + wallet 5,000 on one verified day; hands over 4,900 from each -> variance -200.00. */
async function bothShort(hint: string) {
  const f = await fixtureWithWallet(hint);
  await verifiedDay(f, '2026-01-05');
  await tillMovement(f, '2026-01-05', '5000.00');
  await walletMovement(f, '2026-01-05', '5000.00');
  const r = await asOrg(f.orgId, (tx) =>
    createRemittance(tx, f.admin, {
      storeId: f.storeId,
      remittedOn: '2026-01-05',
      lines: [
        { fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '4900.00' },
        { fromMoneyAccountId: f.wallet, toMoneyAccountId: f.safe, amount: '4900.00' },
      ],
    }),
  );
  expect(r.variance, 'setup: both accounts 100.00 short').toBe('-200.00');
  return { f, r, varianceId: r.varianceId! };
}

/** The refusal's full text — the message plus every string field the error carries. */
async function refusalText(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as Error & Record<string, unknown>;
    return [err.message, ...Object.values(err).filter((v): v is string => typeof v === 'string')].join(' | ');
  }
  throw new Error('expected a refusal, but the charge succeeded');
}

describe('C4 — a multi-account handover names its cashier account (R5)', () => {
  it('C4a: no fromMoneyAccountId is refused and the message names BOTH accounts; nothing written — Mutant: guess fromAccounts[0] / drop the >1 branch -> the charge posts (red); print only one name -> red', async () => {
    const { f, varianceId } = await bothShort('c4a');
    const before = await ledgerSnapshot(f);
    const text = await refusalText(
      asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId, action: 'charge', personId: f.cashierId, on: '2026-01-06' })),
    );
    expect(text).toContain(`"${f.tillName}"`);
    expect(text).toContain(`"${f.walletName}"`);
    expect(text).toMatch(/more than one account/);
    expect(await ledgerSnapshot(f)).toEqual(before);
    expect((await varianceRow(varianceId)).status).toBe('open');
    expect((await chargeEntryLines(f.orgId, varianceId)).length).toBe(0);
  });

  it('C4b: an account NOT on the remittance is refused; nothing written — Mutant: skip the not-on-remittance find/undefined check -> internalFault or a post (red)', async () => {
    const { f, varianceId } = await bothShort('c4b');
    const [other] = await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_foundation)
      values (${f.orgId}, ${f.storeId}, ${uid('Stranger')}, 'cash', '1110', 'cashier', false) returning id`;
    const before = await ledgerSnapshot(f);
    for (const bogus of [other!.id, f.safe]) {
      const text = await refusalText(
        asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId, action: 'charge', personId: f.cashierId, fromMoneyAccountId: bogus, on: '2026-01-06' })),
      );
      expect(text).toMatch(/is not (one this handover came from|on the remittance)|not on the remittance/);
    }
    expect(await ledgerSnapshot(f)).toEqual(before);
    expect((await varianceRow(varianceId)).status).toBe('open');
  });

  it('C4c: charging from the WALLET posts Dr 1230 (employee) / Cr 1140 party money_account=wallet; the cashier account posts Cr 1110 (control) — Mutant: drop creditParty on the 1140 credit -> party_type null / requires_party (red); always credit 1110 -> red', async () => {
    const w = await bothShort('c4c-wallet');
    await asOrg(w.f.orgId, (tx) =>
      resolveRemittanceVariance(tx, w.f.admin, { varianceId: w.varianceId, action: 'charge', personId: w.f.cashierId, fromMoneyAccountId: w.f.wallet, on: '2026-01-06' }),
    );
    const legs = await chargeEntryLines(w.f.orgId, w.varianceId);
    expect(legs.map((l) => ({ ...l }))).toEqual([
      { code: '1140', debit: '0.00', credit: '200.00', party_type: 'money_account', party_id: w.f.wallet },
      { code: '1230', debit: '200.00', credit: '0.00', party_type: 'employee', party_id: w.f.cashierId },
    ]);
    expect(await partyBalance(w.f.orgId, '1230', 'employee', w.f.cashierId)).toBe('200.00');
    expect((await varianceRow(w.varianceId)).status).toBe('charged');

    // positive control: the same two-account remittance, charged from the CASHIER (till) account -> Cr 1110, no party
    const t = await bothShort('c4c-till');
    await asOrg(t.f.orgId, (tx) =>
      resolveRemittanceVariance(tx, t.f.admin, { varianceId: t.varianceId, action: 'charge', personId: t.f.cashierId, fromMoneyAccountId: t.f.till, on: '2026-01-06' }),
    );
    const tl = await chargeEntryLines(t.f.orgId, t.varianceId);
    expect(tl.map((l) => ({ ...l }))).toEqual([
      { code: '1110', debit: '0.00', credit: '200.00', party_type: null, party_id: null },
      { code: '1230', debit: '200.00', credit: '0.00', party_type: 'employee', party_id: t.f.cashierId },
    ]);
  });
});

// -----------------------------------------------------------------------------------------------
// C5 — refusals leave nothing written, each paired with a success control
// -----------------------------------------------------------------------------------------------

describe('C5 — refusals', () => {
  it('staff is refused; the manager/admin succeeds', async () => {
    const f = await fixture('c5-auth');
    await verifiedDay(f, '2026-01-05');
    await tillMovement(f, '2026-01-05', '10000.00');
    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-05', lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '9850.00' }] }),
    );
    const before = await ledgerSnapshot(f);
    await expect(
      asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.staff, { varianceId: r.varianceId!, action: 'charge', personId: f.cashierId, on: '2026-01-06' })),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(await ledgerSnapshot(f)).toEqual(before);

    await asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId: r.varianceId!, action: 'charge', personId: f.cashierId, on: '2026-01-06' }));
    expect((await chargeEntryLines(f.orgId, r.varianceId!)).length).toBe(2);
  });

  it('an already-charged variance is refused a second time; exactly one entry exists', async () => {
    const f = await fixture('c5-double');
    await verifiedDay(f, '2026-01-05');
    await tillMovement(f, '2026-01-05', '10000.00');
    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-05', lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '9850.00' }] }),
    );
    await asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId: r.varianceId!, action: 'charge', personId: f.cashierId, on: '2026-01-06' }));
    await expect(
      asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId: r.varianceId!, action: 'charge', personId: f.cashierId, on: '2026-01-07' })),
    ).rejects.toThrow();
    expect((await chargeEntryLines(f.orgId, r.varianceId!)).length).toBe(2);
  });

  it('a positive variance (overage) is refused for "charge"', async () => {
    const f = await fixture('c5-overage');
    await verifiedDay(f, '2026-01-05');
    await tillMovement(f, '2026-01-05', '10000.00');
    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-05', lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '10080.00', declaredOverage: '80.00' }] }),
    );
    expect(r.variance).toBe('80.00');
    await expect(asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId: r.varianceId!, action: 'charge', personId: f.cashierId, on: '2026-01-06' }))).rejects.toThrow();
  });

  it('an empty personId is refused', async () => {
    const f = await fixture('c5-noperson');
    await verifiedDay(f, '2026-01-05');
    await tillMovement(f, '2026-01-05', '10000.00');
    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-05', lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '9850.00' }] }),
    );
    await expect(asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId: r.varianceId!, action: 'charge', personId: '', on: '2026-01-06' }))).rejects.toThrow();
  });

  it('write_off is now REFUSED (Amendment A1: no write-off); charge on the same variance still works — Mutant: today write_off SUCCEEDS (status -> written_off), so this leg is red today', async () => {
    const f = await fixture('c5-writeoff');
    await verifiedDay(f, '2026-01-05');
    await tillMovement(f, '2026-01-05', '10000.00');
    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-05', lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '9850.00' }] }),
    );
    await expect(
      asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId: r.varianceId!, action: 'write_off', reason: 'test' })),
    ).rejects.toThrow();
    const v = await varianceRow(r.varianceId!);
    expect(v.status, 'still open — the refused write_off wrote nothing').toBe('open');

    await asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId: r.varianceId!, action: 'charge', personId: f.cashierId, on: '2026-01-06' }));
    expect((await varianceRow(r.varianceId!)).status).toBe('charged');
  });

  it('`on` earlier than the remittance\'s remitted_on is refused', async () => {
    const f = await fixture('c5-earlydate');
    await verifiedDay(f, '2026-01-10');
    await tillMovement(f, '2026-01-10', '10000.00');
    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-10', lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '9850.00' }] }),
    );
    await expect(
      asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId: r.varianceId!, action: 'charge', personId: f.cashierId, on: '2026-01-05' })),
    ).rejects.toThrow();
  });

  it('`on` in a closed period is refused by postEntry; nothing written', async () => {
    const f = await fixture('c5-closedperiod');
    await verifiedDay(f, '2026-01-05');
    await tillMovement(f, '2026-01-05', '10000.00');
    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-05', lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '9850.00' }] }),
    );
    await expect(
      asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId: r.varianceId!, action: 'charge', personId: f.cashierId, on: '2026-03-01' })),
    ).rejects.toThrow();
    const v = await varianceRow(r.varianceId!);
    expect(v.status).toBe('open');
    expect((await chargeEntryLines(f.orgId, r.varianceId!)).length).toBe(0);
  });
});

// -----------------------------------------------------------------------------------------------
// C6 — reversal
// -----------------------------------------------------------------------------------------------

describe('C6 — reversing the remittance after a charge reverses the charge too', () => {
  it('a reversal of the charge entry exists; 1230 back to 0.00, 1110 back to 10,000.00 — Mutant: reversing without the variance entry leaves 1230 at 150.00', async () => {
    const f = await fixture('c6');
    await verifiedDay(f, '2026-01-05');
    await tillMovement(f, '2026-01-05', '10000.00');
    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-05', lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '9850.00' }] }),
    );
    await asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId: r.varianceId!, action: 'charge', personId: f.cashierId, on: '2026-01-06' }));

    const { reverseRemittance } = await import('@shareat/domain');
    await asOrg(f.orgId, (tx) => reverseRemittance(tx, f.admin, { remittanceId: r.id, reason: 'T-366 S2 C6' }));

    expect(await partyBalance(f.orgId, '1230', 'employee', f.cashierId)).toBe('0.00');
    expect(await storeBalance(f.orgId, '1110', f.storeId)).toBe('10000.00');
  });
});

// -----------------------------------------------------------------------------------------------
// C7 — Manila date
// -----------------------------------------------------------------------------------------------

describe('C7 — the resolution date is Manila\'s, not UTC\'s', () => {
  it('with no `on`, entry_date and resolved_on are 2026-01-07 at 2026-01-06T17:30:00Z — Mutant: the UTC slice gives 2026-01-06', async () => {
    const f = await fixture('c7');
    await verifiedDay(f, '2026-01-05');
    await tillMovement(f, '2026-01-05', '10000.00');
    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-05', lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '9850.00' }] }),
    );

    // ⚠️ `shouldAdvanceTime: true` — a plain `vi.useFakeTimers()` here freezes the REAL Postgres
    // driver's own internal timers too (it shares the process's global setTimeout), which hangs
    // every subsequent DB round-trip in this file, not just this test. This mode lets real I/O
    // keep advancing in real time while `Date`/`Date.now()` still read the faked instant.
    const { vi } = await import('vitest');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-01-06T17:30:00Z'));
    try {
      await asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId: r.varianceId!, action: 'charge', personId: f.cashierId }));
    } finally {
      vi.useRealTimers();
    }

    expect(await chargeEntryDate(f.orgId, r.varianceId!)).toBe('2026-01-07');
    const [row] = await sql<{ resolved_on: string }[]>`select resolved_on::text from remittance_variances where id = ${r.varianceId}`;
    expect(row!.resolved_on).toBe('2026-01-07');
  });
});

// -----------------------------------------------------------------------------------------------
// C8 — charge and a cash remittance for the same shortage, two ordered cases
// -----------------------------------------------------------------------------------------------

describe('C8 — charge-first vs remittance-first for the same shortage', () => {
  it('charge first: posts 150.00, D owed 0.00; a later 150.00 remittance for D is then refused, nothing written — Mutant: no R4 cap lets the remittance also post', async () => {
    const f = await fixture('c8a');
    await verifiedDay(f, '2026-01-05');
    await tillMovement(f, '2026-01-05', '10000.00');
    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-05', lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '9850.00' }] }),
    );
    await asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId: r.varianceId!, action: 'charge', personId: f.cashierId, on: '2026-01-06' }));
    expect(await partyBalance(f.orgId, '1230', 'employee', f.cashierId)).toBe('150.00');
    expect((await reports(f, '2026-01-10'))[0]!.owed).toBe('0.00');

    const before = await ledgerSnapshot(f);
    await expect(
      asOrg(f.orgId, (tx) => createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-07', lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '150.00' }] })),
    ).rejects.toThrow();
    expect(await ledgerSnapshot(f)).toEqual(before);
  });

  it('remittance first: a 150.00 remittance settles D (owed 0.00); the charge is then refused, 1230 stays 0.00 — Mutant: no R4 cap lets the charge also post 150.00', async () => {
    const f = await fixture('c8b');
    await verifiedDay(f, '2026-01-05');
    await tillMovement(f, '2026-01-05', '10000.00');
    const r = await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-05', lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '9850.00' }] }),
    );
    await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, { storeId: f.storeId, remittedOn: '2026-01-06', lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '150.00' }] }),
    );
    expect((await reports(f, '2026-01-10'))[0]!.owed).toBe('0.00');

    await expect(
      asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId: r.varianceId!, action: 'charge', personId: f.cashierId, on: '2026-01-07' })),
    ).rejects.toThrow();
    expect(await partyBalance(f.orgId, '1230', 'employee', f.cashierId)).toBe('0.00');
  });
});
