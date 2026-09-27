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

/** A decimal quantity as a string, e.g. `"12.500"`. Matches `numeric(14,3)`. */
export type Quantity = string & { readonly __brand: 'Quantity' };

const SCALE = 3;
const FACTOR = 1000n;
/** numeric(14,3) → 11 integer digits. */
const MAX_ABS = 10n ** 11n * FACTOR;

/**
 * Parse a string, integer-thousandths bigint, or exact-at-3dp number into a Quantity.
 *
 * ⚠️ A `number` is accepted only when it is exact to 3dp — the same concession `money()` makes,
 * for the same reason (porting v1 code would be impossible otherwise) and with the same refusal
 * when precision has already been lost.
 */
export function quantity(value: string | number | bigint): Quantity {
  if (typeof value === 'bigint') return fromThousandths(value);

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Not a finite quantity: ${value}`);
    }
    const scaled = Math.round(value * 1000);
    if (Math.abs(scaled - value * 1000) > 1e-6) {
      throw new RangeError(
        `Quantity from float lost precision: ${value}. Pass a string instead (bible §6).`,
      );
    }
    return fromThousandths(BigInt(scaled));
  }

  const trimmed = value.trim();
  if (!/^-?\d+(\.\d{1,3})?$/.test(trimmed)) {
    throw new TypeError(
      `Invalid quantity string: ${JSON.stringify(value)} (expected up to ${SCALE} decimal places)`,
    );
  }
  return fromThousandths(toThousandths(trimmed as Quantity));
}

export const ZERO_QUANTITY = quantity('0');

export function toThousandths(value: Quantity): bigint {
  const negative = value.startsWith('-');
  const [whole, frac = ''] = (negative ? value.slice(1) : value).split('.');
  const units = BigInt(whole ?? '0') * FACTOR + BigInt(frac.padEnd(SCALE, '0'));
  return negative ? -units : units;
}

export function fromThousandths(units: bigint): Quantity {
  // T-343 S5.5p / DEF-462 — the same off-by-one `money.ts`'s MAX_ABS had (S5.5n): `>`/`<` let
  // ±100,000,000,000.000 through, which numeric(14,3) refuses (11 integer digits, true max
  // 99,999,999,999.999). `>=`/`<=` makes MAX_ABS itself the first REFUSED value.
  if (units >= MAX_ABS || units <= -MAX_ABS) {
    throw new RangeError(`Quantity out of range for numeric(14,3): ${units} thousandths`);
  }
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / FACTOR;
  const frac = (abs % FACTOR).toString().padStart(SCALE, '0');
  return `${negative ? '-' : ''}${whole}.${frac}` as Quantity;
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
