/**
 * T-511 S4 (TESTER, 2026-11-04) - `stage.ts`: the pure step from parsed file to staged store-days. docs/tasks/511-settlement-upload-s4-spec.md "stage.ts".
 *
 * RED today, for one reason: `packages/domain/src/settlement-intake/stage.ts` does not exist (the import below cannot resolve).
 *
 * Expected figures come from `t511-s4-helpers.ts`: plain centavo arithmetic over the fixture CSV text, and, for Foodpanda, over the S3 reader's typed
 * orders and charges plus the slice-1 Balance sums. Never from `stage.ts` itself.
 *
 * CONTRACT (tester's choices where the spec leaves a signature open; the builder must meet these or ask BOSS to change the tests):
 *  C1  `stageGrabDays(tied: GrabPayoutTie, transactions: GrabTransactionsFile): StagedFile` and
 *      `stageFoodpandaDays(invoice: FoodpandaInvoice, matched: MatchedChannel): StagedFile`, both synchronous and pure.
 *      `StagedFile = { days: StagedDay[]; periodLines: StagedOtherLine[]; waitingForRows: { settlementId: string; salesDate: string }[] }`.
 *      DEVIATION FROM THE SPEC TEXT (`-> StagedDay[]`): a PandaGO-only invoice stages zero days but three lines, and a line with no day needs a home.
 *  C2  `StagedDay` (camelCase twins of the settlement_day_lines columns): salesDate, platform, orderValue, grossInfo, commission, marketing, platformFee,
 *      vendorDiscount, loanDeduction, loanDisbursal, netPayout, unexplained (all Money strings, 2 decimals), payoutReference, payoutDate, paymentArrivalDate,
 *      paidState ('paid' | 'not_paid'), feeMonthNote, loanLines, otherLines, warnings (string[]).
 *      `loanLines: { kind: 'deduction' | 'disbursal'; amount: Money (magnitude > 0); rowOrdinal: number }[]` (no loan id: S4 never allocates).
 *      `StagedOtherLine = { kind; bookedAs: 'platformFee' | 'marketing' | 'none'; amount: Money; lineDate: string | null; description: string | null }`.
 *  C3  Sign convention for every staged amount and other line: COST POSITIVE, CREDIT NEGATIVE (a Grab withholding-tax row with Total -5.00 stages +5.00; a
 *      Grab compensation of +30.00 stages -30.00; a Foodpanda charge is its printed Net Total, so PandaGO COD -476.00 stays -476.00).
 *  C4  A Grab payout's store-day is the tie's `storeDay`; a payout with no rows (`waiting_for_rows`) stages NO day and is listed in `waitingForRows`.
 *  C5  Grab: orderValue = sum of Net Sales of Payment rows; grossInfo = sum of Amount; commission = minus the sum of Channel Commission (stored positive);
 *      marketing = minus the Total of Advertisement rows; platformFee = minus the Total of Adjustment rows; loanDeduction / loanDisbursal = magnitudes;
 *      netPayout = payout Net Total minus the disbursal; unexplained = netPayout - (orderValue - commission - marketing - platformFee - loanDeduction).
 *      (The spec says "payout less (order_value less all fees plus credits)"; the Lipa 13 Oct figures only reach 0.00 if the loan deduction counts as a fee.)
 *      paidState 'paid' when the payout is `completed`; paymentArrivalDate = the transfer date or null; payoutReference = the Settlement ID.
 *  C6  Other-line kinds: Withholding Tax Remittance -> withholding_tax/platformFee; Deduction - Eater Compensation -> chargeback/platformFee;
 *      Compensation - Orders -> compensation/platformFee; Advertisement -> advertisement/marketing; Foodpanda CPC -> advertisement/marketing (one per charge row,
 *      lineDate = its date); Foodpanda Platform Fee -> platform_fee_weekly/platformFee; PandaGO -> pandago/none. lineDate of a Grab line = the row's Created On date.
 *  C7  Foodpanda: orderValue = sum of column R, grossInfo = sum of K, commission = sum of Y, vendorDiscount = O + P + Q (positive), marketing = the CPC ads dated
 *      that day, platformFee = the order-column costs (T U V Z AB AC AD) less the credits (S AE) plus the weekly Platform Fee when it lands here;
 *      netPayout = the day's Balance sum minus the day's CPC ads minus the weekly fee that landed here (so `unexplained` is 0.00 on a consistent invoice);
 *      payoutReference = the invoice number.
 *  C8  Weekly fee relocation: last sales day, else the nearest earlier day whose order value less its own commission, marketing and order-column fees covers it;
 *      the day that gets it carries `feeMonthNote` (the charge's month text); no other day does.
 *  C9  `checkStagedDay(day: StagedDay): void` (exported, pure) mirrors the table CHECKs and throws a `SettlementIntakeRefusal` naming the field.
 */
import { describe, expect, it } from 'vitest';
import { deductionFor } from '../../src/settlement-intake/deduction-mapping';
import { SettlementIntakeRefusal } from '../../src/settlement-intake/refusal';
import { readGrabTransactions } from '../../src/settlement-intake/grab-transactions';
import { readGrabTransfers } from '../../src/settlement-intake/grab-transfers';
import { tieGrabPayouts } from '../../src/settlement-intake/grab-payouts';
import type { GrabTransactionRow, GrabTransactionsFile } from '../../src/settlement-intake/grab-transactions';
import type { GrabTransfersFile } from '../../src/settlement-intake/grab-transfers';
import { checkStagedDay, stageFoodpandaDays, stageGrabDays, type StagedDay, type StagedFile } from '../../src/settlement-intake/stage';
import { openSettlementZip } from '../../src/settlement-intake/safe-zip';
import { readFoodpandaInvoice } from '../../src/settlement-intake/foodpanda-workbook';
import { money, type Money } from '@shareat/core/money';
import { UUID_SHAPE, day as isoDay, fixture, fpChargeRow, fpWorkbook, fp34Order, zipBytes } from './t511-s3-helpers';
import { FP_FIXTURES, GRAB_PAIRS, cents, expectedWeeklyDay, fmt, fpOracle, grabOracle, readFpFixture, sum } from './t511-s4-helpers';

const MATCHED = { channelId: '00000000-0000-4000-8000-0000000000c1', storeId: '00000000-0000-4000-8000-0000000000a1', storeName: 'Lipa', channelName: 'Foodpanda', platform: 'foodpanda' as const, code: 'O6JZ' };

function stageGrab(txName: string, trName: string): { staged: StagedFile; tx: Buffer; tr: Buffer } {
  const tx = fixture(txName);
  const tr = fixture(trName);
  const transactions = readGrabTransactions(tx);
  const transfers = readGrabTransfers(tr);
  return { staged: stageGrabDays(tieGrabPayouts(transactions, transfers), transactions), tx, tr };
}

const byDate = (s: StagedFile): Map<string, StagedDay> => new Map(s.days.map((d) => [d.salesDate, d]));

/* ================================================================== Grab */

describe('T-511 S4 stage - Grab days from the real Lipa, Malvar and Banay files', () => {
  for (const pair of GRAB_PAIRS) {
    it(`${pair.name}: every staged day equals the independent oracle (figures, payout reference, paid state); payouts with no rows stage nothing [kills: Amount instead of Net Sales as order value; commission kept negative; loan deduction left in the sales part; disbursal left in net payout; wrong store-day]`, () => {
      const { staged, tx, tr } = stageGrab(pair.tx, pair.tr);
      const oracle = grabOracle(tx, tr);
      expect([...byDate(staged).keys()].sort()).toEqual([...oracle.days.keys()].sort());
      for (const [date, want] of oracle.days) {
        const got = byDate(staged).get(date) as StagedDay;
        expect({
          platform: got.platform, orderValue: got.orderValue, grossInfo: got.grossInfo, commission: got.commission, marketing: got.marketing,
          platformFee: got.platformFee, loanDeduction: got.loanDeduction, loanDisbursal: got.loanDisbursal, netPayout: got.netPayout,
          unexplained: got.unexplained, payoutReference: got.payoutReference, payoutDate: got.payoutDate,
          paymentArrivalDate: got.paymentArrivalDate, paidState: got.paidState,
        }, date).toEqual({
          platform: 'grab', orderValue: want.orderValue, grossInfo: want.grossInfo, commission: want.commission, marketing: want.marketing,
          platformFee: want.platformFee, loanDeduction: want.loanDeduction, loanDisbursal: want.loanDisbursal, netPayout: want.netPayout,
          unexplained: want.unexplained, payoutReference: want.settlementId, payoutDate: want.payoutDate,
          paymentArrivalDate: want.transferDate, paidState: want.paid ? 'paid' : 'not_paid',
        });
      }
      expect(staged.waitingForRows.map((w) => `${w.settlementId}|${w.salesDate}`).sort()).toEqual(oracle.waiting.map((w) => `${w.settlementId}|${w.salesDate}`).sort());
      expect(staged.waitingForRows.length).toBeGreaterThanOrEqual(1);
      expect(staged.periodLines).toEqual([]);
    });
  }

  it('Lipa payout dated 13 Oct (154,473.51 = 150,000 disbursal + 4,473.51): sales day 12 Oct stages the disbursal apart and the sales part as net payout, nothing unexplained [kills: disbursal counted as sales; deposit not split]', () => {
    const { staged } = stageGrab('grab-lipa-oct-transactions.csv', 'grab-lipa-oct-transfers.csv');
    const d = byDate(staged).get('2026-10-12') as StagedDay;
    expect(d).toBeDefined();
    expect(d.payoutReference).toBe('SPHVGHJILI4K');
    expect(d.loanDisbursal).toBe('150000.00');
    expect(d.netPayout).toBe('4473.51');
    expect(d.orderValue).toBe('6753.00');
    expect(d.grossInfo).toBe('6807.00');
    expect(d.commission).toBe('1688.25');
    expect(d.loanDeduction).toBe('591.24');
    expect(d.unexplained).toBe('0.00');
    expect(d.paidState).toBe('paid');
    // 154,473.51 is what the bank received; net payout is the sales part only
    expect(cents(d.netPayout) + cents(d.loanDisbursal)).toBe(cents('154473.51'));
    const kinds = d.loanLines.map((l) => `${l.kind}:${l.amount}`).sort();
    expect(kinds).toEqual(['deduction:591.24', 'disbursal:150000.00']);
  });

  it('Lipa 20 Oct: order value is the file Net Sales 9,928.00 (the recorded 9,474.00 is the staff figure, not this file\'s) [kills: staged order value taken from anything but Net Sales]', () => {
    const { staged } = stageGrab('grab-lipa-oct-transactions.csv', 'grab-lipa-oct-transfers.csv');
    const d = byDate(staged).get('2026-10-20') as StagedDay;
    expect(d.orderValue).toBe('9928.00');
    expect(d.grossInfo).toBe('10036.00');
  });

  it('loan lines: magnitudes above zero, one per loan row, distinct non-negative integer ordinals in file order, never allocated [kills: sign kept; deduction summed away; ordinal reused; loan id set in S4]', () => {
    const { staged, tx, tr } = stageGrab('grab-lipa-oct-transactions.csv', 'grab-lipa-oct-transfers.csv');
    const oracle = grabOracle(tx, tr);
    let loanRows = 0;
    for (const [date, want] of oracle.days) {
      const got = (byDate(staged).get(date) as StagedDay).loanLines;
      expect(got.length, date).toBe(want.loanLines.length);
      loanRows += got.length;
      const ordinals = got.map((l) => l.rowOrdinal);
      expect(new Set(ordinals).size, date).toBe(ordinals.length);
      for (const l of got) {
        expect(Number.isInteger(l.rowOrdinal) && l.rowOrdinal >= 0, date).toBe(true);
        expect(cents(l.amount) > 0n, `${date} ${l.kind}`).toBe(true);
        expect((l as { loanId?: unknown }).loanId ?? null).toBeNull();
      }
      // same multiset of (kind, amount), and ordinals ascend with the file line the row sits on
      const ordered = [...got].sort((a, b) => a.rowOrdinal - b.rowOrdinal).map((l) => `${l.kind}:${l.amount}`);
      const inFile = [...want.loanLines].sort((a, b) => a.fileLine - b.fileLine).map((l) => `${l.kind}:${l.amount}`);
      expect(ordered, date).toEqual(inFile);
    }
    expect(loanRows).toBe(45); // 46 loan rows in the file (README) minus 1 that sits on the last, unpaid day (no payout row yet)
  });

  it('Grab other lines: kind, booked-as, signed amount and Created On date per Adjustment and Advertisement row; the day columns equal the sum of its lines [kills: wrong kind; sign flipped; ads under platform fee]', () => {
    const KIND: Record<string, [string, string]> = {
      'Withholding Tax Remittance (non-taxable)': ['withholding_tax', 'platformFee'],
      'Deduction - Eater Compensation': ['chargeback', 'platformFee'],
      'Compensation - Orders': ['compensation', 'platformFee'],
      Advertisement: ['advertisement', 'marketing'],
    };
    let checked = 0;
    for (const pair of GRAB_PAIRS) {
      const { staged, tx, tr } = stageGrab(pair.tx, pair.tr);
      const oracle = grabOracle(tx, tr);
      for (const [date, want] of oracle.days) {
        const got = byDate(staged).get(date) as StagedDay;
        const mine = got.otherLines.map((o) => `${o.kind}|${o.bookedAs}|${o.amount}|${o.lineDate}`).sort();
        const theirs = want.otherLines.map((o) => `${(KIND[o.source] as [string, string])[0]}|${(KIND[o.source] as [string, string])[1]}|${o.amount}|${o.lineDate}`).sort();
        // the day may also carry lines for Cancelled rows; the money-bearing kinds above must match exactly
        const moneyKinds = mine.filter((l) => !l.startsWith('cancelled_order'));
        expect(moneyKinds, `${pair.name} ${date}`).toEqual(theirs);
        checked += theirs.length;
        const booked = (as: string): bigint => sum(got.otherLines.filter((o) => o.bookedAs === as).map((o) => cents(o.amount)));
        expect(fmt(booked('platformFee')), `${pair.name} ${date} platform fee column`).toBe(got.platformFee);
        expect(fmt(booked('marketing')), `${pair.name} ${date} marketing column`).toBe(got.marketing);
      }
    }
    expect(checked).toBe(17); // under payouts that have rows: Lipa 2, Malvar 2, Banay 5, Banay Sep 1, June 4 adjustments + 3 ads
  });

  it('the Malvar June file: its 3 Advertisement rows stage as marketing, advertisement lines [kills: Advertisement mapped to platform fee]', () => {
    const { staged } = stageGrab('grab-malvar-jun-advertisement-transactions.csv', 'grab-malvar-jun-jul-transfers.csv');
    const ads = staged.days.flatMap((d) => d.otherLines.filter((o) => o.kind === 'advertisement'));
    expect(ads.length).toBe(3);
    for (const a of ads) {
      expect(a.bookedAs).toBe('marketing');
      expect(cents(a.amount) > 0n).toBe(true);
    }
    expect(sum(staged.days.map((d) => cents(d.marketing)))).toBe(sum(ads.map((a) => cents(a.amount))));
    expect(sum(staged.days.map((d) => cents(d.marketing)))).toBeGreaterThan(0n);
  });
});

/* ------------------------------------------------------------------ Grab: every category through deductionFor */

function row(over: Partial<GrabTransactionRow> & Pick<GrabTransactionRow, 'kind' | 'total'>): GrabTransactionRow {
  return {
    line: 2, createdOn: { date: '2026-10-05', time: '10:00' }, subcategory: null, status: 'Transferred', settlementId: 'SPHSYNTH0001',
    amount: null, discount: null, netSales: null, channelCommission: null,
    ...over,
  };
}
const M = (v: string): Money => money(v);

function synthetic(rows: GrabTransactionRow[], netTotal: string): { transactions: GrabTransactionsFile; transfers: GrabTransfersFile } {
  const transactions: GrabTransactionsFile = {
    storeId: '11111111-aaaa-4aaa-8aaa-111111111111', storeName: 'Synthetic', periodFrom: '2026-10-05', periodTo: '2026-10-05', rowCount: rows.length,
    readerVersion: 'settlement-intake-reader/1', rows,
  };
  const transfers: GrabTransfersFile = {
    storeId: transactions.storeId, storeName: 'Synthetic', rowCount: 1, readerVersion: 'settlement-intake-reader/1',
    rows: [{ line: 2, settlementId: 'SPHSYNTH0001', payoutDate: { date: '2026-10-06', time: '01:00' }, netTotal: M(netTotal), status: 'completed', transferDate: { date: '2026-10-06', time: '13:00' } }],
  };
  return { transactions, transfers };
}

describe('T-511 S4 stage - the mapping table is the only table (deductionFor), never a second copy', () => {
  const ADJUSTMENTS: [string, string][] = [
    ['Withholding Tax Remittance (non-taxable)', '-5.00'],
    ['Deduction - Eater Compensation', '-20.00'],
    ['Compensation - Orders', '30.00'],
  ];

  it('every Grab adjustment and advertisement row lands in the bucket and with the sign `deductionFor` says (platformFee cost 5.00 + 20.00, credit 30.00; marketing 12.00) [kills: a private copy of the mapping; ads under platform fee]', () => {
    for (const [name] of ADJUSTMENTS) expect(deductionFor('grab', name).kind).toBe('platformFee'); // the oracle itself: if the table changes this test must be revisited
    expect(deductionFor('grab', 'Advertisement').kind).toBe('marketing');
    const rows = [
      row({ kind: 'payment', netSales: M('1000'), amount: M('1000'), channelCommission: M('-250'), total: M('750') }),
      ...ADJUSTMENTS.map(([sub, total], i) => row({ kind: 'adjustment', subcategory: sub, total: M(total), line: 3 + i, description: 'generic' })),
      row({ kind: 'advertisement', total: M('-12'), line: 9 }),
    ];
    const { transactions, transfers } = synthetic(rows, '743.00'); // 750 - 5 - 20 + 30 - 12
    const [d] = stageGrabDays(tieGrabPayouts(transactions, transfers), transactions).days;
    expect(d?.orderValue).toBe('1000.00');
    expect(d?.commission).toBe('250.00');
    expect(d?.marketing).toBe('12.00');
    expect(d?.platformFee).toBe('-5.00'); // +5 +20 -30
    expect(d?.netPayout).toBe('743.00');
    expect(d?.unexplained).toBe('0.00');
  });

  it('a hand-built row whose subcategory is not in the mapping refuses the file naming it, instead of guessing a bucket [kills: default bucket for unknown names]', () => {
    const rows = [
      row({ kind: 'payment', netSales: M('1000'), amount: M('1000'), channelCommission: M('-250'), total: M('750') }),
      row({ kind: 'adjustment', subcategory: 'Brand New Chargeback', total: M('-9.00'), line: 3, description: 'x' }),
    ];
    const { transactions, transfers } = synthetic(rows, '741.00');
    let refusal: unknown;
    try {
      stageGrabDays(tieGrabPayouts(transactions, transfers), transactions);
    } catch (e) {
      refusal = e;
    }
    expect(refusal).toBeInstanceOf(SettlementIntakeRefusal);
    expect((refusal as SettlementIntakeRefusal).message).toContain('Brand New Chargeback');
    expect((refusal as SettlementIntakeRefusal).message).not.toMatch(UUID_SHAPE);
  });

  it('a payout that does not add up marks the line unexplained (payout less everything the rows explain) and still stages it [kills: refusing instead of marking; unexplained left at 0]', () => {
    const rows = [row({ kind: 'payment', netSales: M('1000'), amount: M('1000'), channelCommission: M('-250'), total: M('750') })];
    const { transactions, transfers } = synthetic(rows, '700.00'); // bank paid 50.00 less than the rows explain
    const [d] = stageGrabDays(tieGrabPayouts(transactions, transfers), transactions).days;
    expect(d?.netPayout).toBe('700.00');
    expect(d?.unexplained).toBe('-50.00');
  });

  it('a Grab-merchant-funded discount is information only: it never changes order value or the payout arithmetic [kills: discount subtracted from order value]', () => {
    const base = row({ kind: 'payment', netSales: M('1000'), amount: M('1050'), channelCommission: M('-250'), total: M('750') });
    const a = synthetic([base], '750.00');
    const b = synthetic([{ ...base, discount: M('50') }], '750.00');
    const [da] = stageGrabDays(tieGrabPayouts(a.transactions, a.transfers), a.transactions).days;
    const [db] = stageGrabDays(tieGrabPayouts(b.transactions, b.transfers), b.transactions).days;
    expect(db?.orderValue).toBe('1000.00');
    expect(db?.orderValue).toBe(da?.orderValue);
    expect(db?.netPayout).toBe(da?.netPayout);
    expect(db?.unexplained).toBe('0.00');
  });
});

/* ================================================================== Foodpanda */

describe('T-511 S4 stage - Foodpanda days from the five real invoices', () => {
  for (const f of FP_FIXTURES) {
    it(`${f.name}: one day per order date; order value, gross, commission, discount, ads and fees equal the oracle; fee totals tie to the slice-1 Balance sum ${f.balance} [kills: Gross as order value; commission missed; CPC under platform fee; weekly fee dropped or counted twice]`, async () => {
      const inv = await readFpFixture(f.file);
      const staged = stageFoodpandaDays(inv, MATCHED);
      const o = fpOracle(inv);
      expect(staged.days.length).toBe(f.days);
      expect(staged.waitingForRows).toEqual([]);
      const weeklyDay = expectedWeeklyDay(o.days, o.weeklyFee);
      expect(weeklyDay, 'oracle found a covering day').not.toBeNull();
      for (const [date, want] of o.days) {
        const got = byDate(staged).get(date) as StagedDay;
        expect(got, date).toBeDefined();
        const cpc = sum(want.cpc);
        // T-511 S5a EDIT (tester, 5 Nov): platformFee and netPayout no longer equal order fees + weekly fee / balance - CPC - fee: they now also carry the VAT on
        // Appendix B and the withholding rounding line (decision 19). Their exact values are pinned in t511-s5a-pdf-tie.test.ts; here only the identity that survives.
        expect({
          platform: got.platform, orderValue: got.orderValue, grossInfo: got.grossInfo, commission: got.commission, vendorDiscount: got.vendorDiscount,
          marketing: got.marketing, netPayout: got.netPayout, unexplained: got.unexplained,
          payoutReference: got.payoutReference, feeMonthNote: got.feeMonthNote,
        }, `${f.name} ${date}`).toEqual({
          platform: 'foodpanda', orderValue: fmt(want.orderValue), grossInfo: fmt(want.grossInfo), commission: fmt(want.commission),
          vendorDiscount: fmt(want.vendorDiscount), marketing: fmt(cpc),
          netPayout: fmt(want.balance - cpc - (cents(got.platformFee) - want.platformFeeOrders)), unexplained: '0.00', payoutReference: inv.invoiceNumber,
          feeMonthNote: date === weeklyDay ? o.weeklyNote : null,
        });
      }
      // slice-1 anchor: the five Balance sums, recovered from the staged columns alone (S5a EDIT: fees now include VAT and the rounding line, so they are taken off both sides)
      const t = (pick: (d: StagedDay) => string): bigint => sum(staged.days.map((d) => cents(pick(d))));
      const ordersFees = sum([...o.days.values()].map((d) => d.platformFeeOrders));
      const extraFees = t((d) => d.platformFee) - ordersFees; // weekly fee + VAT on Appendix B + rounding line
      expect(fmt(t((d) => d.orderValue) - t((d) => d.commission) - ordersFees)).toBe(f.balance);
      expect(fmt(t((d) => d.netPayout) + t((d) => d.marketing) + extraFees)).toBe(f.balance);
      expect(t((d) => d.orderValue)).toBe(sum([...o.days.values()].map((d) => d.orderValue)));
    });
  }

  it('the weekly Platform Fee appears once, as a platform_fee_weekly line booked as platformFee, on the day that carries the month note; CPC ads are advertisement lines booked as marketing [kills: fee on every day; fee line missing; CPC kind wrong]', async () => {
    for (const f of FP_FIXTURES) {
      const inv = await readFpFixture(f.file);
      const staged = stageFoodpandaDays(inv, MATCHED);
      const lines = staged.days.flatMap((d) => d.otherLines.map((l) => ({ ...l, on: d.salesDate })));
      const weekly = lines.filter((l) => l.kind === 'platform_fee_weekly');
      expect(weekly.length, f.name).toBe(1);
      expect(weekly[0]).toMatchObject({ bookedAs: 'platformFee', amount: '223.21' });
      expect(staged.days.filter((d) => d.feeMonthNote !== null).map((d) => d.salesDate), f.name).toEqual([weekly[0]?.on]);
      const cpcCharges = inv.charges.filter((c) => c.kind === 'cpc_ad');
      const cpc = lines.filter((l) => l.kind === 'advertisement');
      expect(cpc.length, f.name).toBe(cpcCharges.length);
      expect(cpc.map((l) => `${l.lineDate}|${l.amount}|${l.bookedAs}`).sort(), f.name).toEqual(cpcCharges.map((c) => `${c.date}|${c.netTotal}|marketing`).sort());
    }
  });

  it('information columns (K gross, O P Q vendor discount) never reach the booked columns: order value is column R, not K [kills: K used as order value]', async () => {
    const inv = await readFpFixture('foodpanda-malvar-oct12-34col.zip'); // K 18,266.00 vs R 16,296.45
    const staged = stageFoodpandaDays(inv, MATCHED);
    expect(fmt(sum(staged.days.map((d) => cents(d.orderValue))))).toBe('16296.45');
    expect(fmt(sum(staged.days.map((d) => cents(d.grossInfo))))).toBe('18266.00');
    expect(fmt(sum(staged.days.map((d) => cents(d.vendorDiscount))))).toBe('1969.55');
  });
});

describe('T-511 S4 stage - the weekly Platform Fee relocation (synthetic invoices)', () => {
  const big = (code: string, orderDate: string): (string | number | Date | null)[] =>
    fp34Order(code, { 7: isoDay(orderDate), 10: 1000, 17: 1000, 19: 5, 33: 970 }); // gross = R = 1000.00, T 5.00 (0.5% of R, S5a EDIT: was 0.50), balance 970.00 (identities hold)
  const small = (code: string, orderDate: string): (string | number | Date | null)[] => fp34Order(code, { 7: isoDay(orderDate) }); // R 100.00, balance 74.50

  async function stageSynthetic(orderRows: (string | number | Date | null)[][]): Promise<StagedFile> {
    const book = fpWorkbook({
      orderRows,
      chargeRows: [fpChargeRow('Organic Placement (CPC)', 'Organic Placement (CPC)  2026-10-10  : ZZ99', 10), fpChargeRow('Platform Fee', 'PF for the month of September 2026 (W4):zz99', 223.21)],
    });
    const zip = zipBytes([{ name: '20261015_200999999999.xls', data: book }, { name: '20261015_200999999999.pdf', data: Buffer.from('%PDF-1.4 stub') }]);
    const inv = await readFoodpandaInvoice((await openSettlementZip(zip)).workbook);
    return stageFoodpandaDays(inv, { ...MATCHED, code: 'ZZ99' });
  }

  it('the last day cannot cover 223.21 (order value 100.00 less its own fees): the fee goes to the nearest earlier day that can, and that day keeps the month note [kills: fee left on a day that cannot pay it]', async () => {
    const staged = await stageSynthetic([big('zz99-0001-a', '2026-10-10'), big('zz99-0002-a', '2026-10-10'), small('zz99-0003-a', '2026-10-15')]);
    const days = byDate(staged);
    expect([...days.keys()].sort()).toEqual(['2026-10-10', '2026-10-15']);
    const early = days.get('2026-10-10') as StagedDay;
    const last = days.get('2026-10-15') as StagedDay;
    expect(early.feeMonthNote).toMatch(/September 2026/);
    expect(last.feeMonthNote).toBeNull();
    expect(early.otherLines.filter((l) => l.kind === 'platform_fee_weekly').map((l) => l.amount)).toEqual(['223.21']);
    expect(last.otherLines.filter((l) => l.kind === 'platform_fee_weekly')).toEqual([]);
    // S5a EDIT: orders cost 5.00 + 2.68 each (was 0.50 + 2.68): two orders 15.36, plus the weekly 223.21 and the VAT on Appendix B (12% of 233.21 = 27.99:
    // 26.79 on the fee, 1.20 on the 10 Oct CPC ad); the CPC ad of 10 Oct is marketing 10.00, net of VAT. Was '229.57'.
    expect(early.platformFee).toBe('266.56');
    expect(early.marketing).toBe('10.00');
    expect(last.platformFee).toBe('3.18');
    expect(early.unexplained).toBe('0.00');
    expect(last.unexplained).toBe('0.00');
  });

  it('the last day covers the fee: it stays there, no relocation [kills: always relocating; relocating to the first day]', async () => {
    const staged = await stageSynthetic([small('zz99-0001-a', '2026-10-10'), big('zz99-0002-a', '2026-10-15')]);
    const days = byDate(staged);
    expect((days.get('2026-10-15') as StagedDay).feeMonthNote).toMatch(/September 2026/);
    expect((days.get('2026-10-10') as StagedDay).feeMonthNote).toBeNull();
    expect((days.get('2026-10-15') as StagedDay).platformFee).toBe('257.68'); // S5a EDIT (was '226.39'): 5.00 + 2.68 + 223.21 + 26.79 VAT on the fee
  });

  it('an invoice with no Appendix B charges stages the order columns only: net payout = balance, nothing unexplained [kills: phantom fee on a chargeless invoice]', async () => {
    const book = fpWorkbook({ orderRows: [small('zz99-0001-a', '2026-10-10')], chargeRows: [] });
    const zip = zipBytes([{ name: '20261015_200999999999.xls', data: book }]);
    const inv = await readFoodpandaInvoice((await openSettlementZip(zip)).workbook);
    const [d, ...rest] = stageFoodpandaDays(inv, { ...MATCHED, code: 'ZZ99' }).days;
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ orderValue: '100.00', commission: '22.32', marketing: '0.00', platformFee: '3.18', netPayout: '74.50', unexplained: '0.00', feeMonthNote: null });
  });
});

describe('T-511 S4 stage - the PandaGO-only invoice', () => {
  it('stages zero days and its three lines as pandago / booked as none, signed as printed (1.68, 89.29, -476.00), dated 24 Sep [kills: PandaGO booked; lines dropped; a day invented]', async () => {
    const inv = await readFpFixture('foodpanda-lipa-oct5a-appendix-b-only-pandago.zip');
    const staged = stageFoodpandaDays(inv, MATCHED);
    expect(staged.days).toEqual([]);
    expect(staged.periodLines.length).toBe(3);
    for (const l of staged.periodLines) {
      expect(l.kind).toBe('pandago');
      expect(l.bookedAs).toBe('none');
      expect(l.lineDate).toBe('2026-09-24');
    }
    expect(staged.periodLines.map((l) => l.amount).sort()).toEqual(['-476.00', '1.68', '89.29']);
  });
});

/* ================================================================== the table CHECKs, in code first */

describe('T-511 S4 stage - checkStagedDay mirrors the table CHECKs and refuses by name before the database can', () => {
  function good(): StagedDay {
    const { staged } = stageGrab('grab-lipa-oct-transactions.csv', 'grab-lipa-oct-transfers.csv');
    return structuredClone(byDate(staged).get('2026-10-12') as StagedDay);
  }
  const refusalOf = (day: StagedDay): SettlementIntakeRefusal => {
    try {
      checkStagedDay(day);
    } catch (e) {
      if (e instanceof SettlementIntakeRefusal) return e;
      throw e;
    }
    throw new Error('expected a refusal');
  };

  it('a good staged day passes', () => {
    expect(() => checkStagedDay(good())).not.toThrow();
  });

  for (const field of ['orderValue', 'grossInfo', 'commission', 'marketing', 'platformFee', 'vendorDiscount', 'loanDeduction', 'loanDisbursal', 'netPayout', 'unexplained'] as const) {
    for (const bad of ['NaN', 'Infinity', '-Infinity']) {
      it(`${field} = ${bad} is refused naming the field (the table's finite CHECK) [kills: no finite check in code]`, () => {
        const d = good();
        (d as unknown as Record<string, string>)[field] = bad;
        expect(refusalOf(d).message).toContain(field);
      });
    }
  }

  it('commission stored negative is refused (the column is stored positive) [kills: sign check missing]', () => {
    const d = good();
    d.commission = '-1.00' as Money;
    expect(refusalOf(d).message).toContain('commission');
  });

  for (const bad of ['0.00', '-5.00', 'NaN']) {
    it(`a loan line of ${bad} is refused (amount > 0 and finite, the table CHECKs) [kills: zero or negative loan line staged]`, () => {
      const d = good();
      (d.loanLines[0] as { amount: string }).amount = bad;
      expect(refusalOf(d).message).toMatch(/loan/i);
    });
  }

  it('a pandago line booked as anything but none is refused (the table CHECK) [kills: PandaGO booked]', () => {
    const d = good();
    d.otherLines.push({ kind: 'pandago', bookedAs: 'platformFee', amount: '1.00' as Money, lineDate: '2026-10-12', description: null });
    expect(refusalOf(d).message).toMatch(/pandago/i);
  });

  it('a description over 200 characters is refused (the table CHECK) [kills: no length check]', () => {
    const d = good();
    d.otherLines.push({ kind: 'adjustment', bookedAs: 'none', amount: '1.00' as Money, lineDate: '2026-10-12', description: 'x'.repeat(201) });
    expect(refusalOf(d).message).toMatch(/description/i);
  });

  it('no refusal names an id or a Store ID', () => {
    const d = good();
    d.netPayout = 'NaN' as Money;
    expect(refusalOf(d).message).not.toMatch(UUID_SHAPE);
    expect(refusalOf(d).message).not.toContain('[hidden]');
  });
});
