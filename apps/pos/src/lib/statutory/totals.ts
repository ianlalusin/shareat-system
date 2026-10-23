import { allocate, storedPesosToCentavos, toWirePesos } from '@/lib/money/centavos';
import { Exact, HUNDRED, ONE, ZERO } from '@/lib/money/exact';
import { ordinaryBill } from '@/lib/money/ordinary-bill';
import type { Adjustment, Discount, Store } from '@/lib/types';
import type { LoyaltyDiscountInput, TaxAndTotalsCentavos } from '@/lib/tax';
import { statutoryShares, type StatutoryInput } from './shares';
import type { SessionBillLine } from '@/lib/types';

/** Preserve aggregate allocation while never taking more than a diner's remaining share. */
function allocateWithin(total: number, weights: number[], capacity: number[]): number[] {
  if (!weights.some(weight => weight > 0)) return weights.map(() => 0);
  if (total < 0 || capacity.some(value => value < 0) || capacity.reduce((sum, value) => sum + value, 0) < total) {
    throw new Error('The qualifying amounts do not fit this bill. Review the discounts before payment.');
  }
  // allocate returns one part per weight, aligned with each capacity entry.
  const parts = allocate(total, weights).map((part, index) => Math.min(part, capacity[index]!));
  let left = total - parts.reduce((sum, part) => sum + part, 0);
  while (left > 0) {
    const eligible = weights.map((weight, index) => parts[index]! < capacity[index]! ? weight : 0);
    const more = allocate(left, eligible);
    for (let index = 0; index < parts.length; index++) parts[index]! += Math.min(more[index]!, capacity[index]! - parts[index]!);
    left = total - parts.reduce((sum, part) => sum + part, 0);
  }
  return parts;
}

export function statutoryTotals(input: { subtotalC: number; lineDiscountsC: number; lineChargesC: number;
  lines: SessionBillLine[]; store: Store; promo: Discount | null; adjustments: Adjustment[];
  loyalty: LoyaltyDiscountInput; statutory: StatutoryInput }): TaxAndTotalsCentavos {
  const { store, promo } = input;
  const shares = statutoryShares({ ...input.statutory, lines: input.lines }).shares;
  const shareC = shares.reduce((sum, share) => sum + share.centavos, 0);
  const grossC = input.subtotalC - input.lineDiscountsC;
  if (shareC > grossC) throw new Error('The qualifying shares exceed this bill. Review the assigned dishes before payment.');
  const pct = (value: number) => Exact.of(Number(value || 0)).div(HUNDRED);
  const rate = pct(store.taxRatePct || 0);
  const onePlus = ONE.add(rate);
  const inclusive = store.taxType === 'VAT_INCLUSIVE';
  const exclusive = store.taxType === 'VAT_EXCLUSIVE';
  const fixedC = promo?.type === 'fixed' ? Math.min(grossC, storedPesosToCentavos(promo.value)) : 0;
  let statutoryDiscount = ZERO, promoShare = ZERO, exempt = ZERO, promoGrossC = 0;
  const diners = shares.map((share, index) => {
    const gross = Exact.int(share.centavos);
    const net = inclusive ? gross.div(onePlus) : gross;
    const twenty = net.mul(Exact.int(20)).div(HUNDRED);
    const promotion = !promo ? ZERO : promo.type === 'percent' ? gross.mul(pct(promo.value))
      : grossC > 0 ? Exact.int(fixedC).mul(gross).div(Exact.int(grossC)) : ZERO;
    const promoWasHigher = promotion.gt(twenty);
    if (promoWasHigher) {
      promoShare = promoShare.add(promotion);
      promoGrossC += share.centavos;
    } else {
      statutoryDiscount = statutoryDiscount.add(twenty);
      exempt = exempt.add(net.sub(twenty));
    }
    // statutoryShares preserves the input diner order and length.
    return { dinerId: share.dinerId, kind: input.statutory.diners[index]!.kind, share: share.centavos,
      promoWasHigher, discount: 0, vatRemoved: 0, vatExempt: 0 };
  });
  const statutoryDiscountTotal = statutoryDiscount.roundHalfUp();
  const promoShareC = promoShare.roundHalfUp();
  // The promo amount must enter the centavo budget before deriving its VAT split.
  // Otherwise two half-up rounds can invent negative VAT at a non-VAT store.
  const promoPayable = Exact.int(promoGrossC - promoShareC);
  exempt = exempt.add(inclusive ? promoPayable.div(onePlus) : promoPayable);
  const vatExemptSales = exempt.roundHalfUp();
  const statutoryVatRemovedTotal = shareC - statutoryDiscountTotal - promoShareC - vatExemptSales;
  const remainderPromo = promo?.type === 'fixed' && promoShareC > 0
    ? { ...promo, value: toWirePesos(Math.max(0, fixedC - promoShareC)) } : promo;
  const ordinary = ordinaryBill(Exact.int(grossC - shareC), store, remainderPromo, input.loyalty);
  const netSales = ordinary.netSales.add(Exact.int(vatExemptSales));
  const beforeCharges = exclusive ? netSales.add(ordinary.taxTotal) : netSales;
  let charges = Exact.int(input.lineChargesC);
  for (const charge of input.adjustments) charges = charges.add(charge.type === 'percent'
    ? (charge.appliesTo === 'total' ? beforeCharges : netSales).mul(pct(charge.amount))
    : Exact.int(storedPesosToCentavos(charge.amount)));
  const chargesTotal = charges.roundHalfUp();
  // Every index below comes from this diners array; allocate returns one part per weight.
  for (const higher of [false, true]) {
    const indexes = diners.map((diner, index) => diner.promoWasHigher === higher ? index : -1).filter(index => index >= 0);
    const weights = indexes.map(index => diners[index]!.share);
    if (!weights.some(weight => weight > 0)) continue;
    const parts = allocate(higher ? promoShareC : statutoryDiscountTotal, weights);
    indexes.forEach((index, position) => { diners[index]!.discount = parts[position]!; });
  }
  const weights = diners.map(diner => diner.share);
  const removed = allocateWithin(statutoryVatRemovedTotal, weights, diners.map(diner => diner.share - diner.discount));
  diners.forEach((diner, index) => {
    diner.vatRemoved = removed[index]!; diner.vatExempt = diner.share - diner.discount - diner.vatRemoved;
  });
  const billDiscountTotal = ordinary.billDiscountC + promoShareC;
  return { subtotal: input.subtotalC, lineDiscountsTotal: input.lineDiscountsC, billDiscountTotal,
    loyaltyDiscountTotal: ordinary.loyaltyDiscountC, totalDiscounts: input.lineDiscountsC + billDiscountTotal + ordinary.loyaltyDiscountC + statutoryDiscountTotal,
    chargesTotal, grandTotal: beforeCharges.add(Exact.int(chargesTotal)).roundHalfUp(),
    taxableAmount: ordinary.vatableSales.roundHalfUp(), vatableSales: ordinary.vatableSales.roundHalfUp(), taxTotal: ordinary.taxTotal.roundHalfUp(),
    vatExemptSales, statutoryDiscountTotal, statutoryVatRemovedTotal, statutoryDiners: diners };
}
