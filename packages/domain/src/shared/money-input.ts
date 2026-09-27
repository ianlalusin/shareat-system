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
import { money, type Money } from '@shareat/core/money';

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
 * ⚠️ **No `refuse`/`RefusalError` import here, on purpose.** This file must stay a clean leaf —
 * `packages/domain/src/shared/refusal.ts` re-exports from `@shareat/db`, and this function is
 * reachable from CLIENT code (the same reason `attendance/fingerprint`'s own leaf exists,
 * `vitest.config.mts`'s comment on it). Pulling `@shareat/db` into a browser bundle is T-266's
 * exact regression (`Module not found: Can't resolve 'net'`). `isPresentable`
 * (`apps/erp/src/lib/error-shape.ts`) duck-types `userMessage`, so a plain `Error` with the field
 * assigned renders identically to a real `RefusalError`, with no import needed to produce one.
 */
export function parseMoneyInput(raw: string, rawLabel: string, humanLabel: string): Money {
  try {
    return money(raw);
  } catch (e) {
    // T-343 S5.5n / DEF-458 — `money()`'s two failures need different advice: a malformed STRING
    // (`TypeError`) is fixed by retyping it; an out-of-range VALUE (`RangeError`,
    // `packages/core/src/money.ts`'s `MAX_ABS`, numeric(14,2)'s 12-integer-digit ceiling) is not
    // fixed by any number of decimal places. Scientific notation (`1e+21`, the shape a computed
    // huge number can take) never matches `money()`'s plain-decimal regex, so it throws the
    // ordinary TypeError — but ONLY when it names a value actually over the ceiling does it get
    // the "too large" sentence too; a small one ("1e-5", "3.5e1") is still just a malformed
    // STRING for this two-decimal-place field, and keeps the decimal-places advice.
    // T-343 S5.5p / DEF-458 follow-up — `String(raw).trim()`, not `raw.trim()`: a non-string
    // crossing the `string` boundary (a bug upstream, not this function's business to rule out)
    // must still yield a presentable sentence, not a bare `TypeError` from this catch block itself.
    // And no `Number.isFinite` conjunct: the anchored regex already excludes NaN on its own, so the
    // conjunct only ever excluded OVERFLOW ("1e+400" → `Infinity`) — exactly the shape a genuinely
    // too-large scientific-notation value takes, wrongly routed to the decimal-places sentence.
    const trimmed = String(raw).trim();
    const asNumber = Number(trimmed);
    const hugeExponent = /^[+-]?\d+(\.\d+)?e[+-]?\d+$/i.test(trimmed) && Math.abs(asNumber) > 999999999999.99;
    // T-343 S5.5p follow-up — `money()` throws RangeError for TWO different reasons: out-of-range
    // (`fromCentavos`'s "out of range for numeric(14,2)") and a NUMBER input that loses precision
    // (`money(3.456)`'s "lost precision"). Only the first is "too large"; the second is a malformed
    // NUMBER for a two-decimal-place field, same bucket as a malformed string.
    const outOfRange = e instanceof RangeError && /out of range/.test(e.message);
    if (outOfRange || hugeExponent) {
      const rawMessage = `${rawLabel} — "${raw}" is too large. The most an amount can be is 999,999,999,999.99.`;
      const err = new Error(rawMessage);
      throw Object.assign(err, {
        userMessage: `${humanLabel} — "${raw}" is too large. The most an amount can be is 999,999,999,999.99.`,
      });
    }
    const rawMessage = `${rawLabel} — "${raw}" is not a valid amount. Use at most two decimal places.`;
    const err = new Error(rawMessage);
    throw Object.assign(err, { userMessage: `${humanLabel} — "${raw}" is not a valid amount. Use at most two decimal places.` });
  }
}
