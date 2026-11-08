/**
 * T-528 (TESTER) - R2/R3/R5: the pure payment logic of the POS v2 Payment screen. docs/tasks/528-pos-payment-screen.md.
 *
 * ASSUMED API (the builder matches these or says why not). Everything lives in apps/erp/src/app/pos/_payment/logic.ts, no React, no clock, no network.
 *   type Tender = { id: string; name: string; kind: string }                      the snapshot's `tenders` entry ('cash' | 'wallet' | ...)
 *   type PayRow = { tenderId: string; amount: string; referenceNo?: string }       amount is a 2-dp decimal string
 *   MAX_TENDERS = 20
 *   receiptNoOf(terminalNo: number, terminalSeq: number): string                   'T<terminalNo>-<terminalSeq padded to 6>'
 *   paymentSummary({ total, rows, tenders }): { paid: string; balance: string; change: string }   balance = max(total - paid, 0), change = max(paid - total, 0)
 *   canAddPayment(rows): boolean                                                   false at 20 rows
 *   addPaymentRow(rows, tender, balance): PayRow[]                                 appends { tenderId, amount: balance } (+ referenceNo '' on a wallet); returns the SAME rows at the cap
 *   payBlocker({ total, rows, tenders, diners: { dinerNo, kind }[], holders: Record<number, { holderName: string; idNumber: string }> }): string | null
 *       null = Pay may be enabled. Otherwise the one sentence under the Pay button.
 *   freeUnits(line): number                                                        units still free of discount: qty (heads on a bundle line) minus covered
 *   checkDiscount(bill: BillLine[], heads: number, add: DiscountAdd): string | null    null = the sheet may add it; else the SERVER's own sentence (T-524 R6)
 *       BillLine = { lineId, name, kind: 'package' | 'item', qty, bundleHeads: number | null, unitPrice: string, discounts: { kind, qty, dinerNo: number | null }[] }
 *       DiscountAdd = { lineId, kind: 'senior' | 'pwd' | 'preset' | 'custom', qty, dinerNo?, valueType?, value? }
 *   priceBill({ lines: PriceLineInput[], rules: { vatPercentBasisPoints: number; scPwdPercentBasisPoints: number }, vatRegistered }): PricedSession
 *       the snapshot carries the rates as NUMBERS; priceSession takes bigint. This is the one place that converts.
 *   buildSalePayload({ sessionId, receiptId, terminalNo, terminalSeq, now: Date, online: boolean, priced, rows, tenders, seniors }): sale.completed payload (no storeId, no pairingId)
 *   saleCompletedEvent({ personId, ...same }): NewPosEvent   { kind: 'sale.completed', personId, occurredAtDevice: now ISO, payload }
 *   discountAddedEvent / discountRemovedEvent / applyToAllEvent: NewPosEvent builders (payloads exactly as R2 lists, keys with no value ABSENT)
 *   paySale(deps, input): Promise<{ ok: true; receiptNo; print: 'printed' | 'fallback' | 'failed'; lines: string[]; notice: string | null } | { ok: false; message: string }>
 *       deps = { reserveTerminalSeq(): Promise<number>; newId(): string; enqueue(e): Promise<PosEvent>; requestDrain(): void; print(lines, { copies }): Promise<'printed' | 'fallback' | 'failed'> }
 *       input = { personId, sessionId, online, terminalNo, now, priced, rows, tenders, seniors, vatRateLabel, layout, receipt: { header, tableLabel, heads, cashierName, issuedAtLocal, footerLines, lines: ReceiptLine[] } }
 *
 * RED NOW FOR THE RIGHT REASON: _payment/logic.ts does not exist (lazy import: "MISSING MODULE ... not built").
 */
import { describe, expect, it, vi } from 'vitest';
import { priceSession } from '../../../packages/domain/src/pos/price';

// biome-ignore lint/suspicious/noExplicitAny: the module under test does not exist yet; its types are the builder's
async function logic(): Promise<any> {
  try {
    const mod = await import(/* @vite-ignore */ '../src/app/pos/_payment/logic');
    // payBlocker is the message of payBlockerDetail; only the tests want it alone, so it lives here, not as a caller-less export (production-caller-ratchet)
    return { ...mod, payBlocker: (i: Parameters<typeof mod.payBlockerDetail>[0]) => mod.payBlockerDetail(i)?.message ?? null };
  } catch (e) {
    throw new Error(`MISSING MODULE: apps/erp/src/app/pos/_payment/logic.ts cannot be loaded (T-528 not built): ${String((e as Error).message).slice(0, 160)}`);
  }
}

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T_CASH = id(901);
const T_GCASH = id(902);
const T_MAYA = id(903);
const TENDERS = [
  { id: T_CASH, name: 'Cash', kind: 'cash' },
  { id: T_GCASH, name: 'GCash', kind: 'wallet' },
  { id: T_MAYA, name: 'Maya', kind: 'wallet' },
];
const REF = '4012 889 213';
const TOTAL = '2092.42';

describe('balance and change', () => {
  it('GCash 500 + Cash 1,600 on 2,092.42: paid 2,100.00, balance 0.00, change 7.58', async () => {
    const { paymentSummary } = await logic();
    const rows = [{ tenderId: T_GCASH, amount: '500.00', referenceNo: REF }, { tenderId: T_CASH, amount: '1600.00' }];
    expect(paymentSummary({ total: TOTAL, rows, tenders: TENDERS })).toEqual({ paid: '2100.00', balance: '0.00', change: '7.58' });
  });

  it('one part paid: the balance is what is left and there is no change', async () => {
    const { paymentSummary } = await logic();
    expect(paymentSummary({ total: TOTAL, rows: [{ tenderId: T_GCASH, amount: '500.00', referenceNo: REF }], tenders: TENDERS })).toEqual({ paid: '500.00', balance: '1592.42', change: '0.00' });
  });

  it('nothing taken yet: balance is the whole total; exact cash: no balance, no change', async () => {
    const { paymentSummary } = await logic();
    expect(paymentSummary({ total: TOTAL, rows: [], tenders: TENDERS })).toEqual({ paid: '0.00', balance: TOTAL, change: '0.00' });
    expect(paymentSummary({ total: TOTAL, rows: [{ tenderId: T_CASH, amount: '2092.42' }], tenders: TENDERS })).toEqual({ paid: '2092.42', balance: '0.00', change: '0.00' });
  });
});

describe('change only from cash (row 438)', () => {
  const ok = { total: TOTAL, tenders: TENDERS, diners: [], holders: {} };

  it('control: GCash 500 with a reference + Cash 1,600 (change 7.58 <= cash 1,600) may be paid', async () => {
    const { payBlocker } = await logic();
    expect(payBlocker({ ...ok, rows: [{ tenderId: T_GCASH, amount: '500.00', referenceNo: REF }, { tenderId: T_CASH, amount: '1600.00' }] })).toBeNull();
  });

  it('a wallet that pays MORE than the bill, with no cash at all: blocked with "Only cash can give change."', async () => {
    const { payBlocker } = await logic();
    expect(payBlocker({ ...ok, rows: [{ tenderId: T_GCASH, amount: '2100.00', referenceNo: REF }] })).toBe('Only cash can give change.');
  });

  it('wallet overpay larger than the cash rows: GCash 2,200 + Cash 50 -> change 157.58 > cash 50 -> blocked', async () => {
    const { payBlocker } = await logic();
    expect(payBlocker({ ...ok, rows: [{ tenderId: T_GCASH, amount: '2200.00', referenceNo: REF }, { tenderId: T_CASH, amount: '50.00' }] })).toBe('Only cash can give change.');
  });

  it('change equal to the cash row is allowed (the server refuses only change MORE than the cash)', async () => {
    const { payBlocker } = await logic();
    expect(payBlocker({ total: '100.00', tenders: TENDERS, diners: [], holders: {}, rows: [{ tenderId: T_GCASH, amount: '100.00', referenceNo: REF }, { tenderId: T_CASH, amount: '5.00' }] })).toBeNull();
  });

  it('two cash rows do not add up to give change: the server compares the change with the LARGEST single cash row (completeSale), so the screen must too', async () => {
    const { payBlocker } = await logic();
    // change = 300 - 100 = 200; each cash row is 100. Summed cash (200) would pass the screen and then the server would refuse AFTER the receipt printed.
    expect(
      payBlocker({ total: '100.00', tenders: TENDERS, diners: [], holders: {}, rows: [{ tenderId: T_GCASH, amount: '100.00', referenceNo: REF }, { tenderId: T_CASH, amount: '100.00' }, { tenderId: T_CASH, amount: '100.00' }] }),
    ).toBe('Only cash can give change.');
  });
});

describe('the tender list', () => {
  it('addPaymentRow pre-fills the remaining balance; a wallet row starts with an empty reference', async () => {
    const { addPaymentRow } = await logic();
    const first = addPaymentRow([], TENDERS[1], TOTAL);
    expect(first).toEqual([{ tenderId: T_GCASH, amount: TOTAL, referenceNo: '' }]);
    const second = addPaymentRow([{ tenderId: T_GCASH, amount: '500.00', referenceNo: REF }], TENDERS[0], '1592.42');
    expect(second[1]).toEqual({ tenderId: T_CASH, amount: '1592.42' });
  });

  it('at most 20 rows: canAddPayment is true at 19 and false at 20, addPaymentRow never makes a 21st, and 21 rows block Pay', async () => {
    const { MAX_TENDERS, canAddPayment, addPaymentRow, payBlocker } = await logic();
    expect(MAX_TENDERS).toBe(20);
    const cash = (n: number) => Array.from({ length: n }, () => ({ tenderId: T_CASH, amount: '10.00' }));
    expect(canAddPayment(cash(19))).toBe(true);
    expect(canAddPayment(cash(20))).toBe(false);
    expect(addPaymentRow(cash(20), TENDERS[0], '10.00')).toHaveLength(20);
    expect(payBlocker({ total: '10.00', tenders: TENDERS, diners: [], holders: {}, rows: cash(21) })).not.toBeNull();
    expect(payBlocker({ total: '200.00', tenders: TENDERS, diners: [], holders: {}, rows: cash(20) })).toBeNull(); // 20 x 10.00 = exactly the bill (a 10.00 bill would make 190.00 change > the largest cash row, which the server refuses)
  });

  it('a wallet tender with no reference is blocked with the server\'s own sentence; blank and too-short references too; a cash row needs none', async () => {
    const { payBlocker } = await logic();
    const base = { total: '500.00', tenders: TENDERS, diners: [], holders: {} };
    const SENTENCE = 'The reference number must be 4 to 40 characters.';
    expect(payBlocker({ ...base, rows: [{ tenderId: T_GCASH, amount: '500.00' }] })).toBe(SENTENCE);
    expect(payBlocker({ ...base, rows: [{ tenderId: T_GCASH, amount: '500.00', referenceNo: '   ' }] })).toBe(SENTENCE);
    expect(payBlocker({ ...base, rows: [{ tenderId: T_GCASH, amount: '500.00', referenceNo: '123' }] })).toBe(SENTENCE);
    expect(payBlocker({ ...base, rows: [{ tenderId: T_GCASH, amount: '500.00', referenceNo: '1234' }] })).toBeNull();
    expect(payBlocker({ ...base, rows: [{ tenderId: T_CASH, amount: '500.00' }] })).toBeNull();
  });

  it('underpaid, no rows, and a zero row all block Pay', async () => {
    const { payBlocker } = await logic();
    const base = { total: '500.00', tenders: TENDERS, diners: [], holders: {} };
    expect(payBlocker({ ...base, rows: [] })).not.toBeNull();
    expect(payBlocker({ ...base, rows: [{ tenderId: T_CASH, amount: '499.99' }] })).not.toBeNull();
    expect(payBlocker({ ...base, rows: [{ tenderId: T_CASH, amount: '500.00' }, { tenderId: T_CASH, amount: '0.00' }] })).not.toBeNull();
    expect(payBlocker({ ...base, rows: [{ tenderId: T_CASH, amount: '500.00' }] })).toBeNull();
  });
});

describe('senior / PWD name and ID per diner (row 371)', () => {
  const base = { total: '500.00', tenders: TENDERS, rows: [{ tenderId: T_CASH, amount: '500.00' }] };
  const named = { holderName: 'Lolita R.', idNumber: 'OSCA 04-1187' };

  it('every diner with a senior/PWD discount needs both fields: the sentence names the first diner missing', async () => {
    const { payBlocker } = await logic();
    const diners = [{ dinerNo: 1, kind: 'senior' }, { dinerNo: 2, kind: 'senior' }];
    expect(payBlocker({ ...base, diners, holders: { 1: named } })).toBe('Add the name and ID for Senior #2.');
    expect(payBlocker({ ...base, diners, holders: {} })).toBe('Add the name and ID for Senior #1.');
    expect(payBlocker({ ...base, diners, holders: { 1: named, 2: named } })).toBeNull();
  });

  it('a name without an ID (or an ID that is only spaces) is still missing; a PWD diner is named PWD', async () => {
    const { payBlocker } = await logic();
    expect(payBlocker({ ...base, diners: [{ dinerNo: 1, kind: 'senior' }], holders: { 1: { holderName: 'Lolita R.', idNumber: '   ' } } })).toBe('Add the name and ID for Senior #1.');
    expect(payBlocker({ ...base, diners: [{ dinerNo: 1, kind: 'senior' }], holders: { 1: { holderName: '', idNumber: 'OSCA 04-1187' } } })).toBe('Add the name and ID for Senior #1.');
    expect(payBlocker({ ...base, diners: [{ dinerNo: 3, kind: 'pwd' }], holders: {} })).toBe('Add the name and ID for PWD #3.');
  });

  it('a holder entered for a diner with no senior/PWD discount is ignored (no diner, no card)', async () => {
    const { payBlocker } = await logic();
    expect(payBlocker({ ...base, diners: [], holders: { 4: named } })).toBeNull();
  });
});

describe('the discount sheet shows the server\'s sentence before sending (R2)', () => {
  const line = (o: Record<string, unknown>) => ({ lineId: 'L', name: 'Cheese corn', kind: 'item', qty: 2, bundleHeads: null, unitPrice: '99.00', discounts: [], ...o });
  const PKG = (discounts: unknown[] = []) => line({ lineId: 'PKG', name: 'Unli Samgyup + Cheese', kind: 'package', qty: 4, unitPrice: '449.00', discounts });
  const CORN = (discounts: unknown[] = []) => line({ lineId: 'CORN', discounts });
  const TEA = line({ lineId: 'TEA', name: 'Iced tea pitcher', qty: 1, unitPrice: '120.00' });
  const FREE = line({ lineId: 'FREE', name: 'Free dessert', qty: 1, unitPrice: '0.00' });
  const sen = (dinerNo: number, qty = 1, kind = 'senior') => ({ kind, qty, dinerNo });
  const pre = (qty: number) => ({ kind: 'preset', qty, dinerNo: null });

  it('controls: a senior head on the package, a preset on a corn unit, a custom 100% and a custom full-price peso amount are all allowed', async () => {
    const { checkDiscount } = await logic();
    const bill = [PKG(), CORN(), TEA];
    expect(checkDiscount(bill, 4, { lineId: 'PKG', kind: 'senior', qty: 1, dinerNo: 1 })).toBeNull();
    expect(checkDiscount(bill, 4, { lineId: 'CORN', kind: 'preset', qty: 2 })).toBeNull();
    expect(checkDiscount(bill, 4, { lineId: 'TEA', kind: 'custom', qty: 1, valueType: 'percent', value: '100' })).toBeNull();
    expect(checkDiscount(bill, 4, { lineId: 'TEA', kind: 'custom', qty: 1, valueType: 'fixed', value: '120.00' })).toBeNull();
  });

  it('the cap: more units than are free -> "Only N unit(s) of <name> is/are free of discount."; none free -> "No unit of <name> is free of discount."', async () => {
    const { checkDiscount } = await logic();
    expect(checkDiscount([CORN()], 4, { lineId: 'CORN', kind: 'preset', qty: 3 })).toBe('Only 2 units of Cheese corn are free of discount.');
    expect(checkDiscount([CORN([pre(1)])], 4, { lineId: 'CORN', kind: 'preset', qty: 2 })).toBe('Only 1 unit of Cheese corn is free of discount.');
    expect(checkDiscount([CORN([pre(2)])], 4, { lineId: 'CORN', kind: 'preset', qty: 1 })).toBe('No unit of Cheese corn is free of discount.');
  });

  it('a senior unit carries no other discount, and the reverse', async () => {
    const { checkDiscount } = await logic();
    expect(checkDiscount([CORN([sen(1, 2)])], 4, { lineId: 'CORN', kind: 'preset', qty: 1 })).toBe('No unit of Cheese corn is free of discount.');
    expect(checkDiscount([CORN([pre(2)])], 4, { lineId: 'CORN', kind: 'senior', qty: 1, dinerNo: 1 })).toBe('No unit of Cheese corn is free of discount.');
    // one unit senior, one preset: both units are used up
    expect(checkDiscount([CORN([sen(1), pre(1)])], 4, { lineId: 'CORN', kind: 'custom', qty: 1, valueType: 'percent', value: '5' })).toBe('No unit of Cheese corn is free of discount.');
  });

  it('one senior head per diner on the package', async () => {
    const { checkDiscount } = await logic();
    expect(checkDiscount([PKG([sen(1)])], 4, { lineId: 'PKG', kind: 'senior', qty: 1, dinerNo: 1 })).toBe('Diner 1 already has their own package head discounted.');
    expect(checkDiscount([PKG()], 4, { lineId: 'PKG', kind: 'senior', qty: 2, dinerNo: 2 })).toBe('Diner 2 already has their own package head discounted.');
    expect(checkDiscount([PKG([sen(1)])], 4, { lineId: 'PKG', kind: 'senior', qty: 1, dinerNo: 2 })).toBeNull(); // another diner's own head is fine
  });

  it('seniors cannot outnumber the billed heads', async () => {
    const { checkDiscount } = await logic();
    const bill = [PKG([sen(1), sen(2)])];
    expect(checkDiscount(bill, 2, { lineId: 'PKG', kind: 'senior', qty: 1, dinerNo: 3 })).toBe('There are more senior or PWD discounts than guests at this table.');
    expect(checkDiscount(bill, 3, { lineId: 'PKG', kind: 'senior', qty: 1, dinerNo: 3 })).toBeNull();
  });

  it('one card per diner: the same diner cannot be a senior on one line and a PWD on another', async () => {
    const { checkDiscount } = await logic();
    expect(checkDiscount([PKG([sen(1)]), CORN()], 4, { lineId: 'CORN', kind: 'pwd', qty: 1, dinerNo: 1 })).toBe('Diner 1 already has a senior discount: one card per diner.');
    expect(checkDiscount([PKG([sen(2, 1, 'pwd')]), CORN()], 4, { lineId: 'CORN', kind: 'senior', qty: 1, dinerNo: 2 })).toBe('Diner 2 already has a PWD discount: one card per diner.');
    expect(checkDiscount([PKG([sen(1)]), CORN()], 4, { lineId: 'CORN', kind: 'senior', qty: 1, dinerNo: 1 })).toBeNull(); // the same diner's dish on the same card kind is allowed
  });

  it('a free item takes no discount; a custom value outside its limits is refused', async () => {
    const { checkDiscount } = await logic();
    expect(checkDiscount([FREE], 4, { lineId: 'FREE', kind: 'preset', qty: 1 })).toBe('A free item takes no discount.');
    expect(checkDiscount([TEA], 4, { lineId: 'TEA', kind: 'custom', qty: 1, valueType: 'percent', value: '0' })).toBe('A percent discount is more than 0 and at most 100.');
    expect(checkDiscount([TEA], 4, { lineId: 'TEA', kind: 'custom', qty: 1, valueType: 'percent', value: '100.01' })).toBe('A percent discount is more than 0 and at most 100.');
    expect(checkDiscount([TEA], 4, { lineId: 'TEA', kind: 'custom', qty: 1, valueType: 'fixed', value: '120.01' })).toBe('A peso discount is more than 0 and at most the item price.');
    expect(checkDiscount([TEA], 4, { lineId: 'TEA', kind: 'custom', qty: 1, valueType: 'fixed', value: '0' })).toBe('A peso discount is more than 0 and at most the item price.');
  });

  it('freeUnits (the qty stepper\'s maximum): qty minus covered; a bundle line has its heads', async () => {
    const { freeUnits } = await logic();
    expect(freeUnits(PKG([sen(1)]))).toBe(3);
    expect(freeUnits(CORN([pre(2)]))).toBe(0);
    expect(freeUnits(line({ qty: 1, bundleHeads: 6, kind: 'package', discounts: [sen(1)] }))).toBe(5);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The bill and the exact sale.completed payload for the payment.png bill
// ---------------------------------------------------------------------------------------------------------------------------------------------
const L = { pkg: id(11), tea: id(12), corn: id(13), rice: id(14) };
const BILL_LINES = [
  { lineId: L.pkg, qty: 4, unitPrice: '449.00', bundleHeads: null, discounts: [{ discountId: id(21), kind: 'senior', valueType: 'percent', value: '20.00', qty: 1 }] },
  { lineId: L.tea, qty: 1, unitPrice: '120.00', bundleHeads: null, discounts: [] },
  { lineId: L.corn, qty: 2, unitPrice: '99.00', bundleHeads: null, discounts: [{ discountId: id(22), kind: 'senior', valueType: 'percent', value: '20.00', qty: 1 }] },
  { lineId: L.rice, qty: 1, unitPrice: '150.00', bundleHeads: null, discounts: [{ discountId: id(23), kind: 'preset', valueType: 'percent', value: '10', qty: 1 }] },
];
const RULES = { vatPercentBasisPoints: 1200, scPwdPercentBasisPoints: 2000 };
const SENIORS = [{ dinerNo: 1, kind: 'senior', idNumber: 'OSCA 04-1187', holderName: 'Lolita R.' }];
const ROWS = [{ tenderId: T_GCASH, amount: '500.00', referenceNo: REF }, { tenderId: T_CASH, amount: '1600.00' }];
const NOW = new Date('2026-11-06T11:52:00.000Z');
const SESSION = id(31);
const RECEIPT = id(32);

describe('priceBill - the device prices with the SAME function the server uses', () => {
  it('turns the snapshot\'s numeric rates into the bigint priceSession wants and returns its exact result, vat block included', async () => {
    const { priceBill } = await logic();
    const device = priceBill({ lines: BILL_LINES, rules: RULES, vatRegistered: true });
    const server = priceSession({ vatRegistered: true, vatPercentBasisPoints: 1200n, scPwdPercentBasisPoints: 2000n, lines: BILL_LINES } as Parameters<typeof priceSession>[0]);
    expect(device).toEqual(server);
    expect(device).toMatchObject({ subtotal: '2264.00', discountTotal: '171.58', total: TOTAL });
  });
});

describe('sale.completed payload (R3)', () => {
  const input = async (over: Record<string, unknown> = {}) => {
    const { priceBill } = await logic();
    return { sessionId: SESSION, receiptId: RECEIPT, terminalNo: 1, terminalSeq: 4231, now: NOW, online: true, priced: priceBill({ lines: BILL_LINES, rules: RULES, vatRegistered: true }), rows: ROWS, tenders: TENDERS, seniors: SENIORS, ...over };
  };
  const EXPECTED = {
    sessionId: SESSION,
    receiptId: RECEIPT,
    terminalNo: 1,
    terminalSeq: 4231,
    issuedAtDevice: NOW.toISOString(),
    offline: false,
    device: {
      subtotal: '2264.00',
      discountTotal: '171.58',
      total: TOTAL,
      lines: [
        { lineId: L.pkg, gross: '1796.00', discountTotal: '128.29', net: '1667.71' },
        { lineId: L.tea, gross: '120.00', discountTotal: '0.00', net: '120.00' },
        { lineId: L.corn, gross: '198.00', discountTotal: '28.29', net: '169.71' },
        { lineId: L.rice, gross: '150.00', discountTotal: '15.00', net: '135.00' },
      ],
    },
    payments: [
      { tenderId: T_GCASH, amount: '500.00', referenceNo: REF, toCheck: false },
      { tenderId: T_CASH, amount: '1600.00', toCheck: false },
    ],
    seniors: SENIORS,
  };

  it('the payment.png bill online: GCash 500 with a reference + Cash 1,600 on 2,092.42, exactly (a cash row has no referenceNo key at all)', async () => {
    const { buildSalePayload } = await logic();
    expect(buildSalePayload(await input())).toStrictEqual(EXPECTED);
  });

  it('the device lines carry gross, discountTotal AND net: the inbox requires all three per line, and completeSale compares all three (the spec text says only {lineId, net})', async () => {
    const { buildSalePayload } = await logic();
    const p = buildSalePayload(await input()) as { device: { lines: Record<string, string>[] } };
    for (const l of p.device.lines) expect(Object.keys(l).sort()).toEqual(['discountTotal', 'gross', 'lineId', 'net']);
  });

  it('the payload never carries storeId or pairingId (the server takes both from the pairing)', async () => {
    const { buildSalePayload, saleCompletedEvent } = await logic();
    expect(JSON.stringify(buildSalePayload(await input()))).not.toMatch(/storeId|pairingId/);
    expect(JSON.stringify(saleCompletedEvent({ personId: id(40), ...(await input()) }))).not.toMatch(/storeId|pairingId/);
  });

  it('offline: offline is true, the wallet row is toCheck, the cash row is not', async () => {
    const { buildSalePayload } = await logic();
    const p = buildSalePayload(await input({ online: false })) as { offline: boolean; payments: { toCheck: boolean }[] };
    expect(p.offline).toBe(true);
    expect(p.payments.map((x) => x.toCheck)).toEqual([true, false]);
  });

  it('the reference is sent trimmed; a row the cashier left at a blank wallet reference is not sent as an empty string key', async () => {
    const { buildSalePayload } = await logic();
    const p = buildSalePayload(await input({ rows: [{ tenderId: T_GCASH, amount: '500.00', referenceNo: `  ${REF} ` }, ROWS[1]] })) as { payments: { referenceNo?: string }[] };
    expect(p.payments[0]!.referenceNo).toBe(REF);
  });

  it('saleCompletedEvent wraps it: kind sale.completed, the acting person, the device time', async () => {
    const { saleCompletedEvent } = await logic();
    expect(saleCompletedEvent({ personId: id(40), ...(await input()) })).toStrictEqual({ kind: 'sale.completed', personId: id(40), occurredAtDevice: NOW.toISOString(), payload: EXPECTED });
  });

  it('receiptNoOf: T<terminalNo>-<terminalSeq padded to 6>', async () => {
    const { receiptNoOf } = await logic();
    expect(receiptNoOf(1, 42)).toBe('T1-000042');
    expect(receiptNoOf(3, 123456)).toBe('T3-123456');
    expect(receiptNoOf(12, 4231)).toBe('T12-004231');
  });
});

describe('the discount events (R2): exactly the keys the inbox accepts, none set to undefined', () => {
  const AT = NOW.toISOString();
  it('discount.added for senior, preset and custom', async () => {
    const { discountAddedEvent } = await logic();
    expect(discountAddedEvent({ personId: id(40), now: NOW, discountId: id(50), lineId: L.pkg, kind: 'senior', qty: 1, dinerNo: 1 })).toStrictEqual({
      kind: 'discount.added', personId: id(40), occurredAtDevice: AT, payload: { discountId: id(50), lineId: L.pkg, kind: 'senior', qty: 1, dinerNo: 1, appliedAtDevice: AT },
    });
    expect(discountAddedEvent({ personId: id(40), now: NOW, discountId: id(51), lineId: L.rice, kind: 'preset', presetId: id(60), qty: 1 }).payload).toStrictEqual({
      discountId: id(51), lineId: L.rice, kind: 'preset', presetId: id(60), qty: 1, appliedAtDevice: AT,
    });
    expect(discountAddedEvent({ personId: id(40), now: NOW, discountId: id(52), lineId: L.tea, kind: 'custom', valueType: 'fixed', value: '20.00', qty: 1 }).payload).toStrictEqual({
      discountId: id(52), lineId: L.tea, kind: 'custom', valueType: 'fixed', value: '20.00', qty: 1, appliedAtDevice: AT,
    });
  });

  it('discount.removed and discount.applied_to_all', async () => {
    const { discountRemovedEvent, applyToAllEvent } = await logic();
    expect(discountRemovedEvent({ personId: id(40), now: NOW, discountId: id(50) })).toStrictEqual({ kind: 'discount.removed', personId: id(40), occurredAtDevice: AT, payload: { discountId: id(50), removedAtDevice: AT } });
    expect(applyToAllEvent({ personId: id(40), now: NOW, sessionId: SESSION, presetId: id(60), applyId: id(70) })).toStrictEqual({
      kind: 'discount.applied_to_all', personId: id(40), occurredAtDevice: AT, payload: { sessionId: SESSION, presetId: id(60), applyId: id(70), appliedAtDevice: AT },
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// paySale: reserve, enqueue, print, drain
// ---------------------------------------------------------------------------------------------------------------------------------------------
const RECEIPT_LINES = [
  { name: 'Unli Samgyup + Cheese', qty: 4, unitPrice: '449.00', gross: '1796.00', discounts: [{ label: 'Senior', qty: 1, amount: '128.29' }], net: '1667.71' },
  { name: 'Iced tea pitcher', qty: 1, unitPrice: '120.00', gross: '120.00', discounts: [], net: '120.00' },
  { name: 'Cheese corn', qty: 2, unitPrice: '99.00', gross: '198.00', discounts: [{ label: 'Senior', qty: 1, amount: '28.29' }], net: '169.71' },
  { name: 'Kimchi fried rice', qty: 1, unitPrice: '150.00', gross: '150.00', discounts: [{ label: 'Birthday promo 10%', qty: 1, amount: '15.00' }], net: '135.00' },
];

describe('paySale (R3): one tap, local-first', () => {
  const setup = async (over: { enqueue?: () => Promise<unknown>; print?: () => Promise<string>; online?: boolean } = {}) => {
    const { paySale, priceBill } = await logic();
    const order: string[] = [];
    const enqueue = vi.fn(async (e: unknown) => {
      order.push('enqueue');
      if (over.enqueue) return over.enqueue();
      return { seq: 1, ...(e as object) };
    });
    const print = vi.fn(async (_lines: string[], _o: { copies: number }) => {
      order.push('print');
      return (over.print ? await over.print() : 'printed') as 'printed';
    });
    const deps = {
      reserveTerminalSeq: vi.fn(async () => {
        order.push('reserve');
        return 4231;
      }),
      newId: () => RECEIPT,
      enqueue,
      requestDrain: vi.fn(() => void order.push('drain')),
      print,
    };
    const input = {
      personId: id(40), sessionId: SESSION, online: over.online ?? true, terminalNo: 1, now: NOW, priced: priceBill({ lines: BILL_LINES, rules: RULES, vatRegistered: true }),
      rows: ROWS, tenders: TENDERS, seniors: SENIORS, vatRateLabel: '12%', layout: { width: 58, font: 'normal' }, copies: 1,
      receipt: {
        header: { businessName: 'Shareat Lipa', addressLines: ['Lipa City, Batangas'], tin: '123-456-789-000', vatRegistered: true },
        tableLabel: 'Stand 7', heads: 4, cashierName: 'Joy', issuedAtLocal: '06/11/26 19:52', footerLines: ['This is not an official receipt'], lines: RECEIPT_LINES, scPwdDiscount: '97.86',
      },
    };
    return { result: await paySale(deps, input), deps, order };
  };

  it('online: reserves the number, enqueues the exact sale.completed, prints the receipt built from the same price, then asks for a drain', async () => {
    const { result, deps, order } = await setup();
    expect(result).toMatchObject({ ok: true, receiptNo: 'T1-004231', print: 'printed', notice: null });
    expect(order[0]).toBe('reserve');
    expect(order.indexOf('enqueue')).toBeLessThan(order.indexOf('print'));
    expect(order.indexOf('enqueue')).toBeLessThan(order.indexOf('drain'));
    expect(order.indexOf('drain'), 'the send is asked for BEFORE the printer is touched: a slow or hung printer cannot hold the sale back').toBeLessThan(order.indexOf('print'));
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    const sent = deps.enqueue.mock.calls[0]![0] as { kind: string; payload: { receiptId: string; terminalSeq: number; offline: boolean; device: { total: string } } };
    expect(sent.kind).toBe('sale.completed');
    expect(sent.payload).toMatchObject({ receiptId: RECEIPT, terminalSeq: 4231, offline: false, device: { total: TOTAL } });
    const lines = deps.print.mock.calls[0]![0];
    expect(deps.print.mock.calls[0]![1]).toEqual({ copies: expect.any(Number) });
    expect(lines).toContain('RECEIPT:               T1-004231');
    expect(lines).toContain('TOTAL                   2,092.42');
    expect(lines).toContain('VATABLE SALES           1,518.75');
    expect(lines).toContain('VAT (12%)                 182.25');
    expect(lines, 'the SC/PWD discount (the 20% only) is printed so the VAT block adds up to the total').toContain('Less: SC/PWD discount     -97.86');
    expect(lines).toContain('  Ref: 4012 889 213');
    expect(lines.some((l: string) => l.includes('REPRINT') || l.includes('OFFLINE'))).toBe(false);
    expect(result.lines).toEqual(lines);
  });

  it('offline: the receipt carries OFFLINE SALE - TO SYNC and the wallet tender "(to check)"; the event is marked offline', async () => {
    const { deps } = await setup({ online: false });
    const lines = (deps.print.mock.calls[0]![0] as string[]).map((l) => l.trim());
    expect(lines).toContain('OFFLINE SALE - TO SYNC');
    expect(lines.some((l) => l.startsWith('GCash (to check)'))).toBe(true);
    expect((deps.enqueue.mock.calls[0]![0] as { payload: { offline: boolean } }).payload.offline).toBe(true);
  });

  it('an enqueue failure prints NOTHING, asks for no drain, and says so in the spec\'s sentence; the reserved number is spent', async () => {
    const { result, deps } = await setup({ enqueue: () => Promise.reject(new Error('IndexedDB full')) });
    expect(result).toEqual({ ok: false, message: 'This tablet could not save the sale. Nothing was charged. Try again.' });
    expect(deps.print).not.toHaveBeenCalled();
    expect(deps.requestDrain).not.toHaveBeenCalled();
    expect(deps.reserveTerminalSeq).toHaveBeenCalledTimes(1);
  });

  it('a print that fails never undoes the sale: ok, the sale was enqueued once, the drain was requested, and the cashier is told to tap Reprint', async () => {
    const { result, deps } = await setup({ print: async () => 'failed' });
    expect(result).toMatchObject({ ok: true, print: 'failed', notice: 'Receipt did not print. Tap Reprint.' });
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.requestDrain).toHaveBeenCalledTimes(1);
  });

  it('the browser fallback is reported as "fallback" with no notice', async () => {
    const { result } = await setup({ print: async () => 'fallback' });
    expect(result).toMatchObject({ ok: true, print: 'fallback', notice: null });
  });
});

describe('priceBill vs the receipt VAT block feeds (R1 -> T-528b)', () => {
  it('the priced bill carries the vat block the receipt prints (1,518.75 / 182.25)', async () => {
    const { priceBill } = await logic();
    const priced = priceBill({ lines: BILL_LINES, rules: RULES, vatRegistered: true }) as { vat: Record<string, string> };
    expect(priced.vat).toMatchObject({ vatableSales: '1518.75', vatAmount: '182.25', vatRemovedForScPwd: '58.72' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// T-528c: Split prepares ONE row, a tender fills it; the blocker says where to look; the SC/PWD discount feeds the receipt
// ---------------------------------------------------------------------------------------------------------------------------------------------
describe('T-528c: Split and tender tap (one row, never two)', () => {
  it('addSplitRow appends exactly one row with no tender and the balance; it stops at 20 rows', async () => {
    const { addSplitRow, MAX_TENDERS } = await logic();
    expect(addSplitRow([{ tenderId: T_CASH, amount: '500.00' }], '1592.42')).toEqual([{ tenderId: T_CASH, amount: '500.00' }, { tenderId: '', amount: '1592.42' }]);
    const full = Array.from({ length: MAX_TENDERS }, () => ({ tenderId: T_CASH, amount: '1.00' }));
    expect(addSplitRow(full, '5.00')).toHaveLength(MAX_TENDERS);
  });

  it('chooseTender fills the prepared row (keeping its amount) instead of adding another; a wallet gets an empty reference', async () => {
    const { addSplitRow, chooseTender } = await logic();
    const prepared = addSplitRow([{ tenderId: T_CASH, amount: '500.00' }], '1592.42');
    const out = chooseTender(prepared, TENDERS[1], '1592.42');
    expect(out.rows).toEqual([{ tenderId: T_CASH, amount: '500.00' }, { tenderId: T_GCASH, amount: '1592.42', referenceNo: '' }]);
    expect(out.index).toBe(1);
  });

  it('control: with no prepared row chooseTender adds one row with the balance, as addPaymentRow does; at 20 rows it adds none', async () => {
    const { chooseTender, addPaymentRow, MAX_TENDERS } = await logic();
    const one = [{ tenderId: T_CASH, amount: '500.00' }];
    const out = chooseTender(one, TENDERS[0], '1592.42');
    expect(out.rows).toEqual(addPaymentRow(one, TENDERS[0], '1592.42'));
    expect(out.index).toBe(1);
    const full = Array.from({ length: MAX_TENDERS }, () => ({ tenderId: T_CASH, amount: '1.00' }));
    expect(chooseTender(full, TENDERS[0], '5.00').rows).toHaveLength(MAX_TENDERS);
  });

  it('a prepared row with no tender blocks Pay with its own sentence, before the amounts are judged', async () => {
    const { payBlocker, addSplitRow, SENTENCES } = await logic();
    const rows = addSplitRow([{ tenderId: T_CASH, amount: '500.00' }], '1592.42');
    expect(payBlocker({ total: TOTAL, rows, tenders: TENDERS, diners: [], holders: {} })).toBe(SENTENCES.pickTender);
    expect(SENTENCES.pickTender).toMatch(/pick a way to pay/i);
  });
});

describe('T-528c: payBlockerDetail names the field that needs fixing', () => {
  const base = { total: TOTAL, tenders: TENDERS, diners: [{ dinerNo: 1, kind: 'senior' }, { dinerNo: 2, kind: 'pwd' }], holders: {} as Record<number, { holderName: string; idNumber: string }> };

  it('no name -> the name field of the first diner missing; a name but no ID -> the ID field', async () => {
    const { payBlockerDetail } = await logic();
    expect(payBlockerDetail({ ...base, rows: [] })).toEqual({ message: 'Add the name and ID for Senior #1.', target: { kind: 'holder', dinerNo: 1, field: 'holderName' } });
    expect(payBlockerDetail({ ...base, rows: [], holders: { 1: { holderName: 'Lolita R.', idNumber: '' } } })).toMatchObject({ target: { kind: 'holder', dinerNo: 1, field: 'idNumber' } });
    expect(payBlockerDetail({ ...base, rows: [], holders: { 1: { holderName: 'A', idNumber: 'B' } } })).toMatchObject({ message: 'Add the name and ID for PWD #2.', target: { kind: 'holder', dinerNo: 2, field: 'holderName' } });
  });

  it('the payment problems point at the tenders, the row tender, the row amount or its reference', async () => {
    const { payBlockerDetail, SENTENCES } = await logic();
    const none = { ...base, diners: [] };
    expect(payBlockerDetail({ ...none, rows: [] })).toEqual({ message: SENTENCES.noPayment, target: { kind: 'tenders' } });
    expect(payBlockerDetail({ ...none, rows: [{ tenderId: '', amount: '2092.42' }] })).toMatchObject({ target: { kind: 'row', index: 0, field: 'tender' } });
    expect(payBlockerDetail({ ...none, rows: [{ tenderId: T_CASH, amount: '0.00' }] })).toMatchObject({ message: SENTENCES.notPositive, target: { kind: 'row', index: 0, field: 'amount' } });
    expect(payBlockerDetail({ ...none, rows: [{ tenderId: T_CASH, amount: '10.00' }] })).toMatchObject({ message: SENTENCES.underpaid, target: { kind: 'row', index: 0, field: 'amount' } });
    expect(payBlockerDetail({ ...none, rows: [{ tenderId: T_CASH, amount: '100.00' }, { tenderId: T_GCASH, amount: '2000.00', referenceNo: '' }] })).toMatchObject({ target: { kind: 'row', index: 1, field: 'reference' } });
    expect(payBlockerDetail({ ...none, rows: [{ tenderId: T_GCASH, amount: '2200.00', referenceNo: REF }] })).toMatchObject({ message: SENTENCES.onlyCash, target: { kind: 'tenders' } });
  });

  it('control: when nothing blocks Pay it is null, and payBlocker is always the detail sentence', async () => {
    const { payBlockerDetail, payBlocker } = await logic();
    const ok = { total: TOTAL, tenders: TENDERS, diners: [], holders: {}, rows: [{ tenderId: T_CASH, amount: '2092.42' }] };
    expect(payBlockerDetail(ok)).toBeNull();
    expect(payBlocker(ok)).toBeNull();
    const bad = { ...ok, rows: [] };
    expect(payBlocker(bad)).toBe(payBlockerDetail(bad).message);
  });
});

describe('T-528c: scPwdDiscountOf feeds the receipt and the on-screen bill', () => {
  it('the payment.png bill: the 20% statutory amounts only, 80.18 + 17.68 = 97.86 (the VAT removed 58.72 is NOT in it)', async () => {
    const { priceBill, scPwdDiscountOf } = await logic();
    const priced = priceBill({ lines: BILL_LINES, rules: RULES, vatRegistered: true });
    expect(scPwdDiscountOf(BILL_LINES, priced)).toBe('97.86');
  });

  it('the identity VATable + VAT + VAT-exempt - SC/PWD discount = Due holds on the printed figures (payment.png bill)', async () => {
    const { priceBill, scPwdDiscountOf } = await logic();
    const priced = priceBill({ lines: BILL_LINES, rules: RULES, vatRegistered: true });
    const c = (m: string) => BigInt(m.replace('.', ''));
    expect(c(priced.vat.vatableSales) + c(priced.vat.vatAmount) + c(priced.vat.vatExemptSales) - c(scPwdDiscountOf(BILL_LINES, priced))).toBe(c(priced.total));
  });

  it('a preset or custom discount is never counted; a bill with none is 0.00', async () => {
    const { priceBill, scPwdDiscountOf } = await logic();
    const lines = BILL_LINES.map((l) => ({ ...l, discounts: l.discounts.filter((d) => d.kind !== 'senior') }));
    expect(scPwdDiscountOf(lines, priceBill({ lines, rules: RULES, vatRegistered: true }))).toBe('0.00');
  });

  it('the paySale receipt view carries the caller figure in vat.scPwdDiscount', async () => {
    const { paySale, priceBill } = await logic();
    const deps = { reserveTerminalSeq: async () => 1, newId: () => RECEIPT, enqueue: async (e: unknown) => ({ seq: 1, ...(e as object) }), requestDrain: () => undefined, print: async () => 'printed' };
    const r = await paySale(deps, {
      personId: id(40), sessionId: SESSION, online: true, terminalNo: 1, now: NOW, priced: priceBill({ lines: BILL_LINES, rules: RULES, vatRegistered: true }), rows: ROWS, tenders: TENDERS, seniors: SENIORS, vatRateLabel: '12%', layout: { width: 58, font: 'normal' }, copies: 1,
      receipt: { header: { businessName: 'Shareat Lipa', addressLines: [], tin: null, vatRegistered: true }, tableLabel: 'Stand 7', heads: 4, cashierName: 'Joy', issuedAtLocal: '06/11/26 19:52', footerLines: [], lines: RECEIPT_LINES, scPwdDiscount: '97.86' },
    });
    expect(r.view.vat.scPwdDiscount).toBe('97.86');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// T-528c: the auditor's identity sweep, kept in the suite. 60 seeded bills priced by the real priceSession (through priceBill) on a VAT org:
// VATable + VAT + VAT-exempt - SC/PWD discount = total, to the centavo, read off the same figures the receipt prints.
// ---------------------------------------------------------------------------------------------------------------------------------------------
describe('T-528c: VATable + VAT + VAT-exempt - SC/PWD discount = total, over 60 seeded VAT bills', () => {
  it('holds to the centavo on every bill, with no negative figure, and the bills really cover bundles, dishes, senior, PWD, several diners and senior + preset', async () => {
    const { priceBill, scPwdDiscountOf } = await logic();
    let seed = 0x528c;
    const rnd = (n: number): number => {
      // mulberry32: the same 60 bills on every machine
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    const DISH = ['449.00', '120.00', '99.00', '150.50', '37.77', '260.00', '12.34', '88.88'];
    const BUNDLE = ['2000.00', '1799.99', '1349.00', '2999.97'];
    const PRESET = [{ valueType: 'percent', value: '10' }, { valueType: 'percent', value: '12.5' }, { valueType: 'fixed', value: '15.00' }, { valueType: 'percent', value: '100' }];
    const cover = { bundles: 0, dishes: 0, senior: 0, pwd: 0, severalStatutory: 0, seniorAndPreset: 0 };
    let did = 0;
    for (let n = 0; n < 60; n++) {
      const lines = [];
      const count = 1 + rnd(4);
      let statutory = 0;
      let seniorOnBill = false;
      let presetOnBill = false;
      for (let l = 0; l < count; l++) {
        const bundle = l === 0 && rnd(2) === 0;
        const heads = 2 + rnd(5);
        const capacity = bundle ? heads : 1 + rnd(4);
        if (bundle) cover.bundles++;
        else cover.dishes++;
        const discounts = [];
        let left = capacity;
        while (left > 0 && rnd(3) !== 0) {
          const qty = 1 + rnd(left);
          left -= qty;
          const kind = ['senior', 'pwd', 'preset', 'custom'][rnd(4)] as string;
          const p = PRESET[rnd(PRESET.length)]!;
          if (kind === 'senior' || kind === 'pwd') {
            statutory++;
            if (kind === 'senior') seniorOnBill = true;
            if (kind === 'pwd') cover.pwd++;
            discounts.push({ discountId: id(5000 + did++), kind, valueType: 'percent', value: '20.00', qty });
          } else {
            presetOnBill = true;
            discounts.push({ discountId: id(5000 + did++), kind, valueType: p.valueType, value: p.value, qty });
          }
        }
        lines.push({ lineId: id(4000 + l), qty: bundle ? 1 : capacity, unitPrice: bundle ? BUNDLE[rnd(BUNDLE.length)]! : DISH[rnd(DISH.length)]!, bundleHeads: bundle ? heads : null, discounts });
      }
      if (seniorOnBill) cover.senior++;
      if (statutory > 1) cover.severalStatutory++;
      if (seniorOnBill && presetOnBill) cover.seniorAndPreset++;

      const priced = priceBill({ lines, rules: RULES, vatRegistered: true });
      const c = (m: string) => BigInt(m.replace('.', ''));
      const label = `bill ${n} ${JSON.stringify(lines)}`;
      const lhs = c(priced.vat.vatableSales) + c(priced.vat.vatAmount) + c(priced.vat.vatExemptSales) - c(scPwdDiscountOf(lines, priced));
      expect(lhs, label).toBe(c(priced.total));
      for (const f of [priced.vat.vatableSales, priced.vat.vatAmount, priced.vat.vatExemptSales, scPwdDiscountOf(lines, priced)]) expect(c(f) >= 0n, `${label} no negative figure`).toBe(true);
    }
    expect(cover.bundles, 'bundles').toBeGreaterThanOrEqual(10);
    expect(cover.dishes, 'dishes').toBeGreaterThanOrEqual(40);
    expect(cover.senior, 'bills with a senior').toBeGreaterThanOrEqual(15);
    expect(cover.pwd, 'PWD discounts').toBeGreaterThanOrEqual(8);
    expect(cover.severalStatutory, 'bills with several senior/PWD discounts (several diners)').toBeGreaterThanOrEqual(10);
    expect(cover.seniorAndPreset, 'bills with a senior and a preset or custom discount').toBeGreaterThanOrEqual(8);
  });
});
