/**
 * T-511 S6c (TESTER, 7 Nov 2026) - staging stores the VAT of a charge that has no sales day. docs/tasks/511-settlement-upload-s6c-spec.md Design A: "`stage.ts` computes it for
 * `period_charge` lines with the SAME formula as `vatOnFeesOf` (netTotal x vatRate/100, half up, once) via a shared helper (one copy); `ingest.ts` writes it."
 *
 * RED TODAY, for one reason: a staged other line has no VAT at all (`StagedOtherLine` is kind / bookedAs / amount / lineDate / description), so the period line carries nothing
 * to book. (The write to the table is `t511-s6c-post-platform-charge.test.ts`, last describe.)
 *
 * PINNED (the spec names no field; the builder meets this or asks BOSS to change the tests):
 *  V1  `StagedOtherLine` gains `vat: Money` (the staged VAT of THAT line, 2 decimals, the same sign as `amount`), set for every `period_charge` line and for no other kind
 *      (undefined or null elsewhere: those lines are unchanged, their VAT already rides inside their day's platformFee).
 *  V2  the rate is the row's own printed rate (`vatRate`), never a constant: 12% and 5% and 10% below give different VAT on the same net. Each line is rounded on its own,
 *      half up (away from zero for a credit), exactly once: 0.05 at 10% is 0.01, not 0.00.
 *  V3  one copy of the rounding: `vatOnFeesOf` in review.ts no longer carries its own half-up arithmetic (it calls the shared helper the staging uses).
 *
 * NOT PINNED, because the spec contradicts itself (see the report): a credit note (negative net) has a NEGATIVE staged VAT by the formula above, while Design A also says the
 * column is CHECK >= 0. Only positive nets are pinned here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stageFoodpandaDays, type StagedFile, type StagedOtherLine } from '../../src/settlement-intake/stage';
import { openSettlementZip } from '../../src/settlement-intake/safe-zip';
import { readFoodpandaInvoice } from '../../src/settlement-intake/foodpanda-workbook';
import { day as isoDay, fpChargeRow, fpWorkbook, fp34Order, zipBytes } from './t511-s3-helpers';

const MATCHED = { channelId: '00000000-0000-4000-8000-0000000000c1', storeId: '00000000-0000-4000-8000-0000000000a1', storeName: 'Lipa', channelName: 'Foodpanda', platform: 'foodpanda' as const, code: 'ZZ99' };

type Cell = string | number | Date | null;
const plain = (code: string, date: string): Cell[] => fp34Order(code, { 7: isoDay(date) });
const other = (net: number, vat = '12%', description = 'A one-off charge'): Cell[] => fpChargeRow('Some New Charge Category', description, net, vat);
const weeklyFee = (net: number, vat = '12%'): Cell[] => fpChargeRow('Platform Fee', 'PF for the month of September 2026 (W4):zz99', net, vat);
const cpc = (date: string, net: number): Cell[] => fpChargeRow('Organic Placement (CPC)', `Organic Placement (CPC)  ${date}  : ZZ99`, net);

async function stageWith(orderRows: Cell[][], chargeRows: Cell[][]): Promise<StagedFile> {
  const book = fpWorkbook({ orderRows, chargeRows });
  const zip = zipBytes([{ name: '20261015_200999999999.xls', data: book }, { name: '20261015_200999999999.pdf', data: Buffer.from('%PDF-1.4 stub') }]);
  const inv = await readFoodpandaInvoice((await openSettlementZip(zip)).workbook);
  return stageFoodpandaDays(inv, MATCHED);
}
const vatOf = (l: StagedOtherLine | undefined): string | null | undefined => (l as unknown as { vat?: string | null } | undefined)?.vat;
const periodLines = (s: StagedFile): StagedOtherLine[] => s.periodLines.filter((l) => l.kind === 'period_charge');

describe('T-511 S6c - a period_charge line is dated (an undated charge takes the invoice date)', () => {
  it('a weekly fee and an unrecognised charge print no date of their own: each takes the invoice date the file carries (15 Oct from Appendix A when there are orders, 19 Oct from Appendix B when there are none); a dated line elsewhere keeps its own [kills: lineDate null (the charge can never be booked); a date typed in code]', async () => {
    const withOrders = await stageWith([plain('zz99-0001-a', '2026-10-10')], [other(100)]);
    const noOrders = await stageWith([], [weeklyFee(223.21)]);
    expect([...periodLines(withOrders), ...periodLines(noOrders)].map((l) => l.lineDate)).toEqual(['2026-10-15', '2026-10-19']);
  });

  it('a line whose own date the file gives keeps it, not the invoice date [kills: the invoice date overriding a printed date]', async () => {
    const s = await stageWith([plain('zz99-0001-a', '2026-10-10')], [cpc('2026-10-08', 10), other(100)]);
    const dated = [...s.periodLines, ...s.days.flatMap((d) => d.otherLines)].find((l) => l.kind === 'advertisement');
    expect(dated?.lineDate).toBe('2026-10-08');
    expect(periodLines(s).map((l) => l.lineDate)).toEqual(['2026-10-15']);
  });
});

describe('T-511 S6c - a period_charge line carries its VAT', () => {
  it('a weekly fee with no sales day at all: 223.21 at 12% stages vat 26.79 (26.7852 half up) next to the unbooked line [kills: no VAT on the line (the 12 of 112 lost); truncation to 26.78]', async () => {
    const s = await stageWith([], [weeklyFee(223.21)]);
    const lines = periodLines(s);
    expect(lines.map((l) => `${l.kind}:${l.bookedAs}:${l.amount}`)).toEqual(['period_charge:none:223.21']);
    expect(vatOf(lines[0])).toBe('26.79');
  });

  it('an unrecognised appendix B category on an invoice WITH orders: net 100.00 at 12% stages 12.00 [kills: VAT only on a weekly fee; VAT only when there are no orders]', async () => {
    const s = await stageWith([plain('zz99-0001-a', '2026-10-10')], [other(100)]);
    const lines = periodLines(s);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'period_charge', bookedAs: 'none', amount: '100.00' });
    expect(vatOf(lines[0])).toBe('12.00');
  });

  it('the rate is the row\'s own: 223.21 at 5% is 11.16 (11.1605) and at 10% is 22.32 (22.321) [kills: a hard-coded 12%]', async () => {
    const five = await stageWith([], [other(223.21, '5%')]);
    expect(vatOf(periodLines(five)[0])).toBe('11.16');
    const ten = await stageWith([], [other(223.21, '10%')]);
    expect(vatOf(periodLines(ten)[0])).toBe('22.32');
  });

  it('half up, once: 1.25 at 10% is 0.13 (0.125, not banker\'s 0.12), 0.05 at 10% is 0.01 (0.005), 0.04 at 12% is 0.00 (0.0048) [kills: banker\'s rounding; truncation; rounding twice]', async () => {
    for (const [net, rate, want] of [[1.25, '10%', '0.13'], [0.05, '10%', '0.01'], [0.04, '12%', '0.00']] as const) {
      const s = await stageWith([], [other(net, rate)]);
      expect(vatOf(periodLines(s)[0]), `${net} at ${rate}`).toBe(want);
    }
  });

  it('each line is rounded on its own: two charges of 0.05 at 10% are 0.01 each, not one rounding of the sum [kills: one VAT figure shared across the invoice\'s period lines]', async () => {
    const s = await stageWith([], [other(0.05, '10%', 'first'), other(0.05, '10%', 'second')]);
    expect(periodLines(s).map((l) => vatOf(l))).toEqual(['0.01', '0.01']);
  });
});

describe('T-511 S6c - every other staged line is unchanged', () => {
  it('a weekly fee a day carries, a CPC ad on a day and an ad on a day with no orders carry no staged VAT of their own (their VAT already rides in the day\'s platformFee, or is a warning) [kills: VAT staged twice]', async () => {
    const withDay = await stageWith([plain('zz99-0001-a', '2026-10-10')], [weeklyFee(10), cpc('2026-10-10', 10), cpc('2026-10-12', 20)]);
    const all = [...withDay.days.flatMap((d) => d.otherLines), ...withDay.periodLines];
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const l of all.filter((x) => x.kind !== 'period_charge')) expect(vatOf(l) ?? null, `${l.kind} line`).toBeNull();
    // the day still carries its VAT inside platformFee: 3.18 of orders + 10 fee + 12% of (10 + 10) = 2.40
    expect(withDay.days[0]).toMatchObject({ platformFee: '15.58', unexplained: '0.00' });
  });

  it('the warning for a fee with no sales day is unchanged (the S5a audit-fix pin): two sentences, the VAT named in the second [kills: a changed warning]', async () => {
    const s = await stageWith([], [weeklyFee(223.21)]);
    expect(s.warnings).toEqual([
      'This invoice has a platform fee but no sales days: it is kept as a period charge and needs review.',
      'This invoice has an ad charge (or platform fee) of 223.21 on a day with no orders, so its 12% VAT of 26.79 is not included in any day. It needs review.',
    ]);
  });
});

describe('T-511 S6c - V3: one copy of the VAT rounding', () => {
  it('vatOnFeesOf (review.ts) holds no half-up arithmetic of its own: no `2n * abs` and no 100n / 200n rounding constants outside comments [kills: a second copy of the formula that drifts from the staging copy]', () => {
    const src = readFileSync(path.join(__dirname, '..', '..', 'src', 'settlement-intake', 'review.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
    const body = src.slice(src.indexOf('async function vatOnFeesOf'), src.indexOf('async function vatOnFeesOf') + 900);
    expect(body, 'vatOnFeesOf is still there').toMatch(/vatOnFeesOf/);
    expect(body).not.toMatch(/2n\s*\*\s*abs/);
    expect(body).not.toMatch(/\b(?:100n|200n)\b/);
  });
});
