import { describe, expect, it } from 'vitest';
import { money } from '@shareat/core/money';
import { routeSalesDay, SALES_DAY_ACCOUNTS, type RouteSalesDayInput } from '../src/sales-days/routing';

/**
 * `routeSalesDay` against `docs/POSTING-PATTERNS.md`'s five verified `sale.*` patterns.
 *
 * ⭐ **These are not examples, they are the specification.** T-108 pinned and verified each one
 * against real v1 data; this function is their generalisation and must reproduce every one exactly
 * — same accounts, same sides, same amounts. A change here that "improves" a posting silently
 * breaks a pattern somebody already checked.
 */

const ZERO = money('0');

function input(over: Partial<RouteSalesDayInput>): RouteSalesDayInput {
  return {
    totalSales: ZERO,
    unliSales: ZERO,
    alaCarteSales: ZERO,
    seniorDiscount: ZERO,
    pwdDiscount: ZERO,
    otherDiscount: ZERO,
    comps: ZERO,
    serviceCharge: ZERO,
    otherCharges: ZERO,
    cashCollected: ZERO,
    onlineCollected: ZERO,
    creditSales: ZERO,
    channels: [],
    tenders: [],
    ...over,
  };
}

/** Compact, order-independent view of a routing result, so a test reads like the pattern table. */
function posted(result: ReturnType<typeof routeSalesDay>): Record<string, string> {
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  const out: Record<string, string> = {};
  for (const l of result.lines) {
    out[`${l.side === 'debit' ? 'DR' : 'CR'} ${l.accountCode}`] = String(l.amount);
  }
  return out;
}

describe('sale.unli.simple — dine-in unlimited, cash only', () => {
  it('posts ₱5,600 cash against 4100', () => {
    const r = routeSalesDay(
      input({ totalSales: money('5600'), unliSales: money('5600'), cashCollected: money('5600') }),
    );
    expect(posted(r)).toEqual({ 'DR 1110': '5600.00', 'CR 4100': '5600.00' });
  });
});

describe('sale.alacarte.simple — à la carte, includes take-out and delivery', () => {
  it('posts ₱780 cash against 4150', () => {
    const r = routeSalesDay(
      input({ totalSales: money('780'), alaCarteSales: money('780'), cashCollected: money('780') }),
    );
    expect(posted(r)).toEqual({ 'DR 1110': '780.00', 'CR 4150': '780.00' });
  });
});

describe('sale.discount.senior-pwd — contra-revenue at 4900', () => {
  it('a ₱1,000 unli sale with ₱200 discount tenders ₱800 and debits 4900', () => {
    const r = routeSalesDay(
      input({
        totalSales: money('1000'),
        unliSales: money('1000'),
        seniorDiscount: money('200'),
        cashCollected: money('800'),
      }),
    );
    expect(posted(r)).toEqual({ 'DR 1110': '800.00', 'DR 4900': '200.00', 'CR 4100': '1000.00' });
  });

  it('senior, PWD and other discounts SUM into one 4900 line', () => {
    // They are separate COLUMNS because RR 5-2017 requires the breakout (discovery 24 §4), but
    // they are one ACCOUNT. The statutory split is a reporting obligation, not a chart change.
    const r = routeSalesDay(
      input({
        totalSales: money('1000'),
        unliSales: money('1000'),
        seniorDiscount: money('100'),
        pwdDiscount: money('60'),
        otherDiscount: money('40'),
        cashCollected: money('800'),
      }),
    );
    expect(posted(r)).toEqual({ 'DR 1110': '800.00', 'DR 4900': '200.00', 'CR 4100': '1000.00' });
  });
});

describe('sale.comps — 4950, NEVER 4900 and never a marketing expense', () => {
  it('a ₱500 unli sale with ₱100 comped tenders ₱400 and debits 4950', () => {
    const r = routeSalesDay(
      input({
        totalSales: money('500'),
        unliSales: money('500'),
        comps: money('100'),
        cashCollected: money('400'),
      }),
    );
    expect(posted(r)).toEqual({ 'DR 1110': '400.00', 'DR 4950': '100.00', 'CR 4100': '500.00' });
  });

  it('comps and discounts land on DIFFERENT accounts — the trap this pattern exists to pin', () => {
    const r = routeSalesDay(
      input({
        totalSales: money('1000'),
        unliSales: money('1000'),
        seniorDiscount: money('200'),
        comps: money('100'),
        cashCollected: money('700'),
      }),
    );
    const p = posted(r);
    expect(p['DR 4900']).toBe('200.00');
    expect(p['DR 4950']).toBe('100.00');
    expect(SALES_DAY_ACCOUNTS.DISCOUNTS).not.toBe(SALES_DAY_ACCOUNTS.COMPS);
  });
});

describe('sale.mixed — the full pattern', () => {
  it('reproduces POSTING-PATTERNS.md exactly', () => {
    const r = routeSalesDay(
      input({
        totalSales: money('5450'),
        unliSales: money('4450'),
        alaCarteSales: money('1000'),
        seniorDiscount: money('300'),
        comps: money('150'),
        cashCollected: money('3000'),
        onlineCollected: money('2000'),
        // ⭐ DEF-068: online money must name the wallet it landed in. The identity that the
        // breakdown equals the day's online total is checked in `routeSalesDay`.
        tenders: [{ moneyAccountId: 'wallet-gcash', amount: money('2000') }],
      }),
    );
    expect(posted(r)).toEqual({
      'DR 1110': '3000.00',
      'DR 1140': '2000.00',
      'DR 4900': '300.00',
      'DR 4950': '150.00',
      'CR 4100': '4450.00',
      'CR 4150': '1000.00',
    });
  });

  it('debits equal credits', () => {
    const r = routeSalesDay(
      input({
        totalSales: money('5450'),
        unliSales: money('4450'),
        alaCarteSales: money('1000'),
        seniorDiscount: money('300'),
        comps: money('150'),
        cashCollected: money('3000'),
        onlineCollected: money('2000'),
        // ⭐ DEF-068: online money must name the wallet it landed in. The identity that the
        // breakdown equals the day's online total is checked in `routeSalesDay`.
        tenders: [{ moneyAccountId: 'wallet-gcash', amount: money('2000') }],
      }),
    );
    if (!r.ok) throw new Error(r.reason);
    const sum = (side: 'debit' | 'credit') =>
      r.lines.filter((l) => l.side === side).reduce((acc, l) => acc + Number(l.amount), 0);
    expect(sum('debit')).toBe(sum('credit'));
    expect(sum('debit')).toBe(5450);
  });
});

describe('the balance identity is TWO checks, and a failure BLOCKS rather than guessing', () => {
  it('blocks when the revenue split does not equal the total', () => {
    const r = routeSalesDay(
      input({ totalSales: money('1000'), unliSales: money('600'), cashCollected: money('1000') }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toMatch(/revenue split does not equal total sales/);
  });

  it('blocks when what was COLLECTED does not reconcile — the check a CHECK constraint cannot do', () => {
    // This is the half that spans two tables (non-remitted channel amounts live in
    // sales_day_channels), which is exactly why it lives here rather than in the schema.
    const r = routeSalesDay(
      input({ totalSales: money('1000'), unliSales: money('1000'), cashCollected: money('900') }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toMatch(/does not reconcile/);
  });

  it('a day with no figures at all posts nothing', () => {
    const r = routeSalesDay(input({}));
    expect(r.ok).toBe(false);
  });
});

describe('non-remitted channels — the money that never reaches the till', () => {
  const foodpanda = {
    channelId: 'ch-fp',
    channelName: 'Foodpanda',
    isRemittedDaily: false,
    receivableAccountCode: '1220',
    amount: money('1200'),
    noSales: false,
  };
  /** ⚠️ Added when the channel identity landed: these fixtures previously declared ₱1,200 of
   *  Foodpanda against a ₱2,000 total and nothing else — internally inconsistent, and the new
   *  check was right to reject them. The remitted counterpart makes the breakdown whole. */
  const walkIn = {
    channelId: 'ch-wi',
    channelName: 'Walk-in',
    isRemittedDaily: true,
    receivableAccountCode: null,
    amount: money('800'),
    noSales: false,
  };

  it('debits the channel receivable, with the channel as the party', () => {
    const r = routeSalesDay(
      input({
        totalSales: money('2000'),
        alaCarteSales: money('2000'),
        cashCollected: money('800'),
        channels: [walkIn, foodpanda],
      }),
    );
    if (!r.ok) throw new Error(r.reason);
    const receivable = r.lines.find((l) => l.accountCode === '1220');
    expect(receivable).toBeDefined();
    expect(receivable!.side).toBe('debit');
    expect(String(receivable!.amount)).toBe('1200.00');
    // T-118's subledger: a control account line names WHO owes the money.
    expect(receivable!.partyType).toBe('channel');
    expect(receivable!.partyId).toBe('ch-fp');
  });

  it('⛔ BLOCKS a non-remitted channel with no receivable account — DEF-059 refused', () => {
    // v1's substring fallback on "dine" silently drops the sales of a channel it cannot
    // resolve. Here the money is refused, not lost.
    const r = routeSalesDay(
      input({
        totalSales: money('2000'),
        alaCarteSales: money('2000'),
        cashCollected: money('800'),
        channels: [walkIn, { ...foodpanda, receivableAccountCode: null }],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toMatch(/Foodpanda/);
    expect(r.reason).toMatch(/silently lost/);
  });

  it('a REMITTED channel contributes no receivable line — its money is already in the till', () => {
    const r = routeSalesDay(
      input({
        totalSales: money('800'),
        alaCarteSales: money('800'),
        cashCollected: money('800'),
        channels: [{ ...foodpanda, channelName: 'Walk-in', isRemittedDaily: true, amount: money('800') }],
      }),
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.lines.some((l) => l.accountCode === '1220')).toBe(false);
  });
});

describe('credit sales are refused, by name', () => {
  it('names AR and T-131 rather than guessing a counterparty', () => {
    // 1210 has requires_party; a DAY has no customer. Guessing one would post a receivable
    // against nobody, which is worse than refusing.
    const r = routeSalesDay(
      input({
        totalSales: money('1000'),
        unliSales: money('1000'),
        cashCollected: money('400'),
        creditSales: money('600'),
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toMatch(/requires a party/);
    expect(r.reason).toMatch(/T-131/);
  });
});

describe('⭐ the CHANNEL identity — Σ all channels = totalSales (bible row 133)', () => {
  const walkIn = {
    channelId: 'ch-wi',
    channelName: 'Walk-in',
    isRemittedDaily: true,
    receivableAccountCode: null,
    amount: money('0'),
    noSales: false,
  };
  const foodpanda = {
    channelId: 'ch-fp',
    channelName: 'Foodpanda',
    isRemittedDaily: false,
    receivableAccountCode: '1220',
    amount: money('0'),
    noSales: false,
  };

  it('⛔ BLOCKS the exact day my own browser smoketest let through', () => {
    // ₱6,000 total with only ₱550 of channels declared. This posted cleanly before the identity
    // existed, because the tender and revenue checks both passed — the channels were simply
    // never compared to anything. That is the whole reason this test names the case.
    const r = routeSalesDay(
      input({
        totalSales: money('6000'),
        unliSales: money('4450'),
        alaCarteSales: money('1550'),
        seniorDiscount: money('300'),
        comps: money('150'),
        cashCollected: money('3000'),
        onlineCollected: money('2000'),
        // ⭐ DEF-068: online money must name the wallet it landed in. The identity that the
        // breakdown equals the day's online total is checked in `routeSalesDay`.
        tenders: [{ moneyAccountId: 'wallet-gcash', amount: money('2000') }],
        channels: [{ ...foodpanda, amount: money('550') }],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toMatch(/channel breakdown does not equal total sales/);
    expect(r.reason).toMatch(/550/);
    expect(r.reason).toMatch(/6000/);
  });

  it('passes when remitted and non-remitted channels TOGETHER make the total', () => {
    // Ian: "total sales are all sales channel sum, remitted daily and un-remitted daily combined."
    const r = routeSalesDay(
      input({
        totalSales: money('6000'),
        unliSales: money('4450'),
        alaCarteSales: money('1550'),
        seniorDiscount: money('300'),
        comps: money('150'),
        cashCollected: money('3000'),
        onlineCollected: money('2000'),
        // ⭐ DEF-068: online money must name the wallet it landed in. The identity that the
        // breakdown equals the day's online total is checked in `routeSalesDay`.
        tenders: [{ moneyAccountId: 'wallet-gcash', amount: money('2000') }],
        channels: [
          { ...walkIn, amount: money('5450') },
          { ...foodpanda, amount: money('550') },
        ],
      }),
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.lines.find((l) => l.accountCode === '1220')?.amount).toBeDefined();
  });

  it('a day with NO channel rows is not blocked — the breakdown is optional, not partial', () => {
    // A store with no channels configured must still be able to report. Once one row exists,
    // the breakdown is claiming to BE the breakdown.
    const r = routeSalesDay(
      input({ totalSales: money('1000'), unliSales: money('1000'), cashCollected: money('1000') }),
    );
    expect(r.ok).toBe(true);
  });

  it('a "confirmed no sales" row counts as zero and does not break the identity', () => {
    const r = routeSalesDay(
      input({
        totalSales: money('1000'),
        unliSales: money('1000'),
        cashCollected: money('1000'),
        channels: [
          { ...walkIn, amount: money('1000') },
          { ...foodpanda, amount: money('0'), noSales: true },
        ],
      }),
    );
    expect(r.ok).toBe(true);
  });
});

describe('⛔ charges — two kinds that look alike and are opposite in the books (row 134)', () => {
  it('service charge credits 2160, a LIABILITY — never income', () => {
    // RA 11360 sends 100% of it to rank-and-file employees. The business collects as an agent
    // and keeps nothing, so booking it as revenue would overstate profit AND hide a payable.
    const r = routeSalesDay(
      input({
        totalSales: money('1000'),
        unliSales: money('1000'),
        serviceCharge: money('100'),
        cashCollected: money('1100'),
      }),
    );
    expect(posted(r)).toEqual({ 'DR 1110': '1100.00', 'CR 4100': '1000.00', 'CR 2160': '100.00' });
  });

  it('other charges credit 4500, INCOME — the business keeps these', () => {
    const r = routeSalesDay(
      input({
        totalSales: money('1000'),
        unliSales: money('1000'),
        otherCharges: money('50'),
        cashCollected: money('1050'),
      }),
    );
    expect(posted(r)).toEqual({ 'DR 1110': '1050.00', 'CR 4100': '1000.00', 'CR 4500': '50.00' });
  });

  it('⭐ the two never share an account — that separation IS the requirement', () => {
    // Ian: "all [other charges] in one account, separated from service charge."
    const r = routeSalesDay(
      input({
        totalSales: money('1000'),
        unliSales: money('1000'),
        serviceCharge: money('100'),
        otherCharges: money('50'),
        cashCollected: money('1150'),
      }),
    );
    const p = posted(r);
    expect(p['CR 2160']).toBe('100.00');
    expect(p['CR 4500']).toBe('50.00');
    expect(SALES_DAY_ACCOUNTS.SERVICE_CHARGE_FLOAT).not.toBe(SALES_DAY_ACCOUNTS.OTHER_CHARGES);
    // And one is a liability while the other is income — the whole point.
    expect(SALES_DAY_ACCOUNTS.SERVICE_CHARGE_FLOAT.startsWith('2')).toBe(true);
    expect(SALES_DAY_ACCOUNTS.OTHER_CHARGES.startsWith('4')).toBe(true);
  });

  it('charges sit on the EARNED side of the reconciliation, not the collected side', () => {
    // A day where the customer paid gross + charges − discount. Everything taken in plus
    // everything given away must equal everything earned.
    const r = routeSalesDay(
      input({
        totalSales: money('1000'),
        unliSales: money('1000'),
        seniorDiscount: money('200'),
        serviceCharge: money('100'),
        otherCharges: money('50'),
        cashCollected: money('950'), // 1000 + 100 + 50 − 200
      }),
    );
    if (!r.ok) throw new Error(r.reason);
    const sum = (side: 'debit' | 'credit') =>
      r.lines.filter((l) => l.side === side).reduce((acc, l) => acc + Number(l.amount), 0);
    expect(sum('debit')).toBe(sum('credit'));
    expect(sum('debit')).toBe(1150);
  });

  it('a charge that does not reconcile BLOCKS, naming both sides', () => {
    const r = routeSalesDay(
      input({
        totalSales: money('1000'),
        unliSales: money('1000'),
        serviceCharge: money('100'),
        cashCollected: money('1000'), // forgot to collect the service charge
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toMatch(/does not reconcile/);
    expect(r.reason).toMatch(/service charge/);
  });
});
