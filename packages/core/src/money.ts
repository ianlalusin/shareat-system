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

/**
 * ⭐ T-371 C1 — a decimal figure that has been through `decimal()`, the ONE mint. The brand carries the column's
 * `'precision,scale'` as a string literal, so a (14,4) value cannot be written into a (14,2) column and silently
 * rounded (DEF-272's class), and an unparsed string cannot reach a constrained numeric column under any spelling:
 * the compiler finds every caller. `Money` and `Quantity` are two of the shapes.
 */
export type Decimal<S extends string = string> = string & { readonly __decimal: S };

/** A decimal money amount as a string, e.g. "1234.50". Matches numeric(14,2). */
export type Money = Decimal<'14,2'>;

/** A decimal stock quantity as a string, e.g. "12.500". Matches numeric(14,3). */
export type Quantity = Decimal<'14,3'>;

const SCALE = 2;
const FACTOR = 100n;

/** What `decimal()` calls a value in its messages — money's and quantity's wording predates the generalisation. */
function nameFor(precision: number, scale: number): { noun: string; Noun: string; unit: string; finite: string } {
  if (precision === 14 && scale === 2) return { noun: 'money', Noun: 'Money', unit: 'centavos', finite: 'money value' };
  if (precision === 14 && scale === 3) return { noun: 'quantity', Noun: 'Quantity', unit: 'thousandths', finite: 'quantity' };
  return { noun: 'decimal', Noun: 'Decimal', unit: `units of 1e-${scale}`, finite: 'decimal value' };
}

function shapeOf(shape: string): { precision: number; scale: number } {
  const m = /^(\d+),(\d+)$/.exec(shape);
  const precision = Number(m?.[1]);
  const scale = Number(m?.[2]);
  if (!m || !Number.isInteger(precision) || !Number.isInteger(scale) || scale > precision || precision < 1) {
    throw new TypeError(`decimal(): "${shape}" is not a 'precision,scale' shape`);
  }
  return { precision, scale };
}

/**
 * ⭐ T-371 C1 — THE mint of a branded `Decimal<'p,s'>`. Everything else (`money()`, `quantity()`, `parseMoneyInput`,
 * `parseQuantityInput`, `normaliseRate`, `parseFourDecimalCost`) ends in this function; none adds a validator of its own.
 *
 * The accepted set is `money()`'s, generalised to `scale` places and `precision − scale` integer digits: surrounding
 * whitespace is trimmed; `"0.00"`, `"-0"` and `"-0.00"` normalise to zero at `scale` places; a finite number is accepted
 * when it is exact to `scale` places; a bigint is the integer count of 10^-scale units. A leading `+` is refused
 * (money() refuses it today). It throws `TypeError` for a malformed value and `RangeError` for an out-of-range one, and
 * never accepts `NaN`, `Infinity`, an exponent or `''`.
 */
export function decimal<S extends `${number},${number}`>(value: string | number | bigint, shape: S): Decimal<S> {
  const { precision, scale } = shapeOf(shape);
  const { noun, Noun, unit, finite } = nameFor(precision, scale);
  const limit = 10n ** BigInt(precision);
  const factor = 10n ** BigInt(scale);

  const fromScaled = (scaled: bigint): Decimal<S> => {
    // The bound is EXCLUSIVE: 10^precision itself is the first refused value, matching the column (T-343 S5.5n/p).
    if (scaled >= limit || scaled <= -limit) {
      throw new RangeError(`${Noun} out of range for numeric(${precision},${scale}): ${scaled} ${unit}`);
    }
    const negative = scaled < 0n;
    const abs = negative ? -scaled : scaled;
    const whole = abs / factor;
    const frac = scale > 0 ? `.${(abs % factor).toString().padStart(scale, '0')}` : '';
    return `${negative ? '-' : ''}${whole}${frac}` as Decimal<S>;
  };

  if (typeof value === 'bigint') return fromScaled(value);

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Not a finite ${finite}: ${value}`);
    }
    // A float reaching this function is a smell, but rejecting outright would make porting
    // v1 code impossible. Accept only values that are exact to `scale` places.
    const scaled = Math.round(value * 10 ** scale);
    if (Math.abs(scaled - value * 10 ** scale) > 1e-6) {
      throw new RangeError(`${Noun} from float lost precision: ${value}. Pass a string instead (bible §6).`);
    }
    return fromScaled(BigInt(scaled));
  }

  const trimmed = value.trim();
  if (!(scale > 0 ? new RegExp(`^-?\\d+(\\.\\d{1,${scale}})?$`) : /^-?\d+$/).test(trimmed)) {
    throw new TypeError(
      `Invalid ${noun} string: ${JSON.stringify(value)} (expected up to ${scale} decimal places)`,
    );
  }
  const negative = trimmed.startsWith('-');
  const [whole, frac = ''] = (negative ? trimmed.slice(1) : trimmed).split('.');
  const scaled = BigInt(whole ?? '0') * factor + BigInt(frac.padEnd(scale, '0') || '0');
  return fromScaled(negative ? -scaled : scaled);
}

/**
 * ⭐ T-371 C1 — order two decimals of the SAME shape in scaled bigint, never as floats. Both are branded, so both are plain
 * decimal strings; they are aligned to the longer scale before comparing.
 */
export function compareDecimal<S extends string>(a: Decimal<S>, b: Decimal<S>): -1 | 0 | 1 {
  const parts = (v: string) => {
    const negative = v.startsWith('-');
    const [whole = '0', frac = ''] = (negative ? v.slice(1) : v).split('.');
    return { negative, whole, frac };
  };
  const x = parts(a);
  const y = parts(b);
  const scale = Math.max(x.frac.length, y.frac.length);
  const scaled = (p: ReturnType<typeof parts>) => {
    const n = BigInt(p.whole) * 10n ** BigInt(scale) + BigInt(p.frac.padEnd(scale, '0') || '0');
    return p.negative ? -n : n;
  };
  const left = scaled(x);
  const right = scaled(y);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Parse a string or integer-centavo value into Money. Rejects anything ambiguous. */
export function money(value: string | number | bigint): Money {
  return decimal(value, '14,2');
}

export const ZERO = money('0');

export function toCentavos(value: Money): bigint {
  const negative = value.startsWith('-');
  const [whole, frac = ''] = (negative ? value.slice(1) : value).split('.');
  const centavos = BigInt(whole ?? '0') * FACTOR + BigInt(frac.padEnd(SCALE, '0'));
  return negative ? -centavos : centavos;
}

export function fromCentavos(centavos: bigint): Money {
  // T-343 S5.5n / DEF-458: MAX_ABS (10^12 * 100 centavos) is an EXCLUSIVE bound — the first REFUSED value, matching
  // numeric(14,2)'s 12 integer digits. T-371: the check and the formatting now live in `decimal()`, the one mint.
  return decimal(centavos, '14,2');
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

/** Scaled-integer view of a branded decimal string: `{ n, scale }` where value = n / 10^scale. */
function scaledOf(v: string): { n: bigint; scale: number } {
  // A brand is only ever minted by `decimal()`, so this cannot fail without a cast — but `BigInt('')` is `0n`, so a
  // forged '' / '-' / '.5' would otherwise read as zero. Refuse the shape outright (T-371 audit).
  if (!/^-?\d+(\.\d+)?$/.test(v)) throw new TypeError(`Not a decimal string: ${JSON.stringify(v)}`);
  const negative = v.startsWith('-');
  const [whole = '0', frac = ''] = (negative ? v.slice(1) : v).split('.');
  const n = BigInt(whole) * 10n ** BigInt(frac.length) + BigInt(frac || '0');
  return { n: negative ? -n : n, scale: frac.length };
}

/**
 * T-371 S4 — exact `quantity x unit cost` to centavos, in scaled bigint (no float). Works for any scale pair (a
 * (14,3) quantity and a (14,4) cost, or whatever the strings carry). ROUNDING: HALF-UP away from zero on the absolute
 * value, once, at the end - what `(Number(q) * Number(c)).toFixed(2)` effectively intended on exact decimals.
 */
export function multiplyToMoney(qty: Decimal<string>, cost: Decimal<string>): Money {
  const a = scaledOf(qty);
  const b = scaledOf(cost);
  const product = a.n * b.n; // scale a.scale + b.scale
  const drop = a.scale + b.scale - SCALE;
  if (drop <= 0) return fromCentavos(product * 10n ** BigInt(-drop));
  return fromCentavos(divideRoundHalfUp(product, 10n ** BigInt(drop)));
}

/**
 * T-489 (DEF-780) - exact `quantity x conversion factor` to a stock quantity (three decimals), in scaled bigint (no
 * float, no `Number()`). A (14,3) purchase quantity and a (14,6) factor give a product at nine decimals, kept whole
 * until the end. ROUNDING: HALF-UP away from zero on the absolute value, ONCE, at the third decimal - the project's
 * one rule (see `multiplyToMoney`). A result that does not fit numeric(14,3) throws RangeError, as `decimal()` does.
 */
export function multiplyQuantityByFactor(qty: Decimal<'14,3'>, factor: Decimal<'14,6'>): Decimal<'14,3'> {
  const a = scaledOf(qty);
  const b = scaledOf(factor);
  const product = a.n * b.n; // scale a.scale + b.scale
  const drop = a.scale + b.scale - 3;
  if (drop <= 0) return decimal(product * 10n ** BigInt(-drop), '14,3');
  return decimal(divideRoundHalfUp(product, 10n ** BigInt(drop)), '14,3');
}

/**
 * T-371 S4 — divide money by a positive integer (a month count, a quantity of whole units). ROUNDING: HALF-UP away
 * from zero on the absolute value, once, to the centavo - what `(Number(x) / 12).toFixed(2)` effectively intended.
 */
export function divideMoney(value: Money, divisor: bigint | number): Money {
  if (typeof divisor === 'number' && !Number.isInteger(divisor)) {
    throw new TypeError(`divideMoney() needs an integer divisor, got ${divisor}`);
  }
  const d = BigInt(divisor);
  if (d === 0n) throw new RangeError('divideMoney() by zero');
  return fromCentavos(divideRoundHalfUp(toCentavos(value), d));
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
  // T-371: one ordering, in scaled bigint — `compareDecimal` is it, and `compare` is its money-typed face.
  return compareDecimal(a, b);
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
  // DEF-047. The tolerance is 1e-6, NOT 1e-9, and it matches `money()`'s above on purpose.
  // Float representation error scales with magnitude: 333992.46 — a figure exact to the
  // centavo — computes `value * 100` as 33399245.999999996, an error of 3.7e-9 that a 1e-9
  // threshold reports as precision loss. The first audit over real v1 data produced 468
  // `precision_loss` findings, the large majority of them this false positive, which buries
  // the genuine ones (263.888…, 648.648) in noise and makes the whole finding class
  // unreadable. 1e-6 still flags both of those and neither of the exact values.
  const lostPrecision = Math.abs(roundedAbs - abs) > 1e-6;

  return {
    value: fromCentavos(BigInt(negative ? -roundedAbs : roundedAbs)),
    rounded: lostPrecision,
  };
}
