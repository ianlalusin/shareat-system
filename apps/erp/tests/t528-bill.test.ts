import { describe, expect, it } from 'vitest';
import { HEADS_CHANGED_NOTICE, projectBill, receiptLinesOf, statutoryDiners, toPriceLines } from '@/app/pos/_payment/bill';
import { amountCents, appendAmountKey, priceBill, rateLabel } from '@/app/pos/_payment/logic';
import type { PosEvent } from '@/lib/pos-device';

/**
 * T-528 (BUILDER) - the bill projection the Payment screen prices: server lines with their discounts, plus the outbox's discount events, run through the
 * SAME priceBill the server uses. Fixture: the payment.png bill (total 2,092.42).
 */
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PRESET = { id: id(60), name: 'Birthday promo 10%', valueType: 'percent', value: '10' };
const RULES = { vatPercentBasisPoints: 1200, scPwdPercentBasisPoints: 2000 };

const sl = (n: number, o: Record<string, unknown>) => ({ id: id(n), kind: 'item', name: 'X', qty: 1, unitPrice: '100.00', kitchenStatus: 'queued', bundleHeads: null, discounts: [], ...o });
const BODY = {
  session: { id: id(1), mode: 'dine_in', standId: null, status: 'open', headsCashier: 4, headsServer: 4 },
  lines: [
    sl(11, { kind: 'package', name: 'Unli Samgyup + Cheese', qty: 4, unitPrice: '449.00', discounts: [{ id: id(21), kind: 'senior', valueType: 'percent', value: '20.00', qty: 1, dinerNo: 1, presetId: null }] }),
    sl(12, { name: 'Iced tea pitcher', unitPrice: '120.00' }),
    sl(13, { name: 'Cheese corn', qty: 2, unitPrice: '99.00', discounts: [{ id: id(22), kind: 'senior', valueType: 'percent', value: '20.00', qty: 1, dinerNo: 1, presetId: null }] }),
    sl(14, { name: 'Kimchi fried rice', unitPrice: '150.00', discounts: [{ id: id(23), kind: 'preset', valueType: 'percent', value: '10', qty: 1, dinerNo: null, presetId: PRESET.id }] }),
  ],
};
const view = (lines = BODY.lines) => ({ headsCashier: 4, headsServer: 4, loaded: true, lines: lines.map((l) => ({ id: l.id, name: l.name, qty: l.qty, unitPrice: l.unitPrice, kitchenStatus: 'queued', note: null, optionNames: [], pending: false, cancelled: false, addedAtDevice: null })) });
const bill = (pending: PosEvent[] = []) => projectBill({ sessionId: id(1), view: view(), body: BODY as never, pending, menu: null, presets: [PRESET] });
const ev = (seq: number, kind: PosEvent['kind'], payload: Record<string, unknown>): PosEvent => ({ seq, kind, personId: id(40), occurredAtDevice: '2026-11-07T10:00:00.000Z', payload });
const total = (b: ReturnType<typeof bill>) => priceBill({ lines: toPriceLines(b.lines), rules: RULES, vatRegistered: true }).total;

describe('projectBill (T-528)', () => {
  it('the payment.png bill from the server body: 2,092.42, one senior diner, receipt discounts print VAT-off + percent as one amount', () => {
    const b = bill();
    expect(b.problem).toBeNull();
    expect(total(b)).toBe('2092.42');
    expect(statutoryDiners(b.lines)).toEqual([{ dinerNo: 1, kind: 'senior' }]);
    const priced = priceBill({ lines: toPriceLines(b.lines), rules: RULES, vatRegistered: true });
    const receipt = receiptLinesOf(b.lines, priced);
    expect(receipt[0]).toMatchObject({ name: 'Unli Samgyup + Cheese', qty: 4, gross: '1796.00', net: '1667.71', discounts: [{ label: 'Senior', qty: 1, amount: '128.29' }] });
    expect(receipt[3]!.discounts).toEqual([{ label: 'Birthday promo 10%', qty: 1, amount: '15.00' }]);
  });

  it('a pending discount.removed drops that discount from the bill; a pending discount.added joins it, and a discount the server already holds is not doubled', () => {
    expect(total(bill([ev(1, 'discount.removed', { discountId: id(23), removedAtDevice: 'x' })]))).toBe('2107.42');
    const added = ev(2, 'discount.added', { discountId: id(24), lineId: id(12), kind: 'preset', presetId: PRESET.id, qty: 1, appliedAtDevice: 'x' });
    expect(total(bill([added]))).toBe('2080.42'); // 2,092.42 - 12.00 (10% of the 120.00 pitcher)
    const again = ev(3, 'discount.added', { discountId: id(23), lineId: id(14), kind: 'preset', presetId: PRESET.id, qty: 1, appliedAtDevice: 'x' });
    expect(total(bill([again]))).toBe('2092.42');
  });

  it('apply to all puts the preset on every free unit, and skips a line with none free', () => {
    const all = ev(4, 'discount.applied_to_all', { sessionId: id(1), presetId: PRESET.id, applyId: id(70), appliedAtDevice: 'x' });
    const b = bill([all]);
    const byName = (n: string) => b.lines.find((l) => l.name === n)!;
    expect(byName('Iced tea pitcher').discounts.map((d) => d.qty)).toEqual([1]);
    expect(byName('Kimchi fried rice').discounts).toHaveLength(1); // its only unit already has the preset
    expect(byName('Cheese corn').discounts.map((d) => d.qty)).toEqual([1, 1]); // the senior unit stays, the other unit gets the preset
    expect(byName('Unli Samgyup + Cheese').discounts.map((d) => d.qty)).toEqual([1, 3]);
  });

  it('a line with no price stops the bill with a sentence; an unknown preset in the outbox does too', () => {
    const noPrice = projectBill({ sessionId: id(1), view: { ...view(), lines: view().lines.map((l, i) => (i === 1 ? { ...l, unitPrice: null as never } : l)) }, body: BODY as never, pending: [], menu: null, presets: [PRESET] });
    expect(noPrice.problem).toMatch(/price of Iced tea pitcher is not on this tablet/);
    const unknown = projectBill({ sessionId: id(1), view: view(), body: BODY as never, pending: [ev(5, 'discount.added', { discountId: id(25), lineId: id(12), kind: 'preset', presetId: id(99), qty: 1, appliedAtDevice: 'x' })], menu: null, presets: [PRESET] });
    expect(unknown.problem).toMatch(/not on this tablet/);
  });
});

describe('amount typing (T-528)', () => {
  it('appendAmountKey keeps digits and one decimal point, at most two decimals', () => {
    const type = (keys: string) => [...keys].reduce(appendAmountKey, '');
    expect(type('1600')).toBe('1600');
    expect(type('.5')).toBe('0.5');
    expect(type('12.345')).toBe('12.34');
    expect(type('1.2.3')).toBe('1.23');
    expect(type('007')).toBe('7');
    expect(appendAmountKey('5', 'x')).toBe('5');
  });

  it('amountCents reads half-typed amounts and treats junk as zero', () => {
    expect(amountCents('500.')).toBe(50000n);
    expect(amountCents('.5')).toBe(50n);
    expect(amountCents('')).toBe(0n);
    expect(amountCents('abc')).toBe(0n);
    expect(amountCents('1600.00')).toBe(160000n);
  });

  it('rateLabel turns basis points into the receipt label with integer arithmetic', () => {
    expect(rateLabel(1200)).toBe('12%');
    expect(rateLabel(750)).toBe('7.5%');
    expect(rateLabel(2000)).toBe('20%');
  });
});

describe('a head-count change still in the outbox (T-528 audit): the bill mirrors the server\'s followHeads', () => {
  const heads = (n: number) => ev(9, 'heads.set', { sessionId: id(1), headsCashier: n });
  const viewWith = (lines: ReturnType<typeof view>['lines'], cashier: number) => ({ ...view(), headsCashier: cashier, lines });

  it('an unserved per-head package: re-made at the new heads, its discounts dropped with a notice, and no discount can be put on it until the change has sent', () => {
    const lines = view().lines.map((l) => (l.id === id(11) ? { ...l, qty: 5 } : l));
    const b = projectBill({ sessionId: id(1), view: viewWith(lines, 5), body: BODY as never, pending: [heads(5)], menu: null, presets: [PRESET] });
    const pkg = b.lines.find((l) => l.lineId === id(11))!;
    expect([pkg.qty, pkg.discounts, pkg.discountsBlocked]).toEqual([5, [], true]);
    expect(b.notices).toEqual([HEADS_CHANGED_NOTICE]);
    expect(b.lines.find((l) => l.lineId === id(13))!.discounts).toHaveLength(1); // other lines keep theirs
    const blockedAdd = ev(10, 'discount.added', { discountId: id(30), lineId: id(11), kind: 'preset', presetId: PRESET.id, qty: 1, appliedAtDevice: 'x' });
    const again = projectBill({ sessionId: id(1), view: viewWith(lines, 5), body: BODY as never, pending: [heads(5), blockedAdd], menu: null, presets: [PRESET] });
    expect(again.lines.find((l) => l.lineId === id(11))!.discounts).toEqual([]);
  });

  it('a heads.set that leaves the BILLED heads the same (server counted 5, cashier 4 to 3) changes nothing', () => {
    const body = { ...BODY, session: { ...BODY.session, headsCashier: 4, headsServer: 5 } };
    const b = projectBill({ sessionId: id(1), view: { ...view(), headsCashier: 3, headsServer: 5 }, body: body as never, pending: [heads(3)], menu: null, presets: [PRESET] });
    expect(b.notices).toEqual([]);
    expect(b.lines.find((l) => l.lineId === id(11))!.discounts).toHaveLength(1);
  });

  it('a bundle (1,200.00 for 6) with an extra-heads line: the extra line is rebuilt from the new heads at the same extra price (9 heads -> 3 extra), the bundle line keeps its discounts', () => {
    const bundleBody = {
      session: { ...BODY.session, headsCashier: 8, headsServer: null },
      lines: [
        sl(41, { kind: 'package', name: 'Family Pack (up to 6)', qty: 1, unitPrice: '1200.00', bundleHeads: 6, discounts: [{ id: id(51), kind: 'senior', valueType: 'percent', value: '20.00', qty: 1, dinerNo: 1, presetId: null }] }),
        sl(42, { kind: 'package', name: 'Family Pack - extra head', qty: 2, unitPrice: '199.00' }),
      ],
    };
    const v = { ...view(bundleBody.lines), headsCashier: 9, headsServer: null };
    const b = projectBill({ sessionId: id(1), view: v, body: bundleBody as never, pending: [heads(9)], menu: null, presets: [PRESET] });
    expect(b.lines.map((l) => [l.qty, l.unitPrice, l.bundleHeads, l.lineId.startsWith('pending-extra-heads-')])).toEqual([[1, '1200.00', 6, false], [3, '199.00', null, true]]);
    expect(b.lines[0]!.discounts).toHaveLength(1);
    expect(b.notices).toEqual([]);
    expect(total(b)).toBe(priceBill({ lines: toPriceLines(b.lines), rules: RULES, vatRegistered: true }).total);
  });
});
