/**
 * run.ts — the orchestrator. docs/tasks/112-etl-framework.md.
 *
 * Three modes, sharing one run-lifecycle wrapper (`withRun`):
 *   - `capture` — reads `reader` (the ONLY mode that touches the source, Contract §6),
 *     lands every document, and writes one etl_reconciliation row per collection.
 *   - `analyze` — reads back the CURRENT version of every landed document
 *     (`etlRepo.findCurrentDocuments`) and runs the caller's `convert` function over
 *     each one, classifying, quarantining and reconciling. **Never touches `reader`** —
 *     Contract §6's "analyze must run offline" is proven by the integration test passing
 *     a reader that throws on every method and confirming the run still completes.
 *   - `load` — everything `analyze` does, plus posts every 'converted' outcome through
 *     `postEntry` (`@shareat/domain`, untouched — this task does not modify it).
 *
 * `orgId` is a RUNTIME PARAMETER to `runLoad`, never a persisted column on `etl_runs` —
 * see schema/etl.ts's top comment for why: these four tables describe the migration
 * across every store before any of it is resolved to a v2 org, and the Contract's own
 * column lists name no such column.
 *
 * A run's lifecycle (`etlRepo.startRun` / `etlRepo.finishRun`) is deliberately NOT
 * folded into the same transaction as the work it wraps — see repo/etl.ts's comments on
 * both functions for why: a run that throws must still be recorded as `failed`, which
 * requires `finishRun`'s own commit to survive independently of whatever the failed
 * work rolled back.
 */
import { etlRepo, transaction } from '@shareat/db';
import { postEntry } from '@shareat/domain';
import {
  assertCaptureTallyReconciles,
  assertConversionTallyReconciles,
  tallyConversionOutcomes,
  type ClassifyOutcome,
  type ConversionTally,
  type Converter,
} from './reconcile';
import type { SourceReader } from './source-reader';

type LandedDoc = etlRepo.LandedSourceDocumentRow;

// -----------------------------------------------------------------------------------------
// The run-lifecycle wrapper — Contract §3's "a run whose body throws is finalised as
// `failed` WITH THE ERROR RECORDED, in a finally, never left running."
// -----------------------------------------------------------------------------------------

async function withRun<T>(
  sourceSystem: string,
  mode: etlRepo.EtlMode,
  startedBy: string | null | undefined,
  notes: string | null | undefined,
  body: (runId: string) => Promise<T>,
): Promise<{ runId: string; result: T }> {
  const { id: runId } = await etlRepo.startRun({ sourceSystem, mode, startedBy, notes });
  try {
    const result = await body(runId);
    await etlRepo.finishRun(runId, 'succeeded');
    return { runId, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Must succeed even though `body` may have already rolled back its own
    // transaction(s) — finishRun opens and commits its OWN transaction (repo/etl.ts).
    await etlRepo.finishRun(runId, 'failed', message);
    throw err;
  }
}

// -----------------------------------------------------------------------------------------
// capture
// -----------------------------------------------------------------------------------------

export interface RunCaptureParams {
  sourceSystem: string;
  reader: SourceReader;
  startedBy?: string | null;
  notes?: string | null;
}

export interface CollectionCaptureResult {
  collectionPath: string;
  sourceCount: number;
  landedCount: number;
  /** Of `landedCount`, how many were genuinely NEW rows this run — re-running capture
   *  over unchanged data reports the same landedCount with newlyLanded: 0 (Contract §7:
   *  "lands nothing, and says so"). */
  newlyLanded: number;
}

export interface RunCaptureResult {
  runId: string;
  perCollection: CollectionCaptureResult[];
}

// Named `runCaptureMode`, not `runCapture` — `capture.ts` (T-117, Part 2's guarded
// credential-check entry point) already exports a `runCapture` for a different concept
// (the scheduled sampling job). Renaming that one is out of scope (capture.ts is not in
// this task's Scope); this orchestrator's function is renamed instead.
export async function runCaptureMode(params: RunCaptureParams): Promise<RunCaptureResult> {
  const { runId, result } = await withRun(
    params.sourceSystem,
    'capture',
    params.startedBy,
    params.notes,
    (runId) => runCaptureBody(runId, params.reader),
  );
  return { runId, perCollection: result };
}

async function runCaptureBody(
  runId: string,
  reader: SourceReader,
): Promise<CollectionCaptureResult[]> {
  const collections = await reader.listCollections();
  const perCollection: CollectionCaptureResult[] = [];

  for (const collectionPath of collections) {
    let sourceCount = 0;
    let landedCount = 0;
    let newlyLanded = 0;

    for await (const doc of reader.readDocuments(collectionPath)) {
      sourceCount++;
      try {
        const { inserted } = await transaction((tx) =>
          etlRepo.landDocument(tx, {
            runId,
            sourceSystem: reader.sourceSystem,
            collectionPath: doc.collectionPath,
            docPath: doc.docPath,
            docId: doc.docId,
            storeCode: doc.storeCode,
            payload: doc.payload,
          }),
        );
        landedCount++;
        if (inserted) newlyLanded++;
      } catch {
        // A land failure for ONE document (e.g. a payload that cannot be canonically
        // hashed — repo/etl.ts's canonicalJson throws on a circular reference) is NOT
        // rethrown here. It shows up as sourceCount > landedCount for this collection,
        // which assertCaptureTallyReconciles below turns into a failed run (Contract
        // §5: "an error, never a warning") — without aborting capture for every OTHER
        // document in the same collection.
      }
    }

    // Write BEFORE asserting: the reconciliation row is evidence of what happened, and
    // must survive even when the numbers it records are what fails the run (invariant
    // 18 — persisted and readable after the process exits, including a failed run).
    await transaction((tx) =>
      etlRepo.writeReconciliation(tx, {
        runId,
        // capture-mode source_type = the collection path (schema/etl.ts's top comment)
        // — capture never learns a document's BUSINESS type, only where it came from.
        sourceType: collectionPath,
        sourceCount,
        landedCount,
        convertedCount: null,
        skippedCount: null,
        quarantinedCount: null,
        entriesPosted: 0,
        sourceAmountTotal: null,
        debitTotal: null,
        creditTotal: null,
      }),
    );
    assertCaptureTallyReconciles({ sourceType: collectionPath, sourceCount, landedCount });

    perCollection.push({ collectionPath, sourceCount, landedCount, newlyLanded });
  }

  return perCollection;
}

// -----------------------------------------------------------------------------------------
// analyze / load — share one body, differing only in whether they call postEntry.
// -----------------------------------------------------------------------------------------

export interface RunAnalyzeParams {
  sourceSystem: string;
  /**
   * Accepted for call-shape uniformity with `runCaptureMode` — NEVER invoked by this
   * function. Pass a reader whose every method throws to prove it (Contract §6 /
   * invariant 20); packages/etl/tests/integration/etl-run.test.ts does exactly that.
   */
  reader: SourceReader;
  /**
   * T-112 builds no mapping (task Goal) — this is the injected seam a real converter
   * (T-114/T-115, wrapping convert.ts's convertSpecimen + a real classifier) plugs
   * into. See reconcile.ts's top comment for why this framework never imports
   * convert.ts itself.
   */
  convert: Converter<LandedDoc>;
  startedBy?: string | null;
  notes?: string | null;
}

export interface RunLoadParams extends RunAnalyzeParams {
  orgId: string;
  postedBy?: string | null;
}

export interface RunConversionResult {
  runId: string;
  tallies: ConversionTally[];
}

export async function runAnalyze(params: RunAnalyzeParams): Promise<RunConversionResult> {
  const { runId, result } = await withRun(
    params.sourceSystem,
    'analyze',
    params.startedBy,
    params.notes,
    (runId) => runConversionBody('analyze', runId, params.sourceSystem, params.convert, null, null),
  );
  return { runId, tallies: result };
}

export async function runLoad(params: RunLoadParams): Promise<RunConversionResult> {
  const { runId, result } = await withRun(
    params.sourceSystem,
    'load',
    params.startedBy,
    params.notes,
    (runId) =>
      runConversionBody(
        'load',
        runId,
        params.sourceSystem,
        params.convert,
        params.orgId,
        params.postedBy ?? null,
      ),
  );
  return { runId, tallies: result };
}

async function runConversionBody(
  mode: 'analyze' | 'load',
  runId: string,
  sourceSystem: string,
  convert: Converter<LandedDoc>,
  orgId: string | null,
  postedBy: string | null,
): Promise<ConversionTally[]> {
  // "Current" landed documents ONLY — never the SourceReader (Contract §6). One short,
  // read-only transaction; the per-document work below opens its own.
  const docs = await transaction((tx) => etlRepo.findCurrentDocuments(tx, sourceSystem));

  const bySourceType = new Map<string, ClassifyOutcome[]>();
  const entriesPostedBySourceType = new Map<string, number>();
  let totalOutcomes = 0;

  for (const doc of docs) {
    const outcome = convert(doc);
    totalOutcomes++;
    const list = bySourceType.get(outcome.sourceType) ?? [];
    list.push(outcome);
    bySourceType.set(outcome.sourceType, list);

    if (outcome.status === 'converted') {
      await transaction(async (tx) => {
        if (mode === 'load') {
          for (const entry of outcome.entries) {
            const posted = await postEntry(tx, {
              orgId: orgId!,
              entryDate: entry.entryDate,
              sourceType: entry.sourceType,
              sourceId: entry.sourceId,
              // Caller-derived, from the source document, never a timestamp (Contract
              // §7 / T-105 §3) — this is what makes invariant 21 (no duplicate posts on
              // a repeated load) hold: postEntry's own idempotency check does the work.
              idempotencyKey: entry.idempotencyKey,
              memo: entry.memo,
              postedBy,
              lines: entry.lines.map((line) => ({
                accountCode: line.accountCode,
                storeId: line.storeId ?? null,
                channelId: line.channelId ?? null,
                debit: line.debit,
                credit: line.credit,
                lineMemo: line.lineMemo ?? null,
              })),
            });
            if (posted.created) {
              entriesPostedBySourceType.set(
                outcome.sourceType,
                (entriesPostedBySourceType.get(outcome.sourceType) ?? 0) + 1,
              );
            }
          }
        }
        // A document that now converts cleanly resolves whatever previously blocked it
        // (invariant 12) — a no-op when it was never quarantined, which is the common
        // case. Runs in BOTH analyze and load: Contract §6 says analyze "quarantine[s]"
        // and "reconcile[s]", so an operator re-running analyze alone (never load) still
        // sees the quarantine count go down as the mapping improves.
        await etlRepo.resolveQuarantineForDocument(tx, {
          sourceSystem,
          docPath: doc.docPath,
          resolvedRunId: runId,
        });
      });
    } else if (outcome.status === 'quarantined') {
      await transaction((tx) =>
        etlRepo.quarantineDocument(tx, {
          runId,
          sourceSystem,
          docPath: doc.docPath,
          sourceType: outcome.sourceType,
          caseClass: outcome.caseClass,
          reasonCode: outcome.reasonCode,
          reasonDetail: outcome.reasonDetail,
        }),
      );
    }
    // 'skipped' — nothing to persist beyond the tally below.
  }

  if (totalOutcomes !== docs.length) {
    // Unreachable given the plain loop above (it always produces exactly one outcome
    // per doc) — kept as an explicit, NAMED assertion rather than silent trust, because
    // this is precisely the bug class invariant 15 regression-tests: a future refactor
    // (a filter, an early `continue`) silently dropping a document between landing and
    // classification.
    throw new Error(
      `runConversionBody: produced ${totalOutcomes} outcomes for ${docs.length} landed ` +
        'documents — a document was dropped by the orchestration loop itself',
    );
  }

  const tallies: ConversionTally[] = [];
  for (const [sourceType, outcomes] of bySourceType) {
    const tally = tallyConversionOutcomes(
      sourceType,
      outcomes.length,
      outcomes,
      entriesPostedBySourceType.get(sourceType) ?? 0,
    );
    // Write BEFORE asserting — see runCaptureBody's identical comment.
    await transaction((tx) =>
      etlRepo.writeReconciliation(tx, {
        runId,
        sourceType,
        sourceCount: outcomes.length,
        landedCount: outcomes.length,
        convertedCount: tally.convertedCount,
        skippedCount: tally.skippedCount,
        quarantinedCount: tally.quarantinedCount,
        entriesPosted: tally.entriesPosted,
        sourceAmountTotal: tally.sourceAmountTotal,
        debitTotal: tally.debitTotal,
        creditTotal: tally.creditTotal,
      }),
    );
    assertConversionTallyReconciles(tally, mode);
    tallies.push(tally);
  }

  return tallies;
}
