import { storedPesosToCentavos } from './centavos';
import { Exact, HUNDRED, ONE, ZERO } from './exact';
import type { Discount, Store } from '@/lib/types';

/** T-423's ordinary promo, loyalty and VAT stages, shared with the statutory remainder. */
export function ordinaryBill(gross: Exact, store: Store, promo: Discount | null,
  loyalty: { type: 'fixed' | 'percent'; value: number }[] | null) {
  const pct = (value: number) => Exact.of(Number(value || 0)).div(HUNDRED);
  const stored = (value: number) => Exact.int(storedPesosToCentavos(value));
  const billDiscountC = !promo ? 0 : (promo.type === 'percent'
    ? gross.mul(pct(promo.value)) : gross.min(stored(promo.value))).roundHalfUp();
  let loyaltyDiscountC = 0;
  if (Array.isArray(loyalty) && loyalty.length) {
    let remaining = gross.sub(Exact.int(billDiscountC));
    let sum = ZERO;
    for (const reward of loyalty) {
      if (!reward || !(reward.value > 0) || !remaining.gt(ZERO)) continue;
      const amount = reward.type === 'percent' ? remaining.mul(pct(reward.value)) : remaining.min(stored(reward.value));
      sum = sum.add(amount); remaining = remaining.sub(amount);
    }
    loyaltyDiscountC = sum.max(ZERO).roundHalfUp();
  }
  const netSales = gross.sub(Exact.int(billDiscountC + loyaltyDiscountC));
  const rate = pct(store.taxRatePct || 0);
  const vatableSales = store.taxType === 'VAT_INCLUSIVE' ? netSales.div(ONE.add(rate)) : netSales;
  const taxTotal = store.taxType === 'VAT_INCLUSIVE' ? netSales.sub(vatableSales)
    : store.taxType === 'VAT_EXCLUSIVE' ? netSales.mul(rate) : ZERO;
  return { billDiscountC, loyaltyDiscountC, netSales, vatableSales, taxTotal };
}
