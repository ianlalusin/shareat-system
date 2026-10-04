import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-373 S4 (DEF-547) — a reversed handover's uncharged variance must stop reading as open.
 * `docs/tasks/373-money-follow-ups.md` §S4, tests T1-T7 (T8, the web loaders, is
 * `apps/erp/tests/integration/t373-s4-remittance-loader.test.ts`).
 *
 * R6: "open" is DERIVED — a variance is open when its own status is `open` AND its remittance is
 * `posted`. Today `listVariances(…, 'open')` and `countOpenVariances` filter only on the variance's
 * own status, so a reversed handover's variance (which has no entry to reverse, so stays `open`)
 * is listed and counted forever and can never be closed (resolve refuses it).
 *
 * ⛔ TESTER, not BUILDER. Each leg asserts the positive control (listed/counted BEFORE the reversal)
 * first, so a red is "still listed after the reversal", never a setup fault.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, remittanceRepo, transaction, APP_ROLE, RefusalError, UUID_SHAPE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
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

// Fixture — copied shape, t366-s2-variance-charge.test.ts
async function newOrg(hint: string) {
  const code = uid(`t373s4-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  await seedChartOfAccounts(sql, org!.id);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${org!.id}, '2026-01-01', '2026-01-31', 'open')`;
  return { orgId: org!.id };
}
async function person(orgId: string, storeIds: string[], name: string, role?: string): Promise<string> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  if (role) await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  for (const s of storeIds) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
  return p!.id;
}
async function addStore(orgId: string, hint: string) {
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, '2020-01-01') returning id`;
  const [till] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${store!.id} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  const [safe] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${store!.id} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  return { storeId: store!.id, till: till!.id, safe: safe!.id };
}
type Store = Awaited<ReturnType<typeof addStore>>;

async function fixture(hint: string) {
  const o = await newOrg(hint);
  const s1 = await addStore(o.orgId, `${hint}a`);
  const s2 = await addStore(o.orgId, `${hint}b`);
  const adminId = await person(o.orgId, [s1.storeId, s2.storeId], 'Admin', 'admin');
  const cashierId = await person(o.orgId, [s1.storeId], 'Cashier');
  return { ...o, s1, s2, adminId, admin: actor(o.orgId, adminId), cashierId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function verifiedDay(f: Fixture, s: Store, date: string) {
  await sql`insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${f.orgId}, ${s.storeId}, ${date}, 'verified', '0', '0', '0', ${f.adminId})`;
}
async function tillMovement(f: Fixture, s: Store, date: string, amount: string) {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, ${date}, ${period!.id}, 'sale', ${uid('src')}, 'draft') returning id`;
    const [cash] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1110'`;
    const [rev] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '4100'`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${cash!.id}, ${s.storeId}, ${amount}, '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${rev!.id}, ${s.storeId}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

/** A verified day with `taken` in the till; hands over `handed` (+ declared overage if over). */
async function handover(f: Fixture, s: Store, date: string, taken: string, handed: string, declaredOverage?: string) {
  await verifiedDay(f, s, date);
  await tillMovement(f, s, date, taken);
  return asOrg(f.orgId, (tx) =>
    createRemittance(tx, f.admin, {
      storeId: s.storeId,
      remittedOn: date,
      lines: [{ fromMoneyAccountId: s.till, toMoneyAccountId: s.safe, amount: handed, ...(declaredOverage ? { declaredOverage } : {}) }],
    }),
  );
}
const reverse = (f: Fixture, remittanceId: string, reason = 'T-373 S4') =>
  asOrg(f.orgId, (tx) => reverseRemittance(tx, f.admin, { remittanceId, reason }));

const openIds = async (f: Fixture, storeId?: string) =>
  (await asOrg(f.orgId, (tx) => remittanceRepo.listVariances(tx, f.orgId, 'open', storeId))).map((v) => v.id);
const openCount = (f: Fixture) => asOrg(f.orgId, (tx) => remittanceRepo.countOpenVariances(tx, f.orgId));

async function partyBalance(orgId: string, code: string, partyId: string): Promise<string> {
  const [row] = await sql<{ total: string }[]>`
    select coalesce(sum(l.debit - l.credit), 0)::text as total
    from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
    where e.org_id = ${orgId} and e.status <> 'draft' and a.code = ${code} and l.party_type = 'employee' and l.party_id = ${partyId}`;
  return Number(row!.total).toFixed(2);
}
async function refusalOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a refusal, but the call succeeded');
}

describe('T-373 S4 / DEF-547 — a reversed handover variance is not open', () => {
  it('T1: a short handover (-50.00) is listed and counted (control); reversed, it is neither — Mutant: no predicate (HEAD) -> still listed / count 1; filter only the list -> count leg red', async () => {
    const f = await fixture('t1');
    const r = await handover(f, f.s1, '2026-01-05', '1000.00', '950.00');
    expect(r.variance).toBe('-50.00');
    // positive control: open, listed, counted
    expect(await openIds(f, f.s1.storeId)).toEqual([r.varianceId]);
    expect(await openCount(f)).toBe(1);

    await reverse(f, r.id);

    expect(await openIds(f, f.s1.storeId), 'listVariances(open) after the reversal').toEqual([]);
    expect(await openIds(f), 'org-wide list after the reversal').toEqual([]);
    expect(await openCount(f), 'countOpenVariances after the reversal').toBe(0);
  });

  it('T2: the same for an over (+30.00) — Mutant: HEAD lists it', async () => {
    const f = await fixture('t2');
    const r = await handover(f, f.s1, '2026-01-05', '1000.00', '1030.00', '30.00');
    expect(r.variance).toBe('30.00');
    expect(await openIds(f, f.s1.storeId)).toEqual([r.varianceId]);
    expect(await openCount(f)).toBe(1);

    await reverse(f, r.id);

    expect(await openIds(f, f.s1.storeId)).toEqual([]);
    expect(await openCount(f)).toBe(0);
  });

  it('T3 (control): a second, posted remittance open variance stays listed and counted beside the reversed one', async () => {
    const f = await fixture('t3');
    const a = await handover(f, f.s1, '2026-01-05', '1000.00', '950.00');
    const b = await handover(f, f.s1, '2026-01-06', '1000.00', '900.00');
    expect(await openCount(f)).toBe(2);

    await reverse(f, a.id);

    expect(await openIds(f, f.s1.storeId)).toEqual([b.varianceId]);
    expect(await openCount(f)).toBe(1);
  });

  it('T4 (pin): charge a shortage, then reverse -> the charge entry is reversed, 1230 nets to 0.00, nothing listed', async () => {
    const f = await fixture('t4');
    const r = await handover(f, f.s1, '2026-01-05', '10000.00', '9850.00');
    await asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId: r.varianceId!, action: 'charge', personId: f.cashierId, on: '2026-01-06' }));
    expect(await partyBalance(f.orgId, '1230', f.cashierId)).toBe('150.00');
    expect(await openCount(f)).toBe(0); // charged is not open, before and after

    await reverse(f, r.id);

    expect(await partyBalance(f.orgId, '1230', f.cashierId)).toBe('0.00');
    expect(await openIds(f)).toEqual([]);
    expect(await openCount(f)).toBe(0);
  });

  it('T5 (pin): resolving a reversed handover variance is refused with the existing sentence; nothing is posted — control: the same call on a posted handover succeeds', async () => {
    const f = await fixture('t5');
    const live = await handover(f, f.s1, '2026-01-05', '1000.00', '950.00');
    const r = await handover(f, f.s1, '2026-01-06', '1000.00', '950.00');
    await reverse(f, r.id);

    const [before] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${f.orgId}`;
    const err = await refusalOf(
      asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId: r.varianceId!, action: 'charge', personId: f.cashierId, on: '2026-01-07' })),
    );
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).userMessage).toMatch(/^That handover was reversed/);
    const [after] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${f.orgId}`;
    expect(after!.n).toBe(before!.n);
    const [v] = await sql<{ status: string }[]>`select status from remittance_variances where id = ${r.varianceId}`;
    expect(v!.status).toBe('open'); // derived, not rewritten (R6)

    await asOrg(f.orgId, (tx) => resolveRemittanceVariance(tx, f.admin, { varianceId: live.varianceId!, action: 'charge', personId: f.cashierId, on: '2026-01-07' }));
    const [lv] = await sql<{ status: string }[]>`select status from remittance_variances where id = ${live.varianceId}`;
    expect(lv!.status).toBe('charged');
  });

  it('T6 (org-wide): a reversed open variance at ANOTHER store is excluded from countOpenVariances; the other store posted one still counts — Mutant: predicate dropped from the count -> red', async () => {
    const f = await fixture('t6');
    const a = await handover(f, f.s1, '2026-01-05', '1000.00', '950.00');
    const b = await handover(f, f.s2, '2026-01-05', '1000.00', '950.00');
    expect(await openCount(f)).toBe(2);

    await reverse(f, b.id); // store 2's handover reversed

    expect(await openCount(f)).toBe(1);
    expect(await openIds(f, f.s2.storeId)).toEqual([]);
    expect(await openIds(f, f.s1.storeId)).toEqual([a.varianceId]);
  });

  it('T7 (S4·N1): a second reversal and an empty reason are RefusalErrors with sentences and no uuid — Mutant: plain Error (HEAD)', async () => {
    const f = await fixture('t7');
    const r = await handover(f, f.s1, '2026-01-05', '1000.00', '950.00');

    const empty = await refusalOf(reverse(f, r.id, '   '));
    expect(empty).toBeInstanceOf(RefusalError);
    expect((empty as RefusalError).userMessage).toBe('Say why this handover is being reversed.');
    expect((empty as RefusalError).userMessage).not.toMatch(UUID_SHAPE);
    // control: the empty reason wrote nothing — the handover is still posted and its variance open
    expect(await openCount(f)).toBe(1);

    await reverse(f, r.id); // control: the first reversal succeeds
    const twice = await refusalOf(reverse(f, r.id));
    expect(twice).toBeInstanceOf(RefusalError);
    expect((twice as RefusalError).userMessage).toBe('This handover was already reversed.');
    expect((twice as RefusalError).userMessage).not.toMatch(UUID_SHAPE);
  });
});
