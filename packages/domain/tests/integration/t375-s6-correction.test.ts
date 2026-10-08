import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-375 S6 - the correcting entry, its reports, and the corrected-day void. `docs/tasks/375-pos-v1-day-feed.md`
 * section S6, tests C1-C9, V3 (and X1, the export guard the actions need). R1/R3/S1d/R4L are `t375-s6-drift.test.ts`.
 *
 * TESTER, not BUILDER. Every red leg asserts the TARGET: the exact journal lines (account, side, amount, party), the
 * entry's source and idempotency key, the spec's sentences word for word. Every refusal has a positive control (the
 * very same feed posts once the cause is removed).
 *
 * ## The money (D1 day, `_fixtures/pos-day.ts`; R1's recheck, `_fixtures/pos-s6.ts`)
 *  - posted at verify: Dr 1110 700 (cash), Dr 1140 350 (GCash, party the wallet), Dr 4900 100, Cr 4100 600, Cr 4150 500,
 *    Cr 4500 50. Gross 1,100.00 (unli 600 + a la carte 500).
 *  - R1's feed: P 1,000.00, K 550.00, methods {Cash 650, GCash 350}: gross 1,050.00 (unli 550 + a la carte 500), cash
 *    650, online 350. New - old = Dr 4100 50.00 / Cr 1110 50.00, nothing else.
 *
 * ## Why these are red on HEAD
 * `packages/domain/src/sales-days/correction.ts` does not exist: `postPosCorrection` is loaded by a DYNAMIC import
 * inside `correct()`, so every leg that posts one fails with "Failed to resolve import ../../src/sales-days/correction"
 * (a missing module, acceptable for this one new file). X1 is red on its assertion; the V3 void leg is red on the
 * assertion once the correction exists (HEAD's `voidSalesDay` reverses only the day's entry), and the `getSalesRollup`
 * legs of C8 and the pre-correction controls PASS today (R14 shipped with S4).
 *
 * ## Pinned where the spec is silent
 *  - `postPosCorrection(tx, actor, { salesDayId, feedId, entryDate, reason })`; the return value is not read - the
 *    correction row (`sales_day_pos_corrections`) and its entry are read from the database;
 *  - the closed-period refusal is `postEntry`'s own error, matched on "closed" and the date;
 *  - C2 pins the ORDER of refusals: "already posted as a correction" is answered before "no change" (a repeat of a
 *    posted feed would otherwise read "haven't changed", because the basis has moved to it).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { parseBusinessDate } from '@shareat/core/datetime';
import * as D from '@shareat/domain';
import { humanDate as humanDateOf } from '../../src/shared/refusal-leaf';
import { D1_FIGURES, importTestDay } from './_fixtures/pos-day';
import { asOrgOn, DAY, insertSalesRecheck, R1_FIGURES, s6Fixture, type S6F } from './_fixtures/pos-s6';
import { submitThenVerify } from './_fixtures/sales-day-flow';

const hd = (d: string) => humanDateOf(parseBusinessDate(d));
const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const sentenceOf = async (p: Promise<unknown>): Promise<string> => {
  const err = await p.then(() => null, (e) => e);
  expect(err, 'the call must refuse').toBeInstanceOf(Error);
  return String((err as { userMessage?: string }).userMessage ?? (err as Error).message);
};
const chain = (e: unknown): string => {
  const parts: string[] = [];
  for (let x: unknown = e, i = 0; x && i < 5; i++, x = (x as { cause?: unknown }).cause) parts.push(String((x as Error).message ?? x));
  return parts.join(' | ');
};

// ---- the new module, loaded lazily so only the legs that post a correction fail on HEAD -------------------------
interface CorrectionInput { salesDayId: string; feedId: string; entryDate: string; reason: string }
async function correct(f: S6F, who: Actor, input: Omit<CorrectionInput, 'reason'> & { reason?: string }): Promise<unknown> {
  const m = (await import('../../src/sales-days/correction')) as unknown as {
    postPosCorrection: (tx: Tx, actor: Actor, input: CorrectionInput) => Promise<unknown>;
  };
  return asOrgOn(f.orgId, (tx) => m.postPosCorrection(tx, who, { reason: 'POS voided a cash receipt', ...input }));
}

const imp = (f: S6F, date: string, figures?: Parameters<typeof importTestDay>[2]['figures']) =>
  asOrgOn(f.orgId, (tx) => importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: date, figures }));
const verify = (f: S6F, dayId: string) => asOrgOn(f.orgId, (tx) => submitThenVerify(tx, f.manager, dayId, f.admin));
const recheck = (f: S6F, date: string, figures = R1_FIGURES) =>
  asOrgOn(f.orgId, (tx) =>
    insertSalesRecheck(tx, { orgId: f.orgId, storeId: f.storeId, businessDate: date, posStoreId: f.posStoreId, fetchedBy: f.managerId, figures }),
  );

/** A verified D1 day and a newer feed on R1's figures. */
async function drifted(f: S6F, figures = R1_FIGURES) {
  const { id: dayId } = await imp(f, DAY);
  const { journalEntryId } = await verify(f, dayId);
  const basis = (await sql<{ pos_v1_day_feed_id: string }[]>`select pos_v1_day_feed_id from sales_days where id = ${dayId}`)[0]!.pos_v1_day_feed_id;
  const feedId = (await recheck(f, DAY, figures)).ids.sales!;
  return { dayId, dayEntryId: journalEntryId, basis, feedId };
}

type CorrRow = { id: string; from_feed_id: string; to_feed_id: string; entry_date: string; journal_entry_id: string; reason: string; posted_by: string };
const corrections = (dayId: string) => sql<CorrRow[]>`
  select id, from_feed_id, to_feed_id, to_char(entry_date, 'YYYY-MM-DD') as entry_date, journal_entry_id, reason, posted_by
    from sales_day_pos_corrections where sales_day_id = ${dayId} order by posted_at, id`;
type LineRow = { code: string; debit: string; credit: string; store_id: string | null; party_type: string | null; party_id: string | null };
const lines = (entryId: string) => sql<LineRow[]>`
  select a.code, jl.debit, jl.credit, jl.store_id, jl.party_type, jl.party_id
    from journal_lines jl join accounts a on a.id = jl.account_id where jl.entry_id = ${entryId}`;
const lineText = (rows: LineRow[], withParty = false): string[] =>
  rows
    .map((l) => `${Number(l.debit) > 0 ? `Dr ${l.code} ${Number(l.debit).toFixed(2)}` : `Cr ${l.code} ${Number(l.credit).toFixed(2)}`}${withParty && l.party_id ? ` @${l.party_id}` : ''}`)
    .sort();
const saleEntries = (f: S6F) => sql<{ id: string; source_id: string; status: string; reversal_of_entry_id: string | null; entry_date: string; idempotency_key: string | null; source_type: string }[]>`
  select id, source_id, status, reversal_of_entry_id, to_char(entry_date, 'YYYY-MM-DD') as entry_date, idempotency_key, source_type
    from journal_entries where org_id = ${f.orgId} and source_type = 'sale' order by created_at, id`;
const dayFigures = (dayId: string) => sql`
  select status, source, pos_v1_day_feed_id, total_sales, unli_sales, ala_carte_sales, senior_discount, pwd_discount, other_discount, comps, service_charge,
         other_charges, cash_collected, online_collected, credit_sales, refunds, journal_entry_id
    from sales_days where id = ${dayId}`;
const drift = (f: S6F) =>
  asOrgOn(f.orgId, async (tx) => (await D.listFindings(tx, f.orgId, { period: '2026-12' })).findings.filter((x) => x.kind === 'posDayFeedDrift'));

const S = {
  already: 'That POS check has already been posted as a correction.',
  unchanged: (d: string) => `POS's figures for ${hd(d)} haven't changed since they were posted.`,
  early: (d: string) => `A correction can't be dated before the day it corrects (${hd(d)}).`,
  unmapped: 'POS took ₱350.00 as "Maya", which isn\'t set up as a tender for this store. An admin maps it under Settings › POS link, then import again.',
};
const OPEN_DATE = '2027-01-20';

// =====================================================================================================
describe('X1 - the entry points the screens call are exported from @shareat/domain', () => {
  it('postPosCorrection, recheckPosDay and recheckRecentDays are functions', () => {
    for (const name of ['postPosCorrection', 'recheckPosDay', 'recheckRecentDays']) {
      expect(typeof (D as unknown as Record<string, unknown>)[name], name).toBe('function');
    }
  });
});

describe('C1 - a correction posts new minus posted, dated in an open month, and moves the basis', () => {
  it('Dr 4100 50.00 / Cr 1110 50.00; one correction row; source sale, source id = the correction, the idempotency key; the finding is gone; the day\'s figures, status and entry are unchanged', async () => {
    const f = await s6Fixture(sql, 'c1');
    const { dayId, dayEntryId, basis, feedId } = await drifted(f);
    expect(await drift(f), 'control: before the correction the day is a finding').toHaveLength(1);
    const before = await dayFigures(dayId);
    expect(before[0]).toMatchObject({ status: 'verified', total_sales: '1100.00', unli_sales: '600.00', ala_carte_sales: '500.00', cash_collected: '700.00' });

    await correct(f, f.manager, { salesDayId: dayId, feedId, entryDate: OPEN_DATE, reason: 'POS voided a cash receipt' });

    const rows = await corrections(dayId);
    expect(rows).toHaveLength(1);
    const c = rows[0]!;
    expect({ from: c.from_feed_id, to: c.to_feed_id, date: c.entry_date, reason: c.reason, by: c.posted_by }).toEqual({
      from: basis, to: feedId, date: OPEN_DATE, reason: 'POS voided a cash receipt', by: f.managerId,
    });

    const entry = (await saleEntries(f)).find((e) => e.id === c.journal_entry_id);
    expect(entry, 'the correction\'s entry').toBeDefined();
    expect({ type: entry!.source_type, sourceId: entry!.source_id, date: entry!.entry_date, status: entry!.status, key: entry!.idempotency_key }).toEqual({
      type: 'sale', sourceId: c.id, date: OPEN_DATE, status: 'posted', key: `sales_day:${dayId}:pos_correction:${feedId}`,
    });
    const posted = await lines(c.journal_entry_id);
    expect(lineText(posted)).toEqual(['Cr 1110 50.00', 'Dr 4100 50.00']);
    for (const l of posted) expect(l.store_id, 'on the day\'s store').toBe(f.storeId);

    expect(await drift(f), 'the finding is gone: the basis moved to the checked feed').toEqual([]);
    const after = await dayFigures(dayId);
    expect(after[0], 'the day\'s own figures never change').toEqual(before[0]);
    expect(after[0]!.journal_entry_id).toBe(dayEntryId);
    expect((await saleEntries(f)).filter((e) => e.id === dayEntryId)[0]!.status, 'the day\'s own entry stands').toBe('posted');
  });
});

describe('C2 - the same feed again', () => {
  it('-> "already been posted"; still one correction and one correction entry; control: the first call posted', async () => {
    const f = await s6Fixture(sql, 'c2');
    const { dayId, feedId } = await drifted(f);
    await correct(f, f.manager, { salesDayId: dayId, feedId, entryDate: OPEN_DATE });
    expect(await corrections(dayId), 'control: the first call posted').toHaveLength(1);
    const entriesBefore = (await saleEntries(f)).length;

    expect(await sentenceOf(correct(f, f.manager, { salesDayId: dayId, feedId, entryDate: OPEN_DATE }))).toBe(S.already);
    expect(await corrections(dayId)).toHaveLength(1);
    expect((await saleEntries(f)).length).toBe(entriesBefore);
  });
});

describe('C3 - the date of a correction', () => {
  it('before the business date -> the early sentence; in a CLOSED month (Dec and Jan closed after the day was verified) -> the closed-period refusal of the posting; nothing written; control: the same feed posts in an open month', async () => {
    const f = await s6Fixture(sql, 'c3');
    const { dayId, feedId } = await drifted(f);
    const entriesBefore = (await saleEntries(f)).length;

    expect(await sentenceOf(correct(f, f.manager, { salesDayId: dayId, feedId, entryDate: '2027-01-09' }))).toBe(S.early(DAY));

    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId} and starts_on in ('2026-12-01', '2027-01-01')`;
    const closed = await correct(f, f.manager, { salesDayId: dayId, feedId, entryDate: OPEN_DATE }).then(() => null, (e) => e);
    expect(closed, 'a correction dated in the closed January is refused').toBeInstanceOf(Error);
    expect(chain(closed)).toMatch(/closed/);
    expect(chain(closed)).toContain(OPEN_DATE);

    expect(await corrections(dayId)).toHaveLength(0);
    expect((await saleEntries(f)).length).toBe(entriesBefore);

    await correct(f, f.manager, { salesDayId: dayId, feedId, entryDate: '2027-02-15' });
    const rows = await corrections(dayId);
    expect(rows, 'control: dated in an open month it posts').toHaveLength(1);
    expect(rows[0]!.entry_date).toBe('2027-02-15');
  });
});

describe('C4 - a recheck identical in money', () => {
  it('(only the receipt count moved) -> "haven\'t changed"; nothing posted; control: a money change on the same day posts', async () => {
    const f = await s6Fixture(sql, 'c4');
    const { id: dayId } = await imp(f, DAY);
    await verify(f, dayId);
    const same = (await recheck(f, DAY, { ...D1_FIGURES, receiptCount: 25 })).ids.sales!;
    const entriesBefore = (await saleEntries(f)).length;

    expect(await sentenceOf(correct(f, f.manager, { salesDayId: dayId, feedId: same, entryDate: OPEN_DATE }))).toBe(S.unchanged(DAY));
    expect(await corrections(dayId)).toHaveLength(0);
    expect((await saleEntries(f)).length).toBe(entriesBefore);

    const moved = (await recheck(f, DAY, R1_FIGURES)).ids.sales!;
    await correct(f, f.manager, { salesDayId: dayId, feedId: moved, entryDate: OPEN_DATE });
    expect(await corrections(dayId), 'control').toHaveLength(1);
  });
});

describe('C5 - who may correct (verify_sales_day)', () => {
  it('a plain staff is refused with AuthorizationError and nothing is written; the manager posts the same feed', async () => {
    const f = await s6Fixture(sql, 'c5');
    const { dayId, feedId } = await drifted(f);
    const err = await correct(f, f.plainStaff, { salesDayId: dayId, feedId, entryDate: OPEN_DATE }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AuthorizationError);
    expect(await corrections(dayId)).toHaveLength(0);

    await correct(f, f.manager, { salesDayId: dayId, feedId, entryDate: OPEN_DATE });
    expect(await corrections(dayId), 'control: the manager posts').toHaveLength(1);
  });
});

describe('C6 - the new feed has a method the store has no tender for', () => {
  it('-> the unmapped-tender sentence (R3\'s), nothing posted; control: a feed whose methods are mapped posts', async () => {
    const f = await s6Fixture(sql, 'c6');
    const { id: dayId } = await imp(f, DAY);
    await verify(f, dayId);
    const bad = (await recheck(f, DAY, { ...R1_FIGURES, methods: { Cash: 650, Maya: 350 } })).ids.sales!;
    const entriesBefore = (await saleEntries(f)).length;

    expect(await sentenceOf(correct(f, f.manager, { salesDayId: dayId, feedId: bad, entryDate: OPEN_DATE }))).toBe(S.unmapped);
    expect(await corrections(dayId)).toHaveLength(0);
    expect((await saleEntries(f)).length).toBe(entriesBefore);

    const good = (await recheck(f, DAY, R1_FIGURES)).ids.sales!;
    await correct(f, f.manager, { salesDayId: dayId, feedId: good, entryDate: OPEN_DATE });
    expect(await corrections(dayId), 'control').toHaveLength(1);
  });
});

describe('C7 - platform sales on the day', () => {
  it('a Foodpanda row (200.00) is on both sides, so the delta has no 1220 and no 4150 line: still Dr 4100 50.00 / Cr 1110 50.00', async () => {
    const f = await s6Fixture(sql, 'c7');
    const { id: dayId } = await imp(f, DAY);
    await asOrgOn(f.orgId, (tx) =>
      D.setPlatformSales(tx, f.manager, { salesDayId: dayId, rows: [{ channelId: f.foodpandaId, amount: '200.00', noSales: false }] }),
    );
    const { journalEntryId } = await verify(f, dayId);
    expect(lineText(await lines(journalEntryId)), 'control: the day\'s own entry carries the platform lines').toEqual(
      ['Cr 4100 600.00', 'Cr 4150 700.00', 'Cr 4500 50.00', 'Dr 1110 700.00', 'Dr 1140 350.00', 'Dr 1220 200.00', 'Dr 4900 100.00'].sort(),
    );
    const feedId = (await recheck(f, DAY)).ids.sales!;

    await correct(f, f.manager, { salesDayId: dayId, feedId, entryDate: OPEN_DATE });
    const c = (await corrections(dayId))[0]!;
    expect(lineText(await lines(c.journal_entry_id))).toEqual(['Cr 1110 50.00', 'Dr 4100 50.00']);
  });
});

describe('C8 - reports reconcile with a correction in the period (R14)', () => {
  const rollup = (f: S6F, fromDate: string, toDate: string) =>
    asOrgOn(f.orgId, (tx) => D.getSalesRollup(tx, { orgId: f.orgId, storeId: f.storeId, fromDate, toDate, groupBy: 'month' }));

  it('January with a January correction: reconciles; ledger 1,050.00; modes 550.00 / 500.00; a "POS corrections" channel line of -50.00 (no channel id)', async () => {
    const f = await s6Fixture(sql, 'c8');
    const { dayId, feedId } = await drifted(f);
    const pre = await rollup(f, '2027-01-01', '2027-01-31');
    expect(pre.reconciles, 'control: before the correction').toBe(true);
    expect(pre.channels.some((c) => c.channelName === 'POS corrections'), 'control: no correction line yet').toBe(false);
    expect(Number(pre.ledgerTotal)).toBe(1100);

    await correct(f, f.manager, { salesDayId: dayId, feedId, entryDate: OPEN_DATE });
    const r = await rollup(f, '2027-01-01', '2027-01-31');
    expect(r.reconciles).toBe(true);
    expect(Number(r.ledgerTotal)).toBe(1050);
    expect(Number(r.channelTotal)).toBe(1050);
    expect(r.modes.map((m) => [m.mode, Number(m.total)])).toEqual([['unli', 550], ['ala_carte', 500]]);
    const line = r.channels.find((c) => c.channelName === 'POS corrections');
    expect(line, 'the synthetic correction line').toBeDefined();
    expect(line!.channelId).toBeNull();
    expect(Number(line!.total)).toBe(-50);
  });

  it('a correction dated in MARCH: January alone still reconciles at 1,100.00 with no correction line; January-March reconciles at 1,050.00 with the line', async () => {
    const f = await s6Fixture(sql, 'c8m');
    const { dayId, feedId } = await drifted(f);
    await correct(f, f.manager, { salesDayId: dayId, feedId, entryDate: '2027-03-05' });

    const jan = await rollup(f, '2027-01-01', '2027-01-31');
    expect(jan.reconciles).toBe(true);
    expect(Number(jan.ledgerTotal)).toBe(1100);
    expect(jan.channels.some((c) => c.channelName === 'POS corrections')).toBe(false);

    const all = await rollup(f, '2027-01-01', '2027-03-31');
    expect(all.reconciles).toBe(true);
    expect(Number(all.ledgerTotal)).toBe(1050);
    expect(Number(all.channels.find((c) => c.channelName === 'POS corrections')?.total)).toBe(-50);
  });
});

describe('C9 - old is what was POSTED, not what today\'s tenders would give (V7)', () => {
  const retireAndRemap = async (f: S6F, accountId: string) => {
    await sql`update tenders set is_active = false where id = ${f.walletTenderId}`;
    await sql`insert into tenders (org_id, store_id, name, kind, money_account_id, pos_v1_alias)
              values (${f.orgId}, ${f.storeId}, 'GCash (new)', 'wallet', ${accountId}, 'GCash')`;
  };

  it('retire the GCash tender after verify, map a new one to the SAME account, correct -> no 1140 line: Dr 4100 50.00 / Cr 1110 50.00', async () => {
    const f = await s6Fixture(sql, 'c9');
    const { dayId, feedId } = await drifted(f);
    await retireAndRemap(f, f.gcashAcct);
    await correct(f, f.manager, { salesDayId: dayId, feedId, entryDate: OPEN_DATE });
    const c = (await corrections(dayId))[0]!;
    expect(lineText(await lines(c.journal_entry_id))).toEqual(['Cr 1110 50.00', 'Dr 4100 50.00']);
  });

  it('control: mapped to ANOTHER wallet (Maya) the real change shows - Cr 1140 on the old wallet and Dr 1140 on the new one, each 350.00, beside the 4100 / 1110 pair', async () => {
    const f = await s6Fixture(sql, 'c9b');
    const { dayId, feedId } = await drifted(f);
    await retireAndRemap(f, f.mayaAcct);
    await correct(f, f.manager, { salesDayId: dayId, feedId, entryDate: OPEN_DATE });
    const c = (await corrections(dayId))[0]!;
    expect(lineText(await lines(c.journal_entry_id), true)).toEqual(
      ['Cr 1110 50.00', `Cr 1140 350.00 @${f.gcashAcct}`, 'Dr 4100 50.00', `Dr 1140 350.00 @${f.mayaAcct}`].sort(),
    );
  });
});

describe('V3 - voiding a corrected day reverses the day AND its correction; reports and re-import stay right', () => {
  it('both entries become reversed and each gets a reversal (keeping the sale source and the correction\'s source id); January reconciles at 0.00; re-import + verify -> the ledger holds 1,050.00 once', async () => {
    const f = await s6Fixture(sql, 'v3');
    const { dayId, dayEntryId, feedId } = await drifted(f);
    await correct(f, f.manager, { salesDayId: dayId, feedId, entryDate: OPEN_DATE });
    const corr = (await corrections(dayId))[0]!;

    const out = await asOrgOn(f.orgId, (tx) => D.voidSalesDay(tx, f.manager, dayId, 'wrong day'));
    expect(out.reversalEntryId, 'the day\'s own reversal').not.toBeNull();

    const entries = await saleEntries(f);
    expect(entries, 'day, correction, and one reversal each').toHaveLength(4);
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(byId.get(dayEntryId)!.status).toBe('reversed');
    expect(byId.get(corr.journal_entry_id)!.status, 'the correction entry is reversed too').toBe('reversed');
    const reversals = entries.filter((e) => e.reversal_of_entry_id !== null);
    expect(reversals.map((e) => [e.reversal_of_entry_id, e.source_type, e.source_id].join('|')).sort()).toEqual(
      [`${dayEntryId}|sale|${dayId}`, `${corr.journal_entry_id}|sale|${corr.id}`].sort(),
    );
    expect((await corrections(dayId)), 'the correction row stays (append-only)').toHaveLength(1);
    expect((await dayFigures(dayId))[0]!.status).toBe('voided');

    const jan = await asOrgOn(f.orgId, (tx) => D.getSalesRollup(tx, { orgId: f.orgId, storeId: f.storeId, fromDate: '2027-01-01', toDate: '2027-01-31', groupBy: 'month' }));
    expect(jan.reconciles, 'the correction and its reversal are both matched by source id').toBe(true);
    expect(Number(jan.ledgerTotal)).toBe(0);

    // Re-import and verify: the date is on the new feed once.
    const { id: newDay } = await imp(f, DAY, R1_FIGURES);
    await verify(f, newDay);
    const [net] = await sql<{ n: string }[]>`
      select coalesce(sum(jl.credit - jl.debit), 0)::text as n
        from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
       where je.org_id = ${f.orgId} and je.source_type = 'sale' and a.code in ('4100', '4150')`;
    expect(Number(net!.n), '4100 + 4150 net of everything = the new feed once').toBe(1050);
    const after = await asOrgOn(f.orgId, (tx) => D.getSalesRollup(tx, { orgId: f.orgId, storeId: f.storeId, fromDate: '2027-01-01', toDate: '2027-01-31', groupBy: 'month' }));
    expect(after.reconciles).toBe(true);
    expect(Number(after.ledgerTotal)).toBe(1050);
  });
});

// =====================================================================================================
// Audit additions (S6 audit): A/H retired money account, B two corrections, C void with two, G channel changed.
describe('A/H - a wallet tender whose MONEY ACCOUNT was retired after verify', () => {
  const MOVED = { ...D1_FIGURES, paidTotal: 1000, packageOnly: 600, methods: { Cash: 700, GCash: 300 } }; // the wallet's amount moves
  const RETIRED = `GCash's money account is no longer active, so ${hd(DAY)} can't be corrected. An admin sets GCash's account under Settings › POS link.`;

  it('the correction is refused with the retired-account sentence naming the tender; nothing posted; control: with the account active the same feed posts', async () => {
    const f = await s6Fixture(sql, 'a1');
    const { id: dayId } = await imp(f, DAY);
    await verify(f, dayId);
    const feedId = (await recheck(f, DAY, MOVED)).ids.sales!;
    const entriesBefore = (await saleEntries(f)).length;

    await sql`update money_accounts set is_active = false where id = ${f.gcashAcct}`;
    expect(await sentenceOf(correct(f, f.manager, { salesDayId: dayId, feedId, entryDate: OPEN_DATE }))).toBe(RETIRED);
    expect(await corrections(dayId)).toHaveLength(0);
    expect((await saleEntries(f)).length).toBe(entriesBefore);

    await sql`update money_accounts set is_active = true where id = ${f.gcashAcct}`;
    await correct(f, f.manager, { salesDayId: dayId, feedId, entryDate: OPEN_DATE });
    const c = (await corrections(dayId))[0]!;
    expect(lineText(await lines(c.journal_entry_id)), 'control: active again, the wallet moved 50.00 and the a la carte sale with it').toEqual(
      ['Cr 1140 50.00', 'Dr 4150 50.00'].sort(),
    );
  });
});

describe('B - two corrections on one day: the second one\'s old is the day entry PLUS the first correction', () => {
  it('first R1 (Dr 4100 50 / Cr 1110 50), then P 950 (K 500, Cash 600): the second entry is exactly Dr 4100 50.00 / Cr 1110 50.00 (not 100.00)', async () => {
    const f = await s6Fixture(sql, 'b1');
    const { dayId, feedId } = await drifted(f);
    await correct(f, f.manager, { salesDayId: dayId, feedId, entryDate: OPEN_DATE });
    const second = (await recheck(f, DAY, { ...D1_FIGURES, paidTotal: 950, packageOnly: 500, methods: { Cash: 600, GCash: 350 } })).ids.sales!;
    await correct(f, f.manager, { salesDayId: dayId, feedId: second, entryDate: '2027-01-21', reason: 'POS voided another receipt' });

    const rows = await corrections(dayId);
    expect(rows).toHaveLength(2);
    const c2 = rows.find((r) => r.to_feed_id === second)!;
    expect(c2.from_feed_id, 'the second correction moves from the first one\'s feed').toBe(feedId);
    expect(lineText(await lines(c2.journal_entry_id))).toEqual(['Cr 1110 50.00', 'Dr 4100 50.00']);
    expect(await drift(f), 'the finding is gone').toEqual([]);
  });
});

describe('C - voiding a day with TWO corrections', () => {
  it('all three entries are reversed, the correction reversals newest first; January reconciles at 0.00; re-import + verify -> the new feed once', async () => {
    const f = await s6Fixture(sql, 'c1b');
    const { dayId, dayEntryId, feedId } = await drifted(f);
    await correct(f, f.manager, { salesDayId: dayId, feedId, entryDate: OPEN_DATE });
    const second = (await recheck(f, DAY, { ...D1_FIGURES, paidTotal: 950, packageOnly: 500, methods: { Cash: 600, GCash: 350 } })).ids.sales!;
    await correct(f, f.manager, { salesDayId: dayId, feedId: second, entryDate: '2027-01-21', reason: 'POS voided another receipt' });
    const rows = await corrections(dayId);
    const c1 = rows.find((r) => r.to_feed_id === feedId)!;
    const c2 = rows.find((r) => r.to_feed_id === second)!;

    await asOrgOn(f.orgId, (tx) => D.voidSalesDay(tx, f.manager, dayId, 'wrong day'));

    const entries = await saleEntries(f);
    expect(entries, 'three entries and a reversal each').toHaveLength(6);
    for (const id of [dayEntryId, c1.journal_entry_id, c2.journal_entry_id]) {
      expect(entries.find((e) => e.id === id)!.status).toBe('reversed');
    }
    const reversalOf = (id: string) => entries.find((e) => e.reversal_of_entry_id === id)!;
    expect(reversalOf(c2.journal_entry_id).id < reversalOf(c1.journal_entry_id).id, 'the newer correction is reversed first').toBe(true);
    expect(reversalOf(c2.journal_entry_id).source_id).toBe(c2.id);
    expect(reversalOf(c1.journal_entry_id).source_id).toBe(c1.id);

    const jan = () => asOrgOn(f.orgId, (tx) => D.getSalesRollup(tx, { orgId: f.orgId, storeId: f.storeId, fromDate: '2027-01-01', toDate: '2027-01-31', groupBy: 'month' }));
    const voided = await jan();
    expect(voided.reconciles).toBe(true);
    expect(Number(voided.ledgerTotal)).toBe(0);

    const { id: newDay } = await imp(f, DAY, R1_FIGURES);
    await verify(f, newDay);
    const [net] = await sql<{ n: string }[]>`
      select coalesce(sum(jl.credit - jl.debit), 0)::text as n
        from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
       where je.org_id = ${f.orgId} and je.source_type = 'sale' and a.code in ('4100', '4150')`;
    expect(Number(net!.n)).toBe(1050);
    const after = await jan();
    expect(after.reconciles).toBe(true);
    expect(Number(after.ledgerTotal)).toBe(1050);
  });
});

describe('G - the link\'s sales channel changed after verify', () => {
  it('a correction still posts against the day\'s own channel: no refusal, Dr 4100 50.00 / Cr 1110 50.00', async () => {
    const f = await s6Fixture(sql, 'g1');
    const { dayId, feedId } = await drifted(f);
    const [other] = await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${f.orgId}, ${f.storeId}, 'Dine-in', true) returning id`;
    await sql`update pos_v1_store_links set sales_channel_id = ${other!.id} where store_id = ${f.storeId}`;

    await correct(f, f.manager, { salesDayId: dayId, feedId, entryDate: OPEN_DATE });
    const c = (await corrections(dayId))[0]!;
    expect(lineText(await lines(c.journal_entry_id))).toEqual(['Cr 1110 50.00', 'Dr 4100 50.00']);
    const ch = await sql<{ channel_id: string }[]>`select channel_id from sales_day_channels where sales_day_id = ${dayId}`;
    expect(ch.map((r) => r.channel_id), 'the day keeps its own channel row').toEqual([f.walkInId]);
  });
});
