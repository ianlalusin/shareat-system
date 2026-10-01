/**
 * FIFO allocation — how one handover settles many days. T-143 §4, bible row 144.
 *
 * ## ⭐ "Record the shortage on the last date" is the last day OWED, not the last day TOUCHED.
 *
 * > **Ian:** *"If the remittance is short, cover the oldest sales report first, and record
 * > shortage/overage on the last date."*
 *
 * Pay the oldest day first and keep going, and the residual belongs to the last day that owed
 * anything — whether or not the handover actually reached it. T-366 S6 / DEF-398/399 (census: "a
 * variance can land on the wrong date") corrected this: a handover that exactly clears the FIRST
 * of two owed days used to attribute the shortfall to that (fully-paid) day, because the loop
 * simply stops once `remaining` hits zero. The residual now lands on the last day the ORG owed
 * anything, which is where a person reading the report expects to see it.
 *
 * **This function does not merge with `../shared/allocate-oldest-first.ts`'s `allocateOldestFirst`
 * (DEF-399)** — see that file's own docstring for the reciprocal reason. Short version: this
 * allocator has one date key a SQL query can express (T-143's remittance days); the other has
 * three keys and a nullable fallback (T-330's payment ordering). Merging them would force one
 * caller to fake the other's shape.
 *
 * ## Why this is pure
 *
 * The arithmetic is the whole decision, so it is tested without a database. Everything it needs —
 * what each day is still owed, in date order — the caller derives from the ledger and the
 * allocations already made. Every comparison is `@shareat/core/money`'s `compare`/`isZero`, never a
 * bare float re-stringify (DEF-398 — money strings are exact at 2dp; a float round-trip is not).
 */
import { add, compare, isZero, subtract, ZERO, type Money } from '@shareat/core/money';

export interface DayOwed {
  salesDayId: string;
  /** `YYYY-MM-DD`. The caller supplies these already sorted; §Order below says why. */
  businessDate: string;
  /** What this day still needs, AFTER any earlier batch. Never negative. */
  owed: Money;
}

export interface Allocation {
  salesDayId: string;
  amount: Money;
}

export interface AllocationResult {
  allocations: Allocation[];
  /**
   * ⚠️ SIGNED, and the sign is the whole meaning: negative is **short**, positive is **over**.
   * Zero means the handover matched what the days were owed exactly.
   */
  variance: Money;
  /**
   * The day the variance belongs to — the LAST day that owed anything (T-366 S6 / DEF-398/399),
   * not merely the last day FIFO's allocation loop happened to reach.
   *
   * ⛔ **This says where the arithmetic put the residual. It does NOT say who owes it.** Once the
   * till is counted daily and signed, a batch shortage cannot be a counting error — the counts
   * already reconciled. It is a loss in custody, and that is a different question asked of a
   * possibly different person (bible row 144).
   */
  varianceDayId: string | null;
}

/**
 * Settles `handedOver` against `days`, oldest first.
 *
 * ⚠️ **Order is the caller's contract, not this function's guess.** Sorting here would hide a
 * caller that fetched the days in insertion order — and "oldest first" is the entire allocation
 * rule, so a silent re-sort would make a wrong query look right.
 */
export function allocateFifo(days: readonly DayOwed[], handedOver: Money): AllocationResult {
  const allocations: Allocation[] = [];
  let remaining = handedOver;

  for (const day of days) {
    if (compare(remaining, ZERO) <= 0) break;
    if (compare(day.owed, ZERO) <= 0) continue; // already settled by an earlier batch — skip, silently

    const take = compare(remaining, day.owed) < 0 ? remaining : day.owed;
    allocations.push({ salesDayId: day.salesDayId, amount: take });
    remaining = subtract(remaining, take);
  }

  let totalOwed = ZERO;
  let lastOwedDayId: string | null = null;
  for (const d of days) {
    if (compare(d.owed, ZERO) > 0) {
      totalOwed = add(totalOwed, d.owed);
      // T-366 S6 / DEF-398/399 (row 144) — the LAST day that owed anything, not the last day the
      // loop above actually reached. A handover that exactly clears an earlier day and leaves a
      // later one fully unpaid must attribute the shortfall to the later (unpaid) day.
      lastOwedDayId = d.salesDayId;
    }
  }
  // ⭐ Actual less expected. Negative short, positive over.
  const variance = subtract(handedOver, totalOwed);

  return {
    allocations,
    variance,
    // ⚠️ Audit round — the fallback is restored: when NO day owed anything at all (every day
    // already covered, or `days` is empty) but the variance is still non-zero — a declared overage
    // with nothing outstanding to attribute it to — this falls back to the LAST day in the list
    // (even though it owed zero), or `null` only when `days` itself is empty. Dropping this
    // fallback meant `createRemittance` (index.ts) wrote NO variance row at all for exactly that
    // shape, so a real overage could vanish from the register instead of landing somewhere.
    varianceDayId: isZero(variance) ? null : (lastOwedDayId ?? days.at(-1)?.salesDayId ?? null),
  };
}
