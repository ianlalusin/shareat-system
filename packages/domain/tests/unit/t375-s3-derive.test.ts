import { beforeAll, describe, expect, it } from 'vitest';
import { money } from '@shareat/core/money';
import { posV1SalesBody, type PosV1SalesFigures } from '../../../db/src/pos-v1/fixtures';

/**
 * T-375 S3 - `deriveSalesDay` (`packages/domain/src/pos/v1-derive.ts`) and the `refunds` leg of `routeSalesDay`.
 * `docs/tasks/375-pos-v1-day-feed.md` S3 tests D1, D2, D2a, D2b, D2c, D3, D3r, D4 (+ D5, the R4 centavo rule).
 *
 * TESTER, not BUILDER. Pure, no I/O. Every refusal has a positive control in the same describe.
 *
 * ## Why these are red on HEAD
 * `v1-derive.ts` does not exist. It is imported DYNAMICALLY (preloaded in `beforeAll`), so each leg that derives fails
 * on "Failed to resolve import ../../src/pos/v1-derive" - a missing module is the honest red for a new file. The
 * routing legs run against code that EXISTS, so they are red on the assertion: `routeSalesDay` has no `refunds` and
 * `SALES_DAY_ACCOUNTS` has no `REFUNDS` yet.
 *
 * ## The target shape (the spec says only "figures (incl. refunds), one channel row, tender rows, the W1 cap excess,
 * or a refusal"; read here the way `resolvePosV1Methods` reads, and written down so the builder has one reading)
 *   deriveSalesDay(payload, { channelId, taxType, tenders, businessDate })
 *     -> { ok: true,  figures: { totalSales, unliSales, alaCarteSales, seniorDiscount, pwdDiscount, otherDiscount, comps,
 *                                serviceCharge, otherCharges, cashCollected, onlineCollected, creditSales, refunds },
 *          channel: { channelId, amount }, tenders: { moneyAccountId, amount }[], capExcess }      (Money = '700.00')
 *      | { ok: false, sentence, raw }
 *  - `payload` is the parsed `sales` response (an object); `tenders` are `resolvePosV1Methods` rows;
 *  - `businessDate` (YYYY-MM-DD) is in the context so a refusal can name the day; the DATE inside a sentence is not
 *    pinned here (the integration file pins the full sentences with the date), so unit sentences use `.+` for it.
 */
type Tender = { id: string; kind: 'cash' | 'wallet'; moneyAccountId: string | null; posV1Alias: string | null; isActive: boolean };
type Figures = Record<
  | 'totalSales'
  | 'unliSales'
  | 'alaCarteSales'
  | 'seniorDiscount'
  | 'pwdDiscount'
  | 'otherDiscount'
  | 'comps'
  | 'serviceCharge'
  | 'otherCharges'
  | 'cashCollected'
  | 'onlineCollected'
  | 'creditSales'
  | 'refunds',
  string
>;
type Ok = {
  ok: true;
  figures: Figures;
  channel: { channelId: string; amount: string };
  tenders: { moneyAccountId: string; amount: string }[];
  capExcess: string;
};
type Refused = { ok: false; sentence: string; raw: string };
type Res = Ok | Refused;
type Ctx = { channelId: string; taxType: 'vat_inclusive' | 'vat_exclusive' | 'non_vat'; tenders: Tender[]; businessDate: string };
type Mod = { deriveSalesDay: (payload: unknown, ctx: Ctx) => Res };

let mod: Mod | undefined;
let loadError: unknown;
beforeAll(async () => {
  // A missing module must fail the legs that DERIVE, not skip the routing legs that run against code that exists.
  try {
    mod = (await import('../../src/pos/v1-derive')) as unknown as Mod;
  } catch (err) {
    loadError = err;
  }
}, 120_000);

const CASH: Tender = { id: 't-cash', kind: 'cash', moneyAccountId: null, posV1Alias: 'Cash', isActive: true };
const GCASH: Tender = { id: 't-gcash', kind: 'wallet', moneyAccountId: 'acct-gcash', posV1Alias: 'GCash', isActive: true };
const CHANNEL = 'chan-walkin';

/** A trap-name decoy in POS's residual field (never read). Built by concatenation on purpose (R12). */
const DECOY = { ['take' + 'Out' + 'Sales']: 123.45 };

const D1: PosV1SalesFigures = {
  paidTotal: 1050,
  discounts: 100,
  charges: 50,
  packageOnly: 600,
  receiptCount: 20,
  methods: { Cash: 700, GCash: 350 },
  extra: DECOY,
};

function derive(figs: PosV1SalesFigures, o: Partial<Ctx> = {}): Res {
  if (!mod) throw loadError instanceof Error ? loadError : new Error('v1-derive did not load');
  return mod.deriveSalesDay(posV1SalesBody(figs), {
    channelId: CHANNEL,
    taxType: 'vat_inclusive',
    tenders: [CASH, GCASH],
    businessDate: '2027-01-15',
    ...o,
  });
}
function okOf(r: Res): Ok {
  if (!r.ok) throw new Error(`expected a derivation, got a refusal: ${r.sentence}`);
  return r;
}
function refusalOf(r: Res): Refused {
  expect(r.ok, 'must refuse').toBe(false);
  if (r.ok) throw new Error('unreachable');
  return r;
}

/** Route a derivation through the real `routeSalesDay` and return "Dr 1110 700.00"-style strings, sorted. */
async function routed(r: Ok) {
  const { routeSalesDay } = await import('../../src/sales-days/routing');
  const f = r.figures;
  const res = routeSalesDay({
    totalSales: money(f.totalSales),
    unliSales: money(f.unliSales),
    alaCarteSales: money(f.alaCarteSales),
    seniorDiscount: money(f.seniorDiscount),
    pwdDiscount: money(f.pwdDiscount),
    otherDiscount: money(f.otherDiscount),
    comps: money(f.comps),
    serviceCharge: money(f.serviceCharge),
    otherCharges: money(f.otherCharges),
    cashCollected: money(f.cashCollected),
    onlineCollected: money(f.onlineCollected),
    creditSales: money(f.creditSales),
    refunds: money(f.refunds),
    channels: [
      {
        channelId: r.channel.channelId,
        channelName: 'Walk-in',
        isRemittedDaily: true,
        receivableAccountCode: null,
        amount: money(r.channel.amount),
        noSales: false,
      },
    ],
    tenders: r.tenders.map((t) => ({ moneyAccountId: t.moneyAccountId, amount: money(t.amount) })),
  } as never);
  if (!res.ok) throw new Error(`routeSalesDay refused: ${res.reason}`);
  const text = res.lines.map((l) => `${l.side === 'debit' ? 'Dr' : 'Cr'} ${l.accountCode} ${l.amount}`).sort();
  return { text, lines: res.lines };
}

describe('D1 - the spec day derives to the spec figures and routes to the spec lines', () => {
  it('P 1,050 D 100 C 50 K 600, methods {Cash 700, GCash 350}, N 20 -> total 1,100 / unli 600 / a la carte 500 (not the POS residual) / discount 100 / charges 50 / refunds 0 / cash 700 / online 350', () => {
    const r = okOf(derive(D1));
    expect(r.figures).toEqual({
      totalSales: '1100.00',
      unliSales: '600.00',
      alaCarteSales: '500.00',
      seniorDiscount: '0.00',
      pwdDiscount: '0.00',
      otherDiscount: '100.00',
      comps: '0.00',
      serviceCharge: '0.00',
      otherCharges: '50.00',
      cashCollected: '700.00',
      onlineCollected: '350.00',
      creditSales: '0.00',
      refunds: '0.00',
    });
    expect(r.tenders).toEqual([{ moneyAccountId: 'acct-gcash', amount: '350.00' }]);
    expect(r.channel).toEqual({ channelId: CHANNEL, amount: '1100.00' });
    expect(r.capExcess).toBe('0.00');
  });

  it('routes to Dr 1110 700, Dr 1140 350 (the GCash account), Dr 4900 100, Cr 4100 600, Cr 4150 500, Cr 4500 50', async () => {
    const { text, lines } = await routed(okOf(derive(D1)));
    expect(text).toEqual(
      ['Cr 4100 600.00', 'Cr 4150 500.00', 'Cr 4500 50.00', 'Dr 1110 700.00', 'Dr 1140 350.00', 'Dr 4900 100.00'].sort(),
    );
    expect(lines.find((l) => l.accountCode === '1140')?.partyId).toBe('acct-gcash');
  });

  it('SALES_DAY_ACCOUNTS.REFUNDS is 4950 (the contra-revenue account comps also use)', async () => {
    const { SALES_DAY_ACCOUNTS } = await import('../../src/sales-days/routing');
    expect((SALES_DAY_ACCOUNTS as Record<string, string>).REFUNDS).toBe('4950');
  });
});

describe('R4 routing - refunds on the collected side, a Dr 4950 line (runs against routing.ts, which exists)', () => {
  const base = {
    totalSales: money('1100.00'),
    unliSales: money('600.00'),
    alaCarteSales: money('500.00'),
    seniorDiscount: money('0.00'),
    pwdDiscount: money('0.00'),
    otherDiscount: money('100.00'),
    comps: money('0.00'),
    serviceCharge: money('0.00'),
    otherCharges: money('50.00'),
    onlineCollected: money('350.00'),
    creditSales: money('0.00'),
    channels: [{ channelId: 'c', channelName: 'Walk-in', isRemittedDaily: true, receivableAccountCode: null, amount: money('1100.00'), noSales: false }],
    tenders: [{ moneyAccountId: 'acct-gcash', amount: money('350.00') }],
  };

  it('refunds 100.00 with cash 600.00 balances and posts Dr 4950 100.00 "refunds (POS)"', async () => {
    const { routeSalesDay } = await import('../../src/sales-days/routing');
    const res = routeSalesDay({ ...base, cashCollected: money('600.00'), refunds: money('100.00') } as never);
    expect(res.ok, res.ok ? '' : res.reason).toBe(true);
    if (!res.ok) return;
    const line = res.lines.find((l) => l.accountCode === '4950');
    expect(line?.side).toBe('debit');
    expect(String(line?.amount)).toBe('100.00');
    expect(line?.lineMemo).toBe('refunds (POS)');
  });

  it('control: refunds 0.00 (a legacy day) routes exactly as before, no 4950 line', async () => {
    const { routeSalesDay } = await import('../../src/sales-days/routing');
    const res = routeSalesDay({ ...base, cashCollected: money('700.00'), refunds: money('0.00') } as never);
    expect(res.ok, res.ok ? '' : res.reason).toBe(true);
    if (!res.ok) return;
    expect(res.lines.some((l) => l.accountCode === '4950')).toBe(false);
    expect(res.lines.map((l) => `${l.side} ${l.accountCode} ${l.amount}`).sort()).toEqual(
      ['credit 4100 600.00', 'credit 4150 500.00', 'credit 4500 50.00', 'debit 1110 700.00', 'debit 1140 350.00', 'debit 4900 100.00'].sort(),
    );
  });

  it('refunds sit on the collected side: cash 700.00 plus refunds 100.00 over-collects and does NOT reconcile', async () => {
    const { routeSalesDay } = await import('../../src/sales-days/routing');
    const res = routeSalesDay({ ...base, cashCollected: money('700.00'), refunds: money('100.00') } as never);
    expect(res.ok).toBe(false);
  });
});

describe('D2 - methods short of the sales refuse; float noise that rounds equal does not', () => {
  it('methods 1,049.99 against P 1,050.00 -> the methods-short sentence naming both figures', () => {
    const r = refusalOf(derive({ ...D1, methods: { Cash: 700, GCash: 349.99 } }));
    expect(r.sentence).toMatch(
      /^POS's payments for .+ \(₱1,049\.99\) are less than its sales \(₱1,050\.00\), so the day can't be imported\. This has to be fixed on the POS\.$/,
    );
  });

  it('control: float noise (0.1 + 0.2 against 0.30) rounds equal -> accepted, total 0.30', () => {
    const r = okOf(
      derive({ paidTotal: 0.3, discounts: 0, charges: 0, packageOnly: 0, receiptCount: 1, methods: { Cash: 0.1 + 0.2 }, extra: DECOY }),
    );
    expect(r.figures.totalSales).toBe('0.30');
    expect(r.figures.cashCollected).toBe('0.30');
    expect(r.figures.refunds).toBe('0.00');
  });
});

describe('D2a - a few centavos over is rounding, not a refund (X <= 0.01 x N)', () => {
  const day: PosV1SalesFigures = { ...D1, methods: { Cash: 700.03, GCash: 350 } };

  it('methods 1,050.03, P 1,050, N 20 -> refunds 0, other charges 50.03, cash 700.03, total still 1,100; routes with no 4950 line', async () => {
    const r = okOf(derive(day));
    expect(r.figures.refunds).toBe('0.00');
    expect(r.figures.otherCharges).toBe('50.03');
    expect(r.figures.cashCollected).toBe('700.03');
    expect(r.figures.totalSales).toBe('1100.00');
    const { text } = await routed(r);
    expect(text.some((t) => t.includes(' 4950 '))).toBe(false);
    expect(text).toContain('Cr 4500 50.03');
  });

  it('control: N 2 -> the 0.03 is above 0.02, so it is a refund: refunds 0.03, cash 700.00, total 1,100.03, a Dr 4950 0.03 line', async () => {
    const r = okOf(derive({ ...day, receiptCount: 2 }));
    expect(r.figures.refunds).toBe('0.03');
    expect(r.figures.cashCollected).toBe('700.00');
    expect(r.figures.totalSales).toBe('1100.03');
    expect(r.figures.otherCharges).toBe('50.00');
    const { text } = await routed(r);
    expect(text).toContain('Dr 4950 0.03');
  });
});

describe('D2a boundary - the rounding band is X <= 0.01 x N, inclusive (kills <= -> <)', () => {
  const at = (excess: number, n: number) =>
    derive({ ...D1, receiptCount: n, methods: { Cash: 700 + excess, GCash: 350 } });

  it('X exactly 0.01 x N (0.20 over, N 20) is rounding: refunds 0.00, other charges 50.20', () => {
    const r = okOf(at(0.2, 20));
    expect(r.figures.refunds).toBe('0.00');
    expect(r.figures.otherCharges).toBe('50.20');
    expect(r.figures.cashCollected).toBe('700.20');
  });

  it('X = 0.01 x N + 0.01 (0.21 over, N 20) is a refund: refunds 0.21, cash 700.00, other charges 50.00', () => {
    const r = okOf(at(0.21, 20));
    expect(r.figures.refunds).toBe('0.21');
    expect(r.figures.cashCollected).toBe('700.00');
    expect(r.figures.otherCharges).toBe('50.00');
  });

  it('N 0: the band is 0.01 x 0 = 0 by the R4 formula (the spec states no separate N = 0 rule): X 0.00 derives, any X > 0 is a refund', () => {
    const none = okOf(at(0, 0));
    expect(none.figures.refunds).toBe('0.00');
    expect(okOf(at(0.01, 0)).figures.refunds).toBe('0.01');
  });
});

describe('D2b - a refund day (P 950 against methods that still total 1,050)', () => {
  const refundDay: PosV1SalesFigures = { ...D1, paidTotal: 950 };

  it('refunds 100.00, total 1,100.00, cash 600.00 (refunds come out of cash), online 350.00, a la carte 500.00', () => {
    const r = okOf(derive(refundDay));
    expect(r.figures.refunds).toBe('100.00');
    expect(r.figures.totalSales).toBe('1100.00');
    expect(r.figures.cashCollected).toBe('600.00');
    expect(r.figures.onlineCollected).toBe('350.00');
    expect(r.figures.alaCarteSales).toBe('500.00');
    expect(r.figures.unliSales).toBe('600.00');
    expect(r.figures.comps, 'refunds are never comps').toBe('0.00');
    expect(r.channel.amount).toBe('1100.00');
  });

  it('routes with Dr 4950 100.00 memo "refunds (POS)" beside Dr 1110 600, Dr 1140 350, Dr 4900 100 and the three credits', async () => {
    const { text, lines } = await routed(okOf(derive(refundDay)));
    expect(text).toEqual(
      [
        'Cr 4100 600.00',
        'Cr 4150 500.00',
        'Cr 4500 50.00',
        'Dr 1110 600.00',
        'Dr 1140 350.00',
        'Dr 4900 100.00',
        'Dr 4950 100.00',
      ].sort(),
    );
    expect(lines.find((l) => l.accountCode === '4950')?.lineMemo).toBe('refunds (POS)');
  });

  it('refunds 800.00 against cash 700.00 -> the refunds-above-cash sentence', () => {
    const r = refusalOf(derive({ ...D1, paidTotal: 250, discounts: 0, charges: 0, packageOnly: 0 }));
    expect(r.sentence).toMatch(
      /^POS shows ₱800\.00 refunded on .+ but only ₱700\.00 cash taken, so the day can't be imported\. Tell the office; this needs a ruling\.$/,
    );
  });

  it('control: refunds exactly equal to cash (700.00 against 700.00) are accepted, cash 0.00', () => {
    const r = okOf(derive({ ...D1, paidTotal: 350, discounts: 0, charges: 0, packageOnly: 0 }));
    expect(r.figures.refunds).toBe('700.00');
    expect(r.figures.cashCollected).toBe('0.00');
  });
});

describe('D2c - a VAT-exclusive link is refused before anything is derived', () => {
  it('vat_exclusive -> the VAT sentence, even for a payload that would otherwise refuse for another reason', () => {
    const r = refusalOf(derive({ ...D1, methods: { Cash: 700, GCash: 349.99 } }, { taxType: 'vat_exclusive' }));
    expect(r.sentence).toBe(
      'This store adds VAT on top of its prices in POS. Importing it needs a ruling on where that VAT goes. Ask the office.',
    );
  });

  it('controls: vat_inclusive and non_vat both give the D1 result', () => {
    for (const taxType of ['vat_inclusive', 'non_vat'] as const) {
      const r = okOf(derive(D1, { taxType }));
      expect(r.figures.totalSales).toBe('1100.00');
      expect(r.figures.cashCollected).toBe('700.00');
    }
  });
});

describe('D3 - a package figure above the days sales is capped, never refused (W1)', () => {
  it('K 1,200 > total 1,100 -> unli 1,100, a la carte 0, cap excess 100.00; it still routes', async () => {
    const r = okOf(derive({ ...D1, packageOnly: 1200 }));
    expect(r.figures.unliSales).toBe('1100.00');
    expect(r.figures.alaCarteSales).toBe('0.00');
    expect(r.capExcess).toBe('100.00');
    const { text } = await routed(r);
    expect(text).toContain('Cr 4100 1100.00');
    expect(text.some((t) => t.includes(' 4150 '))).toBe(false);
  });

  it('control: K equal to the total -> unli 1,100, cap excess 0.00', () => {
    const r = okOf(derive({ ...D1, packageOnly: 1100 }));
    expect(r.figures.unliSales).toBe('1100.00');
    expect(r.figures.alaCarteSales).toBe('0.00');
    expect(r.capExcess).toBe('0.00');
  });
});

describe('D3r - a dine-in refund day (refunded package lines counted positive by POS)', () => {
  const day: PosV1SalesFigures = {
    paidTotal: 900,
    discounts: 0,
    charges: 0,
    packageOnly: 1000,
    receiptCount: 20,
    methods: { Cash: 1000 },
    extra: DECOY,
  };

  it('P 900, Cash 1,000, K 1,000 -> refunds 100, total 1,000, unli 1,000 (equal, not capped), a la carte 0', () => {
    const r = okOf(derive(day));
    expect(r.figures.refunds).toBe('100.00');
    expect(r.figures.totalSales).toBe('1000.00');
    expect(r.figures.unliSales).toBe('1000.00');
    expect(r.figures.alaCarteSales).toBe('0.00');
    expect(r.figures.cashCollected).toBe('900.00');
    expect(r.capExcess).toBe('0.00');
  });

  it('K 1,100 -> capped at 1,000 with excess 100.00, and it imports (never refused)', () => {
    const r = okOf(derive({ ...day, packageOnly: 1100 }));
    expect(r.figures.unliSales).toBe('1000.00');
    expect(r.figures.alaCarteSales).toBe('0.00');
    expect(r.capExcess).toBe('100.00');
  });
});

describe('D4 - POS has no data for the day', () => {
  it('found: false -> refused', () => {
    expect(refusalOf(derive({ found: false })).sentence.length).toBeGreaterThan(0);
  });

  it('control: found: true with the same context derives', () => {
    expect(okOf(derive(D1)).ok).toBe(true);
  });
});

describe('D5 - one float -> centavo conversion at the wire (R4)', () => {
  it('a paid total that is not a whole number of centavos (1,050.005) is refused by field; control: 1,050.00 is not', () => {
    const r = refusalOf(derive({ ...D1, paidTotal: 1050.005 }));
    expect(r.sentence).toMatch(/centavo/i);
    expect(okOf(derive(D1)).figures.totalSales).toBe('1100.00');
  });

  it('a negative discount figure is refused; control: zero is accepted', () => {
    refusalOf(derive({ ...D1, discounts: -1 }));
    const zero = okOf(derive({ ...D1, discounts: 0, methods: { Cash: 650, GCash: 350 }, paidTotal: 1000, packageOnly: 600 }));
    expect(zero.figures.otherDiscount).toBe('0.00');
  });
});
