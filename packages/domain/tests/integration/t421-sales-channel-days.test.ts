import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-421 cases 1-6 - `docs/tasks/421-dashboard-channel-bars.md`. The per-day channel split that the dashboard's
 * stacked bars draw: `getSalesRollup(tx, { groupBy: 'day', channelDays: true })` returns `channelDays` and
 * `unreconciledDays`.
 *
 * TESTER, not BUILDER. Every assertion is on the TARGET shape; the money is exact `Money` (strings) arithmetic.
 *
 * ## Fixture (store A is POS-linked, so its days are imported feed days; store B is unlinked and typed)
 *  - D1 2027-01-10 verified: Walk-in 1,000.10 (the feed) + Grab 200.20 (platform row) = 1,200.30
 *  - D2 2027-01-11 verified feed day with no remitted sales, Foodpanda 300.30 (platform row)
 *  - D3 2027-01-12 verified, then VOIDED (its pair nets to 0 in the ledger, and it is not 'verified')
 *  - D4 2027-01-13 no sales
 *  - a POS correction of -50.00 on D1's sales (Dr 4100), posted with entry date D2
 *  - store B: a typed Walk-in 500.00 day on D1
 *
 * ## Why these are red on HEAD
 * `getSalesRollup` ignores `channelDays` and returns neither `channelDays` nor `unreconciledDays`, so every leg is red
 * on the assertion that reads them. The "fixture control" leg uses the code that exists and must be GREEN: it proves the
 * ledger side of the fixture is what the other legs expect (so a red there is the missing feature, not a broken fixture).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import { add, equals, money, type Money } from '@shareat/core/money';
import * as D from '@shareat/domain';
import { importTestDay } from './_fixtures/pos-day';
import { asOrgOn, R1_FIGURES, s6Fixture, type S6F } from './_fixtures/pos-s6';
import { submitThenVerify } from './_fixtures/sales-day-flow';

const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const D1 = '2027-01-10';
const D2 = '2027-01-11';
const D3 = '2027-01-12';
const D4 = '2027-01-13';

interface ChannelBlock { channelId: string | null; channelName: string; total: Money }
interface ChannelDay { day: string; total: Money; channels: ChannelBlock[] }
interface Rollup {
  periods: { period: string | null; total: Money }[];
  ledgerTotal: Money;
  channels: { channelId: string | null; channelName: string; total: Money }[];
  channelDays: ChannelDay[];
  unreconciledDays: string[];
}

let f: S6F;
let storeBId: string;
let grabId: string;

const rollup = (storeId: string | null): Promise<Rollup> =>
  asOrgOn(f.orgId, (tx) =>
    D.getSalesRollup(tx, {
      orgId: f.orgId,
      storeId,
      fromDate: D1,
      toDate: D4,
      groupBy: 'day',
      channelDays: true,
    } as never),
  ) as unknown as Promise<Rollup>;

const sumOf = (xs: Money[]): Money => add(...xs);
const dayOf = (r: Rollup, d: string) => r.channelDays.find((x) => x.day === d);
const blockOf = (day: ChannelDay | undefined, name: string) => day?.channels.find((c) => c.channelName === name);

beforeAll(async () => {
  f = await s6Fixture(sql, 't421');
  grabId = (
    await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
      values (${f.orgId}, ${f.storeId}, 'Grab', false, '1220') returning id`
  )[0]!.id;

  const verify = (dayId: string) => asOrgOn(f.orgId, (tx) => submitThenVerify(tx, f.manager, dayId, f.admin));
  const platform = (dayId: string, channelId: string, amount: string) =>
    asOrgOn(f.orgId, (tx) =>
      D.setPlatformSales(tx, f.manager, { salesDayId: dayId, rows: [{ channelId, amount, noSales: false }] } as never),
    );

  // D1: Walk-in 1,000.10 from the feed + Grab 200.20 typed = 1,200.30
  const d1Figures = { paidTotal: 1000.1, packageOnly: 600.1, receiptCount: 10, methods: { Cash: 1000.1 } };
  const d1 = await asOrgOn(f.orgId, (tx) => importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: D1, figures: d1Figures }));
  await platform(d1.id, grabId, '200.20');
  await verify(d1.id);

  // D2: no remitted sales, Foodpanda 300.30 only
  const d2 = await asOrgOn(f.orgId, (tx) =>
    importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: D2, figures: { paidTotal: 0, packageOnly: 0, receiptCount: 0, methods: {} } }),
  );
  await platform(d2.id, f.foodpandaId, '300.30');
  await verify(d2.id);

  // D3: verified, then voided
  const d3 = await asOrgOn(f.orgId, (tx) => importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: D3, figures: R1_FIGURES }));
  await verify(d3.id);
  await asOrgOn(f.orgId, (tx) => D.voidSalesDay(tx, f.admin, d3.id, 'T-421 fixture: void'));

  // The POS correction of -50.00 on D1's sales, entry-dated D2.
  const { insertSalesRecheck } = await import('./_fixtures/pos-s6');
  const feedId = (
    await asOrgOn(f.orgId, (tx) =>
      insertSalesRecheck(tx, {
        orgId: f.orgId, storeId: f.storeId, businessDate: D1, posStoreId: f.posStoreId, fetchedBy: f.managerId,
        figures: { paidTotal: 950.1, packageOnly: 550.1, receiptCount: 10, methods: { Cash: 950.1 } },
      }),
    )
  ).ids.sales!;
  await asOrgOn(f.orgId, (tx) =>
    D.postPosCorrection(tx, f.manager, { salesDayId: d1.id, feedId, entryDate: D2, reason: 'T-421 fixture: POS voided a receipt' } as never),
  );

  // Store B (unlinked, typed): Walk-in 500.00 on D1.
  storeBId = (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${f.orgId}, ${`t421b-${Date.now()}`}, 'Store B') returning id`)[0]!.id;
  for (const p of [f.managerId, f.adminId]) await sql`insert into person_store_scope (person_id, store_id) values (${p}, ${storeBId})`;
  const walkInB = (
    await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${f.orgId}, ${storeBId}, 'Walk-in', true) returning id`
  )[0]!.id;
  const dayB = await asOrgOn(f.orgId, (tx) =>
    D.createSalesDay(tx, f.manager, {
      storeId: storeBId, businessDate: D1, totalSales: '500.00', unliSales: '0.00', alaCarteSales: '500.00',
      cashCollected: '500.00', channels: [{ channelId: walkInB, amount: '500.00' }],
    }),
  );
  await verify(dayB.id);
}, 180_000);

describe('T-421 fixture control (green today: the ledger side is what the cases below expect)', () => {
  it('store A ledger: D1 1,200.30, D2 250.30 (300.30 - 50.00), D3 nets to 0, D4 none', async () => {
    const r = await rollup(f.storeId);
    const total = (d: string) => r.periods.find((p) => p.period === d)?.total;
    expect(total(D1)).toBe('1200.30');
    expect(total(D2)).toBe('250.30');
    expect(total(D3) ?? '0.00').toBe('0.00');
    expect(total(D4)).toBeUndefined();
  });
});

describe('T-421 case 1 - per day, the blocks add up to the ledger (the line) to the centavo', () => {
  it('D1 = 1,200.30 (Walk-in 1,000.10 + Grab 200.20); D2 = 300.30 - 50.00; D3 and D4 have no blocks; exact Money equality for every day', async () => {
    const r = await rollup(f.storeId);
    expect(Array.isArray(r.channelDays), 'channelDays is returned').toBe(true);

    const d1 = dayOf(r, D1);
    expect(d1?.total).toBe('1200.30');
    expect(blockOf(d1, 'Walk-in')?.total).toBe('1000.10');
    expect(blockOf(d1, 'Grab')?.total).toBe('200.20');
    expect(sumOf(d1!.channels.map((c) => c.total))).toBe('1200.30');

    const d2 = dayOf(r, D2);
    expect(d2?.total).toBe('250.30');
    expect(blockOf(d2, 'Foodpanda')?.total).toBe('300.30');
    expect(blockOf(d2, 'POS corrections')?.total).toBe('-50.00');
    expect(sumOf(d2!.channels.map((c) => c.total))).toBe('250.30');

    for (const d of [D3, D4]) expect(dayOf(r, d)?.channels ?? [], `${d} has no blocks`).toEqual([]);

    // The invariant itself, for every ledger day: blocks === the line's value.
    for (const p of r.periods) {
      const day = dayOf(r, p.period!);
      const blocks = sumOf((day?.channels ?? []).map((c) => c.total));
      expect(equals(blocks, p.total), `${p.period}: blocks ${blocks} vs ledger ${p.total}`).toBe(true);
    }
  });
});

describe('T-421 case 2 - the correction sits on its entry date', () => {
  it('the -50.00 is on D2, not on D1 (the corrected day)', async () => {
    const r = await rollup(f.storeId);
    expect(blockOf(dayOf(r, D1), 'POS corrections'), 'no correction block on D1').toBeUndefined();
    expect(blockOf(dayOf(r, D2), 'POS corrections')?.total).toBe('-50.00');
    expect(blockOf(dayOf(r, D2), 'POS corrections')?.channelId).toBeNull();
  });
});

describe('T-421 case 3 - a voided day contributes nothing', () => {
  it('D3 has no blocks, and the range\'s blocks add up to exactly the ledger total 1,450.60', async () => {
    const r = await rollup(f.storeId);
    expect(dayOf(r, D3)?.channels ?? []).toEqual([]);
    const all = sumOf(r.channelDays.flatMap((d) => d.channels.map((c) => c.total)));
    expect(all).toBe('1450.60');
    expect(r.ledgerTotal).toBe('1450.60');
  });
});

describe('T-421 case 4 - store scope', () => {
  it('store A excludes store B; org-wide includes it (D1 = 1,700.30) and the invariant still holds', async () => {
    const a = await rollup(f.storeId);
    expect(dayOf(a, D1)?.total, 'store A alone, B excluded').toBe('1200.30');

    const org = await rollup(null);
    expect(dayOf(org, D1)?.total).toBe('1700.30');
    expect(org.periods.find((p) => p.period === D1)?.total).toBe('1700.30');
    for (const p of org.periods) {
      const blocks = sumOf((dayOf(org, p.period!)?.channels ?? []).map((c) => c.total));
      expect(equals(blocks, p.total), `${p.period}: blocks ${blocks} vs ledger ${p.total}`).toBe(true);
    }
  });
});

describe('T-421 case 5 - per channel, the blocks over the range equal the donut total', () => {
  it('org-wide, where two channels share the name "Walk-in" (store A and store B): grouped by id, never by name', async () => {
    const org = await rollup(null);
    expect(org.channels.filter((c) => c.channelName === 'Walk-in'), 'fixture: two channels named Walk-in').toHaveLength(2);
    for (const ch of org.channels) {
      const blocks = org.channelDays.flatMap((d) => d.channels.filter((c) => c.channelId === ch.channelId).map((c) => c.total));
      expect(sumOf(blocks), `${ch.channelName} (${ch.channelId}) over the range`).toBe(ch.total);
    }
    // The two Walk-ins stay separate blocks on D1: 1,000.10 (A) and 500.00 (B), not one 1,500.10.
    const walkIns = (dayOf(org, D1)?.channels ?? []).filter((c) => c.channelName === 'Walk-in').map((c) => c.total).sort();
    expect(walkIns).toEqual(['1000.10', '500.00']);
  });
});

describe('T-421 case 6 - a day whose ledger total no longer matches its blocks is named', () => {
  it('none before the tamper; after a fixture-only 1.00 on D1 only D1 is listed', async () => {
    const before = await rollup(f.storeId);
    expect(before.unreconciledDays, 'control: a clean range lists nothing').toEqual([]);

    const period = (await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} and starts_on = '2027-01-01'`)[0]!.id;
    const acct = async (code: string) => (await sql<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = ${code}`)[0]!.id;
    const [rev, cash] = [await acct('4100'), await acct('1110')];
    await sql.begin(async (trx) => {
      const [e] = await trx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status, posted_at)
        values (${f.orgId}, ${D1}, ${period}, 'sale', ${`t421-tamper-${Date.now()}`}, 'draft', null) returning id`;
      await trx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${cash}, ${f.storeId}, 1.00, 0)`;
      await trx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${rev}, ${f.storeId}, 0, 1.00)`;
      await trx`update journal_entries set status = 'posted', posted_at = now() where id = ${e!.id}`;
    });

    const after = await rollup(f.storeId);
    expect(after.periods.find((p) => p.period === D1)?.total, 'control: the ledger moved by 1.00').toBe('1201.30');
    expect(after.unreconciledDays).toEqual([D1]);
    expect(money(after.ledgerTotal)).toBe('1451.60');
  });
});
