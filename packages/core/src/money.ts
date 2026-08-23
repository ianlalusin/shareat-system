/**
 * Money.
 *
 * PROJECT_BIBLE.md §6: amounts are `numeric(14,2)` in Postgres, rates `numeric(14,4)`.
 * Never float, never `double`, never `real`.
 *
 * §12 landmine 25: v1 represented every peso as a plain JavaScript float and fought the
 * resulting drift by rounding half-away-from-zero at EVERY incremental write. That is a
 * symptom-level defence against a root-cause problem — 0.1 + 0.2 !== 0.3, and rounding
 * intermediate steps compounds error rather than cancelling it.
 *
 * Here, money crosses the wire as a STRING and is computed in integer minor units
 * (centavos). There is no intermediate rounding because there is nothing to round.
 *
 * §12 landmine 8: a rate or amount of ZERO is a legitimate value, not "unset".
 * Never `if (amount)`. Use `amount == null` to test for absence.
 */

/** A decimal money amount as a string, e.g. "1234.50". Matches numeric(14,2). */
export type Money = string & { readonly __brand: 'Money' };

const SCALE = 2;
const FACTOR = 100n;
const MAX_ABS = 10n ** 12n * FACTOR; // numeric(14,2) → 12 integer digits

/** Parse a string or integer-centavo value into Money. Rejects anything ambiguous. */
export function money(value: string | number | bigint): Money {
  if (typeof value === 'bigint') return fromCentavos(value);

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Not a finite money value: ${value}`);
    }
    // A float reaching this function is a smell, but rejecting outright would make porting
    // v1 code impossible. Accept only values that are exact to 2dp.
    const scaled = Math.round(value * 100);
    if (Math.abs(scaled - value * 100) > 1e-6) {
      throw new RangeError(
        `Money from float lost precision: ${value}. Pass a string instead (bible §6).`,
      );
    }
    return fromCentavos(BigInt(scaled));
  }

  const trimmed = value.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new TypeError(
      `Invalid money string: ${JSON.stringify(value)} (expected up to ${SCALE} decimal places)`,
    );
  }
  return normalise(trimmed);
}

export const ZERO = money('0');

export function toCentavos(value: Money): bigint {
  const negative = value.startsWith('-');
  const [whole, frac = ''] = (negative ? value.slice(1) : value).split('.');
  const centavos = BigInt(whole ?? '0') * FACTOR + BigInt(frac.padEnd(SCALE, '0'));
  return negative ? -centavos : centavos;
}

export function fromCentavos(centavos: bigint): Money {
  if (centavos > MAX_ABS || centavos < -MAX_ABS) {
    throw new RangeError(`Money out of range for numeric(14,2): ${centavos} centavos`);
  }
  const negative = centavos < 0n;
  const abs = negative ? -centavos : centavos;
  const whole = abs / FACTOR;
  const frac = (abs % FACTOR).toString().padStart(SCALE, '0');
  return `${negative ? '-' : ''}${whole}.${frac}` as Money;
}

function normalise(value: string): Money {
  return fromCentavos(toCentavos(value as Money));
}

export function add(...values: Money[]): Money {
  return fromCentavos(values.reduce((sum, v) => sum + toCentavos(v), 0n));
}

export function subtract(a: Money, b: Money): Money {
  return fromCentavos(toCentavos(a) - toCentavos(b));
}

export function negate(value: Money): Money {
  return fromCentavos(-toCentavos(value));
}

/**
 * Multiply money by a rate. Rounds HALF-UP on the absolute value, so -0.005 and 0.005 both
 * move away from zero — the behaviour v1 used, and the one PH invoicing expects.
 *
 * Rounding happens ONCE, here, at the point a fractional result is unavoidable
 * (VAT, a percentage split). Never round intermediate sums.
 */
export function multiply(value: Money, rate: number | string): Money {
  const rateStr = typeof rate === 'number' ? rate.toString() : rate.trim();
  if (!/^-?\d+(\.\d+)?$/.test(rateStr)) {
    throw new TypeError(`Invalid rate: ${JSON.stringify(rate)}`);
  }
  const [rWhole, rFrac = ''] = rateStr.replace('-', '').split('.');
  const rScale = BigInt(10) ** BigInt(rFrac.length);
  const rNum = BigInt(`${rWhole}${rFrac}`) * (rateStr.startsWith('-') ? -1n : 1n);

  const product = toCentavos(value) * rNum;
  return fromCentavos(divideRoundHalfUp(product, rScale));
}

/** Split an amount into n parts that sum EXACTLY to the original. Remainder goes to the
 *  earliest parts, so nothing is lost or invented — the classic penny-allocation problem. */
export function allocate(value: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new RangeError(`allocate() needs a positive integer part count, got ${parts}`);
  }
  const total = toCentavos(value);
  const n = BigInt(parts);
  const base = total / n;
  let remainder = total - base * n;
  const step = remainder < 0n ? -1n : 1n;

  return Array.from({ length: parts }, () => {
    let share = base;
    if (remainder !== 0n) {
      share += step;
      remainder -= step;
    }
    return fromCentavos(share);
  });
}

function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  const quotient = a / b;
  const remainder = a % b;
  const rounded = remainder * 2n >= b ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

export function isZero(value: Money): boolean {
  return toCentavos(value) === 0n;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  const x = toCentavos(a);
  const y = toCentavos(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function equals(a: Money, b: Money): boolean {
  return compare(a, b) === 0;
}

/** Display formatting. Never used for storage or arithmetic. */
export function formatMoney(value: Money, currency = 'PHP'): string {
  return new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency,
    minimumFractionDigits: SCALE,
  }).format(Number(value));
}

/**
 * ETL-ONLY: convert a v1 float into Money, reporting whether precision was lost.
 *
 * v1 stored every peso as a JavaScript float (§12 landmine 25), so historical values
 * routinely cannot be represented exactly — 1.005 is really 1.00499999999999989. The
 * strict `money()` refuses these on purpose. The migration cannot be blocked by that, but
 * the rounding must be DELIBERATE AND REPORTED rather than silent.
 *
 * `rounded: true` means this amount was ambiguous in the source. The ETL logs it and the
 * reconciliation report counts it (bible §11 rule 5) — "dirty data is surfaced, not
 * silently coerced". Never call this from application code; use `money()` there.
 */
export function moneyFromLegacyFloat(value: number): { value: Money; rounded: boolean } {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Not a finite legacy money value: ${value}`);
  }
  const scaled = value * 100;
  const negative = scaled < 0;
  const abs = Math.abs(scaled);
  // Half away from zero, matching v1's roundMoney() so migrated figures reproduce.
  const roundedAbs = Math.floor(abs + 0.5);
  const lostPrecision = Math.abs(roundedAbs - abs) > 1e-9;

  return {
    value: fromCentavos(BigInt(negative ? -roundedAbs : roundedAbs)),
    rounded: lostPrecision,
  };
}
