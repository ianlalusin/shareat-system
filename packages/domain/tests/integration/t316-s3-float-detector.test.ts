import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-316 S3 — the detector. `docs/tasks/316-till-floor-on-the-cashier-account.md` §1.2, §2.1, "S3 — the
 * detector + T-375 guard", tests T-S3-1, -2, -3, -4, -5, -7, -8, -9 (mutants M7, M12, M13, M14, M16, M17).
 * (T-S3-6, the no-link-read guard, is the fs unit test `tests/unit/t316-s3-no-link-read.test.ts`.)
 *
 * ⭐ THE TARGET: `tillFloatOffTarget` compares `tillFloorPosition().floatPosition` (the float as the books
 * hold it — ordinary trading cannot move it) with the store's `float_target`, NOT the drawer's raw ledger
 * balance. On the 1110 drawer the raw balance is float PLUS unremitted takings, so the old detector reads
 * "₱5,000 over" on every ordinary trading day.
 *
 * ⭐ RED on the current tree, FOR THE RIGHT REASON — the old detector reads the raw drawer balance:
 *   T-S3-1/2/3/7(detector)/8 expect NO finding and get one ("over", figure = the drawer's takings);
 *   T-S3-1/3/8 controls expect a "short" and the old detector says "over" (or the old wording);
 *   T-S3-4/5/9 expect the ✎R-5 sentences and get the old "holds … in the LEDGER" / "INTO the float" text.
 * PASSES TODAY (guards regression): T-S3-5's pre-opening/zero-balance leg; T-S3-7's floatPosition-equality
 * leg (S2's `tillFloorPosition` already reads no `sales_days` figure). Every other test is red.
 *
 * ✎S-5 every fixture has a verified day with owed > 0. The dates are all in January 2026; the detector
 * measures `upTo` Manila today, which is later, so every fixture date is in the past.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, findingsRepo, remittanceRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { type Actor } from '@shareat/auth';
import { createMoneyTransfer, createRemittance, setTillFloat } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

/** The same formatter the detector uses (`@shareat/core` formatMoney = this Intl call). */
const peso = (n: number): string =>
  new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2 }).format(n);
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

interface Opts {
  /** `stores.opening_date`; default '2020-01-01' (open). `null` = pre-opening. */
  openingDate?: string | null;
}

async function mk(hint: string, o: Opts = {}) {
  const code = uid(`t316s3-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const storeName = `Store ${hint}`;
  const openingDate = o.openingDate === undefined ? '2020-01-01' : o.openingDate;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid(hint)}, ${storeName}, ${openingDate}) returning id`;
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
type F = Awaited<ReturnType<typeof mk>>;

/** A balanced posted entry touching 1110 (Dr when amount > 0) against `otherCode`. */
async function post(f: F, date: string, amount: string, sourceType: string, otherCode: string) {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
  const positive = Number(amount) >= 0;
  const abs = Math.abs(Number(amount)).toFixed(2);
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, ${date}, ${period!.id}, ${sourceType}, ${uid('src')}, 'draft') returning id`;
    const [cash] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1110'`;
    const [other] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = ${otherCode}`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${cash!.id}, ${f.storeId}, ${positive ? abs : '0'}, ${positive ? '0' : abs})`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${other!.id}, ${f.storeId}, ${positive ? '0' : abs}, ${positive ? abs : '0'})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}
const sale = (f: F, date: string, amount: string) => post(f, date, amount, 'sale', '4100');
const spend = (f: F, date: string, amount: string) => post(f, date, `-${amount}`, 'expense', '6160');
/** Float funding is custody (source_type 'transfer' — excluded from `movement`). */
const fund = (f: F, date: string, amount: string) => post(f, date, amount, 'transfer', '1130');
const setTarget = (f: F, target: string) => sql`update money_accounts set float_target = ${target} where id = ${f.till}`;

async function day(f: F, date: string, status: 'verified' | 'open', cash = '0.00') {
  await sql`insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, cash_collected, created_by)
    values (${f.orgId}, ${f.storeId}, ${date}, ${status}, ${cash}, '0', ${cash}, ${cash}, ${f.adminId})`;
}

/** A store linked to POS (T-375), no import yet — the link row exists, no `sales_days` row for the day. */
async function link(f: F) {
  const [c] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
    values (${f.orgId}, ${f.storeId}, 'Walk-in', true, null) returning id`;
  await sql`insert into pos_v1_store_links (org_id, store_id, pos_store_id, pos_store_name, sales_channel_id, pos_tax_type, created_by)
    values (${f.orgId}, ${f.storeId}, ${uid('pos')}, 'POS store', ${c!.id}, 'vat_inclusive', ${f.adminId})`;
}

/** A feed-sourced OPEN day (`source = 'pos_v1_day_feed'`, A5) for `date` with `cash` imported. */
async function feedDay(f: F, date: string, cash: string) {
  const hash = 'a'.repeat(64);
  const [feed] = await sql<{ id: string }[]>`
    insert into pos_v1_day_feeds (org_id, store_id, business_date, kind, purpose, batch_id, pos_store_id, body, payload, content_hash, fetched_at, fetched_by)
    values (${f.orgId}, ${f.storeId}, ${date}, 'sales', 'import', ${crypto.randomUUID()}, 'pos-x', '{"found":true}', '{"found":true}'::jsonb, ${hash}, now(), ${f.adminId})
    returning id`;
  await sql`insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, cash_collected,
                                    source, pos_v1_day_feed_id, pos_sourced, pos_sourced_at, created_by)
    values (${f.orgId}, ${f.storeId}, ${date}, 'open', ${cash}, '0', ${cash}, ${cash},
            'pos_v1_day_feed', ${feed!.id}, true, now(), ${f.adminId})`;
}

/** Opening cash in the office safe (1130), so a transfer to the till has something to move. */
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

const detect = (f: F) => asOrg(f.orgId, (tx) => findingsRepo.tillFloatOffTarget(tx, f.orgId));
const position = (f: F) =>
  asOrg(f.orgId, (tx) => remittanceRepo.tillFloorPosition(tx, f.orgId, { storeId: f.storeId, upTo: '2026-12-31' }));

/**
 * ✎S-5 CONTROL — "the detector DOES fire when it should", in this fixture family: float 20,000 funded;
 * D0 verified +1,000 (owes), D1 verified with a 500 spend (closed negative) ⇒ float 19,500 ⇒ "500 short".
 */
async function shortControl(hint: string) {
  const c = await mk(hint);
  await setTarget(c, '20000.00');
  await fund(c, '2026-01-02', '20000.00');
  await day(c, '2026-01-03', 'verified');
  await sale(c, '2026-01-03', '1000.00');
  await day(c, '2026-01-04', 'verified');
  await spend(c, '2026-01-04', '500.00');
  return c;
}

const SHORT_TAIL =
  'Money was paid out of the till and not put back. The office tops it up. ⛔ This is NOT a counted shortage and must not be charged to a cashier.';
const OVER_TAIL =
  'Either the office sent more than the target, or an overage was booked (7350) instead of being settled against the day it came from. Send the surplus back to the office by transfer, or correct the overage.';
const lead = (f: F, pos: number, target: number) =>
  `${f.storeName}'s till float stands at ${peso(pos)} on the books against a target of ${peso(target)} —`;

describe('T-S3-1 — an ordinary trading day is NOT a finding (M12 detector on the raw balance → red)', () => {
  it('float 20,000; V verified, unremitted 5,000 in the drawer — NO finding (old detector: "₱5,000.00 over", every day)', async () => {
    const f = await mk('s3-1');
    await setTarget(f, '20000.00');
    await fund(f, '2026-01-02', '20000.00');
    await day(f, '2026-01-05', 'verified');
    await sale(f, '2026-01-05', '5000.00');
    expect(Number((await position(f)).floatPosition), 'premise: the float stands at target').toBeCloseTo(20000, 2);
    expect(await detect(f), 'an ordinary verified-but-unremitted day must not read as drift').toEqual([]);
  });

  it('control (same family): an expense on a CLOSED day leaves the float 500 short — the "short … office replenishes" finding for 500.00', async () => {
    const c = await shortControl('s3-1c');
    const found = await detect(c);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain(`${peso(500)} short.`);
    expect(found[0]!.detail).toContain('The office tops it up.');
    expect(found[0]!.kind).toBe('tillFloatOffTarget');
    expect(found[0]!.severity).toBe('soft');
  });
});

describe('T-S3-2 — declared-but-unverified cash is not in the float (A3 c; M13 `cash_collected` term → red)', () => {
  it('V verified 5,000 + U open with 8,000 declared (cash posts at verify, nothing posted yet) — NO finding', async () => {
    const f = await mk('s3-2');
    await setTarget(f, '20000.00');
    await fund(f, '2026-01-02', '20000.00');
    await day(f, '2026-01-05', 'verified');
    await sale(f, '2026-01-05', '5000.00');
    await day(f, '2026-01-06', 'open', '8000.00');
    expect(await detect(f), 'the declared 8,000 is in nobody’s owed yet — it must not read as drift').toEqual([]);
  });

  it('control: the same family fires when the closed-day spend is real (500 short)', async () => {
    const c = await shortControl('s3-2c');
    await day(c, '2026-01-06', 'open', '8000.00'); // a declared open day must not mask a real shortfall
    const found = await detect(c);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain(`${peso(500)} short.`);
  });
});

describe('T-S3-3 — ice on today’s open day is on loan (⑤; M14 on-loan rows treated as closed → red)', () => {
  it('V verified 5,000; U open, ice 500 posted — NO finding', async () => {
    const f = await mk('s3-3');
    await setTarget(f, '20000.00');
    await fund(f, '2026-01-02', '20000.00');
    await day(f, '2026-01-05', 'verified');
    await sale(f, '2026-01-05', '5000.00');
    await day(f, '2026-01-06', 'open', '0.00');
    await spend(f, '2026-01-06', '500.00');
    expect(await detect(f), 'the ice is repaid by U’s own sales at verify').toEqual([]);
  });

  it('control: the SAME spend on a day that is VERIFIED (closed) reads "500 short"', async () => {
    const f = await mk('s3-3c');
    await setTarget(f, '20000.00');
    await fund(f, '2026-01-02', '20000.00');
    await day(f, '2026-01-05', 'verified');
    await sale(f, '2026-01-05', '5000.00');
    await day(f, '2026-01-06', 'verified', '0.00');
    await spend(f, '2026-01-06', '500.00');
    const found = await detect(f);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain(`${peso(500)} short.`);
  });
});

describe('T-S3-4 — ⑥ after remitting D2: the float sits at 18,000 and the detector says "2,000 short" (M7 `owed` for `max(owed,0)` → red)', () => {
  it('D1 verified −2,000 (spend), D2 verified +10,000, hand over D2’s 10,000 — finding "₱2,000.00 short", must not be charged to a cashier', async () => {
    const f = await mk('s3-4');
    await officeOpening(f, '2026-01-01', '90000.00');
    await asOrg(f.orgId, (tx) => setTillFloat(tx, f.admin, { storeId: f.storeId, target: '20000.00' }));
    await asOrg(f.orgId, (tx) =>
      createMoneyTransfer(tx, f.admin, {
        fromMoneyAccountId: f.safe,
        toMoneyAccountId: f.till,
        amountOut: '20000.00',
        amountIn: '20000.00',
        transferDate: '2026-01-02',
        notes: 'Fund the till float',
      }),
    );
    await day(f, '2026-01-03', 'verified');
    await spend(f, '2026-01-03', '2000.00');
    await day(f, '2026-01-04', 'verified');
    await sale(f, '2026-01-04', '10000.00');
    await asOrg(f.orgId, (tx) =>
      createRemittance(tx, f.admin, {
        storeId: f.storeId,
        remittedOn: '2026-01-05',
        lines: [{ fromMoneyAccountId: f.till, toMoneyAccountId: f.safe, amount: '10000.00' }],
      }),
    );
    expect(Number((await position(f)).floatPosition), 'premise: 20,000 − 2,000 + 10,000 − 10,000').toBeCloseTo(18000, 2);
    const found = await detect(f);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain(`${peso(2000)} short.`);
    expect(found[0]!.detail).toContain('must not be charged to a cashier');
  });
});

describe('T-S3-5 — over-funded float is "over"; a pre-opening store with a zero balance stays quiet (T-346 control kept)', () => {
  it('float funded 21,000 against a 20,000 target, V verified 5,000 unremitted — the "over" finding for 1,000.00, the figure is the float position (21,000), not the drawer (26,000)', async () => {
    const f = await mk('s3-5');
    await setTarget(f, '20000.00');
    await fund(f, '2026-01-02', '21000.00');
    await day(f, '2026-01-05', 'verified');
    await sale(f, '2026-01-05', '5000.00');
    const found = await detect(f);
    expect(found).toHaveLength(1);
    const d = squash(found[0]!.detail);
    expect(d).toContain(lead(f, 21000, 20000));
    expect(d).toContain(`${peso(1000)} over.`);
  });

  it('PASSES TODAY (guard): pre-opening store (no opening date, never traded), target set, balance exactly zero — no finding', async () => {
    const f = await mk('s3-5p', { openingDate: null });
    await setTarget(f, '20000.00');
    expect(await detect(f)).toEqual([]);
  });

  it('kills the mutant "suppression reads floatPosition instead of cashierBalance": pre-opening by BOTH measures, cashierBalance -500.00 but floatPosition exactly 0.00 — STILL fires (₱20,000.00 short)', async () => {
    // A ₱500 spend on a day-less date with no verified day is on loan: cashierBalance -500, onLoan -500,
    // closedOwed 0 ⇒ floatPosition 0. (A posted SALE would count as trading — store_first_trading_date reads
    // sale entries — and make the store not pre-opening, so the suppression would never engage.) The real rule
    // suppresses only when the CASHIER BALANCE is zero, so this fires; a detector testing floatPosition === 0
    // would go quiet here.
    const f = await mk('s3-5m', { openingDate: null });
    await setTarget(f, '20000.00');
    await spend(f, '2026-01-05', '500.00');
    const [sig] = await sql<{ pre_opening: boolean; first_trading: string | null }[]>`
      select (opening_date is null or opening_date > (now() at time zone 'Asia/Manila')::date) as pre_opening,
             store_first_trading_date(${f.storeId}::uuid)::text as first_trading
      from stores where id = ${f.storeId}`;
    expect(sig!.pre_opening, 'premise: opening_date says pre-opening').toBe(true);
    expect(sig!.first_trading, 'premise: the store has never traded (no sale entry, no sales day)').toBeNull();
    const p = await position(f);
    expect(p.cashierBalance, 'premise').toBe('-500.00');
    expect(p.floatPosition, 'premise').toBe('0.00');
    const found = await detect(f);
    expect(found).toHaveLength(1);
    expect(squash(found[0]!.detail)).toContain(`${peso(20000)} short.`);
  });

  it('control: the same zero balance at an OPEN store fires (the suppression never applies once open)', async () => {
    const f = await mk('s3-5o');
    await setTarget(f, '20000.00');
    const found = await detect(f);
    expect(found).toHaveLength(1);
    expect(squash(found[0]!.detail)).toContain(`${peso(20000)} short.`);
  });
});

describe('T-S3-7 (A5, ✎S-1) — no `sales_days` figure enters the float, whichever path wrote the day', () => {
  async function pair() {
    // Same spend (ice 500 on the open day), same verified V; only the open day's provenance and figure differ.
    const typed = await mk('s3-7t');
    const feed = await mk('s3-7f');
    await link(feed);
    for (const f of [typed, feed]) {
      await setTarget(f, '20000.00');
      await fund(f, '2026-01-02', '20000.00');
      await day(f, '2026-01-05', 'verified');
      await sale(f, '2026-01-05', '5000.00');
      await spend(f, '2026-01-06', '500.00');
    }
    await day(typed, '2026-01-06', 'open', '8000.00');
    await feedDay(feed, '2026-01-06', '3000.00'); // a different cash figure: it must not matter
    return { typed, feed };
  }

  it('PASSES TODAY (guard): a feed-sourced open day and a typed open day with the same spend give the same floatPosition (20,000)', async () => {
    const { typed, feed } = await pair();
    const a = await position(typed);
    const b = await position(feed);
    expect(a.floatPosition).toBe(b.floatPosition);
    expect(Number(a.floatPosition)).toBeCloseTo(20000, 2);
  });

  it('and the detector is quiet on both (the old detector: "over" on each)', async () => {
    const { typed, feed } = await pair();
    expect(await detect(typed)).toEqual([]);
    expect(await detect(feed)).toEqual([]);
  });
});

describe('T-S3-8 ✎R-2 — the morning case: yesterday’s spend has no sales-day row (M16 `businessDate = upTo`, M17 every day-less date on loan)', () => {
  async function morning(hint: string, linked: boolean) {
    const f = await mk(hint);
    if (linked) await link(f); // linked store, no import yet: still no sales_days row for yesterday
    await setTarget(f, '20000.00');
    await fund(f, '2026-01-02', '20000.00');
    await day(f, '2026-01-04', 'verified'); // the latest verified day: the day before yesterday
    await sale(f, '2026-01-04', '5000.00');
    await spend(f, '2026-01-05', '500.00'); // yesterday: posted, NO sales_days row
    return f;
  }
  async function control(hint: string, linked: boolean) {
    const f = await mk(hint);
    if (linked) await link(f);
    await setTarget(f, '20000.00');
    await fund(f, '2026-01-02', '20000.00');
    await spend(f, '2026-01-05', '500.00'); // day-less date BEFORE the latest verified date
    await day(f, '2026-01-06', 'verified');
    await sale(f, '2026-01-06', '5000.00');
    return f;
  }

  it('typed store: V (01-04) verified 5,000; ₱500 spend on day-less 01-05 after it — NO finding', async () => {
    const f = await morning('s3-8t', false);
    expect(await detect(f), 'yesterday’s spend is on loan until a verified day is recorded after it').toEqual([]);
  });

  it('linked store (no import yet): the same — NO finding', async () => {
    const f = await morning('s3-8l', true);
    expect(await detect(f)).toEqual([]);
  });

  it('control (✎S-5), typed: the same spend on a day-less date BEFORE the latest verified date reads "₱500.00 short"', async () => {
    const f = await control('s3-8ct', false);
    const found = await detect(f);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain(`${peso(500)} short.`);
  });

  it('control, linked: likewise "₱500.00 short"', async () => {
    const f = await control('s3-8cl', true);
    const found = await detect(f);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain(`${peso(500)} short.`);
  });
});

describe('T-S3-9 ✎R-5 — the short and over sentences, word for word (neither says "holds" nor "INTO the float")', () => {
  it('short: lead + "₱500.00 short. Money was paid out of the till and not put back. The office tops it up. ⛔ This is NOT a counted shortage and must not be charged to a cashier."', async () => {
    const c = await shortControl('s3-9s');
    const found = await detect(c);
    expect(found).toHaveLength(1);
    const d = squash(found[0]!.detail);
    expect(d).toBe(`${lead(c, 19500, 20000)} ${peso(500)} short. ${SHORT_TAIL}`);
    expect(d).not.toContain('holds');
    expect(d).not.toContain('INTO the float');
    expect(d).not.toContain('LEDGER');
  });

  it('over: lead + "₱1,000.00 over. Either the office sent more than the target, or an overage was booked (7350) instead of being settled against the day it came from. Send the surplus back to the office by transfer, or correct the overage."', async () => {
    const f = await mk('s3-9o');
    await setTarget(f, '20000.00');
    await fund(f, '2026-01-02', '21000.00');
    await day(f, '2026-01-05', 'verified');
    await sale(f, '2026-01-05', '5000.00');
    const found = await detect(f);
    expect(found).toHaveLength(1);
    const d = squash(found[0]!.detail);
    expect(d).toBe(`${lead(f, 21000, 20000)} ${peso(1000)} over. ${OVER_TAIL}`);
    expect(d).not.toContain('holds');
    expect(d).not.toContain('INTO the float');
    expect(d).not.toContain('LEDGER');
  });
});
