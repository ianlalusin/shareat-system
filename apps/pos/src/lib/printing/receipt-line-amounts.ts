import type { SessionBillLine, Store } from '@/lib/types';
import { lineAmounts } from '@/lib/money/line-amounts';
import { allocateExact } from '@/lib/money/centavos';
import { Exact, ZERO } from '@/lib/money/exact';

/** Receipt display only: reuse billing stages, then share their rounded centavos. */
export function receiptLineAmounts(lines: SessionBillLine[], store?: Pick<Store, 'taxRatePct' | 'taxType'>) {
  const active = lines.filter(line => line.qtyOrdered - (line.voidedQty || 0) > 0)
    .sort((a, b) => (a.type === 'package' ? 0 : 1) - (b.type === 'package' ? 0 : 1));
  const stages = active.map(line => lineAmounts([line], store ?? { taxRatePct: 0, taxType: 'NON_VAT' }));
  const share = (key: keyof ReturnType<typeof lineAmounts>) => {
    const weights = stages.map(stage => stage[key]);
    const total = weights.reduce((sum, value) => sum.add(value), ZERO);
    // Historical modifiers can be signed. Keep each whole-cent floor and allocate
    // only its nonnegative fractional remainder; never send negative weights to allocateExact.
    if (weights.some(value => value.lt(ZERO))) {
      const floors = weights.map(value => value.n / value.d - (value.n < 0n && value.n % value.d !== 0n ? 1n : 0n));
      const remainder = weights.map((value, index) => value.sub(new Exact(floors[index])));
      const centsLeft = total.roundHalfUp() - Number(floors.reduce((sum, value) => sum + value, 0n));
      const extra = centsLeft === 0 ? weights.map(() => 0) : allocateExact(centsLeft, remainder);
      return floors.map((value, index) => Number(value) + extra[index]);
    }
    return total.isZero() ? weights.map(() => 0) : allocateExact(total.roundHalfUp(), weights);
  };
  const gross = share('grossSubtotal');
  const discounts = share('lineDiscountsTotal');
  const charges = share('lineChargesTotal');
  return active.map((line, index) => ({ line, activeQty: line.qtyOrdered - (line.voidedQty || 0),
    grossCentavos: gross[index], discountCentavos: discounts[index], chargeCentavos: charges[index] }));
}
