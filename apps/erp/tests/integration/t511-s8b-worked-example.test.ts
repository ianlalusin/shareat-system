import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import postgres from 'postgres';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * T-511 S8b (8) - THE WORKED EXAMPLE of a weekly Foodpanda statement with three earlier small invoices, to the centavo (synthetic figures; the arithmetic is the proof), through the app's own server actions (the session mocked to a real actor, the database reached
 * through `withOrgPrincipal`, real ingest, real posting; money read back raw).
 *
 *   The weekly 299999000010 (1-7 Nov, Appendix C printing the three earlier items) is built with these figures: Sigma balance 62,000.00, own charges with 12% VAT
 *   1,596.00 (net 1,425.00 + VAT 171.00), the S3 withholding rounding 0.02, and the three small invoices (+89.29, -89.29, +89.29 with their official document numbers, each 100.00 with
 *   VAT) booked first through `bookChargeAction`. The seven days are approved in date order; the last day (the carrier) deposits what Foodpanda pays:
 *       62,000.00 - 1,596.00 - 100.00 - 0.02 = 60,303.98.
 *   The 100.00 the three small charges left on 1220 is cleared (1220 ends at zero), the three links exist, and a second weekly printing the same items nets nothing again.
 *
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);

vi.setConfig({ testTimeout: 240_000, hookTimeout: 90_000 });
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
const act0 = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => act0.actor),
  requireSession: vi.fn(async () => ({ actor: act0.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));

import { closeDb } from '@shareat/db';
import * as D from '@shareat/domain';
import { inMemoryDriver, setStorageDriver } from '@shareat/domain';
import { fpPriorRow } from '../../../../packages/domain/tests/unit/t511-s3-helpers';
import {
  TEST_DOCS, TEST_INVOICES, asOrg, chargeLinks, entryCount, ingest, lineOfDoc, lineOn, netDebit, postedDay, s7World, setDestination, settlementFull, settlementsOf, smallInvoice, weekly, weeklyOrderRow,
  zipFile, type S7World, type WeeklyOrder,
} from '../../../../packages/domain/tests/integration/_fixtures/t511-s8b-world';
import { captureRedirect, outcomeOf } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
setStorageDriver(inMemoryDriver());
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

const ACTIONS = () => import('../../src/app/channel-settlements/review/actions');
type Who = { personId: string; orgId: string };
async function act(who: Who, name: 'approveDayAction' | 'bookChargeAction', fields: Record<string, string>) {
  act0.actor = who;
  const m = (await ACTIONS()) as unknown as Record<string, (f: FormData) => Promise<void>>;
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const o = outcomeOf(await captureRedirect(() => m[name]!(fd)));
  return { path: o.path, nav: o.nav, error: o.flash.error, ok: o.flash.ok, stamp: (o.flash as { stamp?: string }).stamp };
}

/* ---------------------------------------------------------------- the figures of the synthetic weekly */

const PRIOR = [fpPriorRow(TEST_DOCS.original, -100), fpPriorRow(TEST_DOCS.reversal, 100), fpPriorRow(TEST_DOCS.rebill, -100)];
const TARGET_BALANCE = 6200000n; // 62,000.00
const ADS = [200, 150, 175, 125, 100, 225, 250]; // Nov 1 .. Nov 7, net 1,225.00
const FEE = 200; // the weekly platform fee
const DAYS = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'];
const BIG = [1500000n, 1400000n, 1300000n, 1200000n, 1100000n, 1000000n, 900000n];
const SMALL_DAYS = [DAYS[0]!, DAYS[0]!, DAYS[1]!, DAYS[2]!, DAYS[3]!]; // five 100.90 orders: withholding 0.50 each, so the sum rounds 0.02 differently from the rows
const SMALL = 10090n;

/** The week's orders: seven big ones (one a day), five of 100.90, and the LAST big order's commission/tax chosen so the balances add up to exactly 62,000.00. */
function weekOrders(): WeeklyOrder[] {
  const half = (n: bigint, num: bigint, den: bigint): bigint => (2n * n * num + den) / (2n * den);
  const orders: WeeklyOrder[] = [
    ...BIG.slice(0, 6).map((revenue, i) => ({ date: DAYS[i]!, revenue })),
    ...SMALL_DAYS.map((date) => ({ date, revenue: SMALL })),
  ];
  const others = orders.reduce((t, o) => t + weeklyOrderRow('x', o, 'x', 'x').balance, 0n);
  const last = BIG[6]!;
  const withholding = half(last, 5n, 1000n);
  const x = last - withholding - (TARGET_BALANCE - others); // commission + tax of the last order
  const commission = half(x * 100n, 1n, 112n); // about x / 1.12
  const tax = x - commission;
  return [...orders, { date: DAYS[6]!, revenue: last, commission, tax }];
}
const cents = (t: string): bigint => BigInt(t.replace('.', ''));
const money2 = (c: bigint): string => `${c < 0n ? '-' : ''}${(c < 0n ? -c : c) / 100n}.${String((c < 0n ? -c : c) % 100n).padStart(2, '0')}`;

async function smallWorld(hint: string): Promise<S7World> {
  const w = await s7World(sql, `s8b-wx-${hint}`, { loanPeriods: false });
  await setDestination(sql, w, w.fpA);
  return w;
}

/** The three small invoices ingested by the uploader (managerA); `book` of them booked by another manager through `bookChargeAction`. */
async function smallCharges(w: S7World, book: ('original' | 'reversal' | 'rebill')[] = ['original', 'reversal', 'rebill'], real = true): Promise<void> {
  const rows = [
    { which: 'original' as const, net: 89.29, description: real ? 'PandaGO Order-10.31.2026-zz99-test01' : undefined },
    { which: 'reversal' as const, net: -89.29, description: 'Incorrect Invoice Amount Reversal: 299999000001' },
    { which: 'rebill' as const, net: 89.29, description: real ? 'PandaGO Order-10.31.2026-zz99-test01' : undefined },
  ];
  for (const r of rows) await ingest(w, w.managerA, zipFile(smallInvoice({ invoice: TEST_INVOICES[r.which], doc: TEST_DOCS[r.which], net: r.net, ...(r.description ? { description: r.description } : {}) })));
  for (const which of book) {
    const res = await act(w.managerA2, 'bookChargeAction', { otherLineId: await lineOfDoc(sql, w.orgId, TEST_DOCS[which]) });
    expect([res.error, res.ok, res.stamp], which).toEqual([undefined, 'Charge booked.', 'POSTED']);
  }
}

describe('S8b (8) the real weekly of lipa nov 11, to the centavo', () => {
  it('seven days approved in order; the carrier deposits 60,303.98 in all; 1220 ends at zero; three links; 6400 and 6650 hold every fee and the 100.00 of small charges once; the 0.02 is the S3 rounding line [kills: the three earlier charges never netted (a 100.00 variance booked); a charge expensed twice; a deposit that differs from what Foodpanda paid]', async () => {
    const w = await smallWorld('main');
    await smallCharges(w);
    const wk = weekly({ invoice: '299999000010', tag: 'wx-main', orders: weekOrders(), ads: DAYS.map((date, i) => ({ date, net: ADS[i]! })), fee: FEE, prior: PRIOR });
    expect(wk.balance, 'the synthetic week hits the target total').toBe(TARGET_BALANCE);
    // staff recorded exactly the file's figure each day, through the real domain (so each day carries its journal entry)
    const perDay = new Map<string, bigint>();
    for (const o of weekOrders()) perDay.set(o.date, (perDay.get(o.date) ?? 0n) + o.revenue);
    for (const d of DAYS) await postedDay(w, w.fpA, d, money2(perDay.get(d)!));
    await ingest(w, w.managerA, zipFile(wk.zip));

    const staged = await sql<{ sales_date: string; net_payout: string; unexplained: string; platform_fee: string; order_value: string }[]>`
      select sales_date::text, net_payout::text, unexplained::text, platform_fee::text, order_value::text from settlement_day_lines where org_id = ${w.orgId} and is_current order by sales_date`;
    expect(staged.map((s) => s.sales_date)).toEqual(DAYS);
    expect(staged.every((s) => s.unexplained === '0.00')).toBe(true);
    const stagedNet = staged.reduce((t, s) => t + cents(s.net_payout), 0n);
    expect(money2(stagedNet), 'the staged payouts add to 62,000.00 - 1,596.00 - 0.02').toBe('60403.98');
    // the 0.02: the S3 rounding line on the last day, nowhere else
    const rounding = await sql<{ sales: string; amount: string; description: string }[]>`
      select l.sales_date::text as sales, ol.amount::text, ol.description from settlement_other_lines ol join settlement_day_lines l on l.id = ol.day_line_id where ol.org_id = ${w.orgId} and ol.kind = 'adjustment'`;
    expect(rounding).toEqual([{ sales: '2026-11-07', amount: '0.02', description: 'withholding rounding to the PDF total' }]);

    // approve in date order by a manager who did not upload the files
    const results: string[] = [];
    for (const d of DAYS) {
      const line = await lineOn(sql, w.orgId, w.fpA, d);
      const r = await act(w.managerA2, 'approveDayAction', { lineId: line.id });
      expect([d, r.error, r.stamp]).toEqual([d, undefined, 'POSTED']);
      results.push((await lineOn(sql, w.orgId, w.fpA, d)).settlement_id!);
    }
    const sets = await Promise.all(results.map((id) => settlementFull(sql, id)));
    const deposits = sets.map((s) => cents(s.net_deposited));
    expect(sets.map((s) => [s.variance, s.settlement_gain])).toEqual(DAYS.map(() => ['0.00', '0.00']));
    expect(money2(deposits.reduce((t, n) => t + n, 0n)), 'the bank total is what the PDF prints').toBe('60303.98');
    expect(money2(deposits[6]!), 'the carrier deposits its own payout less the 100.00').toBe(money2(cents(staged[6]!.net_payout) - 10000n));
    expect(await netDebit(sql, w.orgId, '1140')).toBe('60303.98');
    expect(await netDebit(sql, w.orgId, '1220'), 'what the three small charges left on 1220 is cleared').toBe('0.00');
    // 6400 holds the commission, the withholding and tax on charges, the weekly fee with its VAT, the rounding and the 100.00 net of the small charges; the CPC ads (1,225.00) go to 6650
    expect(await netDebit(sql, w.orgId, '6400'), 'every fee once + the 100.00 net of the small charges once: sales 84,504.50 - bank 60,303.98 - ads 1,225.00 (1220 ends at zero)').toBe(money2([...perDay.values()].reduce((t, n) => t + n, 0n) - deposits.reduce((t, n) => t + n, 0n) - 122500n));
    expect(await netDebit(sql, w.orgId, '6650'), 'the seven CPC ads, once').toBe('1225.00');
    expect([await netDebit(sql, w.orgId, '6420'), await netDebit(sql, w.orgId, '7100')]).toEqual(['0.00', '0.00']);

    const links = await chargeLinks(sql, w.orgId);
    expect(links).toHaveLength(3);
    expect(new Set(links.map((l) => l.settlement_id))).toEqual(new Set([results[6]]));
    expect(links.map((l) => l.charge_id).sort()).toEqual((await sql<{ id: string }[]>`select id::text from channel_period_charges where org_id = ${w.orgId}`).map((c) => c.id).sort());

    // re-approve: refused, nothing moves
    const before = { entries: await entryCount(sql, w.orgId), settlements: (await settlementsOf(sql, w.orgId)).length };
    const again = await act(w.managerA2, 'approveDayAction', { lineId: (await lineOn(sql, w.orgId, w.fpA, DAYS[6]!)).id });
    expect(again.error).toMatch(/already decided|booked/i);
    expect({ entries: await entryCount(sql, w.orgId), settlements: (await settlementsOf(sql, w.orgId)).length }).toEqual(before);

    // a second weekly that prints the same three items: nothing is netted again
    const wk2 = weekly({ invoice: '299999000011', tag: 'wx-second', orders: [{ date: '2026-11-09', revenue: 100000n }, { date: '2026-11-10', revenue: 100000n }], prior: PRIOR });
    for (const d of ['2026-11-09', '2026-11-10']) await postedDay(w, w.fpA, d, '1000.00');
    await ingest(w, w.managerA, zipFile(wk2.zip));
    for (const d of ['2026-11-09', '2026-11-10']) {
      const r = await act(w.managerA2, 'approveDayAction', { lineId: (await lineOn(sql, w.orgId, w.fpA, d)).id });
      expect([d, r.error, r.stamp]).toEqual([d, undefined, 'POSTED']);
    }
    expect(await chargeLinks(sql, w.orgId), 'still the first payout\'s three links').toHaveLength(3);
    const last = (await settlementsOf(sql, w.orgId)).at(-1)!;
    expect((await settlementFull(sql, last.id)).net_deposited, 'the second weekly deposits its own net, no -100.00').toBe('771.00');
  });

  it('audit 5: while ANY blocker holds the carrier day, the earlier charges say "Not settled yet - see the reason above", not "Settled by this payout"; once clear they say it again; the printed items read "deducted 100.00" [kills: a screen promising a settlement a blocker is stopping]', async () => {
    const w = await smallWorld('panel');
    await smallCharges(w, ['original', 'reversal']); // the re-bill is on file but not booked: a blocker
    for (const d of ['2026-11-02', '2026-11-03']) await postedDay(w, w.fpA, d, '1000.00');
    await ingest(w, w.managerA, zipFile(weekly({ invoice: '299999000010', tag: 'wx-panel', orders: [{ date: '2026-11-02', revenue: 100000n }, { date: '2026-11-03', revenue: 100000n }], prior: PRIOR }).zip));
    const d2 = await lineOn(sql, w.orgId, w.fpA, '2026-11-03');
    const { DayDetail } = await import('../../src/app/channel-settlements/review/DayDetail');
    const html = async () => renderToStaticMarkup(h(DayDetail, { detail: (await asOrg(w.orgId, (tx) => D.getReviewDayDetail(tx, w.managerA2, { lineId: d2.id })))!, access: { canReject: true, canReopen: false, canOverrideLoans: false }, loans: [], backHref: '/x', filters: {}, ack: null }));
    const held = await html();
    expect(held).toContain('Not settled yet - see the reason above');
    expect(held).not.toContain('Settled by this payout');
    expect(held).toContain(`document ${TEST_DOCS.original} (deducted`);
    expect(held).not.toMatch(/\(-[₱\d]/);
    expect((await act(w.managerA2, 'bookChargeAction', { otherLineId: await lineOfDoc(sql, w.orgId, TEST_DOCS.rebill), lineId: d2.id })).stamp).toBe('POSTED');
    await act(w.managerA2, 'approveDayAction', { lineId: (await lineOn(sql, w.orgId, w.fpA, '2026-11-02')).id });
    const clear = await html();
    expect(clear).toContain('Settled by this payout');
    expect(clear).not.toContain('Not settled yet');
  });

  it('the screen of the carrier day shows what is settled from earlier invoices, by invoice number, and the earlier items the statement printed [kills: an earlier charge netted that nobody can see]', async () => {
    const w = await smallWorld('screen');
    await smallCharges(w);
    for (const d of ['2026-11-02', '2026-11-03']) await postedDay(w, w.fpA, d, '1000.00');
    await ingest(w, w.managerA, zipFile(weekly({ invoice: '299999000010', tag: 'wx-screen', orders: [{ date: '2026-11-02', revenue: 100000n }, { date: '2026-11-03', revenue: 100000n }], prior: PRIOR }).zip));
    const d2 = await lineOn(sql, w.orgId, w.fpA, '2026-11-03');
    const detail = (await asOrg(w.orgId, (tx) => D.getReviewDayDetail(tx, w.managerA2, { lineId: d2.id })))!;
    expect(detail.isCarrier).toBe(true);
    expect(detail.carrierNote).toBe("This payout also settles 3 charges from earlier invoices. The bank deposit is the file's net minus 100.00.");
    expect(detail.earlierCharges.map((e) => [e.invoiceNumber, e.document, e.total, e.netted]).sort()).toEqual(
      [[TEST_INVOICES.original, TEST_DOCS.original, '100.00', false], [TEST_INVOICES.reversal, TEST_DOCS.reversal, '-100.00', false], [TEST_INVOICES.rebill, TEST_DOCS.rebill, '100.00', false]].sort(),
    );
    expect(detail.priorItems).toEqual([{ document: TEST_DOCS.original, amount: '-100.00' }, { document: TEST_DOCS.reversal, amount: '100.00' }, { document: TEST_DOCS.rebill, amount: '-100.00' }]);
    const { DayDetail } = await import('../../src/app/channel-settlements/review/DayDetail');
    const html = renderToStaticMarkup(h(DayDetail, { detail, access: { canReject: true, canReopen: false, canOverrideLoans: false }, loans: [], backHref: '/x', filters: {}, ack: null }));
    expect(html).toContain('From earlier invoices');
    expect(html).toContain(`Invoice ${TEST_INVOICES.rebill}`);
    expect(html, 'the earlier day is still waiting, so a blocker holds this day: nothing is promised yet').toContain('Not settled yet - see the reason above');
    // the first day is not the carrier: no earlier list
    const d1 = await lineOn(sql, w.orgId, w.fpA, '2026-11-02');
    const first = (await asOrg(w.orgId, (tx) => D.getReviewDayDetail(tx, w.managerA2, { lineId: d1.id })))!;
    expect([first.isCarrier, first.earlierCharges, first.priorItems]).toEqual([false, [], []]);
  });
});

describe('S8b (6) the carrier note when the payout settles its own invoice\'s charge AND earlier invoices\'', () => {
  it('"4 charges (1 of this invoice and 3 from earlier invoices) ... minus 212.00" and the deposit really is the file\'s net minus 212.00 [kills: the note counting only one side; a deposit that differs from the note]', async () => {
    const w = await smallWorld('mixed');
    await smallCharges(w);
    for (const d of ['2026-11-02', '2026-11-03']) await postedDay(w, w.fpA, d, '1000.00');
    await ingest(w, w.managerA, zipFile(weekly({
      invoice: '299999000010', tag: 'wx-mixed', orders: [{ date: '2026-11-02', revenue: 100000n }, { date: '2026-11-03', revenue: 100000n }], prior: PRIOR,
      other: [{ category: 'Admin Adjustment Fee', description: 'Admin Adjustment Fee', net: 100 }],
    }).zip));
    const [own] = await sql<{ id: string }[]>`select id::text from settlement_other_lines where org_id = ${w.orgId} and kind = 'period_charge' and description = 'Admin Adjustment Fee'`;
    const d2 = await lineOn(sql, w.orgId, w.fpA, '2026-11-03');
    expect((await act(w.managerA2, 'bookChargeAction', { otherLineId: own!.id, lineId: d2.id })).stamp).toBe('POSTED');
    const detail = (await asOrg(w.orgId, (tx) => D.getReviewDayDetail(tx, w.managerA2, { lineId: d2.id })))!;
    expect(detail.carrierNote).toBe("This payout also settles 4 charges (1 of this invoice and 3 from earlier invoices). The bank deposit is the file's net minus 212.00.");
    expect((await act(w.managerA2, 'approveDayAction', { lineId: (await lineOn(sql, w.orgId, w.fpA, '2026-11-02')).id })).stamp).toBe('POSTED');
    expect((await act(w.managerA2, 'approveDayAction', { lineId: d2.id })).stamp).toBe('POSTED');
    const last = (await settlementsOf(sql, w.orgId)).at(-1)!;
    expect((await settlementFull(sql, last.id)).net_deposited).toBe('559.00'); // 771.00 - 212.00
    expect(await chargeLinks(sql, w.orgId)).toHaveLength(4);
  });
});

describe('S8b (8) negative controls through the action: the carrier is refused, nothing is written', () => {
  async function carrierWorld(hint: string, prior: ReturnType<typeof fpPriorRow>[], book?: ('original' | 'reversal' | 'rebill')[]) {
    const w = await smallWorld(hint);
    await smallCharges(w, book);
    for (const d of ['2026-11-02', '2026-11-03']) await postedDay(w, w.fpA, d, '1000.00');
    await ingest(w, w.managerA, zipFile(weekly({ invoice: '299999000010', tag: `wx-${hint}`, orders: [{ date: '2026-11-02', revenue: 100000n }, { date: '2026-11-03', revenue: 100000n }], prior }).zip));
    const first = await act(w.managerA2, 'approveDayAction', { lineId: (await lineOn(sql, w.orgId, w.fpA, '2026-11-02')).id });
    expect(first.error).toBeUndefined();
    return { w, carrier: (await lineOn(sql, w.orgId, w.fpA, '2026-11-03')).id };
  }
  const snap = async (orgId: string) => ({ entries: await entryCount(sql, orgId), settlements: (await settlementsOf(sql, orgId)).length, links: (await chargeLinks(sql, orgId)).length });

  it('a document that is not on file [kills: a payout booked around a hole]', async () => {
    const { w, carrier } = await carrierWorld('missing', [fpPriorRow(TEST_DOCS.original, -100), fpPriorRow(TEST_DOCS.reversal, 100), fpPriorRow('2000000009999990', -100)]);
    const before = await snap(w.orgId);
    const r = await act(w.managerA2, 'approveDayAction', { lineId: carrier });
    expect(r.error).toMatch(/no charge with that document number is on file/);
    expect(r.error).toContain('2000000009999990');
    expect(r.ok).toBeUndefined();
    expect(await snap(w.orgId)).toEqual(before);
  });

  it('an amount that does not match the charges on file [kills: a payout that guesses]', async () => {
    const { w, carrier } = await carrierWorld('amount', [fpPriorRow(TEST_DOCS.original, -100), fpPriorRow(TEST_DOCS.reversal, 100), fpPriorRow(TEST_DOCS.rebill, -90)]);
    const before = await snap(w.orgId);
    const r = await act(w.managerA2, 'approveDayAction', { lineId: carrier });
    expect(r.error).toBe('Foodpanda says this payout settles earlier items worth 90.00 deducted, but the charges on file add up to 100.00 deducted (document 2999999900000003). Check that the right invoices were uploaded, or reject this day.');
    expect(await snap(w.orgId)).toEqual(before);
  });

  it('a matching charge that is on file but not booked [kills: an unbooked charge skipped]', async () => {
    const { w, carrier } = await carrierWorld('unbooked', PRIOR, ['original', 'reversal']);
    const before = await snap(w.orgId);
    const r = await act(w.managerA2, 'approveDayAction', { lineId: carrier });
    expect(r.error).toMatch(/not booked yet. Book it first/);
    expect(await snap(w.orgId)).toEqual(before);
    // booking it through the action releases the carrier
    const booked = await act(w.managerA2, 'bookChargeAction', { otherLineId: await lineOfDoc(sql, w.orgId, TEST_DOCS.rebill), lineId: carrier });
    expect([booked.error, booked.stamp]).toEqual([undefined, 'POSTED']);
    expect((await act(w.managerA2, 'approveDayAction', { lineId: carrier })).stamp).toBe('POSTED');
  });
});

describe('S8b (7) a late charge through the action: the message says which month it went into', () => {
  it('an October charge booked in November after October closed: "Charge booked." and the sentence with both dates, and the charges panel says it too [kills: a silent move into another month]', async () => {
    const w = await smallWorld('late');
    await ingest(w, w.managerA, zipFile(smallInvoice({ invoice: TEST_INVOICES.original, doc: TEST_DOCS.original, net: 89.29, date: '2026-10-20' })));
    await sql`update fiscal_periods set status = 'closed' where org_id = ${w.orgId} and starts_on = '2026-10-01'`;
    const res = await act(w.managerA2, 'bookChargeAction', { otherLineId: await lineOfDoc(sql, w.orgId, TEST_DOCS.original) });
    expect(res.error).toBeUndefined();
    expect(res.stamp).toBe('POSTED');
    expect(res.ok).toMatch(/^Charge booked\. Dated .* instead of .*: October 2026 is closed\.$/);
    const [c] = await sql<{ charge_date: string; entry_date: string }[]>`select charge_date::text, entry_date::text from channel_period_charges where org_id = ${w.orgId}`;
    expect(c!.charge_date).toBe('2026-10-20');
    expect(c!.entry_date > '2026-10-31').toBe(true);
    const charges = await asOrg(w.orgId, (tx) => D.listPeriodCharges(tx, w.managerA2));
    expect(charges).toHaveLength(1);
    expect(charges[0]!.state).toBe('booked');
    expect(charges[0]!.dateNote).toMatch(/instead of .*: October 2026 is closed\.$/);
  });
});
