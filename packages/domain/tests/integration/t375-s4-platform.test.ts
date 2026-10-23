import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-375 S4 - platform sales, the one removable seam (R8), and the reports that must keep reconciling (R14).
 * `docs/tasks/375-pos-v1-day-feed.md` S4 tests P1-P6 (+ P1b, P4b, WS).
 *
 * TESTER, not BUILDER. Every red leg asserts the TARGET (the spec's sentences word for word, exact peso figures and
 * account codes). Every refusal has a positive control.
 *
 * ## Why these are red on HEAD
 * `sales-days/platform.ts` does not exist. It is loaded DYNAMICALLY (`platformApi()`), so a leg that calls
 * `setPlatformSales` fails with "Failed to resolve import ../../src/sales-days/platform": a missing module is the
 * honest red for a new file (and the only missing-module red in this file). The legs that run against code that
 * EXISTS are red on the assertion:
 *  - P1b: a Foodpanda row on an open feed day (raw insert, no setPlatformSales) -> verify REFUSES today ("can't be
 *    posted": the day total omits the platform sales); the target is that `routeInputForDay` adds them (compose.ts).
 *  - P6: the same, through the rollup.
 *  - WS: the withdraw sentence still carries the old dash text.
 * P5 (a typed day on an unlinked store verifies with exactly today's lines) PASSES today: it is the guard a mutant
 * that composes platform sales on legacy days must turn red.
 *
 * ## How the target is read where the spec is silent (a question to the builder, not a test edit)
 *  - `setPlatformSales(tx, actor, { salesDayId, rows: { channelId, amount, noSales }[] })` throws a RefusalError with
 *    `userMessage` on every refusal; `amount` is passed as `money('500.00')`; it is audited `set_platform_sales` with
 *    `entity_id` = the day id;
 *  - `{channel}` in the remitted-channel sentence is the channel's name ("Walk-in");
 *  - authorize() comes first (I1): a plain staff member gets an AuthorizationError on a verified day, not the status
 *    sentence;
 *  - the withdraw sentence for a wastage-blocked day is "Wastage is recorded against this day, so it can't be
 *    withdrawn." + " Re-import it from POS instead." (feed day) or + " Edit its figures instead." (typed day, store
 *    unlinked), the spec's wording joined with one space.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, channelSettlementsRepo, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { money } from '@shareat/core/money';
import { submitSalesDay, verifySalesDay, voidSalesDay } from '../../src/sales-days/verify';
import { getSalesRollup } from '../../src/reports/sales-rollup';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { importTestDay, linkTestStore, seedTestTenders } from './_fixtures/pos-day';
import { mkSubmitter } from './_fixtures/sales-day-flow';

const sql = postgres(url, { max: 12 });
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
const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });
const sentence = (e: unknown): string => String((e as { userMessage?: string }).userMessage ?? (e as Error).message);
async function sentenceOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e) => e);
  expect(err, 'the call must refuse').toBeInstanceOf(Error);
  return sentence(err);
}

interface PlatformApi {
  setPlatformSales: (
    tx: Tx,
    actor: Actor,
    input: { salesDayId: string; rows: { channelId: string; amount: unknown; noSales: boolean }[] },
  ) => Promise<unknown>;
}
const platformApi = async () => (await import('../../src/sales-days/platform')) as unknown as PlatformApi;
const setPlatform = async (f: F, who: Actor, dayId: string, rows: { channelId: string; amount: string; noSales?: boolean }[]) => {
  const { setPlatformSales } = await platformApi();
  return asOrg(f.orgId, (tx) =>
    setPlatformSales(tx, who, { salesDayId: dayId, rows: rows.map((r) => ({ channelId: r.channelId, amount: money(r.amount), noSales: r.noSales ?? false })) }),
  );
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const D10 = '2027-01-10';
const D11 = '2027-01-11';

/** Lipa: LINKED, Cash + GCash tenders, Walk-in (remitted) + Foodpanda (non-remitted, 1220). Batangas: NEVER linked, same channels. */
async function fixture(hint: string) {
  const code = uid(`t375s4p-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2027-01-01', '2027-01-31', 'open')`;
  const mkStore = async (name: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, ${name}) returning id`)[0]!.id;
  const storeId = await mkStore('Lipa');
  const store2Id = await mkStore('Batangas');
  const mkPerson = async (name: string, role: string, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const adminId = await mkPerson('Admin', 'admin', [storeId, store2Id]);
  const managerId = await mkPerson('Manager', 'manager', [storeId]);
  const staffId = await mkPerson('Staff', 'staff', [storeId]);
  const plainStaffId = await mkPerson('Plain Staff', 'staff', [storeId]);
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: emp!.id, personId: staffId, setBy: managerId });

  const mkChannel = async (sid: string, name: string, remitted: boolean, receivable: string | null) =>
    (await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
      values (${orgId}, ${sid}, ${name}, ${remitted}, ${receivable}) returning id`)[0]!.id;
  const walkInId = await mkChannel(storeId, 'Walk-in', true, null);
  const foodpandaId = await mkChannel(storeId, 'Foodpanda', false, '1220');
  const walkIn2Id = await mkChannel(store2Id, 'Walk-in', true, null);
  const foodpanda2Id = await mkChannel(store2Id, 'Foodpanda', false, '1220');

  const [gcash] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeId}, 'GCash - Lipa', 'ewallet', '1140', 'cashier') returning id`;
  await linkTestStore(sql, { orgId, storeId, channelId: walkInId, createdBy: adminId });
  await seedTestTenders(sql, { orgId, storeId, walletAccountId: gcash!.id });

  return {
    orgId, storeId, store2Id, walkInId, foodpandaId, walkIn2Id, foodpanda2Id, gcashAcct: gcash!.id,
    admin: actorOf(orgId, adminId), manager: actorOf(orgId, managerId), staff: actorOf(orgId, staffId), plainStaff: actorOf(orgId, plainStaffId),
    adminId, managerId, staffId,
  };
}
type F = Awaited<ReturnType<typeof fixture>>;

const imp = (f: F, who: Actor, date: string) => asOrg(f.orgId, (tx) => importTestDay(tx, who, { storeId: f.storeId, businessDate: date }));
const submit = (f: F, who: Actor, id: string) => asOrg(f.orgId, (tx) => submitSalesDay(tx, who, id));
const verify = (f: F, who: Actor, id: string) => asOrg(f.orgId, (tx) => verifySalesDay(tx, who, id));
const channelRows = (dayId: string) => sql<{ channel_id: string; amount: string; no_sales: boolean }[]>`
  select channel_id, amount, no_sales from sales_day_channels where sales_day_id = ${dayId} order by amount desc, channel_id`;
const linesFor = (entryId: string) => sql<{ code: string; debit: string; credit: string; party_type: string | null; party_id: string | null }[]>`
  select a.code, jl.debit, jl.credit, jl.party_type, jl.party_id from journal_lines jl join accounts a on a.id = jl.account_id
   where jl.entry_id = ${entryId} order by jl.line_no`;
const lineText = (rows: { code: string; debit: string; credit: string }[]) =>
  rows.map((l) => (Number(l.debit) > 0 ? `Dr ${l.code} ${l.debit}` : `Cr ${l.code} ${l.credit}`)).sort();

/** D1 plus Foodpanda 500.00: D1's lines, Dr 1220 500 (party Foodpanda), Cr 4150 1,000 (500 + 500). */
const P1_LINES = ['Cr 4100 600.00', 'Cr 4150 1000.00', 'Cr 4500 50.00', 'Dr 1110 700.00', 'Dr 1140 350.00', 'Dr 1220 500.00', 'Dr 4900 100.00'].sort();

describe('P1 - platform sales on a feed day: typed through setPlatformSales, posted at verify', () => {
  it('D1 + Foodpanda 500.00: the row is written and audited; the day\'s own figures are untouched; verify posts D1 plus Dr 1220 500 (party Foodpanda) and Cr 4150 1,000; balanced; the T-150 queue lists Foodpanda 500.00', async () => {
    const f = await fixture('p1');
    const { id } = await imp(f, f.staff, D10);
    await setPlatform(f, f.staff, id, [{ channelId: f.foodpandaId, amount: '500.00' }]);

    expect(await channelRows(id), 'Walk-in from the import, Foodpanda typed').toEqual([
      { channel_id: f.walkInId, amount: '1100.00', no_sales: false },
      { channel_id: f.foodpandaId, amount: '500.00', no_sales: false },
    ].sort((a, b) => Number(b.amount) - Number(a.amount)));
    const [day] = await sql<{ total_sales: string; unli_sales: string; ala_carte_sales: string }[]>`
      select total_sales, unli_sales, ala_carte_sales from sales_days where id = ${id}`;
    expect(day, 'platform sales are composed at verify, never written into the day\'s figures').toEqual({ total_sales: '1100.00', unli_sales: '600.00', ala_carte_sales: '500.00' });
    const audit = await sql<{ action: string }[]>`select action from audit_log where entity_id = ${id} and action = 'set_platform_sales'`;
    expect(audit, 'audited set_platform_sales').toHaveLength(1);

    await submit(f, f.staff, id);
    const { journalEntryId } = await verify(f, f.manager, id);
    const lines = await linesFor(journalEntryId);
    expect(lineText(lines)).toEqual(P1_LINES);
    const debits = lines.reduce((a, l) => a + Number(l.debit), 0);
    const credits = lines.reduce((a, l) => a + Number(l.credit), 0);
    expect({ debits, credits }, 'balances').toEqual({ debits: 1650, credits: 1650 });
    const receivable = lines.find((l) => l.code === '1220')!;
    expect({ type: receivable.party_type, id: receivable.party_id }, 'the receivable names Foodpanda').toEqual({ type: 'channel', id: f.foodpandaId });

    const queue = await asOrg(f.orgId, (tx) => channelSettlementsRepo.listSettleableChannelDays(tx, f.orgId, {}));
    const row = queue.find((r) => r.salesDayId === id && r.channelId === f.foodpandaId);
    expect(row?.reportedAmount, 'T-150 lists Foodpanda 500.00').toBe('500.00');
  });

  it('P1b (compose, isolated from platform.ts): a Foodpanda row on an open feed day, written by raw SQL, posts the same lines at verify', async () => {
    const f = await fixture('p1b');
    const { id } = await imp(f, f.staff, D10);
    await sql`insert into sales_day_channels (sales_day_id, channel_id, amount) values (${id}, ${f.foodpandaId}, '500.00')`;
    await submit(f, f.staff, id);
    const { journalEntryId } = await verify(f, f.manager, id);
    expect(lineText(await linesFor(journalEntryId))).toEqual(P1_LINES);
  });

  it('control: no platform row at all -> verify posts exactly D1\'s lines (no 1220, Cr 4150 stays 500)', async () => {
    const f = await fixture('p1c');
    const { id } = await imp(f, f.staff, D10);
    await submit(f, f.staff, id);
    const { journalEntryId } = await verify(f, f.manager, id);
    expect(lineText(await linesFor(journalEntryId))).toEqual(
      ['Cr 4100 600.00', 'Cr 4150 500.00', 'Cr 4500 50.00', 'Dr 1110 700.00', 'Dr 1140 350.00', 'Dr 4900 100.00'].sort(),
    );
  });
});

describe('P2 - a REMITTED channel is not typed here', () => {
  it('Walk-in via setPlatformSales -> "Walk-in is paid at the till, so its sales come from POS, not from here."; nothing written', async () => {
    const f = await fixture('p2');
    const { id } = await imp(f, f.staff, D10);
    const before = await channelRows(id);
    const s = await sentenceOf(setPlatform(f, f.staff, id, [{ channelId: f.walkInId, amount: '700.00' }]));
    expect(s).toBe("Walk-in is paid at the till, so its sales come from POS, not from here.");
    expect(await channelRows(id), 'nothing written').toEqual(before);
    expect(await sql`select 1 from audit_log where entity_id = ${id} and action = 'set_platform_sales'`, 'nothing audited').toHaveLength(0);
  });

  it('control: the same call for the non-remitted Foodpanda succeeds', async () => {
    const f = await fixture('p2c');
    const { id } = await imp(f, f.staff, D10);
    await expect(setPlatform(f, f.staff, id, [{ channelId: f.foodpandaId, amount: '700.00' }])).resolves.toBeDefined();
    expect((await channelRows(id)).map((r) => r.amount)).toContain('700.00');
  });
});

describe('P3 - a day that is verified or withdrawn takes no platform sales', () => {
  it('verified -> "Platform sales can only be changed before the day is verified."; withdrawn (voided) -> the same; rows unchanged', async () => {
    const f = await fixture('p3');
    const { id } = await imp(f, f.staff, D10);
    await submit(f, f.staff, id);
    await verify(f, f.manager, id);
    const before = await channelRows(id);
    expect(await sentenceOf(setPlatform(f, f.manager, id, [{ channelId: f.foodpandaId, amount: '500.00' }]))).toBe(
      'Platform sales can only be changed before the day is verified.',
    );
    expect(await channelRows(id)).toEqual(before);

    const { id: id2 } = await imp(f, f.staff, D11);
    await asOrg(f.orgId, (tx) => voidSalesDay(tx, f.manager, id2, 'imported by mistake'));
    expect(await sentenceOf(setPlatform(f, f.manager, id2, [{ channelId: f.foodpandaId, amount: '500.00' }]))).toBe(
      'Platform sales can only be changed before the day is verified.',
    );
  });

  it('control: an OPEN day and a SUBMITTED day (by the verifier) both take platform sales', async () => {
    const f = await fixture('p3c');
    const { id } = await imp(f, f.staff, D10);
    await setPlatform(f, f.staff, id, [{ channelId: f.foodpandaId, amount: '100.00' }]);
    await submit(f, f.staff, id);
    await setPlatform(f, f.manager, id, [{ channelId: f.foodpandaId, amount: '200.00' }]);
    expect((await channelRows(id)).map((r) => r.amount)).toContain('200.00');
  });
});

describe('P4 - who may set platform sales (as editSalesDay: submit_sales_day open, verify_sales_day submitted)', () => {
  it('staff WITHOUT submit_sales_day is refused (AuthorizationError) on an open day, nothing written; control: staff with it succeeds', async () => {
    const f = await fixture('p4');
    const { id } = await imp(f, f.staff, D10);
    const before = await channelRows(id);
    const err = await setPlatform(f, f.plainStaff, id, [{ channelId: f.foodpandaId, amount: '500.00' }]).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AuthorizationError);
    expect(await channelRows(id)).toEqual(before);
    await expect(setPlatform(f, f.staff, id, [{ channelId: f.foodpandaId, amount: '500.00' }])).resolves.toBeDefined();
  });

  it('a SUBMITTED day needs verify_sales_day: staff is refused (AuthorizationError), the manager succeeds', async () => {
    const f = await fixture('p4b');
    const { id } = await imp(f, f.staff, D10);
    await submit(f, f.staff, id);
    const err = await setPlatform(f, f.staff, id, [{ channelId: f.foodpandaId, amount: '500.00' }]).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AuthorizationError);
    await expect(setPlatform(f, f.manager, id, [{ channelId: f.foodpandaId, amount: '500.00' }])).resolves.toBeDefined();
  });

  it('authorize() comes before parsing: an UNAUTHORIZED actor sending amount "abc" gets the AuthorizationError, not the amount sentence; control: an authorized actor with "abc" gets the amount sentence', async () => {
    const f = await fixture('p4d');
    const { id } = await imp(f, f.staff, D10);
    const { setPlatformSales } = await platformApi();
    const send = (who: Actor) =>
      asOrg(f.orgId, (tx) => setPlatformSales(tx, who, { salesDayId: id, rows: [{ channelId: f.foodpandaId, amount: 'abc', noSales: false }] }));
    const err = await send(f.plainStaff).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AuthorizationError);
    const s = await sentenceOf(send(f.staff));
    expect(s, 'the amount sentence names the channel').toContain('Foodpanda');
    expect(s).not.toMatch(UUID);
    expect(await channelRows(id), 'nothing written by either').toHaveLength(1);
  });

  it('authorize() comes first: a plain staff member on a VERIFIED day gets the AuthorizationError, not the status sentence', async () => {
    const f = await fixture('p4c');
    const { id } = await imp(f, f.staff, D10);
    await submit(f, f.staff, id);
    await verify(f, f.manager, id);
    const err = await setPlatform(f, f.plainStaff, id, [{ channelId: f.foodpandaId, amount: '500.00' }]).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AuthorizationError);
  });
});

describe('P5 - a typed day of an UNLINKED store verifies with exactly today\'s lines (composition is for feed days only)', () => {
  it('Batangas: total 1,000 (unli 600, a la carte 400), cash 500, Walk-in 500 + Foodpanda 500 typed -> Dr 1110 500, Dr 1220 500, Cr 4100 600, Cr 4150 400', async () => {
    const f = await fixture('p5');
    const [d] = await sql<{ id: string; source: string }[]>`
      insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, cash_collected, created_by)
      values (${f.orgId}, ${f.store2Id}, ${D10}, 1000, 600, 400, 500, ${f.adminId}) returning id, source`;
    expect(d!.source).toBe('legacy_typed');
    await sql`insert into sales_day_channels (sales_day_id, channel_id, amount) values (${d!.id}, ${f.walkIn2Id}, 500), (${d!.id}, ${f.foodpanda2Id}, 500)`;
    await submit(f, await mkSubmitter(sql, f.orgId, [f.store2Id]), d!.id); // T-385 S3: the submitter is not the verifier
    const { journalEntryId } = await verify(f, f.admin, d!.id);
    expect(lineText(await linesFor(journalEntryId))).toEqual(['Cr 4100 600.00', 'Cr 4150 400.00', 'Dr 1110 500.00', 'Dr 1220 500.00'].sort());
  });
});

describe('P6 - the sales report still reconciles on a platform day (R14)', () => {
  it('P1\'s verified day: getSalesRollup for that date reconciles; a la carte includes the 500; unli 600; channels carry Walk-in 1,100 and Foodpanda 500', async () => {
    const f = await fixture('p6');
    const { id } = await imp(f, f.staff, D10);
    await sql`insert into sales_day_channels (sales_day_id, channel_id, amount) values (${id}, ${f.foodpandaId}, '500.00')`;
    await submit(f, f.staff, id);
    await verify(f, f.manager, id);
    const r = await asOrg(f.orgId, (tx) =>
      getSalesRollup(tx, { orgId: f.orgId, storeId: f.storeId, fromDate: D10, toDate: D10, groupBy: 'day' }),
    );
    expect({
      reconciles: r.reconciles,
      ledger: String(r.ledgerTotal),
      channel: String(r.channelTotal),
      mode: String(r.modeTotal),
    }).toEqual({ reconciles: true, ledger: '1600.00', channel: '1600.00', mode: '1600.00' });
    const mode = Object.fromEntries(r.modes.map((m) => [m.mode, String(m.total)]));
    expect(mode).toEqual({ unli: '600.00', ala_carte: '1000.00' });
  });
});

describe('WS (V13) - the withdraw refusal when wastage hangs off the day names the way out that is true for that day', () => {
  const addWastage = (f: F, storeId: string, dayId: string, channelId: string, by: string) =>
    sql`insert into order_wastages (org_id, store_id, sales_day_id, channel, channel_id, type_mode, amount, reason, created_by)
        values (${f.orgId}, ${storeId}, ${dayId}, 'Foodpanda', ${channelId}, 'instant', '50.00', 'spoiled in transit', ${by})`;

  it('a FEED day: "Wastage is recorded against this day, so it can\'t be withdrawn. Re-import it from POS instead."', async () => {
    const f = await fixture('ws1');
    const { id } = await imp(f, f.staff, D10);
    await addWastage(f, f.storeId, id, f.foodpandaId, f.managerId);
    const s = await sentenceOf(asOrg(f.orgId, (tx) => voidSalesDay(tx, f.manager, id, 'wrong day')));
    expect(s).toBe("Wastage is recorded against this day, so it can't be withdrawn. Re-import it from POS instead.");
  });

  it('a TYPED day of an unlinked store: "... withdrawn. Edit its figures instead."', async () => {
    const f = await fixture('ws2');
    const [d] = await sql<{ id: string }[]>`
      insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
      values (${f.orgId}, ${f.store2Id}, ${D10}, 1000, 600, 400, ${f.adminId}) returning id`;
    await addWastage(f, f.store2Id, d!.id, f.foodpanda2Id, f.adminId);
    const s = await sentenceOf(asOrg(f.orgId, (tx) => voidSalesDay(tx, f.admin, d!.id, 'wrong day')));
    expect(s).toBe("Wastage is recorded against this day, so it can't be withdrawn. Edit its figures instead.");
  });
});

describe('P7 - R14: POS corrections enter the report as ONE synthetic channel line and the two modes, and the report still reconciles', () => {
  /** A correction row plus its posted `sale` entry (source_id = the correction's id), raw SQL. delta > 0 credits 4150. */
  async function correct(f: F, dayId: string, delta: string) {
    const abs = delta.replace('-', '');
    const positive = !delta.startsWith('-');
    const correctionId = crypto.randomUUID();
    const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
    const [feed] = await sql<{ id: string; pos_v1_day_feed_id: string }[]>`select id, pos_v1_day_feed_id from sales_days where id = ${dayId}`;
    const [to] = await sql<{ id: string }[]>`
      insert into pos_v1_day_feeds (org_id, store_id, business_date, kind, purpose, batch_id, pos_store_id, body, payload, content_hash, fetched_at, fetched_by)
      values (${f.orgId}, ${f.storeId}, ${D10}, 'sales', 'recheck', ${crypto.randomUUID()}, 'pos-x', '{"found":true}', '{"found":true}'::jsonb, ${uid('h').replace(/[^0-9a-f]/g, '0').padEnd(64, '0').slice(0, 64)}, now(), ${f.adminId})
      returning id`;
    const entryId = await sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
        values (${f.orgId}, ${D10}, ${period!.id}, 'sale', ${correctionId}, 'draft') returning id`;
      const [cash] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1110'`;
      const [ala] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '4150'`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${cash!.id}, ${f.storeId}, ${positive ? abs : '0'}, ${positive ? '0' : abs})`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${ala!.id}, ${f.storeId}, ${positive ? '0' : abs}, ${positive ? abs : '0'})`;
      await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
      return e!.id;
    });
    await sql`
      insert into sales_day_pos_corrections (id, org_id, store_id, sales_day_id, from_feed_id, to_feed_id, entry_date, journal_entry_id, reason, posted_by)
      values (${correctionId}, ${f.orgId}, ${f.storeId}, ${dayId}, ${feed!.pos_v1_day_feed_id}, ${to!.id}, ${D10}, ${entryId}, 'POS changed', ${f.adminId})`;
  }
  const rollup = (f: F) => asOrg(f.orgId, (tx) => getSalesRollup(tx, { orgId: f.orgId, storeId: f.storeId, fromDate: D10, toDate: D10, groupBy: 'day' }));
  const corrLine = (r: Awaited<ReturnType<typeof rollup>>) => r.channels.filter((c) => c.channelName === 'POS corrections');

  it('control: no correction -> no "POS corrections" line; the report reconciles at 1,100', async () => {
    const f = await fixture('p7c');
    const { id } = await imp(f, f.staff, D10);
    await submit(f, f.staff, id);
    await verify(f, f.manager, id);
    const r = await rollup(f);
    expect(corrLine(r)).toHaveLength(0);
    expect({ reconciles: r.reconciles, ledger: String(r.ledgerTotal) }).toEqual({ reconciles: true, ledger: '1100.00' });
  });

  it('a +100.00 correction (Cr 4150) and a -30.00 one (Dr 4150): one line, null channel id, +70.00; a la carte 570.00, unli 600.00; ledger = channels = modes = 1,170.00', async () => {
    const f = await fixture('p7');
    const { id } = await imp(f, f.staff, D10);
    await submit(f, f.staff, id);
    await verify(f, f.manager, id);
    await correct(f, id, '100.00');
    await correct(f, id, '-30.00');
    const r = await rollup(f);
    const line = corrLine(r);
    expect(line, 'exactly one synthetic line').toHaveLength(1);
    expect({ channelId: line[0]!.channelId, total: String(line[0]!.total) }).toEqual({ channelId: null, total: '70.00' });
    expect(Object.fromEntries(r.modes.map((m) => [m.mode, String(m.total)]))).toEqual({ unli: '600.00', ala_carte: '570.00' });
    expect({ reconciles: r.reconciles, ledger: String(r.ledgerTotal), channels: String(r.channelTotal), modes: String(r.modeTotal) }).toEqual({
      reconciles: true, ledger: '1170.00', channels: '1170.00', modes: '1170.00',
    });
  });
});
