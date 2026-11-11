import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-504 (TESTER) - a sales channel is never blank or zero unless "No sales" is ticked.
 * Spec: docs/tasks/504-no-sales-tick-required.md. Also DEF-628 (a typed amount with "No sales" ticked is refused, not dropped).
 *
 * Sentences (spec rules 1 and 4, word for word, with the channel's NAME):
 *   MISSING = "{Channel}: type the sales, or tick No sales if there were none."
 *   BOTH    = "{Channel}: you typed sales and ticked No sales - choose one."   (an em dash in the real sentence)
 *
 * Pinned readings where the spec is silent (the builder matches; a different reading is a question to the tester):
 *  - the domain receives a blank box as amount '' and a zero as '0' / '0.00'; both with noSales false are MISSING;
 *  - save (create / edit / setPlatformSales) judges the rows it is GIVEN; a channel it is not given is submit's concern;
 *  - submit checks every ACTIVE channel of the store (typed day: all of them, remitted or not; feed day: only the active
 *    NON-remitted ones, the Platform sales section), so a retired channel never blocks, and submit uses the MISSING sentence;
 *  - ITEM 9 (Ian, 1 Nov): SAVE keeps the day open and ALLOWS blanks (a blank writes no row; on an edit it clears the row);
 *    a typed 0 unticked and amount+ticked are still refused at save; the completeness rule bites at SUBMIT;
 *  - a refusal leaves nothing written (create writes no day, edit leaves the old rows, submit leaves the day open).
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createSalesDay, editSalesDay, submitSalesDay, verifySalesDay } from '../../src';
import { importTestDay, linkTestStore, seedTestTenders } from './_fixtures/pos-day';

const sql = postgres(url, { max: 8 });
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
const sentence = (e: unknown): string => String((e as { userMessage?: string }).userMessage ?? (e as Error).message);
async function sentenceOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e) => e);
  expect(err, 'the call must refuse').toBeInstanceOf(Error);
  return sentence(err);
}
const MISSING = (name: string) => `${name}: type the sales, or tick No sales if there were none.`;
/** Ruling 4: submit names EVERY channel still missing, in display (name) order. */
const SUBMIT_MISSING = (...names: string[]) => `Type the sales, or tick No sales, for: ${names.join(', ')}.`;
const BOTH = (name: string) => `${name}: you typed sales and ticked No sales — choose one.`;

const FIG = { totalSales: '1000.00', unliSales: '1000.00', alaCarteSales: '0.00', cashCollected: '1000.00' };
let dayN = 0;
const nextDate = () => `2027-01-${String(10 + (++dayN % 15)).padStart(2, "0")}`;

/**
 * Batangas: UNLINKED (typed days) with Walk-in (remitted), Foodpanda + GrabFood (non-remitted) and a RETIRED "Old Grab".
 * Lipa: LINKED to POS (feed days) with Walk-in, Foodpanda, GrabFood.
 */
async function fixture(hint: string) {
  const code = uid(`t504-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2027-01-01', '2027-01-31', 'open')`;
  const mkStore = async (name: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, ${name}) returning id`)[0]!.id;
  const typedStoreId = await mkStore('Batangas');
  const feedStoreId = await mkStore('Lipa');
  const mkPerson = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of [typedStoreId, feedStoreId]) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const adminId = await mkPerson('Admin', 'admin');
  const managerId = await mkPerson('Manager', 'manager');
  const mkChannel = async (storeId: string, name: string, remitted: boolean, receivable: string | null, active = true) =>
    (await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, is_active)
      values (${orgId}, ${storeId}, ${name}, ${remitted}, ${receivable}, ${active}) returning id`)[0]!.id;
  const t = {
    walkIn: await mkChannel(typedStoreId, 'Walk-in', true, null),
    foodpanda: await mkChannel(typedStoreId, 'Foodpanda', false, '1220'),
    grab: await mkChannel(typedStoreId, 'GrabFood', false, '1220'),
    oldGrab: await mkChannel(typedStoreId, 'Old Grab', false, '1220', false),
  };
  const fd = {
    walkIn: await mkChannel(feedStoreId, 'Walk-in', true, null),
    foodpanda: await mkChannel(feedStoreId, 'Foodpanda', false, '1220'),
    grab: await mkChannel(feedStoreId, 'GrabFood', false, '1220'),
  };
  const [gcash] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${feedStoreId}, 'GCash - Lipa', 'ewallet', '1140', 'cashier') returning id`;
  await linkTestStore(sql, { orgId, storeId: feedStoreId, channelId: fd.walkIn, createdBy: adminId });
  await seedTestTenders(sql, { orgId, storeId: feedStoreId, walletAccountId: gcash!.id });
  const manager: Actor = { personId: managerId, orgId };
  const admin: Actor = { personId: adminId, orgId };
  return { orgId, typedStoreId, feedStoreId, t, fd, manager, admin };
}
type F = Awaited<ReturnType<typeof fixture>>;

type Row = { channelId: string; amount: string; noSales?: boolean };
const create = (f: F, channels: Row[], date = nextDate()) =>
  asOrg(f.orgId, (tx) => createSalesDay(tx, f.manager, { storeId: f.typedStoreId, businessDate: date, ...FIG, channels }));
/** A typed day saved the pre-T-504 way: Walk-in carries the sales, and every OTHER row is written straight into the table. */
async function mkTypedDay(f: F, extra: Array<{ channelId: string; amount: string; noSales: boolean }> = []): Promise<string> {
  const { id } = await create(f, [{ channelId: f.t.walkIn, amount: '1000.00' }]);
  for (const r of extra) {
    await sql`insert into sales_day_channels (sales_day_id, channel_id, amount, no_sales) values (${id}, ${r.channelId}, ${r.amount}, ${r.noSales})`;
  }
  return id;
}
const rowsOf = (dayId: string) =>
  sql<{ channel_id: string; amount: string; no_sales: boolean }[]>`
    select channel_id, amount::text, no_sales from sales_day_channels where sales_day_id = ${dayId} order by channel_id`;
const dayCount = async (f: F, date: string) =>
  Number((await sql<{ n: number }[]>`select count(*)::int as n from sales_days where store_id = ${f.typedStoreId} and business_date = ${date}`)[0]!.n);
/** A feed day also carries POS's own Walk-in row (written by the import); the Platform sales rows are the others. */
const platformRowsOf = async (f: F, dayId: string) => (await rowsOf(dayId)).filter((r) => r.channel_id !== f.fd.walkIn);
const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from sales_days where id = ${id}`)[0]!.status;

const GOOD = (f: F): Row[] => [
  { channelId: f.t.walkIn, amount: '1000.00' },
  { channelId: f.t.foodpanda, amount: '0', noSales: true },
  { channelId: f.t.grab, amount: '0.00', noSales: true },
];

// ---------------------------------------------------------------------------------------------------------------
describe('T-504 create: a channel row is an amount or a tick', () => {
  it('ITEM 9: a blank unticked box is ALLOWED at save: the day is saved open and that channel gets no row', async () => {
    const f = await fixture('cr-blank-ok');
    const { id } = await create(f, [{ channelId: f.t.walkIn, amount: '1000.00' }, { channelId: f.t.foodpanda, amount: '' }, { channelId: f.t.grab, amount: '' }]);
    expect(await statusOf(id)).toBe('open');
    expect((await rowsOf(id)).map((r) => r.channel_id)).toEqual([f.t.walkIn]);
  });

  it('ITEM 9: a draft saved with blanks cannot be submitted until each blank is an amount or a tick (then it can)', async () => {
    const f = await fixture('cr-blank-submit');
    const { id } = await create(f, [{ channelId: f.t.walkIn, amount: '1000.00' }, { channelId: f.t.foodpanda, amount: '' }, { channelId: f.t.grab, amount: '' }]);
    expect(await sentenceOf(asOrg(f.orgId, (tx) => submitSalesDay(tx, f.manager, id)))).toBe(SUBMIT_MISSING('Foodpanda', 'GrabFood'));
    await asOrg(f.orgId, (tx) => editSalesDay(tx, f.manager, { salesDayId: id, ...FIG, channels: GOOD(f) }));
    await asOrg(f.orgId, (tx) => submitSalesDay(tx, f.manager, id));
    expect(await statusOf(id)).toBe('submitted');
  });

  it('ITEM 7: a channel amount typed with a thousands comma ("16,980") saves as 16980.00', async () => {
    const f = await fixture('cr-comma');
    const { id } = await create(f, [{ channelId: f.t.walkIn, amount: '1,000.00' }, { channelId: f.t.foodpanda, amount: '16,980' }, { channelId: f.t.grab, amount: '0', noSales: true }]);
    const rows = await rowsOf(id);
    expect(Number(rows.find((r) => r.channel_id === f.t.foodpanda)!.amount)).toBe(16980);
    expect(rows.every((r) => !r.amount.includes(','))).toBe(true);
  });

  it.each([['0', '0'], ['0.00', '0.00']])('%s with the box unticked is still refused at save, in words, and no day is written', async (_n, amount) => {
    const f = await fixture('cr-miss');
    const date = nextDate();
    const s = await sentenceOf(create(f, [{ channelId: f.t.walkIn, amount: '1000.00' }, { channelId: f.t.foodpanda, amount }], date));
    expect(s).toBe(MISSING('Foodpanda'));
    expect(await dayCount(f, date), 'a refusal writes nothing').toBe(0);
  });

  it('the sentence names the offending channel, not another (GrabFood this time, Foodpanda is fine)', async () => {
    const f = await fixture('cr-name');
    const s = await sentenceOf(create(f, [
      { channelId: f.t.foodpanda, amount: '300.00' },
      { channelId: f.t.grab, amount: '0' },
      { channelId: f.t.walkIn, amount: '700.00' },
    ]));
    expect(s).toBe(MISSING('GrabFood'));
  });

  it('a REMITTED channel is held to the same rule as a non-remitted one (Walk-in 0 unticked refused)', async () => {
    const f = await fixture('cr-remitted');
    expect(await sentenceOf(create(f, [{ channelId: f.t.walkIn, amount: '0.00' }]))).toBe(MISSING('Walk-in'));
  });

  it('ticked + blank saves a no-sales row of 0', async () => {
    const f = await fixture('cr-tick-blank');
    const { id } = await create(f, [
      { channelId: f.t.walkIn, amount: '1000.00' },
      { channelId: f.t.foodpanda, amount: '', noSales: true },
      { channelId: f.t.grab, amount: '', noSales: true },
    ]);
    const rows = await rowsOf(id);
    for (const c of [f.t.foodpanda, f.t.grab]) {
      const r = rows.find((x) => x.channel_id === c)!;
      expect([Number(r.amount), r.no_sales]).toEqual([0, true]);
    }
  });

  it('positive control: ticked + 0 saves a no-sales row of 0', async () => {
    const f = await fixture('cr-tick');
    const { id } = await create(f, GOOD(f));
    const rows = await rowsOf(id);
    const by = (c: string) => rows.find((r) => r.channel_id === c)!;
    expect(Number(by(f.t.foodpanda).amount)).toBe(0);
    expect(by(f.t.foodpanda).no_sales).toBe(true);
    expect(Number(by(f.t.grab).amount)).toBe(0);
    expect(by(f.t.grab).no_sales).toBe(true);
    expect(Number(by(f.t.walkIn).amount)).toBe(1000);
    expect(by(f.t.walkIn).no_sales).toBe(false);
  });

  it('DEF-628: an amount typed AND No sales ticked is refused ("choose one"), never silently zeroed', async () => {
    const f = await fixture('cr-both');
    const date = nextDate();
    const s = await sentenceOf(create(f, [{ channelId: f.t.walkIn, amount: '1000.00' }, { channelId: f.t.foodpanda, amount: '250.00', noSales: true }], date));
    expect(s).toBe(BOTH('Foodpanda'));
    expect(await dayCount(f, date)).toBe(0);
  });

  it('positive control: an amount above zero, unticked, saves', async () => {
    const f = await fixture('cr-amount');
    const { id } = await create(f, [{ channelId: f.t.walkIn, amount: '800.00' }, { channelId: f.t.foodpanda, amount: '200.00' }]);
    expect(Number((await rowsOf(id)).find((r) => r.channel_id === f.t.foodpanda)!.amount)).toBe(200);
  });

  it('positive control: a day created with NO channel rows is not refused at save (submit is where completeness is checked)', async () => {
    const f = await fixture('cr-none');
    const { id } = await asOrg(f.orgId, (tx) => createSalesDay(tx, f.manager, { storeId: f.typedStoreId, businessDate: nextDate(), ...FIG }));
    expect(await statusOf(id)).toBe('open');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('T-504 edit: the same rule, and a refusal leaves the old rows', () => {
  const edit = (f: F, dayId: string, channels: Row[]) =>
    asOrg(f.orgId, (tx) => editSalesDay(tx, f.manager, { salesDayId: dayId, ...FIG, channels }));

  it('ITEM 9: a blank unticked box on an edit is allowed and clears that channel row; the day stays open', async () => {
    const f = await fixture('ed-blank-ok');
    const { id } = await create(f, GOOD(f));
    await edit(f, id, [{ channelId: f.t.walkIn, amount: '1000.00' }, { channelId: f.t.foodpanda, amount: '' }]);
    expect((await rowsOf(id)).map((r) => r.channel_id)).toEqual([f.t.walkIn]);
    expect(await statusOf(id)).toBe('open');
  });

  it('ITEM 7: an edit accepts "1,234.50" and stores 1234.50', async () => {
    const f = await fixture('ed-comma');
    const { id } = await create(f, GOOD(f));
    await edit(f, id, [{ channelId: f.t.walkIn, amount: '1,000' }, { channelId: f.t.foodpanda, amount: '1,234.50' }]);
    expect(Number((await rowsOf(id)).find((r) => r.channel_id === f.t.foodpanda)!.amount)).toBe(1234.5);
  });

  it.each([['0.00', '0.00'], ['0', '0']])('%s unticked is still refused at save and the saved rows stay as they were', async (_n, amount) => {
    const f = await fixture('ed-miss');
    const { id } = await create(f, GOOD(f));
    const before = await rowsOf(id);
    const s = await sentenceOf(edit(f, id, [{ channelId: f.t.walkIn, amount: '1000.00' }, { channelId: f.t.foodpanda, amount }]));
    expect(s).toBe(MISSING('Foodpanda'));
    expect(await rowsOf(id)).toEqual(before);
  });

  it('ticked + blank becomes a no-sales row', async () => {
    const f = await fixture('ed-tick');
    const { id } = await create(f, [{ channelId: f.t.walkIn, amount: '1000.00' }, { channelId: f.t.foodpanda, amount: '50.00' }]);
    await edit(f, id, [{ channelId: f.t.walkIn, amount: '1000.00' }, { channelId: f.t.foodpanda, amount: '', noSales: true }]);
    const fp = (await rowsOf(id)).find((r) => r.channel_id === f.t.foodpanda)!;
    expect(Number(fp.amount)).toBe(0);
    expect(fp.no_sales).toBe(true);
  });

  it('DEF-628: amount + No sales ticked is refused ("choose one")', async () => {
    const f = await fixture('ed-both');
    const { id } = await create(f, GOOD(f));
    expect(await sentenceOf(edit(f, id, [{ channelId: f.t.walkIn, amount: '1000.00' }, { channelId: f.t.foodpanda, amount: '75.00', noSales: true }]))).toBe(BOTH('Foodpanda'));
  });

  it('positive control: an amount above zero saves', async () => {
    const f = await fixture('ed-amount');
    const { id } = await create(f, GOOD(f));
    await edit(f, id, [{ channelId: f.t.walkIn, amount: '900.00' }, { channelId: f.t.foodpanda, amount: '100.00' }]);
    expect(Number((await rowsOf(id)).find((r) => r.channel_id === f.t.foodpanda)!.amount)).toBe(100);
  });

  it('positive control: an edit that sends no channels at all does not trip the rule', async () => {
    const f = await fixture('ed-nochan');
    const { id } = await create(f, GOOD(f));
    await asOrg(f.orgId, (tx) => editSalesDay(tx, f.manager, { salesDayId: id, ...FIG }));
    expect((await rowsOf(id)).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('T-504 submit: every active channel of the store has an amount or a tick (also catches older days)', () => {
  const submit = (f: F, id: string) => asOrg(f.orgId, (tx) => submitSalesDay(tx, f.manager, id));

  it('an older day (or a draft) with NO row for an active channel is refused at submit, naming it, and stays open', async () => {
    const f = await fixture('sub-norow');
    // Walk-in has a row; Foodpanda and GrabFood have none (the pre-T-504 "blank is skipped" shape).
    const id = await mkTypedDay(f);
    const s = await sentenceOf(submit(f, id));
    expect(s).toBe(SUBMIT_MISSING('Foodpanda', 'GrabFood'));
    expect(await statusOf(id)).toBe('open');
  });

  it('an older day with a 0, unticked row is refused (the pre-T-504 "typed 0 is saved" shape)', async () => {
    const f = await fixture('sub-zero');
    const id = await mkTypedDay(f, [
      { channelId: f.t.foodpanda, amount: '0', noSales: false },
      { channelId: f.t.grab, amount: '0', noSales: true },
    ]);
    expect(await sentenceOf(submit(f, id))).toBe(SUBMIT_MISSING('Foodpanda'));
    expect(await statusOf(id)).toBe('open');
  });

  it('a REMITTED channel with no row also blocks (Walk-in missing, others complete)', async () => {
    const f = await fixture('sub-remitted');
    const { id } = await create(f, [{ channelId: f.t.foodpanda, amount: '1000.00' }, { channelId: f.t.grab, amount: '', noSales: true }]);
    expect(await sentenceOf(submit(f, id))).toBe(SUBMIT_MISSING('Walk-in'));
  });

  it('every active channel an amount or a tick: submit goes through (a retired channel with no row never blocks)', async () => {
    const f = await fixture('sub-ok');
    const { id } = await create(f, GOOD(f));
    await submit(f, id);
    expect(await statusOf(id)).toBe('submitted');
  });

  it('a store with no channels configured is not blocked', async () => {
    const f = await fixture('sub-nochan');
    const [bare] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${f.orgId}, ${uid('st')}, 'Bare') returning id`;
    await sql`insert into person_store_scope (person_id, store_id) values (${f.manager.personId}, ${bare!.id})`;
    const { id } = await asOrg(f.orgId, (tx) => createSalesDay(tx, f.manager, { storeId: bare!.id, businessDate: nextDate(), ...FIG }));
    await submit(f, id);
    expect(await statusOf(id)).toBe('submitted');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('T-504 feed day (source pos_v1_day_feed): only the Platform sales section is judged', () => {
  async function feedDay(f: F): Promise<string> {
    const { id } = await asOrg(f.orgId, (tx) => importTestDay(tx, f.manager, { storeId: f.feedStoreId, businessDate: nextDate() }));
    return id;
  }
  const platform = (f: F, dayId: string, rows: Row[]) =>
    asOrg(f.orgId, (tx) => editSalesDay(tx, f.manager, { salesDayId: dayId, platform: rows.map((r) => ({ channelId: r.channelId, amount: r.amount, noSales: r.noSales ?? false })) }));
  const submit = (f: F, id: string) => asOrg(f.orgId, (tx) => submitSalesDay(tx, f.manager, id));

  it('ITEM 9: setPlatformSales: a blank unticked box is allowed and writes NO row (was: a zero row)', async () => {
    const f = await fixture('pl-blank-ok');
    const id = await feedDay(f);
    await platform(f, id, [{ channelId: f.fd.foodpanda, amount: '' }, { channelId: f.fd.grab, amount: '60.00' }]);
    const rows = await rowsOf(id);
    expect(rows.some((r) => r.channel_id === f.fd.foodpanda)).toBe(false);
    expect(rows.some((r) => r.channel_id === f.fd.grab)).toBe(true);
  });

  it('ITEM 7: setPlatformSales accepts "1,500.50"', async () => {
    const f = await fixture('pl-comma');
    const id = await feedDay(f);
    await platform(f, id, [{ channelId: f.fd.foodpanda, amount: '1,500.50' }]);
    expect(Number((await rowsOf(id)).find((r) => r.channel_id === f.fd.foodpanda)!.amount)).toBe(1500.5);
  });

  it.each([['0', '0'], ['0.00', '0.00']])('setPlatformSales: %s unticked is still refused in words (was: written as a zero row)', async (_n, amount) => {
    const f = await fixture('pl-miss');
    const id = await feedDay(f);
    expect(await sentenceOf(platform(f, id, [{ channelId: f.fd.foodpanda, amount }]))).toBe(MISSING('Foodpanda'));
    expect((await platformRowsOf(f, id)).length, 'a refusal writes nothing').toBe(0);
  });

  it('setPlatformSales: ticked + blank writes a no-sales row of 0; an amount above zero saves', async () => {
    const f = await fixture('pl-ok');
    const id = await feedDay(f);
    await platform(f, id, [{ channelId: f.fd.foodpanda, amount: '', noSales: true }, { channelId: f.fd.grab, amount: '120.50' }]);
    const rows = await rowsOf(id);
    const fp = rows.find((r) => r.channel_id === f.fd.foodpanda)!;
    expect([Number(fp.amount), fp.no_sales]).toEqual([0, true]);
    expect(Number(rows.find((r) => r.channel_id === f.fd.grab)!.amount)).toBeCloseTo(120.5);
  });

  it('DEF-628 (platform.ts:77): an amount typed with No sales ticked is refused ("choose one"), not read as zero', async () => {
    const f = await fixture('pl-both');
    const id = await feedDay(f);
    expect(await sentenceOf(platform(f, id, [{ channelId: f.fd.foodpanda, amount: '500.00', noSales: true }]))).toBe(BOTH('Foodpanda'));
    expect((await platformRowsOf(f, id)).length).toBe(0);
  });

  it('submit refuses a feed day whose Platform sales channels are missing (naming one), and stays open', async () => {
    const f = await fixture('pl-submit-miss');
    const id = await feedDay(f);
    const s = await sentenceOf(submit(f, id));
    expect(s).toBe(SUBMIT_MISSING('Foodpanda', 'GrabFood'));
    expect(await statusOf(id)).toBe('open');
  });

  it('ONE SAVE (ruling 3): editSalesDay carries the platform rows, in one call, on a feed day', async () => {
    const f = await fixture('pl-one-save');
    const id = await feedDay(f);
    await asOrg(f.orgId, (tx) => editSalesDay(tx, f.manager, { salesDayId: id, platform: [{ channelId: f.fd.foodpanda, amount: '', noSales: true }, { channelId: f.fd.grab, amount: '1,200', noSales: false }] }));
    const rows = await rowsOf(id);
    expect([Number(rows.find((r) => r.channel_id === f.fd.grab)!.amount), rows.find((r) => r.channel_id === f.fd.foodpanda)!.no_sales]).toEqual([1200, true]);
    await submit(f, id);
    expect(await statusOf(id)).toBe('submitted');
  });

  it('ATOMICITY (ruling 3): one refused platform row rolls back the valid row beside it - nothing is written', async () => {
    const f = await fixture('pl-atomic');
    const id = await feedDay(f);
    const s = await sentenceOf(asOrg(f.orgId, (tx) => editSalesDay(tx, f.manager, { salesDayId: id, platform: [{ channelId: f.fd.foodpanda, amount: '300.00', noSales: false }, { channelId: f.fd.grab, amount: '0', noSales: false }] })));
    expect(s).toBe(MISSING('GrabFood'));
    expect((await platformRowsOf(f, id)).length).toBe(0);
  });

  it('ATOMICITY (ruling 3): on a typed day, platform rows are refused and the typed channel rows in the same call stay as they were', async () => {
    const f = await fixture('pl-atomic-typed');
    const { id } = await create(f, GOOD(f));
    const before = await rowsOf(id);
    const err = await asOrg(f.orgId, (tx) => editSalesDay(tx, f.manager, {
      salesDayId: id, ...FIG,
      channels: [{ channelId: f.t.walkIn, amount: '900.00' }, { channelId: f.t.foodpanda, amount: '100.00' }],
      platform: [{ channelId: f.t.foodpanda, amount: '5', noSales: false }],
    })).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(await rowsOf(id)).toEqual(before);
  });

  it('submit: POS-fed channels (Walk-in) are NOT checked - with Platform sales complete and Walk-in at 0 unticked, it goes through', async () => {
    const f = await fixture('pl-submit-ok');
    const id = await feedDay(f);
    await platform(f, id, [{ channelId: f.fd.foodpanda, amount: '', noSales: true }, { channelId: f.fd.grab, amount: '90.00' }]);
    // The imported day carries POS's own Walk-in row; make it the shape the rule would refuse if it were typed (0, unticked).
    // The row trigger only lets the derivation write a feed day's channel rows, so the flag the import itself sets is set here.
    await sql.begin(async (tx) => {
      await tx`select set_config('app.sales_day_derivation', 'on', true)`;
      await tx`update sales_day_channels set amount = 0, no_sales = false where sales_day_id = ${id} and channel_id = ${f.fd.walkIn}`;
    });
    await submit(f, id);
    expect(await statusOf(id)).toBe('submitted');
  });
});

describe('T-504 verify: a verifier who blanks a channel on a submitted day cannot post it', () => {
  it('blank Grab by edit, then verify -> refused naming Grab; tick No sales, then verify works', async () => {
    const f = await fixture('ver-blank');
    const { id } = await create(f, GOOD(f));
    await asOrg(f.orgId, (tx) => submitSalesDay(tx, f.manager, id));
    await asOrg(f.orgId, (tx) =>
      editSalesDayAsAdmin(tx, f, id, [{ channelId: f.t.walkIn, amount: '1000.00' }, { channelId: f.t.foodpanda, amount: '0', noSales: true }, { channelId: f.t.grab, amount: '' }]),
    );
    expect(await sentenceOf(asOrg(f.orgId, (tx) => verifySalesDay(tx, f.admin, id)))).toBe(SUBMIT_MISSING('GrabFood'));
    expect(await statusOf(id)).toBe('submitted');
    await asOrg(f.orgId, (tx) =>
      editSalesDayAsAdmin(tx, f, id, [{ channelId: f.t.walkIn, amount: '1000.00' }, { channelId: f.t.foodpanda, amount: '0', noSales: true }, { channelId: f.t.grab, amount: '0', noSales: true }]),
    );
    await asOrg(f.orgId, (tx) => verifySalesDay(tx, f.admin, id));
    expect(await statusOf(id)).toBe('verified');
  });
});
function editSalesDayAsAdmin(tx: Tx, f: F, dayId: string, channels: Row[]) {
  return editSalesDay(tx, f.admin, { salesDayId: dayId, ...FIG, channels });
}
