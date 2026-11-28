/**
 * T-650 S2 - the standard labour of a recipe, scaled to the quantity cooked. Pure, so the unit tests run without Postgres.
 *
 * A recipe's `standard_labour_cost` is the labour for ONE batch of its `output_quantity`. A cook of `target` (in the recipe's output unit) takes
 * standard x target / output_quantity, exact in integers, rounded half-up to the centavo ONCE. Never floats.
 */
import { fromCentavos, money, toCentavos, type Money } from '@shareat/core/money';
import { fromThousandths, quantity, toThousandths, type Quantity } from '../stock/quantity';
import { divideRoundHalfUp } from './unit-conversion';

export interface CookLabour {
  readonly pay: Money;
  /** The number of batches as written for people: "1.5", "2", "0.333". */
  readonly batches: string;
}

export function cookLabourFor(standard: string | Money, recipeOutputQuantity: string, target: Quantity): CookLabour | null {
  const outTh = toThousandths(quantity(recipeOutputQuantity));
  if (outTh <= 0n) return null;
  const targetTh = toThousandths(target);
  const centavos = divideRoundHalfUp(toCentavos(money(standard)) * targetTh, outTh);
  const batchTh = divideRoundHalfUp(targetTh * 1000n, outTh);
  const batches = fromThousandths(batchTh).replace(/\.?0+$/, '');
  return { pay: fromCentavos(centavos), batches: batches === '' ? '0' : batches };
}
