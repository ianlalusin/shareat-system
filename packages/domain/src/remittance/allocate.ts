/**
 * FIFO allocation — how one handover settles many days. T-143 §4, bible row 144.
 *
 * ## ⭐ "Record the shortage on the last date" is not a rule. It is what FIFO PRODUCES.
 *
 * > **Ian:** *"If the remittance is short, cover the oldest sales report first, and record
 * > shortage/overage on the last date."*
 *
 * Pay the oldest day first and keep going, and the residual has nowhere to land but the last day
 * touched. **A rule that falls out of the allocation cannot drift from it** — which is why this is
 * one function and not a rule plus a placement convention that some later branch forgets.
 *
 * ## Why this is pure
 *
 * The arithmetic is the whole decision, so it is tested without a database. Everything it needs —
 * what each day is still owed, in date order — the caller derives from the ledger and the
 * allocations already made.
 */
import { add, money, subtract, type Money } from '@shareat/core/money';

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
   * The day the variance belongs to — the last one FIFO touched.
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
  let lastTouched: string | null = null;

  for (const day of days) {
    if (Number(remaining) <= 0) break;
    if (Number(day.owed) <= 0) continue; // already settled by an earlier batch — skip, silently

    const take = Number(remaining) < Number(day.owed) ? remaining : day.owed;
    allocations.push({ salesDayId: day.salesDayId, amount: take });
    remaining = subtract(remaining, take);
    lastTouched = day.salesDayId;
  }

  const totalOwed = days.reduce(
    (sum, d) => (Number(d.owed) > 0 ? add(sum, d.owed) : sum),
    money('0'),
  );
  // ⭐ Actual less expected. Negative short, positive over — and it lands on `lastTouched` because
  // that is simply where FIFO stopped.
  const variance = subtract(handedOver, totalOwed);

  return {
    allocations,
    variance,
    // ⚠️ An overage still belongs to the last day the batch touched. When the batch settled
    // nothing at all — every day already covered — there is no day to attribute it to, and the
    // caller must decide rather than have one invented here.
    varianceDayId: Number(variance) === 0 ? null : (lastTouched ?? days.at(-1)?.salesDayId ?? null),
  };
}
