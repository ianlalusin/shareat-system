/**
 * The case-class taxonomy — docs/tasks/117-replay-harness-stage-a.md Contract §1.
 *
 * This is what makes the corpus coverage-driven instead of volume-driven (bible §15.2,
 * task "Why a corpus and not a bulk replay"). Every captured specimen belongs to exactly
 * one class. A class with a numeric `target` stops accepting new specimens once it has
 * that many; a class with `target: null` is an ANOMALY class and is **never capped** —
 * every anomaly found is captured (invariant 2).
 *
 * This module is pure data + pure functions. It captures nothing itself — `capture.ts`
 * (Part 2) is the only caller of `shouldCapture()`, and it is not exercised in this
 * environment (no Firestore credentials — see capture.ts). `shouldCapture()` is unit
 * tested directly against synthetic counts, which is sufficient to prove invariants 1–2
 * without a live sampler.
 */

/**
 * One case class per row of Contract §1's table. Dotted so a class also names its
 * corpus subdirectory (`corpus/<class>/...` — Contract §3) unambiguously.
 */
export type CaseClass =
  | 'sale.dine_in_unli.plain'
  | 'sale.a_la_carte.plain'
  | 'sale.discount'
  | 'sale.comps'
  | 'sale.voided'
  | 'sale.partial_refund'
  | 'sale.re_rung'
  | 'sale.split_payment'
  | 'sale.online_order'
  | 'sale.branch_sale'
  | 'ticket.cancelled'
  | 'refill.addon'
  | 'expense.cash'
  | 'expense.ap'
  | 'expense.online'
  | 'expense.capex'
  | 'expense.personal'
  | 'channel.settlement'
  | 'anomaly.zero_amount'
  | 'anomaly.negative'
  | 'anomaly.same_day_void'
  | 'anomaly.cross_period';

export interface TaxonomyEntry {
  readonly caseClass: CaseClass;
  readonly label: string;
  /** null = uncapped (anomaly classes — Contract §1's "capture every one, no cap"). */
  readonly target: number | null;
  /**
   * True for the four anomaly kinds. Kept as an explicit flag rather than derived
   * solely from `target === null` so a future capped class can never accidentally
   * read as an anomaly just because someone passes `target: null` by mistake —
   * see `isAnomalyClass` below, which checks both.
   */
  readonly anomaly: boolean;
}

/**
 * The exact table from Contract §1. Targets are per business day of capture, summed
 * across days by the sampler (Part 2) — Stage A does not re-derive or duplicate this
 * number anywhere else.
 */
export const TAXONOMY: readonly TaxonomyEntry[] = [
  { caseClass: 'sale.dine_in_unli.plain', label: 'sale · dine-in unlimited, plain', target: 5, anomaly: false },
  { caseClass: 'sale.a_la_carte.plain', label: 'sale · à la carte, plain', target: 5, anomaly: false },
  { caseClass: 'sale.discount', label: 'sale · with discount (senior / PWD / other)', target: 5, anomaly: false },
  { caseClass: 'sale.comps', label: 'sale · with comps', target: 3, anomaly: false },
  { caseClass: 'sale.voided', label: 'sale · voided', target: 5, anomaly: false },
  { caseClass: 'sale.partial_refund', label: 'sale · partially refunded', target: 3, anomaly: false },
  { caseClass: 'sale.re_rung', label: 'sale · re-rung after void (retained cash)', target: 3, anomaly: false },
  { caseClass: 'sale.split_payment', label: 'sale · split / multi-method payment', target: 5, anomaly: false },
  { caseClass: 'sale.online_order', label: 'sale · online order', target: 3, anomaly: false },
  { caseClass: 'sale.branch_sale', label: 'sale · branch sale', target: 3, anomaly: false },
  { caseClass: 'ticket.cancelled', label: 'ticket · cancelled', target: 3, anomaly: false },
  { caseClass: 'refill.addon', label: 'refill · addon', target: 5, anomaly: false },
  { caseClass: 'expense.cash', label: 'expense · cash', target: 3, anomaly: false },
  { caseClass: 'expense.ap', label: 'expense · AP', target: 3, anomaly: false },
  { caseClass: 'expense.online', label: 'expense · online', target: 3, anomaly: false },
  { caseClass: 'expense.capex', label: 'expense · CAPEX', target: 3, anomaly: false },
  { caseClass: 'expense.personal', label: 'expense · PERSONAL', target: 3, anomaly: false },
  { caseClass: 'channel.settlement', label: 'channel settlement', target: 3, anomaly: false },
  { caseClass: 'anomaly.zero_amount', label: 'anomaly — zero amount', target: null, anomaly: true },
  { caseClass: 'anomaly.negative', label: 'anomaly — negative', target: null, anomaly: true },
  { caseClass: 'anomaly.same_day_void', label: 'anomaly — same-day void', target: null, anomaly: true },
  { caseClass: 'anomaly.cross_period', label: 'anomaly — cross-period', target: null, anomaly: true },
] as const;

const BY_CLASS: ReadonlyMap<CaseClass, TaxonomyEntry> = new Map(
  TAXONOMY.map((entry) => [entry.caseClass, entry]),
);

export function taxonomyEntry(caseClass: CaseClass): TaxonomyEntry {
  const entry = BY_CLASS.get(caseClass);
  if (!entry) throw new Error(`Unknown case class: ${caseClass}`);
  return entry;
}

export function isAnomalyClass(caseClass: CaseClass): boolean {
  return taxonomyEntry(caseClass).anomaly && taxonomyEntry(caseClass).target === null;
}

/**
 * Invariants 1–2 (task spec): capture a specimen only when its class is below target;
 * anomaly classes are never capped, so this always returns true for them regardless of
 * how many have already been captured.
 *
 * `currentCount` is the number of specimens of this class already captured (this run or
 * a previous one — capture is idempotent per Contract §5, so the sampler always counts
 * what already exists on disk before deciding).
 */
export function shouldCapture(caseClass: CaseClass, currentCount: number): boolean {
  if (currentCount < 0 || !Number.isInteger(currentCount)) {
    throw new RangeError(`currentCount must be a non-negative integer, got ${currentCount}`);
  }
  const entry = taxonomyEntry(caseClass);
  if (entry.anomaly) return true; // uncapped, always capture — invariant 2
  if (entry.target === null) {
    // A non-anomaly class with a null target is a taxonomy authoring error, not a
    // runtime case to silently accept — fail loudly rather than guess a behaviour.
    throw new Error(
      `Case class ${caseClass} has target: null but anomaly: false — the taxonomy table is inconsistent.`,
    );
  }
  return currentCount < entry.target; // invariant 1
}

/** Every case class name, in table order — used by report.ts to enumerate coverage. */
export const ALL_CASE_CLASSES: readonly CaseClass[] = TAXONOMY.map((e) => e.caseClass);
