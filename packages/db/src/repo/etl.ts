/**
 * etl repo — the ONLY place ETL SQL is written (PROJECT_BIBLE.md §4.3).
 * docs/tasks/112-etl-framework.md.
 *
 * Every function here takes a `Tx` (same convention as repo/journal.ts) EXCEPT the two
 * run-lifecycle functions (`startRun`, `finishRun`), which deliberately open and commit
 * their OWN transaction via `systemTransaction()` rather than joining a caller's — see their
 * comments for why that is not a convention violation but the whole point (a run's
 * start/finish must survive even when the work between them rolls back).
 *
 * No business rule lives here beyond what the table's own constraints already enforce
 * (bible: "the database enforces the rules, not the service layer"). This file only:
 *   - computes the canonical-JSON content hash landing's identity depends on
 *     (Contract §2's own warning: two serialisations of the same document that differ
 *     only in key order must hash identically, or every run manufactures a phantom
 *     "the source changed" finding).
 *   - resolves ON CONFLICT semantics for landing (no-op on an identical document),
 *     quarantine (advance vs insert), and reconciliation (one row per run/source_type).
 *   - reads back "current" landed documents via a query (selectDistinctOn), never a
 *     maintained flag (bible §4.2 rule 7) — see schema/etl.ts's top comment for why this
 *     is a plain typed query rather than a literal `CREATE VIEW`.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { etlQuarantine, etlReconciliation, etlRuns, etlSourceDocuments } from '../../schema';
import { systemTransaction, type Tx } from '../client';

// -----------------------------------------------------------------------------------------
// Canonical JSON + content hash (Contract §2).
// -----------------------------------------------------------------------------------------

/**
 * Deterministic JSON serialisation: object keys sorted recursively, arrays preserve
 * order (order is semantic for an array, unlike object key order), numbers serialised
 * via plain `JSON.stringify` (stable for anything that survived a Firestore round-trip —
 * Firestore itself has no ambiguous number representation to canonicalise away).
 *
 * Throws on anything `JSON.stringify` cannot represent (a circular reference, a BigInt,
 * a function) — a document like that cannot be hashed, so it cannot be landed, and that
 * throw is a REAL land failure (repo.landDocument lets it propagate), not a bug to catch
 * silently. See run.ts's capture loop for how a per-document failure like this is
 * surfaced through source_count != landed_count (invariant 16) instead of aborting the
 * whole run.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function contentHashOf(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

// -----------------------------------------------------------------------------------------
// etl_runs (Contract §3) — the lock + ledger.
// -----------------------------------------------------------------------------------------

export type EtlMode = 'capture' | 'analyze' | 'load';
export type EtlRunStatus = 'running' | 'succeeded' | 'failed' | 'aborted';

export interface StartRunInput {
  sourceSystem: string;
  mode: EtlMode;
  startedBy?: string | null;
  notes?: string | null;
}

/**
 * Opens and IMMEDIATELY COMMITS its own transaction — deliberately not given a `tx` to
 * join. A run's "I have started" fact must be visible to every OTHER process the instant
 * it happens, because that visibility IS the lock (Contract §3's partial unique index).
 * If this shared the caller's long-running work transaction instead, a concurrent run
 * attempting to start would be blocked on an open, uncommitted row rather than cleanly
 * rejected — and the lock would not actually be "one running at a time" so much as "one
 * process holding a transaction open at a time," which is a different, worse property.
 *
 * Throws, naming the collision, when a run of this exact (source_system, mode) is
 * already `running` — the unique index rejects the INSERT with a Postgres unique
 * violation (23505); this wraps that in a message that does not require the caller to
 * know Postgres error codes.
 */
export async function startRun(input: StartRunInput): Promise<{ id: string }> {
  try {
    return await systemTransaction(async (tx) => {
      const [row] = await tx
        .insert(etlRuns)
        .values({
          sourceSystem: input.sourceSystem,
          mode: input.mode,
          status: 'running',
          startedBy: input.startedBy ?? null,
          notes: input.notes ?? null,
        })
        .returning({ id: etlRuns.id });
      return { id: row!.id };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('etl_runs_source_system_mode_running_unique')) {
      throw new Error(
        `startRun: a ${input.mode} run for source system "${input.sourceSystem}" is already running — ` +
          'only one run per (source_system, mode) may run at a time (bible §12 landmine — one writer, ' +
          'no racing capture runs)',
      );
    }
    throw err;
  }
}

/**
 * Finalises a run — status 'succeeded' | 'failed' | 'aborted', never left 'running'.
 * Same deliberate own-transaction choice as `startRun`, for the same reason in reverse:
 * this MUST commit even when the work the run performed threw and rolled back its own
 * transaction(s) — see run.ts's `withRun`, which calls this from a `catch` block wrapping
 * the run's body. A run whose finalisation shared the failed work's transaction could
 * never actually record that failure; it would roll back along with everything else,
 * leaving the row 'running' forever and the (source_system, mode) lock stuck (exactly
 * the DEF-039-shaped silent failure this whole task exists to prevent, just for a run
 * instead of a migration).
 */
export async function finishRun(
  id: string,
  status: Exclude<EtlRunStatus, 'running'>,
  error?: string | null,
): Promise<void> {
  await systemTransaction(async (tx) => {
    const updated = await tx
      .update(etlRuns)
      .set({ status, finishedAt: sql`now()`, error: error ?? null })
      .where(and(eq(etlRuns.id, id), eq(etlRuns.status, 'running')))
      .returning({ id: etlRuns.id });
    if (updated.length === 0) {
      throw new Error(`finishRun: run ${id} was not 'running' (already finalised, or missing)`);
    }
  });
}

// -----------------------------------------------------------------------------------------
// etl_source_documents (Contract §2) — append-only landing.
// -----------------------------------------------------------------------------------------

export interface LandDocumentInput {
  runId: string;
  sourceSystem: string;
  collectionPath: string;
  docPath: string;
  docId: string;
  storeCode: string | null;
  payload: Record<string, unknown>;
}

export interface LandedSourceDocumentRow {
  id: string;
  runId: string;
  sourceSystem: string;
  collectionPath: string;
  docPath: string;
  docId: string;
  storeCode: string | null;
  payload: Record<string, unknown>;
  contentHash: string;
  capturedAt: Date;
}

/**
 * Lands one document. `ON CONFLICT (source_system, doc_path, content_hash) DO NOTHING` —
 * the byte-identical document (Contract §2's canonical hash makes "byte-identical"
 * mean "same content regardless of key order") inserts NOTHING and this returns
 * `inserted: false` with the EXISTING row's id. A changed document (different hash for
 * the same doc_path) always inserts a NEW row — there is no update path here, by
 * construction (invariant 5: never UPDATE or DELETE a landed row).
 */
export async function landDocument(
  tx: Tx,
  input: LandDocumentInput,
): Promise<{ id: string; inserted: boolean }> {
  const contentHash = contentHashOf(input.payload);

  const [inserted] = await tx
    .insert(etlSourceDocuments)
    .values({
      runId: input.runId,
      sourceSystem: input.sourceSystem,
      collectionPath: input.collectionPath,
      docPath: input.docPath,
      docId: input.docId,
      storeCode: input.storeCode,
      payload: input.payload,
      contentHash,
    })
    .onConflictDoNothing({
      target: [etlSourceDocuments.sourceSystem, etlSourceDocuments.docPath, etlSourceDocuments.contentHash],
    })
    .returning({ id: etlSourceDocuments.id });

  if (inserted) {
    return { id: inserted.id, inserted: true };
  }

  const [existing] = await tx
    .select({ id: etlSourceDocuments.id })
    .from(etlSourceDocuments)
    .where(
      and(
        eq(etlSourceDocuments.sourceSystem, input.sourceSystem),
        eq(etlSourceDocuments.docPath, input.docPath),
        eq(etlSourceDocuments.contentHash, contentHash),
      ),
    )
    .limit(1);

  if (!existing) {
    // Same "unreachable in practice" shape as journal.ts's insertDraftEntry: a DO
    // NOTHING conflict means a row satisfying the unique index already exists.
    throw new Error(
      `landDocument: conflict landing ${input.docPath} but no existing identical row found`,
    );
  }
  return { id: existing.id, inserted: false };
}

function rowToLanded(row: typeof etlSourceDocuments.$inferSelect): LandedSourceDocumentRow {
  return {
    id: row.id,
    runId: row.runId,
    sourceSystem: row.sourceSystem,
    collectionPath: row.collectionPath,
    docPath: row.docPath,
    docId: row.docId,
    storeCode: row.storeCode,
    payload: row.payload as Record<string, unknown>,
    contentHash: row.contentHash,
    capturedAt: row.capturedAt,
  };
}

/**
 * The CURRENT version of every landed document for this source system — "current" =
 * greatest captured_at per doc_path (Contract §2), computed by `selectDistinctOn`, never
 * a maintained flag (bible §4.2 rule 7). This is what `analyze`/`load` mode iterates —
 * never the SourceReader (Contract §6's "analyze must run offline").
 */
export async function findCurrentDocuments(
  tx: Tx,
  sourceSystem: string,
): Promise<LandedSourceDocumentRow[]> {
  const rows = await tx
    .selectDistinctOn([etlSourceDocuments.docPath])
    .from(etlSourceDocuments)
    .where(eq(etlSourceDocuments.sourceSystem, sourceSystem))
    .orderBy(etlSourceDocuments.docPath, desc(etlSourceDocuments.capturedAt));
  return rows.map(rowToLanded);
}

/** The current version of exactly one document, if it has ever been landed. */
export async function findCurrentDocument(
  tx: Tx,
  sourceSystem: string,
  docPath: string,
): Promise<LandedSourceDocumentRow | undefined> {
  const [row] = await tx
    .select()
    .from(etlSourceDocuments)
    .where(
      and(eq(etlSourceDocuments.sourceSystem, sourceSystem), eq(etlSourceDocuments.docPath, docPath)),
    )
    .orderBy(desc(etlSourceDocuments.capturedAt))
    .limit(1);
  return row ? rowToLanded(row) : undefined;
}

// -----------------------------------------------------------------------------------------
// etl_quarantine (Contract §4) — re-drivable, reason-coded.
// -----------------------------------------------------------------------------------------

export interface QuarantineDocumentInput {
  runId: string;
  sourceSystem: string;
  docPath: string;
  sourceType: string;
  caseClass: string | null;
  reasonCode: string;
  reasonDetail: string;
}

/**
 * `ON CONFLICT (source_system, doc_path, reason_code) WHERE resolved_at IS NULL DO
 * UPDATE SET last_seen_at = now()` — a still-unconvertible document for the SAME reason
 * advances the existing open row (invariant 13) rather than inserting a duplicate.
 * A genuinely NEW row is inserted when there is no open row for this (doc, reason) pair
 * yet — either the very first time, or after a previous occurrence of this exact reason
 * was resolved (Contract §4's partial unique index only excludes resolved rows, so the
 * SAME reason can legitimately recur and quarantine again across a document's history).
 */
export async function quarantineDocument(
  tx: Tx,
  input: QuarantineDocumentInput,
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(etlQuarantine)
    .values({
      runId: input.runId,
      sourceSystem: input.sourceSystem,
      docPath: input.docPath,
      sourceType: input.sourceType,
      caseClass: input.caseClass,
      reasonCode: input.reasonCode,
      reasonDetail: input.reasonDetail,
    })
    .onConflictDoUpdate({
      target: [etlQuarantine.sourceSystem, etlQuarantine.docPath, etlQuarantine.reasonCode],
      targetWhere: isNull(etlQuarantine.resolvedAt),
      set: { lastSeenAt: sql`now()` },
    })
    .returning({ id: etlQuarantine.id });

  return { id: row!.id };
}

/**
 * Resolves every OPEN quarantine row for this document — called when a document that
 * was previously unconvertible (for any reason) converts cleanly (invariant 12). Never
 * deletes a row; the resolved history is the migration's progress metric (Contract §4).
 * A no-op (0 rows touched) when the document was never quarantined, which is the common
 * case and not an error.
 */
export async function resolveQuarantineForDocument(
  tx: Tx,
  input: { sourceSystem: string; docPath: string; resolvedRunId: string },
): Promise<number> {
  const updated = await tx
    .update(etlQuarantine)
    .set({ resolvedAt: sql`now()`, resolvedRunId: input.resolvedRunId })
    .where(
      and(
        eq(etlQuarantine.sourceSystem, input.sourceSystem),
        eq(etlQuarantine.docPath, input.docPath),
        isNull(etlQuarantine.resolvedAt),
      ),
    )
    .returning({ id: etlQuarantine.id });
  return updated.length;
}

// -----------------------------------------------------------------------------------------
// etl_reconciliation (Contract §5) — one row per (run, source_type).
// -----------------------------------------------------------------------------------------

export interface WriteReconciliationInput {
  runId: string;
  sourceType: string;
  sourceCount: number;
  landedCount: number;
  convertedCount: number | null;
  skippedCount: number | null;
  quarantinedCount: number | null;
  entriesPosted: number;
  sourceAmountTotal: string | null;
  debitTotal: string | null;
  creditTotal: string | null;
}

/**
 * Writes ONE reconciliation row. Always a plain INSERT, never an update — a run's
 * reconciliation is computed once, for that run, and "re-running analyze... never
 * mutates a prior run's rows" (Contract §7) means there is never a legitimate reason to
 * revise a row after writing it. The UNIQUE(run_id, source_type) index
 * (schema/etl.ts) is the backstop if a caller ever calls this twice for the same pair.
 */
export async function writeReconciliation(
  tx: Tx,
  input: WriteReconciliationInput,
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(etlReconciliation)
    .values({
      runId: input.runId,
      sourceType: input.sourceType,
      sourceCount: input.sourceCount,
      landedCount: input.landedCount,
      convertedCount: input.convertedCount,
      skippedCount: input.skippedCount,
      quarantinedCount: input.quarantinedCount,
      entriesPosted: input.entriesPosted,
      sourceAmountTotal: input.sourceAmountTotal,
      debitTotal: input.debitTotal,
      creditTotal: input.creditTotal,
    })
    .returning({ id: etlReconciliation.id });
  return { id: row!.id };
}
