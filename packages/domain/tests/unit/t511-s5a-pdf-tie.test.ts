/**
 * T-511 S5a (TESTER, 2026-11-05) - Foodpanda staging ties to the PDF to the centavo. docs/tasks/511-settlement-upload-s5-spec.md "S5a"; design decisions 18 and 19.
 *
 * RED today, for one reason: `stageFoodpandaDays` still uses the S4 rule (balance - CPC ads - weekly fee): no VAT on Appendix B, no withholding rounding line,
 * no PandaGO figures on the StagedFile.
 *
 * THE RULE (found by probe over the five real invoices, 5 Nov; every other variant tried missed at least one invoice by 0.01 to 0.02):
 *   net payout of the invoice = sum of day Balance - CPC ads (net of VAT) - weekly platform fee - V + R
 *     V = VAT on Appendix B = round-half-up( 12% x sum of the netTotal of ALL cpc_ad + platform_fee rows ), rounded ONCE on the invoice sum
 *         (per row, per day and per category all miss by 0.01 to 0.02 on Banay, Lipa 8-15 Oct, Lipa 8-15 Jul)
 *     R = (sum of per-order withholding, column T) - round-half-up( 0.5% x sum of the withholding base ), the base rounded to the centavo per order:
 *         the workbook computes T per order as round-half-up(0.5% x base) where the base is column R (Banay, Malvar: every order matches) or column R / 1.12
 *         rounded to the centavo (the three Lipa invoices: every order matches). Which of the two, is read off the orders themselves: the one that
 *         reproduces EVERY order's T. If neither does, R = 0 and no rounding line is made (nothing invented).
 *     R observed: 0.09, 0.05, 0.05, 0.13, 0.06 (Banay, Lipa 23-30 Sep, Lipa 8-15 Oct, Malvar, Lipa 8-15 Jul), the doc's own constants.
 *
 * CONTRACT (tester's choices; the builder must meet these or ask BOSS to change the tests):
 *  K1  VAT is NOT a separate other line. It rides inside `platformFee` of the day it belongs to: a CPC row's VAT on the CPC day, the weekly fee's VAT on the fee's
 *      (relocated) day. Because V is rounded once on the sum, the per-day shares are allocated so that they add up to V exactly; each day's share is within
 *      0.02 of 12% x that day's Appendix B net. The CPC and weekly-fee other lines keep their printed Net Total as `amount`. `marketing` stays net of VAT.
 *  K2  The rounding line is ONE other line on the invoice's last sales day: kind 'adjustment' (the kind CHECK has no room for a new kind and S5 has no migration),
 *      bookedAs 'platformFee', amount = -R (a credit: it raises the net payout), lineDate null, description containing 'withholding rounding to the PDF total'.
 *      It also sits inside that day's `platformFee`. It is made only when R is not zero. It carries the withholding remainder ONLY (V is allocated exactly, K1).
 *  K3  net_payout of a day = day Balance - day marketing - (day platformFee - day order-column fees): so `unexplained` is 0.00 on every day, always.
 *  K4  The weekly-fee relocation rule (C8 of the S4 tests) is unchanged: it compares the fee's NET amount to the day's room. The warnings (fee larger than any day;
 *      fee with no sales days) are unchanged, and a fee with no sales days stays an unbooked period_charge with no VAT invented.
 *  K5  `StagedFile` gains `pandagoNetTotal: Money | null` (sum of the PandaGO rows as printed, -385.03) and `pandagoReceivable: Money | null` (the PDF's amount after the
 *      VAT on the delivery-service rows, 374.32, a positive magnitude: Foodpanda PAYS this to the partner), both null when the invoice has no PandaGO rows. PandaGO stays bookedAs 'none', no day, no VAT line.
 *
 * DIRECTION (BOSS ruling, 5 Nov, read from the real PandaGO PDF): 374.32 = [a] - [d] is money Foodpanda PAYS the partner (the COD cash PandaGO riders collected, less
 * PandaGO fees and VAT). It was first named pandagoReceivable, which had the direction backwards; renamed pandagoReceivable.
 */
import { describe, expect, it } from 'vitest';
import { stageFoodpandaDays, type StagedDay, type StagedFile } from '../../src/settlement-intake/stage';
import { openSettlementZip } from '../../src/settlement-intake/safe-zip';
import { readFoodpandaInvoice } from '../../src/settlement-intake/foodpanda-workbook';
import { day as isoDay, fpChargeRow, fpWorkbook, fp34Order, zipBytes } from './t511-s3-helpers';
import { cents, expectedWeeklyDay, fmt, fpOracle, readFpFixture, sum } from './t511-s4-helpers';

const MATCHED = { channelId: '00000000-0000-4000-8000-0000000000c1', storeId: '00000000-0000-4000-8000-0000000000a1', storeName: 'Lipa', channelName: 'Foodpanda', platform: 'foodpanda' as const, code: 'ZZ99' };

/** the label the discovery doc quotes for the bank figure, "Foodpanda PDF totals (recorded by hand, 4 Nov)" */
const PDF_LABEL = 'Total Amount Receivable/Payable [a - d]';

const FIVE = [
  { name: 'Banay 8-15 Oct', file: 'foodpanda-banay-oct19-34col.zip', pdf: '12881.22', rounding: '-0.09' },
  { name: 'Lipa 23-30 Sep', file: 'foodpanda-lipa-oct5-34col.zip', pdf: '84427.39', rounding: '-0.05' },
  { name: 'Lipa 8-15 Oct', file: 'foodpanda-lipa-oct19-34col-feerow.zip', pdf: '67936.68', rounding: '-0.05' },
  { name: 'Malvar 1-7 Oct', file: 'foodpanda-malvar-oct12-34col.zip', pdf: '8135.12', rounding: '-0.13' },
  { name: 'Lipa 8-15 Jul (32 columns)', file: 'foodpanda-lipa-jul15-32col.zip', pdf: '80190.53', rounding: '-0.06' },
] as const;

type S5aFile = StagedFile & { pandagoNetTotal: string | null; pandagoReceivable: string | null };
const ROUNDING_NOTE = /withholding rounding to the PDF total/i;
const isRounding = (l: { kind: string }): boolean => l.kind === 'adjustment';

/** round-half-up of a non-negative ratio of BigInts */
const roundHalfUp = (num: bigint, den: bigint): bigint => (2n * num + den) / (2n * den);

describe(`T-511 S5a - the five real Foodpanda invoices tie to the PDF "${PDF_LABEL}" to the centavo`, () => {
  for (const f of FIVE) {
    it(`${f.name}: sum of net payout over the days = ${f.pdf} exactly (period lines add nothing); unexplained 0.00 on every day [kills: VAT on Appendix B missing; withholding rounding missing; unexplained used for a known difference]`, async () => {
      const inv = await readFpFixture(f.file);
      const staged = stageFoodpandaDays(inv, MATCHED);
      expect(PDF_LABEL).toBe('Total Amount Receivable/Payable [a - d]');
      expect(staged.periodLines.every((l) => l.bookedAs === 'none')).toBe(true);
      expect(fmt(sum(staged.days.map((d) => cents(d.netPayout)))), `${f.name} against ${PDF_LABEL}`).toBe(f.pdf);
      for (const d of staged.days) {
        expect(d.unexplained, `${f.name} ${d.salesDate}`).toBe('0.00');
        expect(d.warnings, `${f.name} ${d.salesDate}`).toEqual([]);
      }
    });

    it(`${f.name}: ONE rounding line of ${f.rounding}, on the invoice's last sales day, kind adjustment, booked as platform fee, with a visible note, inside that day's platform fee [kills: line on the wrong day; line on every day; no note; wrong sign]`, async () => {
      const staged = stageFoodpandaDays(await readFpFixture(f.file), MATCHED);
      const dates = staged.days.map((d) => d.salesDate).sort();
      const last = dates[dates.length - 1] as string;
      const all = staged.days.flatMap((d) => d.otherLines.filter(isRounding).map((l) => ({ ...l, on: d.salesDate })));
      expect(all.length).toBe(1);
      expect(all[0]).toMatchObject({ on: last, kind: 'adjustment', bookedAs: 'platformFee', amount: f.rounding, lineDate: null });
      expect(all[0]?.description ?? '').toMatch(ROUNDING_NOTE);
      expect(staged.periodLines.filter(isRounding)).toEqual([]);
    });

    it(`${f.name}: marketing is the CPC amount net of VAT; the CPC and fee lines keep their printed amounts; VAT sits inside platform fee, shares add up to 12% of Appendix B rounded once, the weekly fee day carries the fee and its VAT [kills: VAT in marketing; VAT per row; fee VAT on the wrong day; VAT line invented]`, async () => {
      const inv = await readFpFixture(f.file);
      const staged = stageFoodpandaDays(inv, MATCHED);
      const o = fpOracle(inv);
      const weeklyDay = expectedWeeklyDay(o.days, o.weeklyFee) as string;
      expect(weeklyDay).not.toBeNull();
      const rows = inv.charges.filter((c) => c.kind === 'cpc_ad' || c.kind === 'platform_fee');
      const invoiceVat = roundHalfUp(sum(rows.map((c) => cents(c.netTotal) * BigInt(c.vatRate))), 100n);
      let shares = 0n;
      for (const [date, want] of o.days) {
        const got = staged.days.find((d) => d.salesDate === date) as StagedDay;
        const cpc = sum(want.cpc);
        const fee = date === weeklyDay ? o.weeklyFee : 0n;
        const rounding = got.otherLines.filter(isRounding).reduce((t, l) => t + cents(l.amount), 0n);
        expect(got.marketing, `${f.name} ${date} marketing is net of VAT`).toBe(fmt(cpc));
        const share = cents(got.platformFee) - want.platformFeeOrders - fee - rounding;
        shares += share;
        const exact = (cpc + fee) * 12n; // x100: centavos x percent
        const diff = share * 100n - exact;
        expect(diff <= 200n && diff >= -200n, `${f.name} ${date}: VAT share ${fmt(share)} is within 0.02 of 12% of the day's Appendix B net ${fmt(cpc + fee)}`).toBe(true);
        if (cpc + fee === 0n) expect(share, `${f.name} ${date}: no Appendix B here, no VAT here`).toBe(0n);
        expect(got.netPayout, `${f.name} ${date} net payout identity`).toBe(fmt(want.balance - cpc - (cents(got.platformFee) - want.platformFeeOrders)));
        const weekly = got.otherLines.filter((l) => l.kind === 'platform_fee_weekly');
        expect(weekly.map((l) => l.amount), `${f.name} ${date}`).toEqual(date === weeklyDay ? ['223.21'] : []);
      }
      expect(shares, `${f.name}: the VAT shares add up to ${fmt(invoiceVat)}`).toBe(invoiceVat);
    });
  }
});

describe('T-511 S5a - the Appendix-B-only invoice stays out of the receivable', () => {
  it('stays none: zero days, its three PandaGO lines booked as none, no rounding line, no VAT line; the file carries the PandaGO net total -385.03 and the receivable 374.32 for the screen note [kills: PandaGO booked; a day invented; figures missing]', async () => {
    const staged = stageFoodpandaDays(await readFpFixture('foodpanda-lipa-oct5a-appendix-b-only-pandago.zip'), MATCHED) as S5aFile;
    expect(staged.days).toEqual([]);
    expect(staged.periodLines.length).toBe(3);
    for (const l of staged.periodLines) expect(l).toMatchObject({ kind: 'pandago', bookedAs: 'none' });
    expect(staged.periodLines.map((l) => l.amount).sort()).toEqual(['-476.00', '1.68', '89.29']);
    expect(staged.pandagoNetTotal).toBe('-385.03');
    expect(staged.pandagoReceivable).toBe('374.32');
  });

  it('an invoice with orders carries no PandaGO figures [kills: figures on every file]', async () => {
    const staged = stageFoodpandaDays(await readFpFixture('foodpanda-banay-oct19-34col.zip'), MATCHED) as S5aFile;
    expect(staged.pandagoNetTotal).toBeNull();
    expect(staged.pandagoReceivable).toBeNull();
  });
});

/* ================================================================== synthetic invoices */

type Cell = string | number | Date | null;
/** R 100.00, T 0.50, commission 22.32, tax 2.68 -> balance 74.50, order-column fees 3.18 */
const plain = (code: string, date: string): Cell[] => fp34Order(code, { 7: isoDay(date) });
/** R 1000.00, T 5.00 (0.5% of R), commission 22.32, tax 2.68 -> balance 970.00, order-column fees 7.68 */
const heavy = (code: string, date: string): Cell[] => fp34Order(code, { 7: isoDay(date), 10: 1000, 17: 1000, 19: 5, 33: 970 });
/** R 101.00, T 0.51 (0.505 rounded half up), no commission, no tax -> balance 100.49, order-column fees 0.51; three of them leave a 0.01 withholding remainder */
const odd = (code: string, date: string): Cell[] => fp34Order(code, { 7: isoDay(date), 10: 101, 17: 101, 19: 0.51, 24: 0, 29: 0, 33: 100.49 });
/** R 1000.00 with T 0.50: fits neither 0.5% of R nor 0.5% of R / 1.12 */
const mismatched = (code: string, date: string): Cell[] => fp34Order(code, { 7: isoDay(date), 10: 1000, 17: 1000, 33: 974.5 });

const cpc = (date: string, net: number): Cell[] => fpChargeRow('Organic Placement (CPC)', `Organic Placement (CPC)  ${date}  : ZZ99`, net);
const weeklyFee = (net: number): Cell[] => fpChargeRow('Platform Fee', 'PF for the month of September 2026 (W4):zz99', net);

async function stageWith(orderRows: Cell[][], chargeRows: Cell[][]): Promise<S5aFile> {
  const book = fpWorkbook({ orderRows, chargeRows });
  const zip = zipBytes([{ name: '20261015_200999999999.xls', data: book }, { name: '20261015_200999999999.pdf', data: Buffer.from('%PDF-1.4 stub') }]);
  const inv = await readFoodpandaInvoice((await openSettlementZip(zip)).workbook);
  return stageFoodpandaDays(inv, MATCHED) as S5aFile;
}
const dayOf = (s: StagedFile, date: string): StagedDay => s.days.find((d) => d.salesDate === date) as StagedDay;

describe('T-511 S5a - synthetic invoices: the weekly fee and its VAT', () => {
  it('the fee relocates to the nearest earlier day that can pay it and its VAT goes with it; the CPC VAT stays on the CPC day; marketing is net [kills: fee VAT left on the last day; CPC VAT in marketing; VAT on both]', async () => {
    const s = await stageWith([heavy('zz99-0001-a', '2026-10-10'), heavy('zz99-0002-a', '2026-10-10'), plain('zz99-0003-a', '2026-10-15')], [cpc('2026-10-10', 10), weeklyFee(223.21)]);
    const early = dayOf(s, '2026-10-10');
    const last = dayOf(s, '2026-10-15');
    // VAT: 12% of 233.21 = 27.9852 -> 27.99 = 1.20 on the CPC + 26.79 on the fee, both on 10 Oct. Orders cost 2 x 7.68 = 15.36.
    expect(early).toMatchObject({ marketing: '10.00', platformFee: '266.56', netPayout: '1678.80', unexplained: '0.00' });
    expect(early.feeMonthNote).toMatch(/September 2026/);
    expect(early.otherLines.filter((l) => l.kind === 'platform_fee_weekly').map((l) => l.amount)).toEqual(['223.21']);
    expect(early.otherLines.filter((l) => l.kind === 'advertisement').map((l) => l.amount)).toEqual(['10.00']);
    expect(last).toMatchObject({ marketing: '0.00', platformFee: '3.18', netPayout: '74.50', unexplained: '0.00', feeMonthNote: null });
    expect([...early.otherLines, ...last.otherLines].filter(isRounding)).toEqual([]); // the withholding adds up: 0.5% of 2,100.00 = 10.50 = the column
  });

  it('a fee larger than any day stays on the last day with the warning kept; its VAT goes there too and the day goes negative, still explained [kills: warning dropped; VAT dropped; unexplained used]', async () => {
    const s = await stageWith([plain('zz99-0001-a', '2026-10-10')], [weeklyFee(223.21)]);
    expect(s.warnings).toEqual(['The weekly platform fee on this invoice is larger than any single sales day: it was placed on 2026-10-10, please check.']);
    // 3.18 orders + 223.21 fee + 26.79 VAT (12% of 223.21 = 26.7852)
    expect(dayOf(s, '2026-10-10')).toMatchObject({ platformFee: '253.18', netPayout: '-175.50', unexplained: '0.00' });
  });

  it('a fee with no sales days stays an unbooked period charge with its warning, and no VAT is invented [kills: VAT line or day invented; fee dropped]', async () => {
    const s = await stageWith([], [weeklyFee(223.21)]);
    expect(s.days).toEqual([]);
    expect(s.periodLines.map((l) => `${l.kind}:${l.bookedAs}:${l.amount}`)).toEqual(['period_charge:none:223.21']);
    // S5a audit fix EDIT (5 Nov): a second sentence now names the VAT no day carries; the full pin is in the audit-fix block below.
    expect(s.warnings[0]).toBe('This invoice has a platform fee but no sales days: it is kept as a period charge and needs review.');
    expect(s.warnings.length).toBe(2);
  });

  it('VAT is rounded once on the Appendix B sum, not per row: three CPC rows of 1.04 give 0.37, not 3 x 0.12 [kills: per-row rounding]', async () => {
    const s = await stageWith([plain('zz99-0001-a', '2026-10-10')], [cpc('2026-10-10', 1.04), cpc('2026-10-10', 1.04), cpc('2026-10-10', 1.04)]);
    // 12% of 3.12 = 0.3744 -> 0.37; orders 3.18
    expect(dayOf(s, '2026-10-10')).toMatchObject({ marketing: '3.12', platformFee: '3.55', netPayout: '71.01', unexplained: '0.00' });
  });
});

describe('T-511 S5a - synthetic invoices: the withholding rounding line', () => {
  it('three days, remainder 0.01: the line (-0.01) is on the last sales day only; earlier days are untouched; the week adds up to revenue less 0.5% once [kills: line on the first day; line on every day; sign]', async () => {
    const s = await stageWith([odd('zz99-0001-a', '2026-10-10'), odd('zz99-0002-a', '2026-10-12'), odd('zz99-0003-a', '2026-10-15')], []);
    // orders' T 3 x 0.51 = 1.53; the invoice's 0.5% of 303.00 = 1.515 -> 1.52; remainder 0.01
    for (const date of ['2026-10-10', '2026-10-12']) {
      expect(dayOf(s, date), date).toMatchObject({ platformFee: '0.51', netPayout: '100.49', unexplained: '0.00' });
      expect(dayOf(s, date).otherLines.filter(isRounding)).toEqual([]);
    }
    const last = dayOf(s, '2026-10-15');
    expect(last).toMatchObject({ platformFee: '0.50', netPayout: '100.50', unexplained: '0.00' });
    const line = last.otherLines.filter(isRounding);
    expect(line.length).toBe(1);
    expect(line[0]).toMatchObject({ kind: 'adjustment', bookedAs: 'platformFee', amount: '-0.01', lineDate: null });
    expect(line[0]?.description ?? '').toMatch(ROUNDING_NOTE);
    expect(fmt(sum(s.days.map((d) => cents(d.netPayout))))).toBe('301.48'); // 303.00 - 1.52
  });

  it('a single-day invoice: the line goes on that day [kills: line missing when first day = last day]', async () => {
    const s = await stageWith([odd('zz99-0001-a', '2026-10-10'), odd('zz99-0002-a', '2026-10-10')], []);
    expect(s.days.length).toBe(1);
    // T 1.02; 0.5% of 202.00 = 1.01; remainder 0.01
    expect(s.days[0]).toMatchObject({ platformFee: '1.01', netPayout: '200.99', unexplained: '0.00' });
    expect(s.days[0]?.otherLines.filter(isRounding).map((l) => l.amount)).toEqual(['-0.01']);
  });

  it('remainder zero: no line is created and nothing else moves [kills: a zero line; a fudge on a clean invoice]', async () => {
    const s = await stageWith([plain('zz99-0001-a', '2026-10-10'), plain('zz99-0002-a', '2026-10-12'), plain('zz99-0003-a', '2026-10-15')], []);
    for (const d of s.days) {
      expect(d).toMatchObject({ platformFee: '3.18', netPayout: '74.50', unexplained: '0.00' });
      expect(d.otherLines).toEqual([]);
    }
  });

  it('withholding that fits neither basis (T 0.50 on R 1,000.00): no rounding line is guessed, the day still adds up [kills: a made-up remainder when the basis is unknown]', async () => {
    const s = await stageWith([mismatched('zz99-0001-a', '2026-10-10')], []);
    expect(s.days[0]).toMatchObject({ platformFee: '3.18', netPayout: '974.50', unexplained: '0.00' });
    expect(s.days[0]?.otherLines).toEqual([]);
  });
});

/* ================================================================== S5a audit fixes (5 Nov) */

describe('T-511 S5a audit fix - VAT that no day can carry is warned about, never invented on the period line', () => {
  it('a CPC ad dated on a day with no orders stays a period line and a plain warning names its amount and its VAT [kills: VAT lost silently; VAT put on another day]', async () => {
    const s = await stageWith([plain('zz99-0001-a', '2026-10-12')], [cpc('2026-10-10', 235.14)]);
    expect(s.periodLines.map((l) => `${l.kind}:${l.bookedAs}:${l.amount}`)).toEqual(['advertisement:marketing:235.14']);
    expect(s.warnings).toEqual(['This invoice has an ad charge (or platform fee) of 235.14 on a day with no orders, so its 12% VAT of 28.22 is not included in any day. It needs review.']);
    expect(dayOf(s, '2026-10-12')).toMatchObject({ platformFee: '3.18', netPayout: '74.50', unexplained: '0.00' });
  });

  it('a weekly fee with no sales day at all warns with its VAT too, next to the existing sentence [kills: fee VAT lost silently]', async () => {
    const s = await stageWith([], [weeklyFee(223.21)]);
    expect(s.warnings).toEqual([
      'This invoice has a platform fee but no sales days: it is kept as a period charge and needs review.',
      'This invoice has an ad charge (or platform fee) of 223.21 on a day with no orders, so its 12% VAT of 26.79 is not included in any day. It needs review.',
    ]);
  });

  it('a CPC ad on a day that has orders raises no such warning [kills: warning on every ad]', async () => {
    const s = await stageWith([plain('zz99-0001-a', '2026-10-10')], [cpc('2026-10-10', 10)]);
    expect(s.warnings).toEqual([]);
  });
});

describe('T-511 S5a audit fix - the withholding warning does not promise centavos', () => {
  it('words the mismatch as the withholding of the odd orders [kills: "a few centavos" when one order can move the net by more]', async () => {
    const s = await stageWith([mismatched('zz99-0001-a', '2026-10-10')], []);
    expect(s.warnings).toEqual(['The withholding on this invoice does not match the usual rule, so the net can differ from the PDF by the withholding of the odd orders.']);
  });
});

describe('T-511 S5a audit fix - a VAT rate this screen cannot read is refused by name', () => {
  for (const rate of ['12.5%', '9'.repeat(400) + '%']) {
    it(`a rate of ${rate.length > 10 ? 'an enormous number' : rate} on an additional charge is a STAGED_BAD_VALUE sentence, not "more than the system can hold" [kills: RangeError turned into a misleading sentence]`, async () => {
      let refused: { code?: string; message?: string } | null = null;
      try {
        await stageWith([plain('zz99-0001-a', '2026-10-10')], [fpChargeRow('Organic Placement (CPC)', 'Organic Placement (CPC)  2026-10-10  : ZZ99', 10, rate)]);
      } catch (e) {
        refused = e as { code?: string; message?: string };
      }
      expect(refused?.code).toBe('STAGED_BAD_VALUE');
      expect(refused?.message).toMatch(/is not one this screen can read\. Ask for help\.$/);
      expect(refused?.message).not.toMatch(/more than the system can hold/);
    });
  }
});
