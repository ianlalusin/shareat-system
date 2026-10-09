import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-375 S3 - `importSalesDay`, the typed path gated by the link, the create-block moved. `docs/tasks/
 * 375-pos-v1-day-feed.md` S3 tests I1-I12 (+ I1b, I4b, I4c, L5 REVERSE, moved here from S1).
 *
 * TESTER, not BUILDER. Every red leg asserts the TARGET (the spec's sentences word for word, exact peso figures and
 * account codes). Every refusal has a positive control in the same test or the next one.
 *
 * ## Why these are red on HEAD
 * `sales-days/import.ts` does not exist. `importTestDay` (the `_fixtures/pos-day.ts` helper) loads it DYNAMICALLY, so a
 * leg that imports fails with "Failed to resolve import ../../../src/sales-days/import" - a missing module is the
 * honest red for a new file. The legs that run against code that EXISTS are red on the assertion: I10 / L5 REVERSE
 * (`createSalesDay` / `editSalesDay` on a linked store still type the day).
 *
 * ## How the target is read where the spec is silent (a question to the builder, not a test edit)
 *  - `importSalesDay(tx, actor, { storeId, businessDate }, fetchers?)` -> `{ id }`; every refusal THROWS (a
 *    RefusalError with `userMessage`); `ImportFetchers = { sales; soldItems }`, each a `PosV1DayFetcher`
 *    (called with `{ posStoreId, businessDate, kind }`), the second argument the helper builds from `stubFetchers`;
 *  - dates inside sentences are `humanDate(date)` (I8); the store is named by its row name ("Lipa");
 *  - audit: a row with `action = 'reimport_sales_day'` and `entity_id` = the day id; both feed ids appear somewhere in
 *    its `before` / `after` JSON (the spec says "both feed ids" and no key);
 *  - I12's sentence is not given: asserted as a refusal that names the wallet ("GCash") and leaks no id.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { parseBusinessDate } from '@shareat/core/datetime';
import { createSalesDay } from '../../src/sales-days/create';
import { mkSubmitter, submitThenVerify } from './_fixtures/sales-day-flow';
import { editSalesDay } from '../../src/sales-days/edit';
import { submitSalesDay, verifySalesDay, voidSalesDay } from '../../src/sales-days/verify';
import { SalesDayBlockedError } from '../../src/sales-days/create';
import { PosNotConfiguredError, PosUnreachableError } from '../../src/pos/v1-feed';
import { humanDate as humanDateOf } from '../../src/shared/refusal-leaf';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { D1_FIGURES, D2B_FIGURES, importTestDay, linkTestStore, seedTestTenders, sha256, stubFetchers } from './_fixtures/pos-day';

const hd = (d: string) => humanDateOf(parseBusinessDate(d));
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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
const chain = (e: unknown): string => {
  const parts: string[] = [];
  for (let x: unknown = e, i = 0; x && i < 5; i++, x = (x as { cause?: unknown }).cause) {
    parts.push(String((x as Error).message ?? x), String((x as { code?: string }).code ?? ''));
  }
  return parts.join(' | ');
};

const D10 = '2027-01-10';
const D11 = '2027-01-11';

interface FixtureOpts {
  link?: boolean;
  tenders?: boolean;
  taxType?: 'vat_inclusive' | 'vat_exclusive' | 'non_vat';
}

/**
 * One org: Lipa (LINKED to POS by default, Cash and GCash tenders) and Batangas (never linked). Admin (both stores),
 * manager (Lipa), staff (Lipa, everyday grant), plain staff (Lipa, NO grant: lacks submit_sales_day).
 */
async function fixture(hint: string, o: FixtureOpts = {}) {
  const code = uid(`t375s3-${hint}`);
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
    values (${orgId}, ${storeId}, ${staffId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: emp!.id, personId: staffId, setBy: managerId });

  const mkChannel = async (sid: string, name: string, remitted: boolean, receivable: string | null) =>
    (await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
      values (${orgId}, ${sid}, ${name}, ${remitted}, ${receivable}) returning id`)[0]!.id;
  const walkInId = await mkChannel(storeId, 'Walk-in', true, null);
  const foodpandaId = await mkChannel(storeId, 'Foodpanda', false, '1220');
  await mkChannel(store2Id, 'Walk-in', true, null);

  const [gcash] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeId}, 'GCash - Lipa', 'ewallet', '1140', 'cashier') returning id`;
  const gcashAcct = gcash!.id;

  let posStoreId = '';
  if (o.link !== false) {
    ({ posStoreId } = await linkTestStore(sql, { orgId, storeId, channelId: walkInId, createdBy: adminId, taxType: o.taxType }));
  }
  if (o.tenders !== false) await seedTestTenders(sql, { orgId, storeId, walletAccountId: gcashAcct });

  return {
    orgId, storeId, store2Id, walkInId, foodpandaId, gcashAcct, posStoreId,
    admin: actorOf(orgId, adminId),
    manager: actorOf(orgId, managerId),
    staff: actorOf(orgId, staffId),
    plainStaff: actorOf(orgId, plainStaffId),
    adminId, managerId, staffId,
  };
}
type F = Awaited<ReturnType<typeof fixture>>;

const imp = (f: F, who: Actor, date: string, o: { figures?: Parameters<typeof importTestDay>[2]['figures'] } = {}) =>
  asOrg(f.orgId, (tx) => importTestDay(tx, who, { storeId: f.storeId, businessDate: date, ...o }));

type DayRow = {
  id: string; status: string; source: string; pos_sourced: boolean; pos_sourced_at: Date | null; pos_v1_day_feed_id: string | null;
  total_sales: string; unli_sales: string; ala_carte_sales: string; other_discount: string; other_charges: string;
  refunds: string; cash_collected: string; online_collected: string; comps: string;
};
const dayRows = (storeId: string, date?: string) => sql<DayRow[]>`
  select id, status, source, pos_sourced, pos_sourced_at, pos_v1_day_feed_id, total_sales, unli_sales, ala_carte_sales,
         other_discount, other_charges, refunds, cash_collected, online_collected, comps
    from sales_days where store_id = ${storeId} ${date ? sql`and business_date = ${date}` : sql``} order by business_date, created_at`;
type FeedRow = { id: string; kind: string; purpose: string; batch_id: string; pos_store_id: string; body: string; content_hash: string; fetched_at: Date };
const feedRows = (storeId: string, date?: string) => sql<FeedRow[]>`
  select id, kind, purpose, batch_id, pos_store_id, body, content_hash, fetched_at from pos_v1_day_feeds
   where store_id = ${storeId} ${date ? sql`and business_date = ${date}` : sql``} order by fetched_at, kind`;
const channelRows = (dayId: string) => sql<{ channel_id: string; amount: string }[]>`
  select channel_id, amount from sales_day_channels where sales_day_id = ${dayId} order by channel_id`;
const tenderRows = (dayId: string) => sql<{ money_account_id: string; amount: string }[]>`
  select money_account_id, amount from sales_day_tenders where sales_day_id = ${dayId}`;
const linesFor = (entryId: string) => sql<{ code: string; debit: string; credit: string; line_memo: string | null }[]>`
  select a.code, jl.debit, jl.credit, jl.line_memo from journal_lines jl join accounts a on a.id = jl.account_id
   where jl.entry_id = ${entryId} order by jl.line_no`;
const lineText = (rows: { code: string; debit: string; credit: string }[]) =>
  rows.map((l) => (Number(l.debit) > 0 ? `Dr ${l.code} ${l.debit}` : `Cr ${l.code} ${l.credit}`)).sort();

async function expectNothingWritten(f: F, date: string) {
  expect(await dayRows(f.storeId, date), 'a refused import must create no day').toHaveLength(0);
  expect(await feedRows(f.storeId, date), 'a refused import must store no feed row').toHaveLength(0);
}

describe('I1 - a new date on a linked store imports one feed-sourced day', () => {
  it('one day, feed source, the sales feed id, pos_sourced true and pos_sourced_at = fetched_at; two feed rows in one import batch, body byte-identical, hash = sha256(body); D1 figures; channel and tender rows', async () => {
    const f = await fixture('i1');
    const r = await imp(f, f.staff, D10);

    const days = await dayRows(f.storeId);
    expect(days, 'exactly one day').toHaveLength(1);
    const day = days[0]!;
    expect(day.id).toBe(r.id);
    expect(day.source).toBe('pos_v1_day_feed');
    expect(day.pos_sourced).toBe(true);
    expect(day.status).toBe('open');

    const feeds = await feedRows(f.storeId, D10);
    expect(feeds.map((x) => x.kind).sort(), 'both kinds, captured together').toEqual(['sales', 'sold_items']);
    expect(new Set(feeds.map((x) => x.batch_id)).size, 'one batch').toBe(1);
    for (const x of feeds) {
      expect(x.purpose).toBe('import');
      expect(x.pos_store_id, "POS's own store id, never the v2 uuid").toBe(f.posStoreId);
      expect(x.content_hash).toBe(sha256(x.body));
    }
    const sales = feeds.find((x) => x.kind === 'sales')!;
    expect(sales.body, 'the exact text the fetcher returned').toBe(r.bodies.sales[0]);
    expect(feeds.find((x) => x.kind === 'sold_items')!.body).toBe(r.bodies.sold_items[0]);
    expect(day.pos_v1_day_feed_id, 'the day points at the sales feed').toBe(sales.id);
    expect(day.pos_sourced_at?.getTime(), 'pos_sourced_at is the sales feed fetched_at').toBe(sales.fetched_at.getTime());

    expect(r.calls.map((c) => c.kind).sort()).toEqual(['sales', 'sold_items']);
    for (const c of r.calls) {
      expect(c.posStoreId, 'the fetcher receives the link\'s POS id').toBe(f.posStoreId);
      expect(c.businessDate).toBe(D10);
    }

    expect({
      total: day.total_sales, unli: day.unli_sales, ala: day.ala_carte_sales, disc: day.other_discount, charges: day.other_charges,
      refunds: day.refunds, cash: day.cash_collected, online: day.online_collected,
    }).toEqual({ total: '1100.00', unli: '600.00', ala: '500.00', disc: '100.00', charges: '50.00', refunds: '0.00', cash: '700.00', online: '350.00' });
    expect(await channelRows(day.id)).toEqual([{ channel_id: f.walkInId, amount: '1100.00' }]);
    expect(await tenderRows(day.id)).toEqual([{ money_account_id: f.gcashAcct, amount: '350.00' }]);
  });

  it('submit then verify posts D1\'s lines: Dr 1110 700, Dr 1140 350, Dr 4900 100, Cr 4100 600, Cr 4150 500, Cr 4500 50', async () => {
    const f = await fixture('i1v');
    const { id } = await imp(f, f.staff, D10);
    await asOrg(f.orgId, (tx) => submitSalesDay(tx, f.staff, id));
    const { journalEntryId } = await asOrg(f.orgId, (tx) => verifySalesDay(tx, f.manager, id));
    expect(lineText(await linesFor(journalEntryId))).toEqual(
      ['Cr 4100 600.00', 'Cr 4150 500.00', 'Cr 4500 50.00', 'Dr 1110 700.00', 'Dr 1140 350.00', 'Dr 4900 100.00'].sort(),
    );
  });
});

describe('I1b - a refund day posts its refunds to 4950 and never to comps (R4)', () => {
  it('P 950 against methods 1,050: refunds 100.00, comps 0.00, cash 600.00; verify posts Dr 4950 100.00 "refunds (POS)" and Dr 1110 600', async () => {
    const f = await fixture('i1b');
    const { id } = await imp(f, f.staff, D10, { figures: D2B_FIGURES });
    const day = (await dayRows(f.storeId, D10))[0]!;
    expect({ refunds: day.refunds, comps: day.comps, cash: day.cash_collected, total: day.total_sales }).toEqual({
      refunds: '100.00', comps: '0.00', cash: '600.00', total: '1100.00',
    });
    await asOrg(f.orgId, (tx) => submitSalesDay(tx, f.staff, id));
    const { journalEntryId } = await asOrg(f.orgId, (tx) => verifySalesDay(tx, f.manager, id));
    const lines = await linesFor(journalEntryId);
    expect(lineText(lines)).toEqual(
      ['Cr 4100 600.00', 'Cr 4150 500.00', 'Cr 4500 50.00', 'Dr 1110 600.00', 'Dr 1140 350.00', 'Dr 4900 100.00', 'Dr 4950 100.00'].sort(),
    );
    expect(lines.find((l) => l.code === '4950')?.line_memo).toBe('refunds (POS)');
  });
});

describe('I2 - re-import of an open day replaces the figures and nothing else', () => {
  const day2 = { ...D1_FIGURES, paidTotal: 1150, methods: { Cash: 700, GCash: 450 } };

  it('P 1,150: figures, remitted channel row and tender row replaced; the Foodpanda row untouched; status kept; audited with both feed ids; four feed rows', async () => {
    const f = await fixture('i2');
    const first = await imp(f, f.staff, D10);
    await sql`insert into sales_day_channels (sales_day_id, channel_id, amount) values (${first.id}, ${f.foodpandaId}, '200.00')`;
    const feedsBefore = await feedRows(f.storeId, D10);
    const oldSalesFeed = feedsBefore.find((x) => x.kind === 'sales')!.id;

    const second = await imp(f, f.staff, D10, { figures: day2 });
    expect(second.id, 'the same day').toBe(first.id);

    const day = (await dayRows(f.storeId, D10))[0]!;
    expect({ total: day.total_sales, online: day.online_collected, cash: day.cash_collected, status: day.status }).toEqual({
      total: '1200.00', online: '450.00', cash: '700.00', status: 'open',
    });
    expect(await tenderRows(day.id)).toEqual([{ money_account_id: f.gcashAcct, amount: '450.00' }]);
    const channels = await channelRows(day.id);
    expect(channels.find((c) => c.channel_id === f.walkInId)?.amount, 'the remitted row follows the new total').toBe('1200.00');
    expect(channels.find((c) => c.channel_id === f.foodpandaId)?.amount, 'a platform row is not touched').toBe('200.00');

    const feeds = await feedRows(f.storeId, D10);
    expect(feeds, 'two batches of two').toHaveLength(4);
    const newSalesFeed = feeds.find((x) => x.kind === 'sales' && x.id !== oldSalesFeed)!;
    expect(day.pos_v1_day_feed_id, 'the day now points at the newer sales feed').toBe(newSalesFeed.id);

    const audit = await sql<{ before: unknown; after: unknown }[]>`
      select before, after from audit_log where action = 'reimport_sales_day' and entity_id = ${first.id}`;
    expect(audit, 'one reimport audit row').toHaveLength(1);
    const text = JSON.stringify([audit[0]!.before, audit[0]!.after]);
    expect(text, 'names the feed it came from').toContain(oldSalesFeed);
    expect(text, 'and the feed it was replaced by').toContain(newSalesFeed.id);
    expect(text, 'before and after figures').toContain('1100.00');
    expect(text).toContain('1200.00');
  });

  it('lock order (I4): the fetch happens BEFORE the day lock; with the day held by another connection the fetchers still run, then the import blocks', async () => {
    const f = await fixture('i2lock');
    const first = await imp(f, f.staff, D10);
    const rec = stubFetchers({ figures: day2 });

    const err = await sql.begin(async (holder) => {
      await holder`select id from sales_days where id = ${first.id} for update`;
      return asOrg(f.orgId, async (tx) => {
        await tx.execute(dsql`set local lock_timeout = '800ms'`);
        return importTestDay(tx, f.staff, { storeId: f.storeId, businessDate: D10, fetchers: rec.fetchers });
      }).then(() => null, (e) => e);
    });
    expect(err, 'the import must block on the held day and time out').not.toBeNull();
    expect(chain(err)).toMatch(/lock timeout|55P03/i);
    expect(rec.calls.length, 'both fetches ran BEFORE the lock was waited on').toBe(2);

    // control: once the holder is gone the same import goes through
    const again = await imp(f, f.staff, D10, { figures: day2 });
    expect(again.id).toBe(first.id);
    expect((await dayRows(f.storeId, D10))[0]!.total_sales).toBe('1200.00');
  });
});

describe('I3 - a verified day is never re-imported', () => {
  it('the verified sentence, and no new feed row; control: the open day re-imports (I2)', async () => {
    const f = await fixture('i3');
    const { id } = await imp(f, f.staff, D10);
    await asOrg(f.orgId, (tx) => submitSalesDay(tx, f.staff, id));
    await asOrg(f.orgId, (tx) => verifySalesDay(tx, f.manager, id));
    const before = await feedRows(f.storeId, D10);
    expect(before).toHaveLength(2);

    const stub = stubFetchers({ figures: { ...D1_FIGURES, paidTotal: 1150, methods: { Cash: 700, GCash: 450 } } });
    const s = await sentenceOf(asOrg(f.orgId, (tx) => importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: D10, fetchers: stub.fetchers })));
    expect(stub.calls, 'a verified day is refused BEFORE POS is called').toHaveLength(0);
    expect(s).toBe(`${hd(D10)} is already verified. If POS changed since, it shows under Findings and is corrected there.`);
    expect(await feedRows(f.storeId, D10), 'a refused re-import stores nothing').toHaveLength(2);
    expect((await dayRows(f.storeId, D10))[0]!.total_sales, 'the figures did not move').toBe('1100.00');
  });
});

describe('I3b - the verified re-gate AFTER the fetch, under the day lock', () => {
  /** A sales fetcher that, during its own call (no lock held yet), runs `during()` on another connection. */
  function fetchersWith(during: () => Promise<void>) {
    const base = stubFetchers({ figures: { ...D1_FIGURES, paidTotal: 1150, methods: { Cash: 700, GCash: 450 } } });
    const sales = async (input: { posStoreId: string; businessDate: string; kind?: string }) => {
      await during();
      return base.fetchers.sales(input);
    };
    return { fetchers: { sales, soldItems: base.fetchers.soldItems }, calls: base.calls };
  }

  it('the day is verified by someone else while POS is being fetched: refused with the verified sentence, zero new feed rows, figures unmoved', async () => {
    const f = await fixture('i3b');
    const { id } = await imp(f, f.staff, D10);
    await asOrg(f.orgId, (tx) => submitSalesDay(tx, f.staff, id));
    const rec = fetchersWith(async () => {
      await asOrg(f.orgId, (tx) => verifySalesDay(tx, f.manager, id));
    });
    const s = await sentenceOf(
      asOrg(f.orgId, (tx) => importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: D10, fetchers: rec.fetchers })),
    );
    expect(s).toBe(`${hd(D10)} is already verified. If POS changed since, it shows under Findings and is corrected there.`);
    expect(rec.calls.length, 'the fetch really ran before the refusal').toBeGreaterThan(0);
    expect(await feedRows(f.storeId, D10), 'a refused re-import stores nothing').toHaveLength(2);
    expect((await dayRows(f.storeId, D10))[0]!.total_sales).toBe('1100.00');
  });

  it('control: the same fetcher without the concurrent verify imports (four feed rows, figures follow POS)', async () => {
    const f = await fixture('i3bc');
    const { id } = await imp(f, f.staff, D10);
    await asOrg(f.orgId, (tx) => submitSalesDay(tx, f.staff, id));
    const rec = fetchersWith(async () => {});
    await asOrg(f.orgId, (tx) => importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: D10, fetchers: rec.fetchers }));
    expect(await feedRows(f.storeId, D10)).toHaveLength(4);
    expect((await dayRows(f.storeId, D10))[0]!.total_sales).toBe('1200.00');
  });
});

describe('I13 - the business date is validated right after authorize', () => {
  const BAD = "That isn't a valid date. Use YYYY-MM-DD.";

  it.each(['abc', '2026-02-30', '2026-1-10'])('%j -> the exact date sentence (input not echoed), zero fetcher calls, nothing written', async (bad) => {
    const f = await fixture('i13');
    const stub = stubFetchers();
    const s = await sentenceOf(asOrg(f.orgId, (tx) => importTestDay(tx, f.staff, { storeId: f.storeId, businessDate: bad, fetchers: stub.fetchers })));
    expect(s).toBe(BAD);
    expect(stub.calls).toHaveLength(0);
    expect(await dayRows(f.storeId)).toHaveLength(0);
    expect(await feedRows(f.storeId)).toHaveLength(0);
  });

  it('control: 2026-01-10 imports', async () => {
    const f = await fixture('i13c');
    await imp(f, f.staff, '2026-01-10');
    expect(await dayRows(f.storeId, '2026-01-10')).toHaveLength(1);
  });
});

describe('I14 - reimportSalesDay: a missing day and an inaccessible day are indistinguishable', () => {
  const reimport = async (f: F, who: Actor, salesDayId: string) => {
    const { reimportSalesDay } = (await import('../../src/sales-days/import')) as unknown as {
      reimportSalesDay: (tx: Tx, actor: Actor, input: { salesDayId: string }, fetchers?: unknown) => Promise<unknown>;
    };
    const stub = stubFetchers();
    const err = await asOrg(f.orgId, (tx) => reimportSalesDay(tx, who, { salesDayId }, stub.fetchers)).then(() => null, (e) => e);
    return { err, stub };
  };

  it('a day id that does not exist -> AuthorizationError, no fetch', async () => {
    const f = await fixture('i14a');
    const { err, stub } = await reimport(f, f.admin, '00000000-0000-4000-8000-000000000000');
    expect(err).toBeInstanceOf(AuthorizationError);
    expect(stub.calls).toHaveLength(0);
  });

  it('a real day the actor may not touch (no submit_sales_day) -> the same AuthorizationError, no fetch; control: the staff with the grant re-imports', async () => {
    const f = await fixture('i14b');
    const { id } = await imp(f, f.staff, D10);
    const denied = await reimport(f, f.plainStaff, id);
    expect(denied.err).toBeInstanceOf(AuthorizationError);
    expect(denied.stub.calls).toHaveLength(0);
    const ok = await reimport(f, f.staff, id);
    expect(ok.err).toBeNull();
    expect(ok.stub.calls).toHaveLength(2);
  });
});

describe('I4 - every refusal writes nothing: zero days, zero feed rows', () => {
  it('an unmapped method (Maya 10.00) -> the unmapped-tender sentence', async () => {
    const f = await fixture('i4a');
    const s = await sentenceOf(imp(f, f.staff, D10, { figures: { ...D1_FIGURES, paidTotal: 1060, methods: { Cash: 700, GCash: 350, Maya: 10 } } }));
    expect(s).toBe(
      'POS took ₱10.00 as "Maya", which isn\'t set up as a tender for this store. An admin maps it under Settings › POS link, then import again.',
    );
    await expectNothingWritten(f, D10);
  });

  it('POS not configured -> the not-configured sentence', async () => {
    const f = await fixture('i4b');
    const stub = stubFetchers({ failWith: new PosNotConfiguredError() });
    const s = await sentenceOf(asOrg(f.orgId, (tx) => importTestDay(tx, f.staff, { storeId: f.storeId, businessDate: D10, fetchers: stub.fetchers })));
    expect(s).toBe("The POS connection isn't set up on this server, so sales can't be imported.");
    await expectNothingWritten(f, D10);
  });

  it('POS unreachable (the fetcher throws) -> the unreachable sentence, naming the date and none of the raw text', async () => {
    const f = await fixture('i4c');
    const stub = stubFetchers({ failWith: new PosUnreachableError('POS /api/external/sales returned 503: boom-secret') });
    const s = await sentenceOf(asOrg(f.orgId, (tx) => importTestDay(tx, f.staff, { storeId: f.storeId, businessDate: D10, fetchers: stub.fetchers })));
    expect(s).toBe(`POS couldn't be reached, so ${hd(D10)} wasn't imported. Try again later — sales only come from POS.`);
    expect(s).not.toContain('boom-secret');
    await expectNothingWritten(f, D10);
  });

  it('POS has no sales for the day (found false) -> the not-found sentence naming the store and the date', async () => {
    const f = await fixture('i4d');
    const s = await sentenceOf(imp(f, f.staff, D10, { figures: { found: false } }));
    expect(s).toBe(`POS has no sales for Lipa on ${hd(D10)}. The day waits until POS has them.`);
    await expectNothingWritten(f, D10);
  });

  it('a VAT-exclusive link -> the VAT sentence', async () => {
    const f = await fixture('i4e', { taxType: 'vat_exclusive' });
    const s = await sentenceOf(imp(f, f.staff, D10));
    expect(s).toBe('This store adds VAT on top of its prices in POS. Importing it needs a ruling on where that VAT goes. Ask the office.');
    await expectNothingWritten(f, D10);
  });

  it('control: the same store, vat_inclusive, imports the same payload (so the refusals above are the tests\' own reasons)', async () => {
    const f = await fixture('i4ctl');
    await imp(f, f.staff, D10);
    expect(await dayRows(f.storeId, D10)).toHaveLength(1);
    expect(await feedRows(f.storeId, D10)).toHaveLength(2);
  });
});

describe('I4d - no feed row is written before the derivation refuses (counted inside the same transaction, before rollback)', () => {
  const feedCountIn = async (tx: Tx, storeId: string) =>
    Number(((await tx.execute(dsql`select count(*)::int as n from pos_v1_day_feeds where store_id = ${storeId}`)) as unknown as { n: number }[])[0]!.n);

  async function inTx(f: F, figures: Parameters<typeof importTestDay>[2]['figures']) {
    return asOrg(f.orgId, async (tx) => {
      const before = await feedCountIn(tx, f.storeId);
      const err = await importTestDay(tx, f.staff, { storeId: f.storeId, businessDate: D10, figures }).then(() => null, (e) => e);
      return { before, after: await feedCountIn(tx, f.storeId), err };
    });
  }

  it('a payload derive refuses (methods short): the in-transaction feed count is unchanged after the refusal', async () => {
    const f = await fixture('i4d1');
    const r = await inTx(f, { ...D1_FIGURES, methods: { Cash: 700, GCash: 349.99 } });
    expect(r.err, 'derive must refuse').toBeInstanceOf(Error);
    expect(r.after).toBe(r.before);
  });

  it('an unmapped method refuses the same way', async () => {
    const f = await fixture('i4d2');
    const r = await inTx(f, { ...D1_FIGURES, paidTotal: 1060, methods: { Cash: 700, GCash: 350, Maya: 10 } });
    expect(r.err).toBeInstanceOf(Error);
    expect(r.after).toBe(r.before);
  });

  it('control: the same in-transaction pattern with a good payload shows +2 feed rows', async () => {
    const f = await fixture('i4d3');
    const r = await inTx(f, D1_FIGURES);
    expect(r.err).toBeNull();
    expect(r.after - r.before).toBe(2);
  });
});

describe('I4b - methods short of the sales, and refunds above cash (full sentences with the date)', () => {
  it('methods 1,049.99 against P 1,050.00', async () => {
    const f = await fixture('i4f');
    const s = await sentenceOf(imp(f, f.staff, D10, { figures: { ...D1_FIGURES, methods: { Cash: 700, GCash: 349.99 } } }));
    expect(s).toBe(
      `POS's payments for ${hd(D10)} (₱1,049.99) are less than its sales (₱1,050.00), so the day can't be imported. This has to be fixed on the POS.`,
    );
    await expectNothingWritten(f, D10);
  });

  it('refunds 800.00 against cash 700.00', async () => {
    const f = await fixture('i4g');
    const s = await sentenceOf(imp(f, f.staff, D10, { figures: { ...D1_FIGURES, paidTotal: 250, discounts: 0, charges: 0, packageOnly: 0 } }));
    expect(s).toBe(
      `POS shows ₱800.00 refunded on ${hd(D10)} but only ₱700.00 cash taken, so the day can't be imported. Tell the office; this needs a ruling.`,
    );
    await expectNothingWritten(f, D10);
  });
});

describe('I5 - authorize() first: no submit_sales_day means no link read and no fetch', () => {
  it('a staff member without the grant -> AuthorizationError and the fetchers recorded zero calls; control: the granted staff imports (two calls)', async () => {
    const f = await fixture('i5');
    const stub = stubFetchers();
    const err = await asOrg(f.orgId, (tx) =>
      importTestDay(tx, f.plainStaff, { storeId: f.storeId, businessDate: D10, fetchers: stub.fetchers }),
    ).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AuthorizationError);
    expect(stub.calls, 'the fetchers must not be reached').toHaveLength(0);
    await expectNothingWritten(f, D10);

    const ok = await imp(f, f.staff, D10);
    expect(ok.calls).toHaveLength(2);
  });

  it('and on an UNLINKED store the denial still comes first (the unlinked sentence is not shown to someone who may not ask)', async () => {
    const f = await fixture('i5u');
    const stub = stubFetchers();
    const err = await asOrg(f.orgId, (tx) =>
      importTestDay(tx, f.plainStaff, { storeId: f.store2Id, businessDate: D10, fetchers: stub.fetchers }),
    ).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AuthorizationError);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('I6 - the create-block moved with the code: an older open day blocks a newer import', () => {
  it('staff: an open Jan 10 blocks Jan 11 (the create-block sentence), nothing written for Jan 11', async () => {
    const f = await fixture('i6a');
    await imp(f, f.staff, D10);
    const err = await imp(f, f.staff, D11).then(() => null, (e) => e);
    expect(err, 'the block is the same class create.ts throws').toBeInstanceOf(SalesDayBlockedError);
    expect(sentence(err)).toBe(`${hd(D10)} is still open — verify or edit it before entering a newer day.`);
    await expectNothingWritten(f, D11);
  });

  it('control: an admin is not blocked', async () => {
    const f = await fixture('i6b');
    await imp(f, f.staff, D10);
    await imp(f, f.admin, D11);
    expect(await dayRows(f.storeId, D11)).toHaveLength(1);
  });

  it('control: an OLDER date is not blocked by a newer open one', async () => {
    const f = await fixture('i6c');
    await imp(f, f.staff, D11);
    await imp(f, f.staff, D10);
    expect(await dayRows(f.storeId, D10)).toHaveLength(1);
  });
});

describe('I7 - a voided date needs void_sales_day to be imported again (row 270: re-IMPORT, never re-type)', () => {
  it('staff: refused with the withdrawn sentence; manager: imported as a new day', async () => {
    const f = await fixture('i7');
    const first = await imp(f, f.staff, D10);
    await asOrg(f.orgId, (tx) => voidSalesDay(tx, f.manager, first.id, 'imported by mistake'));

    const s = await sentenceOf(imp(f, f.staff, D10));
    expect(s).toBe(`${hd(D10)} was withdrawn earlier. Only a manager can enter that date again — ask one to do it.`);
    expect((await dayRows(f.storeId, D10)).filter((d) => d.status !== 'voided'), 'no live day was created').toHaveLength(0);

    const again = await imp(f, f.manager, D10);
    expect(again.id).not.toBe(first.id);
    expect((await dayRows(f.storeId, D10)).filter((d) => d.status !== 'voided')).toHaveLength(1);
  });
});

describe('I8 - re-importing a submitted day is the verifier\'s act', () => {
  it('submit_sales_day only -> AuthorizationError; verify_sales_day -> imported and the figures follow POS', async () => {
    const f = await fixture('i8');
    const { id } = await imp(f, f.staff, D10);
    await asOrg(f.orgId, (tx) => submitSalesDay(tx, f.staff, id));
    const later = { ...D1_FIGURES, paidTotal: 1150, methods: { Cash: 700, GCash: 450 } };

    const err = await imp(f, f.staff, D10, { figures: later }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AuthorizationError);
    expect((await dayRows(f.storeId, D10))[0]!.total_sales, 'the figures did not move').toBe('1100.00');

    await imp(f, f.manager, D10, { figures: later });
    const day = (await dayRows(f.storeId, D10))[0]!;
    expect({ total: day.total_sales, status: day.status }).toEqual({ total: '1200.00', status: 'submitted' });
  });
});

const typed = (storeId: string, date: string, extra: Record<string, unknown> = {}) => ({
  storeId, businessDate: date, totalSales: '1000.00', unliSales: '1000.00', alaCarteSales: '0.00', cashCollected: '1000.00', ...extra,
});

describe('I10 - the typed path is gated by the link (R13)', () => {
  it('a LINKED store: createSalesDay refuses with the import-instead sentence and writes nothing', async () => {
    const f = await fixture('i10a');
    const s = await sentenceOf(asOrg(f.orgId, (tx) => createSalesDay(tx, f.manager, typed(f.storeId, D10))));
    expect(s).toBe('Lipa takes its sales from POS. Import the day instead.');
    expect(await dayRows(f.storeId)).toHaveLength(0);
  });

  it('a verified typed day whose store was linked since: editSalesDay refuses with the same sentence (before the status rule), figures unchanged', async () => {
    const f = await fixture('i10b', { link: false, tenders: false });
    const { id } = await asOrg(f.orgId, (tx) => createSalesDay(tx, f.manager, typed(f.storeId, D10)));
    // T-385 (2026-10-09): a day is verified only after it is submitted, by someone other than the verifier.
    const submitter = await mkSubmitter(sql, f.orgId, [f.storeId], 'I10 submitter');
    await asOrg(f.orgId, (tx) => submitThenVerify(tx, f.manager, id, submitter));
    await linkTestStore(sql, { orgId: f.orgId, storeId: f.storeId, channelId: f.walkInId, createdBy: f.adminId });

    const s = await sentenceOf(
      asOrg(f.orgId, (tx) => editSalesDay(tx, f.manager, { salesDayId: id, totalSales: '1200.00', unliSales: '1200.00', alaCarteSales: '0.00', cashCollected: '1200.00' })),
    );
    expect(s).toBe('Lipa takes its sales from POS. Import the day instead.');
    expect((await dayRows(f.storeId, D10))[0]!.total_sales).toBe('1000.00');
  });

  it('control (UNLINKED Batangas): createSalesDay makes a legacy_typed day with pos_sourced false even when the old posSourced true is passed; editSalesDay edits it', async () => {
    const f = await fixture('i10c');
    const { id } = await asOrg(f.orgId, (tx) => createSalesDay(tx, f.admin, typed(f.store2Id, D10, { posSourced: true }) as never));
    const day = (await dayRows(f.store2Id, D10))[0]!;
    expect({ source: day.source, posSourced: day.pos_sourced, at: day.pos_sourced_at, feed: day.pos_v1_day_feed_id }).toEqual({
      source: 'legacy_typed', posSourced: false, at: null, feed: null,
    });

    await asOrg(f.orgId, (tx) =>
      editSalesDay(tx, f.admin, { salesDayId: id, totalSales: '1200.00', unliSales: '1200.00', alaCarteSales: '0.00', cashCollected: '1200.00' } as never),
    );
    const edited = (await dayRows(f.store2Id, D10))[0]!;
    expect({ total: edited.total_sales, source: edited.source, posSourced: edited.pos_sourced }).toEqual({
      total: '1200.00', source: 'legacy_typed', posSourced: false,
    });
  });
});

describe('L5 REVERSE (moved from S1) - B links first and commits; A\'s typed createSalesDay then refuses and writes ZERO days', () => {
  it('the linked store refuses the typed create; the unlinked store still types freely', async () => {
    const f = await fixture('l5r');
    const err = await asOrg(f.orgId, (tx) => createSalesDay(tx, f.manager, typed(f.storeId, D10))).then(() => null, (e) => e);
    expect(err, 'a typed create on a linked store must refuse').toBeInstanceOf(Error);
    expect(sentence(err)).toBe('Lipa takes its sales from POS. Import the day instead.');
    expect(await dayRows(f.storeId)).toHaveLength(0);
    await expect(asOrg(f.orgId, (tx) => createSalesDay(tx, f.admin, typed(f.store2Id, D10)))).resolves.toHaveProperty('id');
    expect(await dayRows(f.store2Id)).toHaveLength(1);
  });
});

describe('I11 - an UNLINKED store has nothing to import', () => {
  it('the unlinked sentence, zero feed rows, and the fetchers never called', async () => {
    const f = await fixture('i11');
    const stub = stubFetchers();
    const s = await sentenceOf(asOrg(f.orgId, (tx) => importTestDay(tx, f.admin, { storeId: f.store2Id, businessDate: D10, fetchers: stub.fetchers })));
    expect(s).toBe("Batangas isn't linked to a POS store yet, so its sales can't be imported. An admin links it under Settings › POS link.");
    expect(stub.calls).toHaveLength(0);
    expect(await feedRows(f.store2Id)).toHaveLength(0);
    expect(await dayRows(f.store2Id)).toHaveLength(0);
  });
});

describe('I12 - a wallet tender whose money account was retired since is refused at import time, by name (S2 audit)', () => {
  it('GCash\'s account inactive -> a refusal naming GCash and no id; nothing written; control: reactivated, the same import succeeds', async () => {
    const f = await fixture('i12');
    await sql`update money_accounts set is_active = false where id = ${f.gcashAcct}`;

    const s = await sentenceOf(imp(f, f.staff, D10));
    expect(s).toContain('GCash');
    expect(s).not.toMatch(UUID);
    await expectNothingWritten(f, D10);

    await sql`update money_accounts set is_active = true where id = ${f.gcashAcct}`;
    await imp(f, f.staff, D10);
    expect(await dayRows(f.storeId, D10)).toHaveLength(1);
    expect(await tenderRows((await dayRows(f.storeId, D10))[0]!.id)).toEqual([{ money_account_id: f.gcashAcct, amount: '350.00' }]);
  });
});
