/**
 * T-330 — allocate a payment across a counterparty's outstanding items, oldest (most overdue)
 * first. docs/tasks/330-auto-allocate-a-payment-oldest-first.md, amendments 1–7.
 *
 * PURE. No DB, no framework, no I/O. Integer centavos throughout (`@shareat/core/money`:
 * `toCentavos` in, `fromCentavos` out — bible §6, RULES §1 rule 6). No second money converter.
 *
 * Precedent: `packages/domain/src/remittance/allocate.ts`'s `allocateFifo` — the same
 * oldest-first exhaustion over one date key, but that module trusts the caller to sort first.
 * This one sorts internally, because T-330's whole rule (§1) is the ordering itself, across two
 * callers (AP, AR) that must not each re-implement it.
 *
 * ⛔ **T-366 S6 / DEF-399: the two are NOT merged, on purpose.** `allocateFifo` has a single date
 * key (a remittance's `business_date`) that one SQL query already expresses in order; this
 * allocator's ordering key is `dueDate || documentDate` — two columns and a nullable fallback,
 * resolved HERE because that resolution is itself the one thing a pure test can falsify (see
 * `dueDate`'s own doc below). Forcing either caller into the other's shape would mean either
 * inventing a fake due date for a remittance day or pre-resolving AP/AR's fallback outside the one
 * place that can prove it — so each allocator keeps its own ruling.
 */
import { type Money, fromCentavos, toCentavos } from '@shareat/core/money';

/** One outstanding item, already read and already scoped by the caller. Ordering keys included. */
export interface AllocationItem {
  readonly id: string;
  /**
   * NULLABLE, handed in RAW — not pre-resolved by the caller. AP: `supplier_invoices.due_date`.
   * AR: `ar_charges.due_date`.
   */
  readonly dueDate: string | null;
  /**
   * ⭐ THE FALLBACK, NOT NULL. AP: `supplier_invoices.invoice_date`. AR: `ar_charges.charge_date`.
   * This module resolves `dueDate || documentDate` itself — the ONE implementation of Ian's aging
   * rule (bible row 162, AMENDMENT 4 ruling 1). A pre-resolved date could not be told apart from
   * its absence by a test that only ever sees the resolved value (AMENDMENT 5's finding), so the
   * fallback lives here, in the one file a pure test can falsify, and nowhere else.
   *
   * ⛔ The fallback below is `||`, never `??` (AMENDMENT 6): `??` only catches `null`/`undefined`,
   * and `'' ?? documentDate` is `''`, which sorts BEFORE every real date — undated FIRST, the
   * option Ian rejected. `dueDate || documentDate` treats a blank string as absent correctly,
   * because `''` is falsy.
   */
  readonly documentDate: string;
  /** AP: `supplier_invoices.invoice_no`. AR: `ar_charges.reference_no`. Nullable free text. */
  readonly tieBreak: string | null;
  readonly outstanding: Money;
}

/** An amount the OPERATOR already typed against an item, before pressing auto-allocate. */
export interface TypedAmount {
  readonly id: string;
  readonly amount: Money;
}

export interface AllocationLine {
  readonly id: string;
  readonly amount: string;
}

export interface AllocationPlan {
  readonly allocations: AllocationLine[];
  readonly remainder: string;
}

function resolvedDate(item: AllocationItem): string {
  return item.dueDate || item.documentDate;
}

/**
 * Ascending: resolved date, then `tieBreak` (a null tie-break is treated as equal to another
 * null, never as a value of its own), then `id`. `id` is `uuidv7()` on both AP's and AR's grain —
 * unique and creation-ordered — so it always decides and is never omitted (AMENDMENT 4, F3+F7).
 */
function compareItems(a: AllocationItem, b: AllocationItem): number {
  const dateA = resolvedDate(a);
  const dateB = resolvedDate(b);
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;
  const tieA = a.tieBreak ?? '';
  const tieB = b.tieBreak ?? '';
  if (tieA !== tieB) return tieA < tieB ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/**
 * Fills `payment` across `items`, oldest first, until exhausted or nothing is left outstanding.
 *
 * ⭐ `typed` is where Ian's ruling 2 lives (AMENDMENT 7): "auto-allocate fills only the EMPTY
 * boxes." In order — SKIP every item whose id is in `typed`; REDUCE the payment available by the
 * SUM of `typed` before allocating anything; REFUSE (throw) when that sum exceeds the payment,
 * so the operator learns it before pressing Save instead of seeing a plan built against a
 * negative balance. The remainder this returns is therefore `payment − (typed + suggested)`.
 *
 * ⛔ `typed` ITSELF IS VALIDATED FIRST, FAIL CLOSED (audit, 2026-09-20 — confirmed by the
 * orchestrator, not reachable from either screen today, but an internal contract this module must
 * not get wrong): a non-positive typed amount would inflate the pot the sum is subtracted from
 * (Q5's rule, applied to the other operand of the same subtraction); a typed id absent from
 * `items` is Q3's exact shape on the typed side — silently dropping its amount rather than
 * refusing; and the SAME id typed twice must not be deduplicated for the skip-list (a `Set`) and
 * summed twice for the reduction (a raw `reduce`) — one input, disagreeing with itself inside one
 * function. All three refuse before any arithmetic runs.
 *
 * ⛔ WRITES NOTHING, EVER (invariant 5) — this proposes; the caller merges the result with
 * `typed` and hands the merged array to `recordPayment`/`recordCollection`, whose own guards see
 * only that final array, never this function's arithmetic.
 */
export function allocateOldestFirst(
  items: readonly AllocationItem[],
  payment: Money,
  typed: readonly TypedAmount[] = [],
): AllocationPlan {
  const paymentCentavos = toCentavos(payment);
  if (paymentCentavos <= 0n) {
    throw new Error('allocateOldestFirst: the payment must be greater than zero.');
  }

  // ⛔ `typedIds` (the skip-list) and `typedCentavos` (the sum) are built in ONE pass over the
  // validated loop, not two — the tester's case 7 was exactly this split: a `Set` deduplicating
  // one id for the skip-list while a separate `reduce` summed it twice for the reduction. One
  // input must not have two derivations that can disagree; there is only one now.
  const itemIds = new Set(items.map((item) => item.id));
  const typedIds = new Set<string>();
  let typedCentavos = 0n;
  for (const t of typed) {
    const amountCentavos = toCentavos(t.amount);
    if (amountCentavos <= 0n) {
      throw new Error(`allocateOldestFirst: the typed amount for ${t.id} must be greater than zero.`);
    }
    if (typedIds.has(t.id)) {
      throw new Error(`allocateOldestFirst: ${t.id} was typed twice — one figure per item, not two.`);
    }
    if (!itemIds.has(t.id)) {
      throw new Error(`allocateOldestFirst: ${t.id} was typed but is not one of the items handed in.`);
    }
    typedIds.add(t.id);
    typedCentavos += amountCentavos;
  }

  if (typedCentavos > paymentCentavos) {
    throw new Error(
      'allocateOldestFirst: the amounts already typed exceed the payment — nothing left to auto-fill.',
    );
  }

  let remaining = paymentCentavos - typedCentavos;
  const candidates = items
    .filter((item) => !typedIds.has(item.id) && toCentavos(item.outstanding) > 0n)
    .slice()
    .sort(compareItems);

  const allocations: AllocationLine[] = [];
  for (const item of candidates) {
    if (remaining <= 0n) break;
    const outstandingCentavos = toCentavos(item.outstanding);
    const take = remaining < outstandingCentavos ? remaining : outstandingCentavos;
    allocations.push({ id: item.id, amount: fromCentavos(take) });
    remaining -= take;
  }

  return { allocations, remainder: fromCentavos(remaining) };
}
