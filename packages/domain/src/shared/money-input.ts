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
 * sentence a cashier can act on. `label` identifies the field ("createCashRequest: the amount") —
 * the caller's own positivity or other business check runs on the RETURNED value, not here: this
 * only closes the "an unparsed string reaches the database" gap.
 */
export function parseMoneyInput(raw: string, label: string): Money {
  try {
    return money(raw);
  } catch {
    throw new Error(
      `${label} — "${raw}" is not a valid amount. Use at most two decimal places.`,
    );
  }
}
