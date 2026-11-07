import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-511 S6c (TESTER, 7 Nov 2026) - the double-count rule: a payout that the platform already netted a period charge out of must not expense that charge a second time.
 * docs/tasks/511-settlement-upload-s6c-spec.md Design D (BOSS: "a later payout must not expense it again, and that must be tested") and Design E (readers).
 * Real Postgres, real posting; the charge is posted through `postPlatformCharge`, the payout through `recordChannelSettlement`.
 *
 * THE WORKED EXAMPLE (spec): staff day 12 Oct 10,000 (day fees 2,000 incl. VAT, no loan) and another unsettled day 13 Oct 9,000; weekly charge net 100 + VAT 12 = 112 posted
 * (Dr 6400 112 / Cr 1220 112). The platform pays 10,000 - 2,000 - 112 = 7,888. With `settleChargeIds [c]`: Dr 1140 7,888 / Dr 6400 2,000 / Cr 1220 9,888, no difference,
 * 6400 total 2,112, 1220 control 0.00 once both days are cleared.
 *
 * RED TODAY, for one reason: `postPlatformCharge` and `settleChargeIds` do not exist (and migration 0244). Every leg posts the charge through the lazily loaded module first.
 *
 * PINNED (the builder meets these or asks BOSS to change the tests; the spec leaves each open):
 *  N1  `recordChannelSettlement` / `previewChannelSettlement` take `settleChargeIds?: string[]` (charge ids = `channel_period_charges.id`, what `postPlatformCharge` returns as chargeId).
 *  N2  ⚠️ the stored `channel_settlements.outstanding_cleared` is the amount actually CREDITED to 1220 (9,888.00 in the example), NOT min(owedGross, gross) = 10,000.00: the
 *      existing DB CHECK `channel_settlements_identity_check` (outstanding_cleared + gain = fees + variance + loan + net_deposited, within 0.005) refuses 10,000.00 against
 *      2,000 + 7,888. The spec's `outstandingCleared = min(owedGross, gross)` then `1220 credit = outstandingCleared - C` is therefore a local variable, not the stored column;
 *      the preview's `outstandingCleared` equals the stored column (preview == post). See the report.
 *  N3  a refusal is a plain sentence naming the charge (no UUID); the preview collects it as a blocker, the posting throws it, and nothing is written (no settlement, no link, no entry).
 *  N4  a link counts only while its settlement is not voided; the links of a voided settlement stay as history.
 *
 * MUTANTS are named in each title `[kills: ...]`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import * as D from '@shareat/domain';
import {
  CHARGE_DATE, DATE, DATE2, SETTLED, UUID_RE, addGrabChannel, asOrg, entryCount, linesOf, lineText, links, netDebit, periodCharge, postCharge, rawOtherLine, sentenceOf,
  settlements, world, type World,
} from './_fixtures/t511-s6c-world';

const sql = postgres(url, { max: 8 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

/** Day 1 of the worked example: gross 10,000, day fees 2,000 (one platform-fee deduction, VAT inside it), the deposit net of the 112 charge. */
const day1 = (f: World, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  storeId: f.storeA, channelId: f.channelId, salesDayId: f.dayId, businessDate: DATE, grossAmount: '10000.00', netDeposited: '7888.00', deductions: { platformFee: '2000.00' },
  settledOn: SETTLED, ...over,
});
/** Day 2: 9,000, nothing deducted, nothing netted. */
const day2 = (f: World, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  storeId: f.storeA, channelId: f.channelId, salesDayId: f.day2Id, businessDate: DATE2, grossAmount: '9000.00', netDeposited: '9000.00', settledOn: SETTLED, ...over,
});
const record = (f: World, who: Actor, input: Record<string, unknown>) =>
  asOrg(f.orgId, (tx) => D.recordChannelSettlement(tx, who, input as never));
const preview = (f: World, who: Actor, input: Record<string, unknown>) => {
  const { salesDayId: _d, settledOn: _s, ...rest } = input;
  return asOrg(f.orgId, (tx) => D.previewChannelSettlement(tx, who, rest as never));
};
/** The world of the worked example with the 112 charge posted: returns the charge id. */
async function chargeWorld(hint: string, two = true): Promise<{ f: World; chargeId: string; otherLine: string }> {
  const f = await world(sql, hint, two ? { staff: '10000.00', staff2: '9000.00' } : { staff: '10000.00' });
  const otherLine = await periodCharge(sql, f);
  const res = await postCharge(f, f.admin, otherLine);
  expect(res.posted, 'control: the charge posted').toBe(true);
  return { f, chargeId: res.chargeId!, otherLine };
}
const controls = async (f: World) => ({
  c1220: await netDebit(sql, f.orgId, '1220'), c6400: await netDebit(sql, f.orgId, '6400'), c6420: await netDebit(sql, f.orgId, '6420'), c7100: await netDebit(sql, f.orgId, '7100'),
});

describe('S6c worked example, WITH settleChargeIds: the charge is expensed once', () => {
  it('payout 7,888 for day 1 netting the 112 charge: preview and posting agree; Dr 1140 7,888.00 / Dr 6400 2,000.00 / Cr 1220 9,888.00; difference 0, no acknowledgement; the link is written; 6400 totals 2,112.00; then day 2 clears 1220 to exactly 0.00 [kills: the charge expensed a second time as 6420 112; a credit of 10,000 (1220 left at -112); no link; a preview that disagrees with the posting; a stored outstanding_cleared that breaks the identity CHECK]', async () => {
    const { f, chargeId } = await chargeWorld('with');
    expect((await controls(f)).c1220, 'control: 19,000 raised, 112 credited').toBe('18888.00');

    const input = day1(f, { settleChargeIds: [chargeId] });
    const p = await preview(f, f.admin, input);
    expect(p.blockers, 'nothing blocks it').toEqual([]);
    expect([p.difference, p.differenceSign, p.needsAcknowledgement, p.variance, p.settlementGain]).toEqual(['0.00', 'none', false, '0.00', '0.00']);
    expect([p.feesTotal, p.netDeposited]).toEqual(['2000.00', '7888.00']);

    const res = await record(f, f.admin, input);
    const rows = await settlements(sql, f.orgId);
    expect(rows).toHaveLength(1);
    const s = rows[0]!;
    expect(s.status).toBe('posted');
    expect([s.variance, s.settlement_gain, s.difference_reason]).toEqual(['0.00', '0.00', null]);
    expect(s.outstanding_cleared, 'N2: the stored figure is what was credited to 1220').toBe('9888.00');
    expect(p.outstandingCleared, 'preview == post').toBe(s.outstanding_cleared);
    expect([p.variance, p.settlementGain, p.feesTotal, p.netDeposited]).toEqual([s.variance, s.settlement_gain, '2000.00', s.net_deposited]);

    expect(lineText(await linesOf(sql, res.entryId))).toEqual(['Cr 1220 9888.00', 'Dr 1140 7888.00', 'Dr 6400 2000.00']);
    expect(await links(sql, f.orgId)).toEqual([{ settlement_id: s.id, charge_id: chargeId }]);
    expect(await controls(f)).toEqual({ c1220: '9000.00', c6400: '2112.00', c6420: '0.00', c7100: '0.00' });

    await record(f, f.admin, day2(f));
    expect(await controls(f), '1220 ends at exactly 0.00; the charge was expensed once').toEqual({ c1220: '0.00', c6400: '2112.00', c6420: '0.00', c7100: '0.00' });
    const aging = await asOrg(f.orgId, (tx) => D.getArAgingReport(tx, { orgId: f.orgId, storeId: f.storeA, asOfDate: '2026-10-31' }));
    expect(aging.platform.controlBalance).toBe('0.00');
    expect(aging.platform.rows.filter((r) => r.channelId === f.channelId), 'the channel owes nothing and shows no row').toEqual([]);
  });
});

describe('S6c worked example, WITHOUT settleChargeIds (the negative control): the charge is expensed twice', () => {
  it('the same 7,888 payout and no ids: a 112.00 SHORT difference; posting it books 6420 112.00 on top of the 6400 112.00 of the charge (2,224.00 of cost for 2,112.00 of fees): exactly the double count the feature prevents [kills: a negative control that no longer reproduces the defect, so the WITH test proves nothing]', async () => {
    const { f } = await chargeWorld('without');
    const input = day1(f);
    const p = await preview(f, f.admin, input);
    expect([p.difference, p.differenceSign, p.variance]).toEqual(['112.00', 'short', '112.00']);
    // SPEC AMBIGUITY (see the report): at the default rules (floor 50.00, 10 percent of gross) the tolerance on a 10,000.00 payout is 1,000.00, so 112.00 is WITHIN it and needs no
    // acknowledgement. The spec says "past tolerance needing acknowledgement"; that does not hold at the defaults. What is pinned is the number.
    expect(Number(p.tolerance), 'the default tolerance is far above 112.00').toBeGreaterThan(112);
    expect(p.needsAcknowledgement).toBe(false);

    const res = await record(f, f.admin, input);
    expect(lineText(await linesOf(sql, res.entryId))).toEqual(['Cr 1220 10000.00', 'Dr 1140 7888.00', 'Dr 6400 2000.00', 'Dr 6420 112.00']);
    const c = await controls(f);
    expect(c.c6420, 'the shortfall IS the charge again').toBe('112.00');
    expect(c.c6400, 'the charge once (112) plus the day fees (2,000)').toBe('2112.00');
    expect(Number(c.c6400) + Number(c.c6420), 'cost recognised for 2,112.00 of fees').toBe(2224);
    expect(await links(sql, f.orgId), 'no charge was netted').toEqual([]);
  });
});

describe('S6c single day: the whole receivable is this day', () => {
  it('only day 1 exists (1220 is 9,888.00 after the charge): with the id the payout credits 9,888.00, difference 0, 1220 ends at 0.00, 6400 is 2,112.00 and nothing is swept to 6420 [kills: owedGross not used (a nothing-outstanding refusal or a shortfall); the link missing]', async () => {
    const { f, chargeId } = await chargeWorld('single', false);
    expect((await controls(f)).c1220).toBe('9888.00');
    const p = await preview(f, f.admin, day1(f, { settleChargeIds: [chargeId] }));
    expect(p.blockers).toEqual([]);
    expect([p.difference, p.differenceSign]).toEqual(['0.00', 'none']);
    const res = await record(f, f.admin, day1(f, { settleChargeIds: [chargeId] }));
    expect(lineText(await linesOf(sql, res.entryId))).toEqual(['Cr 1220 9888.00', 'Dr 1140 7888.00', 'Dr 6400 2000.00']);
    expect(await controls(f)).toEqual({ c1220: '0.00', c6400: '2112.00', c6420: '0.00', c7100: '0.00' });
    expect((await links(sql, f.orgId)).map((l) => l.charge_id)).toEqual([chargeId]);
  });

  it('control, no charge at all: the existing behaviour is unchanged: gross 10,000 net 8,000 fees 2,000 credits 10,000.00 and settleChargeIds [] is the same as absent [kills: an empty list read as an error or as a charge; a regression of the plain settlement]', async () => {
    const f = await world(sql, 'plain', { staff: '10000.00' });
    const res = await record(f, f.admin, day1(f, { netDeposited: '8000.00', settleChargeIds: [] }));
    expect(lineText(await linesOf(sql, res.entryId))).toEqual(['Cr 1220 10000.00', 'Dr 1140 8000.00', 'Dr 6400 2000.00']);
    expect(await links(sql, f.orgId)).toEqual([]);
    expect((await controls(f)).c1220).toBe('0.00');
  });
});

describe('S6c a zero 1220 credit is never posted (audit MEDIUM, 7 Nov)', () => {
  it('P1: gross equals the netted charge (112.00), nothing deposited: the preview blocks in plain words, the posting refuses in the same words (never a raw database error), nothing written [kills: a zero credit line that hits journal_lines_exactly_one_side_check; a preview that says clear]', async () => {
    const f = await world(sql, 'zero1', { staff: '112.00' });
    const ol = await periodCharge(sql, f);
    const charge = await postCharge(f, f.admin, ol);
    const input = { storeId: f.storeA, channelId: f.channelId, salesDayId: f.dayId, businessDate: DATE, grossAmount: '112.00', netDeposited: '0.00', settledOn: SETTLED, settleChargeIds: [charge.chargeId!] };
    const p = await preview(f, f.admin, input);
    expect(p.blockers.length, 'the preview must not say clear').toBeGreaterThan(0);
    const before = await entryCount(sql, f.orgId);
    const sentence = await sentenceOf(record(f, f.admin, input));
    expect(sentence).toContain(p.blockers[0]!);
    expect(sentence).not.toMatch(/journal_lines|check constraint|violates|undefined|\[object/i);
    expect(sentence).not.toMatch(UUID_RE);
    expect(await settlements(sql, f.orgId)).toHaveLength(0);
    expect(await links(sql, f.orgId)).toHaveLength(0);
    expect(await entryCount(sql, f.orgId)).toBe(before);
  });

  it('P2: deposit 112.00 against the same day and charge, difference acknowledged: preview and posting agree, no 1220 line is posted, 1220 ends at 0.00, 1140 gets 112.00 [kills: a zero credit line; a preview that differs from the posting]', async () => {
    const f = await world(sql, 'zero2', { staff: '112.00' });
    const ol = await periodCharge(sql, f);
    const charge = await postCharge(f, f.admin, ol);
    const input = {
      storeId: f.storeA, channelId: f.channelId, salesDayId: f.dayId, businessDate: DATE, grossAmount: '112.00', netDeposited: '112.00', settledOn: SETTLED,
      settleChargeIds: [charge.chargeId!], acknowledgeDifference: { reason: 'The platform paid the charge back to us' },
    };
    const p = await preview(f, f.admin, input);
    expect(p.blockers, 'the preview is clear').toEqual([]);
    expect(p.outstandingCleared).toBe('0.00');
    const res = await record(f, f.admin, input);
    const [row] = await settlements(sql, f.orgId);
    expect(row!.outstanding_cleared).toBe(p.outstandingCleared);
    expect(row!.settlement_gain).toBe('112.00');
    expect(await netDebit(sql, f.orgId, '1220'), '1220 is 0.00: the day 112 less the charge 112, no settlement line').toBe('0.00');
    expect(await netDebit(sql, f.orgId, '1140')).toBe('112.00');
    const lines = await linesOf(sql, res.entryId);
    expect(lines.filter((l) => l.code === '1220'), 'no 1220 line on the settlement entry').toHaveLength(0);
  });
});

describe('S6c ruling 5: a charge named twice counts once', () => {
  it('settleChargeIds [c, c, C-in-capitals] is the same as [c]: one 112.00 netted, the preview and the posting agree with the worked example, exactly one link [kills: no de-duplication (C = 336.00: a 1220 credit of 9,664.00, a 224.00 gain, or a primary-key crash on the second link)]', async () => {
    const { f, chargeId } = await chargeWorld('dupes');
    const input = day1(f, { settleChargeIds: [chargeId, chargeId, chargeId.toUpperCase()] });
    const p = await preview(f, f.admin, input);
    expect(p.blockers).toEqual([]);
    expect([p.outstandingCleared, p.difference, p.differenceSign]).toEqual(['9888.00', '0.00', 'none']);
    const res = await record(f, f.admin, input);
    expect(lineText(await linesOf(sql, res.entryId))).toEqual(['Cr 1220 9888.00', 'Dr 1140 7888.00', 'Dr 6400 2000.00']);
    expect((await links(sql, f.orgId)).map((l) => l.charge_id)).toEqual([chargeId]);
  });
});

describe('S6c what a settlement may not net (plain sentence, nothing written)', () => {
  async function refusedEverywhere(f: World, input: Record<string, unknown>, want: RegExp): Promise<void> {
    const before = await entryCount(sql, f.orgId);
    const rowsBefore = (await settlements(sql, f.orgId)).length;
    const linksBefore = (await links(sql, f.orgId)).length;
    const p = await preview(f, f.admin, input);
    expect(p.blockers.length, 'the preview says why').toBeGreaterThan(0);
    expect(p.blockers.join(' | ')).toMatch(want);
    expect(p.blockers.join(' | ')).not.toMatch(UUID_RE);
    const sentence = await sentenceOf(record(f, f.admin, input));
    expect(sentence).toMatch(want);
    expect(sentence).not.toMatch(UUID_RE);
    expect(await entryCount(sql, f.orgId), 'no entry').toBe(before);
    expect((await settlements(sql, f.orgId)).length, 'no settlement row').toBe(rowsBefore);
    expect((await links(sql, f.orgId)).length, 'no link').toBe(linksBefore);
  }

  it('a charge bigger than the payout\'s gross (112.00 against gross 100.00) is refused: it would drive the 1220 credit negative [kills: a negative credit; a settlement netting more than it settles]', async () => {
    const { f, chargeId } = await chargeWorld('toobig');
    await refusedEverywhere(f, day1(f, { grossAmount: '100.00', netDeposited: '100.00', deductions: {}, settleChargeIds: [chargeId] }), /charge/i);
  });

  it('a charge of ANOTHER channel (a Grab charge named on a Foodpanda payout) is refused [kills: netting the wrong platform\'s credit]', async () => {
    const { f } = await chargeWorld('otherchannel');
    const grab = await addGrabChannel(sql, f);
    const gl = await rawOtherLine(sql, { orgId: f.orgId, storeId: f.storeA, channelId: grab, platform: 'grab', personId: f.admin.personId, net: '100.00', vat: '12.00' });
    const posted = await postCharge(f, f.admin, gl);
    expect(posted.posted, 'control: the Grab charge posted').toBe(true);
    await refusedEverywhere(f, day1(f, { settleChargeIds: [posted.chargeId!] }), /charge/i);
  });

  it('an id that is not a posted charge, and the charge of ANOTHER org, are refused [kills: a crash; a cross-org link; netting a charge that was never booked]', async () => {
    const { f } = await chargeWorld('unknown');
    const g = await chargeWorld('foreign');
    await refusedEverywhere(f, day1(f, { settleChargeIds: [crypto.randomUUID()] }), /charge/i);
    await refusedEverywhere(f, day1(f, { settleChargeIds: [g.chargeId] }), /charge/i);
  });

  it('a staged line that was never posted (its id given as if it were a charge) is refused [kills: confusing the other line with the charge]', async () => {
    const { f } = await chargeWorld('unposted');
    const staged = await periodCharge(sql, f, { net: '50.00', vat: '6.00' });
    await refusedEverywhere(f, day1(f, { settleChargeIds: [staged] }), /charge/i);
  });

  it('a charge already netted by a NON-VOIDED settlement is refused the second time; voiding that settlement frees it; its first link stays as history and the freed charge nets again [kills: one charge expensed against two payouts; a link that outlives its void and locks the charge forever; a deleted link]', async () => {
    const { f, chargeId } = await chargeWorld('twice');
    const first = await record(f, f.admin, day1(f, { settleChargeIds: [chargeId] }));
    const second = day2(f, { netDeposited: '8888.00', settleChargeIds: [chargeId] });
    await refusedEverywhere(f, second, /charge|already/i);

    await asOrg(f.orgId, (tx) => D.voidChannelSettlement(tx, f.admin, { settlementId: first.settlementId, reason: 'wrong deposit typed' }));
    expect((await controls(f)).c1220, 'control: the void put the 9,888.00 back').toBe('18888.00');
    const p = await preview(f, f.admin, second);
    expect(p.blockers, 'free again').toEqual([]);
    expect([p.difference, p.differenceSign]).toEqual(['0.00', 'none']);
    const res = await record(f, f.admin, second);
    expect(lineText(await linesOf(sql, res.entryId))).toEqual(['Cr 1220 8888.00', 'Dr 1140 8888.00']);
    const ls = await links(sql, f.orgId);
    expect(ls.map((l) => l.settlement_id).sort(), 'both links stay, the first as history').toEqual([first.settlementId, res.settlementId].sort());
    expect(ls.every((l) => l.charge_id === chargeId)).toBe(true);
    expect((await controls(f)).c6400, 'the fees of day 1 were reversed with the void; the charge stands once').toBe('112.00');
  });
});

describe('S6c the preview is the posting', () => {
  it('every figure the preview shows equals what the posting stored, with and without ids [kills: a second copy of the arithmetic (computeSettlement is the only one)]', async () => {
    const a = await chargeWorld('same-with');
    const pa = await preview(a.f, a.f.admin, day1(a.f, { settleChargeIds: [a.chargeId] }));
    await record(a.f, a.f.admin, day1(a.f, { settleChargeIds: [a.chargeId] }));
    const sa = (await settlements(sql, a.f.orgId))[0]!;
    expect([pa.outstandingCleared, pa.variance, pa.settlementGain, pa.netDeposited]).toEqual([sa.outstanding_cleared, sa.variance, sa.settlement_gain, sa.net_deposited]);

    const b = await chargeWorld('same-without');
    const pb = await preview(b.f, b.f.admin, day1(b.f));
    await record(b.f, b.f.admin, day1(b.f));
    const sb = (await settlements(sql, b.f.orgId))[0]!;
    expect([pb.outstandingCleared, pb.variance, pb.settlementGain, pb.netDeposited]).toEqual([sb.outstanding_cleared, sb.variance, sb.settlement_gain, sb.net_deposited]);
    expect(sb.variance).toBe('112.00');
  });
});

describe('S6c readers: the platform receivable and the sales reports', () => {
  const aging = (f: World, asOf = '2026-10-31') => asOrg(f.orgId, (tx) => D.getArAgingReport(tx, { orgId: f.orgId, storeId: f.storeA, asOfDate: asOf }));

  it('before any payout: the channel owes 19,000 less the 112 credit = 18,888.00 and the row ties to the control balance; after the day-1 payout that netted the charge it owes 9,000.00 [kills: a credit that falls out of the platform aging (19,000); a control that does not tie]', async () => {
    const { f, chargeId } = await chargeWorld('aging');
    const before = await aging(f);
    const row = before.platform.rows.find((r) => r.channelId === f.channelId)!;
    expect(row.total).toBe('18888.00');
    expect([before.platform.controlBalance, before.platform.reconciles]).toEqual(['18888.00', true]);

    await record(f, f.admin, day1(f, { settleChargeIds: [chargeId] }));
    const mid = await aging(f);
    expect(mid.platform.rows.find((r) => r.channelId === f.channelId)!.total).toBe('9000.00');
    expect([mid.platform.controlBalance, mid.platform.reconciles]).toEqual(['9000.00', true]);
  });

  it('a charge posted before any sales day is verified: the credit shows as a credit (-112.00 in the current bucket) and the row ties [kills: a credit-only channel that vanishes from the aging]', async () => {
    const f = await world(sql, 'creditonly', { staff: '10000.00' });
    // a different channel with no sale at all: only the charge
    const grab = await addGrabChannel(sql, f);
    const gl = await rawOtherLine(sql, { orgId: f.orgId, storeId: f.storeA, channelId: grab, platform: 'grab', personId: f.admin.personId, net: '100.00', vat: '12.00' });
    expect((await postCharge(f, f.admin, gl)).posted).toBe(true);
    const r = await aging(f);
    const row = r.platform.rows.find((x) => x.channelId === grab)!;
    expect(row, 'the Grab channel shows its credit').toBeDefined();
    expect(row.total).toBe('-112.00');
    expect(r.platform.reconciles).toBe(true);
  });

  it('the sales reports do not count a charge as revenue or reduce it: the October rollup reconciles at 19,000.00 before and after the charge and the payout [kills: a channel_charge entry leaking into the sales report (its 1220 credit read as a sale)]', async () => {
    const f = await world(sql, 'report', { staff: '10000.00', staff2: '9000.00' });
    const rollup = () => asOrg(f.orgId, (tx) => D.getSalesRollup(tx, { orgId: f.orgId, storeId: f.storeA, fromDate: '2026-10-01', toDate: '2026-10-31', groupBy: 'month' } as never));
    const pre = await rollup();
    expect([pre.reconciles, Number(pre.ledgerTotal)], 'control: before the charge').toEqual([true, 19000]);
    const ol = await periodCharge(sql, f);
    const posted = await postCharge(f, f.admin, ol);
    expect(posted.posted).toBe(true);
    await record(f, f.admin, day1(f, { settleChargeIds: [posted.chargeId!] }));
    const post = await rollup();
    expect(post.reconciles).toBe(true);
    expect(Number(post.ledgerTotal)).toBe(19000);
    expect(Number(post.channels.find((c) => c.channelId === f.channelId)!.total)).toBe(19000);
    expect(CHARGE_DATE >= '2026-10-01' && CHARGE_DATE <= '2026-10-31', 'control: the charge is inside the window it must not change').toBe(true);
  });
});
