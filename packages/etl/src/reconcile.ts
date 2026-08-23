/**
 * reconcile.ts — the reconciliation computation. docs/tasks/112-etl-framework.md §5.
 * Pure functions, no database — packages/etl/tests/reconcile.test.ts exercises this
 * directly, and run.ts (the orchestrator) is the only caller in this package.
 *
 * SCOPE BOUNDARY, stated plainly (task's own Goal: "T-112 builds no mapping"): this file
 * does not import anything from convert.ts, leg-mapping.ts or taxonomy.ts, and never
 * will. The `ClassifyOutcome` shape below is this framework's OWN seam — a document's
 * conversion outcome, decoupled from any particular converter's implementation — not a
 * re-export of convert.ts's `ConversionResult`. Two consequences:
 *
 *   1. `run.ts` takes a `Converter` (a plain function to `ClassifyOutcome`) as a
 *      REQUIRED, INJECTED parameter for `analyze`/`load` mode — exactly like
 *      `SourceReader` is injected for `capture` mode. A future caller (T-114/T-115) can
 *      wrap `convertSpecimen` in one of these; this task proves the orchestration with a
 *      synthetic converter, never convertSpecimen itself, so the framework's tests do
 *      not depend on business mapping rules that are explicitly someone else's task.
 *
 *   2. `reasonCode` on a quarantined outcome is the CALLER's responsibility, not
 *      derived here. `convertSpecimen` (packages/etl/src/convert.ts) currently returns
 *      only a free-text `reason: string`, with no stable, aggregable code — Contract
 *      §4's "reason_code is an enumerated string" therefore cannot be honestly derived
 *      from convert.ts's output TODAY without parsing prose (which would be exactly the
 *      kind of guess bible §11 rule 5 forbids). This is a genuine seam gap between T-112
 *      (framework, no mapping) and T-113/T-117's convert.ts (mapping, free-text reasons
 *      only) — flagged in the task report as a finding for whoever writes the real
 *      Converter (T-114/T-115), not silently patched around here.
 */
import { add, equals, money, type Money } from '@shareat/core/money';

// -----------------------------------------------------------------------------------------
// The seam — Contract §6/§7: what a Converter must report about ONE landed document.
// -----------------------------------------------------------------------------------------

export interface ConvertedLineForPosting {
  /** e.g. '6200' — never a uuid; postEntry resolves code -> id (docs/tasks/105). */
  accountCode: string;
  storeId?: string | null;
  channelId?: string | null;
  debit?: string;
  credit?: string;
  lineMemo?: string | null;
}

export interface ConvertedEntryForPosting {
  entryDate: string;
  sourceType: string;
  sourceId: string;
  /**
   * Required, and MUST be derived from the source document, never a timestamp (Contract
   * §7 / bible T-105 §3) — this is what makes a repeated `load` run post no duplicates
   * (invariant 21). Passed straight through to `postEntry`; run.ts never derives or
   * inspects it.
   */
  idempotencyKey: string;
  memo: string | null;
  lines: readonly ConvertedLineForPosting[];
}

interface ClassifyOutcomeBase {
  /** The business document kind ('sale' | 'expense' | ...) — same vocabulary as
   *  journal_entries.source_type. Always supplied, regardless of status. */
  sourceType: string;
  /** The T-117 taxonomy case class, when the Converter can determine one. */
  caseClass: string | null;
  /** The source document's own headline amount ('50000.00'), if it has one — recorded
   *  into etl_reconciliation.source_amount_total REGARDLESS of conversion outcome
   *  (Contract §5: "recorded, never gated"). Omit/null when not applicable. */
  sourceAmount?: string | null;
}

export type ClassifyOutcome =
  | (ClassifyOutcomeBase & { status: 'converted'; entries: readonly ConvertedEntryForPosting[] })
  | (ClassifyOutcomeBase & { status: 'skipped'; reason: string })
  | (ClassifyOutcomeBase & { status: 'quarantined'; reasonCode: string; reasonDetail: string });

/** `TDoc` is whatever run.ts reads back from landing (`LandedSourceDocumentRow`) — kept
 *  generic here so this file has zero dependency on `@shareat/db`. */
export type Converter<TDoc> = (doc: TDoc) => ClassifyOutcome;

// -----------------------------------------------------------------------------------------
// Tally — folding a batch of outcomes for ONE source_type into reconciliation numbers.
// -----------------------------------------------------------------------------------------

export interface ConversionTally {
  sourceType: string;
  landedCount: number;
  convertedCount: number;
  skippedCount: number;
  quarantinedCount: number;
  entriesPosted: number;
  sourceAmountTotal: Money;
  debitTotal: Money;
  creditTotal: Money;
}

/**
 * Folds outcomes for ONE source_type into the tally etl_reconciliation needs.
 *
 * `landedCount` is a CALLER-SUPPLIED, independently-counted number — it is NEVER
 * derived from `outcomes.length` here. That is the whole point: invariant 15's
 * regression case ("a document dropped between land and classify") means the caller's
 * own count of what it read back from landing disagrees with how many outcomes it
 * actually produced, and `assertConversionTallyReconciles` below is what catches that
 * gap. If this function derived landedCount from the array it was folding, the
 * invariant would be unfalsifiable by construction.
 *
 * `entriesPosted` is likewise caller-supplied: `analyze` mode never posts (always 0);
 * `load` mode passes how many `postEntry` calls actually returned `created: true` this
 * run (a repeat run legitimately reports 0 — invariant 21, idempotent by construction).
 */
export function tallyConversionOutcomes(
  sourceType: string,
  landedCount: number,
  outcomes: readonly ClassifyOutcome[],
  entriesPosted: number,
): ConversionTally {
  let convertedCount = 0;
  let skippedCount = 0;
  let quarantinedCount = 0;
  let sourceAmountTotal: Money = money('0');
  let debitTotal: Money = money('0');
  let creditTotal: Money = money('0');

  for (const outcome of outcomes) {
    if (outcome.sourceAmount != null) {
      sourceAmountTotal = add(sourceAmountTotal, money(outcome.sourceAmount));
    }
    if (outcome.status === 'converted') {
      convertedCount++;
      for (const entry of outcome.entries) {
        for (const line of entry.lines) {
          if (line.debit) debitTotal = add(debitTotal, money(line.debit));
          if (line.credit) creditTotal = add(creditTotal, money(line.credit));
        }
      }
    } else if (outcome.status === 'skipped') {
      skippedCount++;
    } else {
      quarantinedCount++;
    }
  }

  return {
    sourceType,
    landedCount,
    convertedCount,
    skippedCount,
    quarantinedCount,
    entriesPosted,
    sourceAmountTotal,
    debitTotal,
    creditTotal,
  };
}

// -----------------------------------------------------------------------------------------
// The HARD gates — Contract §5. Thrown, never merely logged; the caller (run.ts) lets
// this propagate so the whole run is marked 'failed' with this exact message.
// -----------------------------------------------------------------------------------------

export class ReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconciliationError';
  }
}

/**
 * `converted + skipped + quarantined = landed`, exactly (HARD, invariant 14) — every
 * landed document lands in exactly one bucket, or a document silently vanished.
 * `debit_total = credit_total` (HARD, but ONLY in `load` mode, invariant 17) — the
 * ledger's own constraints already guarantee this for anything postEntry accepted;
 * asserting it again here catches a FRAMEWORK bug (e.g. a tally that double-counted a
 * line), never a ledger bug, which is exactly why it does not belong in
 * schema/etl.ts as a database CHECK — see that file's top comment.
 */
export function assertConversionTallyReconciles(
  tally: ConversionTally,
  mode: 'analyze' | 'load',
): void {
  const bucketSum = tally.convertedCount + tally.skippedCount + tally.quarantinedCount;
  if (bucketSum !== tally.landedCount) {
    throw new ReconciliationError(
      `source_type "${tally.sourceType}": converted(${tally.convertedCount}) + skipped(${tally.skippedCount}) ` +
        `+ quarantined(${tally.quarantinedCount}) = ${bucketSum}, but landed_count is ${tally.landedCount} — ` +
        'a document was dropped between landing and classification',
    );
  }
  if (mode === 'load' && !equals(tally.debitTotal, tally.creditTotal)) {
    throw new ReconciliationError(
      `source_type "${tally.sourceType}": debit_total (${tally.debitTotal}) != credit_total ` +
        `(${tally.creditTotal}) in load mode — the ledger already guarantees balance, so this is a ` +
        'FRAMEWORK bug, not a ledger bug',
    );
  }
}

export interface CaptureTally {
  sourceType: string;
  sourceCount: number;
  landedCount: number;
}

/**
 * `source_count = landed_count`, exactly (HARD, invariant 16). A shortfall means a read
 * or a land failed partway through — capture is the only mode that touches the true
 * source, so this is the only place that failure can originate (Contract §5).
 */
export function assertCaptureTallyReconciles(tally: CaptureTally): void {
  if (tally.sourceCount !== tally.landedCount) {
    throw new ReconciliationError(
      `source_type "${tally.sourceType}": source_count (${tally.sourceCount}) != landed_count ` +
        `(${tally.landedCount}) — a read or a land failed`,
    );
  }
}
