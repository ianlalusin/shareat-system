/**
 * Quantity — exact decimal stock quantities, computed in integer thousandths.
 *
 * ⚠️ **This file is `packages/core/src/money.ts` applied to the other axis, and the reason is the
 * same bible landmine (§12, 25).** v1 held stock quantities as plain JavaScript floats, so
 * `10 - 3 - 7` could land at `1e-16` and a balance could drift a hair below zero for no physical
 * reason. Its defence was a **1e-6 comparison tolerance** (`stock-count.ts:20-26`,
 * `stock-ledger.ts:38`) — a symptom-level fix for a representation-level problem.
 *
 * ⭐ **Here, quantity is `numeric(14,3)` in the database and a decimal STRING in code, computed in
 * integer thousandths. There is no float, therefore no drift, therefore nothing to tolerate.**
 *
 * ### ⛔ The 1e-6 tolerance does NOT come forward, and that is a finding, not an oversight
 *
 * At three decimal places the smallest representable non-zero difference is `0.001`. A tolerance of
 * `1e-6` can therefore **never fire** — it is unreachable code the moment the column stops being a
 * float. Carrying it would be worse than useless: it would read as a deliberate business tolerance
 * and be maintained as one. Corrected in **T-161 §8** and **T-169 invariant 6**, which both
 * inherited the constant from v1 without noticing it had lost its reason for existing.
 *
 * ⚠️ **Money tolerances are unaffected** — the ₱0.99 invoice-match tolerance (T-163 invariant 5) is
 * a real business judgement about supplier paperwork, not a float defence, and §16.6's rule that
 * purpose-tuned tolerances stay separate still holds.
 *
 * ### Why this lives in `packages/domain/src/stock/` and not `packages/core/`
 *
 * ⭐ **It probably belongs in core, beside `money`.** It is the same class of primitive and a second
 * domain will want it. It is here because moving it to core means editing `packages/core`'s
 * exports, the root `tsconfig` paths and `vitest.config.mts`'s alias table — three shared files —
 * and only inventory needs it today. **Promote it the moment a second caller appears**; the API is
 * deliberately shaped like `money`'s so the move is mechanical.
 */

import { decimal, type Quantity } from '@shareat/core/money';

/**
 * A decimal quantity as a string, e.g. `"12.500"`. Matches `numeric(14,3)`.
 *
 * ⭐ T-371 R4: `Quantity` is `Decimal<'14,3'>` and lives in `@shareat/core/money` beside `Money`, minted by the ONE
 * `decimal()`. It is re-exported here so the ~80 importers do not change.
 */
export type { Quantity };

const SCALE = 3;
const FACTOR = 1000n;

/**
 * Parse a string, integer-thousandths bigint, or exact-at-3dp number into a Quantity.
 *
 * ⚠️ A `number` is accepted only when it is exact to 3dp — the same concession `money()` makes,
 * for the same reason (porting v1 code would be impossible otherwise) and with the same refusal
 * when precision has already been lost.
 */
export function quantity(value: string | number | bigint): Quantity {
  return decimal(value, '14,3');
}

export const ZERO_QUANTITY = quantity('0');

export function toThousandths(value: Quantity): bigint {
  const negative = value.startsWith('-');
  const [whole, frac = ''] = (negative ? value.slice(1) : value).split('.');
  const units = BigInt(whole ?? '0') * FACTOR + BigInt(frac.padEnd(SCALE, '0'));
  return negative ? -units : units;
}

export function fromThousandths(units: bigint): Quantity {
  // T-343 S5.5p / DEF-462: the bound is EXCLUSIVE (10^14 thousandths is the first REFUSED value, matching
  // numeric(14,3)'s 11 integer digits). T-371: the check and the formatting live in `decimal()`, the one mint.
  return decimal(units, '14,3');
}

export function addQuantity(...values: Quantity[]): Quantity {
  return fromThousandths(values.reduce((sum, v) => sum + toThousandths(v), 0n));
}

export function subtractQuantity(a: Quantity, b: Quantity): Quantity {
  return fromThousandths(toThousandths(a) - toThousandths(b));
}

export function compareQuantity(a: Quantity, b: Quantity): -1 | 0 | 1 {
  const left = toThousandths(a);
  const right = toThousandths(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isZeroQuantity(value: Quantity): boolean {
  return toThousandths(value) === 0n;
}

export function isPositiveQuantity(value: Quantity): boolean {
  return toThousandths(value) > 0n;
}
