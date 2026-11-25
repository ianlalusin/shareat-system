/**
 * Slicer pay maths, PURE (no database): the rate in force and the pay for one record. T-635. Split from `slicer-pay.ts` so it is unit-testable.
 */
import { fromCentavos, money, toCentavos, type Money } from '@shareat/core/money';
import { humanDate } from '../shared/refusal-leaf';
import { fromThousandths, quantity, toThousandths, type Quantity } from '../stock/quantity';
import { divideRoundHalfUp, unitConversionFactor } from './unit-conversion';

const refusal = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

// -------------------------------------------------------------------------------------------------
// The rate in force, and the pay for one record. PURE.
// -------------------------------------------------------------------------------------------------
export interface SlicerRateLike {
  readonly itemId: string | null;
  readonly ratePerKg: string;
  readonly effectiveFrom: string;
}

/**
 * The per-kg rate in force for `itemId` on `on`: the latest row whose `effectiveFrom <= on` for that item; when the item has none in
 * force, the org default (the latest default row whose `effectiveFrom <= on`); else null. An override in force always beats the default,
 * even when the default is newer. ISO dates compare as strings.
 */
export function slicerRateInForce(rates: readonly SlicerRateLike[], itemId: string, on: string): string | null {
  const latest = (rows: readonly SlicerRateLike[]) =>
    rows.filter((r) => r.effectiveFrom <= on).reduce<SlicerRateLike | null>((a, r) => (a === null || r.effectiveFrom > a.effectiveFrom ? r : a), null);
  return (latest(rates.filter((r) => r.itemId === itemId)) ?? latest(rates.filter((r) => r.itemId === null)))?.ratePerKg ?? null;
}

export interface SlicerPayLine {
  readonly itemId: string;
  readonly itemName: string;
  readonly quantity: string;
  readonly unit: string;
}

export type RecordPay = { readonly ok: true; readonly pay: Money; readonly kg: Quantity } | { readonly ok: false; readonly reason: string };

/**
 * What one record pays: the sum over its PAID output lines of (kg x rate in force for that item on `producedOn`), exact, rounded half-up
 * to the centavo ONCE for the record. Only kg and g are priced (g -> kg through the one conversion table); anything else is refused in
 * words, and so is a line with no rate in force, never paid at zero.
 */
export function computeRecordPay(producedOn: string, lines: readonly SlicerPayLine[], rates: readonly SlicerRateLike[]): RecordPay {
  const D = 1_000_000n;
  let total = 0n;
  let kgThousandths = 0n;
  for (const line of lines) {
    const unit = line.unit.trim();
    if (unit !== 'kg' && unit !== 'g') {
      return refusal(`${line.itemName} was recorded in ${unit || 'no unit'}, and slicer pay is per kg. Only kg or g can be paid; change the unit on the record.`);
    }
    const rate = slicerRateInForce(rates, line.itemId, producedOn);
    if (rate === null) {
      return refusal(`There is no slicer rate in force for ${line.itemName} on ${humanDate(producedOn as never)}. Set the per-kg rate under Slicer pay first.`);
    }
    const ratio = unitConversionFactor(unit, 'kg')!;
    const qTh = toThousandths(quantity(line.quantity));
    // value (centavos) = qTh/1000 x num/den x rateCentavos = N / (1000 x den); den is 1 or 1000, so 1000/den is whole.
    total += qTh * ratio.num * toCentavos(money(rate)) * (1000n / ratio.den);
    kgThousandths += divideRoundHalfUp(qTh * ratio.num, ratio.den);
  }
  return { ok: true, pay: fromCentavos(divideRoundHalfUp(total, D)), kg: fromThousandths(kgThousandths) };
}

