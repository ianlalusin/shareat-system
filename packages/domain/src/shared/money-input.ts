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
 * `parseFourDecimalCost` uses) is OPTIONAL: this function has ~20 callers across the domain, most
 * still unconverted, and every one of them must keep compiling and behaving exactly as before.
 * Omit it and the raw `Error` is unchanged; pass it and the throw becomes presentable, with
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
export function parseMoneyInput(raw: string, rawLabel: string, humanLabel?: string): Money {
  try {
    return money(raw);
  } catch {
    const rawMessage = `${rawLabel} — "${raw}" is not a valid amount. Use at most two decimal places.`;
    const err = new Error(rawMessage);
    if (humanLabel === undefined) throw err;
    throw Object.assign(err, { userMessage: `${humanLabel} — "${raw}" is not a valid amount. Use at most two decimal places.` });
  }
}
