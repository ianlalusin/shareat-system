import { formatMoney, type Money } from '@shareat/core/money';

/** Show a Money string as pesos. Display only, never used for sums. */
export function peso(value: Money): string {
  return formatMoney(value, 'PHP');
}
