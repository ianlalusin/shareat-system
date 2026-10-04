/**
 * The one place a raw money STRING becomes a validated `Money`. DEF-272.
 *
 * `Number(x) > 0` accepts `"0.004"` — `Number('0.004') > 0` is `true` — and the raw string then
 * reaches a `numeric(14,2)` column unparsed. Depending on the column, Postgres either refuses the
 * row (a `> 0` CHECK sees it stored as `0.00`) or silently stores a truncated precision (`1.234`
 * becomes `1.23`, and nothing says so). `packages/core/src/money.ts`'s `money()` already refuses
 * both cases; the defect was every money-input call site bypassing it. This is the shared entry
 * point instead of a fifth hand-copied guard (T-255 already deleted four of those).
 */
import { decimal, type Decimal, type Money } from '@shareat/core/money';

/**
 * ⭐ T-371 R2/C3 — is the exponent-form string `s` (`1e+21`, `5.5e10`, `.5e300`) larger in magnitude than the biggest value a
 * `numeric(precision,scale)` column holds? Exact: BigInt arithmetic on the mantissa digits and the exponent, never a float,
 * so `1e+400` (which `Number()` turns into `Infinity`) and `5e11` are both decided correctly. A string that is not in
 * exponent form returns `false`; the caller's own regex decides whether to ask at all.
 */
export function exceedsMaxMagnitude(s: string, precision: number, scale: number): boolean {
  const m = /^[+-]?(\d*)(?:\.(\d*))?e([+-]?\d+)$/i.exec(s);
  if (!m) return false;
  const int = m[1] ?? '';
  const frac = m[2] ?? '';
  const digits = (int + frac).replace(/^0+/, '');
  if (digits === '') return false; // zero, however large its exponent
  // value × 10^scale = digits × 10^e
  const e = BigInt(m[3]!) - BigInt(frac.length) + BigInt(scale);
  if (e > 1000n) return true; // non-zero digits times 10^1000+: past every column
  const maxScaled = 10n ** BigInt(precision) - 1n;
  const d = BigInt(digits);
  if (e >= 0n) return d * 10n ** e > maxScaled;
  if (-e > 1000n) return false; // astronomically small
  return d > maxScaled * 10n ** -e;
}

const SCALE_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six'] as const;

/** `999999999999.99` for (14,2): the largest value the column holds, with thousands separators. */
function maxText(precision: number, scale: number): string {
  const whole = '9'.repeat(precision - scale).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return scale > 0 ? `${whole}.${'9'.repeat(scale)}` : whole;
}

/** What a figure of this shape is called in a sentence: money is "an amount", a (14,3) value "a quantity". */
function phraseFor(shape: string): { noun: string; article: string } {
  if (shape === '14,2') return { noun: 'amount', article: 'an amount' };
  if (shape === '14,3') return { noun: 'quantity', article: 'a quantity' };
  return { noun: 'figure', article: 'a figure' };
}

/**
 * ⭐ T-371 C3 — the humane wrapper over `decimal()`, the one mint: parses a raw string into a branded `Decimal<shape>` or
 * throws a presentable sentence that names the field, the decimal places allowed and the maximum. `parseMoneyInput` IS this
 * with `'14,2'`, its sentences unchanged.
 *
 * `blank` is R6 — a blank figure follows its COLUMN, never a guessed zero. Omit the option and a blank is refused as an
 * invalid figure, exactly as `parseMoneyInput` always did. Pass it and the column's rule decides:
 *   - `'refuse'`  a NOT NULL column with no default: refused, with its own sentence;
 *   - `'omit'`    a column WITH a default: `undefined`, so the caller leaves it out of an insert and unchanged on an update;
 *   - `'null'`    a nullable column: `null`.
 * `'0'` is never invented.
 */
export function parseDecimalInput<S extends `${number},${number}`>(
  raw: string,
  shape: S,
  rawLabel: string,
  humanLabel: string,
): Decimal<S>;
export function parseDecimalInput<S extends `${number},${number}`>(
  raw: string | null | undefined,
  shape: S,
  rawLabel: string,
  humanLabel: string,
  options: { blank: 'refuse' },
): Decimal<S>;
export function parseDecimalInput<S extends `${number},${number}`>(
  raw: string | null | undefined,
  shape: S,
  rawLabel: string,
  humanLabel: string,
  options: { blank: 'omit' },
): Decimal<S> | undefined;
export function parseDecimalInput<S extends `${number},${number}`>(
  raw: string | null | undefined,
  shape: S,
  rawLabel: string,
  humanLabel: string,
  options: { blank: 'null' },
): Decimal<S> | null;
export function parseDecimalInput<S extends `${number},${number}`>(
  raw: string | null | undefined,
  shape: S,
  rawLabel: string,
  humanLabel: string,
  options?: { blank: 'refuse' | 'omit' | 'null' },
): Decimal<S> | null | undefined {
  const [precision = 14, scale = 2] = shape.split(',').map(Number);
  const { noun, article } = phraseFor(shape);
  const places = scale === 0 ? 'Use a whole number.' : `Use at most ${SCALE_WORDS[scale] ?? scale} decimal place${scale === 1 ? '' : 's'}.`;

  if (options && (raw == null || String(raw).trim() === '')) {
    if (options.blank === 'omit') return undefined;
    if (options.blank === 'null') return null;
    const err = new Error(`${rawLabel} — a ${noun} is required and was left blank.`);
    throw Object.assign(err, { userMessage: `${humanLabel} — can't be left blank. Enter ${article}.` });
  }

  try {
    return decimal(raw as string, shape);
  } catch (e) {
    // T-343 S5.5n / DEF-458 — `decimal()`'s two failures need different advice: a malformed STRING (`TypeError`) is
    // fixed by retyping it; an out-of-range VALUE (`RangeError`, the column's `precision − scale` integer digits) is not
    // fixed by any number of decimal places. Scientific notation (`1e+21`, the shape a computed huge number can take)
    // never matches the plain-decimal regex, so it throws the ordinary TypeError — but ONLY when it names a value
    // actually over the ceiling does it get the "too large" sentence too; a small one ("1e-5", "3.5e1") is still just a
    // malformed STRING for this field, and keeps the decimal-places advice.
    // T-343 S5.5p — `String(raw).trim()`, not `raw.trim()`: a non-string crossing the `string` boundary must still yield
    // a presentable sentence, not a bare `TypeError` from this catch block itself.
    // T-371 — the "over the ceiling" decision is exact (`exceedsMaxMagnitude`, BigInt), not `Math.abs(Number(x)) > max`,
    // so a NaN-adjacent float comparison no longer decides a sentence; the accepted set and the sentences are unchanged.
    const trimmed = String(raw).trim();
    const hugeExponent = /^[+-]?\d+(\.\d+)?e[+-]?\d+$/i.test(trimmed) && exceedsMaxMagnitude(trimmed, precision, scale);
    // T-343 S5.5p follow-up — `decimal()` throws RangeError for TWO different reasons: out-of-range ("out of range for
    // numeric(…)") and a NUMBER input that loses precision. Only the first is "too large"; the second is a malformed
    // NUMBER for this field, same bucket as a malformed string.
    const outOfRange = e instanceof RangeError && /out of range/.test(e.message);
    if (outOfRange || hugeExponent) {
      const rawMessage = `${rawLabel} — "${raw}" is too large. The most ${article} can be is ${maxText(precision, scale)}.`;
      const err = new Error(rawMessage);
      throw Object.assign(err, {
        userMessage: `${humanLabel} — "${raw}" is too large. The most ${article} can be is ${maxText(precision, scale)}.`,
      });
    }
    const rawMessage = `${rawLabel} — "${raw}" is not a valid ${noun}. ${places}`;
    const err = new Error(rawMessage);
    throw Object.assign(err, { userMessage: `${humanLabel} — "${raw}" is not a valid ${noun}. ${places}` });
  }
}

/**
 * Parse a raw money input, turning `money()`'s developer-facing `TypeError`/`RangeError` into a
 * sentence a cashier can act on. `rawLabel` identifies the field in the raw diagnostic exactly as
 * every existing caller already does ("createCashRequest: the amount") — the caller's own
 * positivity or other business check runs on the RETURNED value, not here: this only closes the
 * "an unparsed string reaches the database" gap.
 *
 * `humanLabel` (S5.3b — the same raw/human split `commissary/catalogue.ts`'s
 * `parseFourDecimalCost` uses) is REQUIRED (S5.5m, DEF-454): every caller passes a capitalised
 * noun phrase that names no id, key or function, and the throw is always presentable, with
 * `humanLabel` in place of `rawLabel` in the sentence a screen shows.
 *
 * T-371: this is `parseDecimalInput(raw, '14,2', …)` and nothing more — the sentences, the accepted set and the
 * "blank is an invalid amount" behaviour are byte-identical to before.
 */
export function parseMoneyInput(raw: string, rawLabel: string, humanLabel: string): Money {
  return parseDecimalInput(raw, '14,2', rawLabel, humanLabel);
}
