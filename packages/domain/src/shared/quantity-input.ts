/**
 * `quantity()` (`packages/domain/src/stock/quantity.ts`) is a `numeric(14,3)` value's own choke
 * point, the same relationship `money()` has to `parseMoneyInput` — it throws a raw `TypeError`,
 * never a sentence a cashier can act on. This is that wrapper.
 *
 * T-343 S5.5w item 2 — moved here from `trade/index.ts` (its only prior caller) so `items/index.ts`
 * and `cutover/index.ts` can share the same sentence-producing entry point rather than each growing
 * their own copy; every existing sentence stays byte-identical.
 */
import { quantity as parseQuantity } from '../stock/quantity';
import { refuse } from './refusal';

export function parseQuantityInput(raw: string, rawLabel: string, humanLabel: string): string {
  try {
    return parseQuantity(raw);
  } catch (err) {
    // T-343 S5.5r / DEF-469 — `fromThousandths`'s ceiling (`stock/quantity.ts`) throws a RangeError
    // distinct from every other malformed-string failure; collapsing both into one "not a valid
    // quantity... at most three decimal places" sentence told an operator whose number was too big
    // that their DECIMAL PLACES were wrong.
    // T-343 S5.5u item 2 (DEF-473) — money-input's huge-exponent arm: scientific notation never
    // matches `parseQuantity`'s plain-decimal regex, so it fell into the malformed-string sentence
    // even when the VALUE it names is genuinely too large, same class of gap `parseMoneyInput` had.
    // S5.5u Amendment A1 item 2 — the mantissa also accepts a leading dot with no digit before it
    // (".5e300"), not just "digit(.digits)?"; update both together with `numeric(14,3)`'s own
    // 99,999,999,999.999 ceiling below if that column's precision ever changes.
    const trimmed = raw.trim();
    const hugeExponent =
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)e[+-]?\d+$/i.test(trimmed) && Math.abs(Number(trimmed)) > 99999999999.999;
    if (hugeExponent || (err instanceof RangeError && /out of range/.test(err.message))) {
      throw refuse(
        `${rawLabel} — "${raw}" is too large. The most a quantity can be is 99,999,999,999.999.`,
        `${humanLabel} — "${raw}" is too large. The most a quantity can be is 99,999,999,999.999.`,
      );
    }
    throw refuse(
      `${rawLabel} — "${raw}" is not a valid quantity. Use at most three decimal places.`,
      `${humanLabel} — "${raw}" is not a valid quantity. Use at most three decimal places.`,
    );
  }
}
