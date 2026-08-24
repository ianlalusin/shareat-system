/**
 * plan.ts — the count-first capture plan. docs/tasks/114a-firestore-reader-and-capture.md
 * Contract §3.
 *
 * A plan is a list of `(storeCode, collectionPath)` targets, built ahead of any network call
 * (`planCapture` — pure, no I/O, invariant 7). Running it always counts first
 * (`countTargets`, one `count()` aggregation per target) and reads documents ONLY when the
 * caller explicitly opts in (`runFetch`, via `runPlan({ fetch: true })`) — there is no path
 * through this file that reads a document without that explicit opt-in (invariants 8/9).
 */
import { runCaptureMode, type RunCaptureResult } from '@shareat/etl/run';

import { FirestoreSourceReader, type FirestoreClientLike } from './reader';

export class PlanError extends Error {}

export interface CaptureTarget {
  readonly storeCode: string;
  readonly collectionPath: string;
}

export interface CapturePlan {
  readonly targets: readonly CaptureTarget[];
}

export interface PlanCaptureParams {
  storeCodes: readonly string[];
  collections: readonly string[];
}

/**
 * Builds the target list. Rejects a plan with no targets, NAMING the problem (invariant 7) —
 * "no store named" and "no collection named" are distinguished because they call for
 * different fixes, and `--store all` is deliberately unsupported here (Contract §4): naming
 * every store is the caller's job, not a default this function could quietly supply.
 */
export function planCapture(params: PlanCaptureParams): CapturePlan {
  const storeCodes = params.storeCodes ?? [];
  const collections = params.collections ?? [];

  if (storeCodes.length === 0 && collections.length === 0) {
    throw new PlanError(
      'planCapture: no stores and no collections named — a plan must name at least one of each explicitly',
    );
  }
  if (storeCodes.length === 0) {
    throw new PlanError('planCapture: no store named — name at least one store explicitly (--store all is not supported)');
  }
  if (storeCodes.includes('all')) {
    throw new PlanError('planCapture: "--store all" is not implemented — name stores explicitly (Contract §4)');
  }
  if (collections.length === 0) {
    throw new PlanError('planCapture: no collection named — name at least one collection explicitly, e.g. --collection journal');
  }

  const targets: CaptureTarget[] = [];
  for (const storeCode of storeCodes) {
    for (const collection of collections) {
      targets.push({ storeCode, collectionPath: `stores/${storeCode}/${collection}` });
    }
  }
  return { targets };
}

export interface TargetCount extends CaptureTarget {
  readonly count: number;
}

/**
 * Count phase. One `count()` aggregation per target, zero document reads (invariant 8) —
 * this function never calls `.get()` on anything but the aggregate query.
 */
export async function countTargets(
  plan: CapturePlan,
  firestore: FirestoreClientLike,
): Promise<TargetCount[]> {
  const results: TargetCount[] = [];
  for (const target of plan.targets) {
    const snapshot = await firestore.collection(target.collectionPath).count().get();
    results.push({ ...target, count: snapshot.data().count });
  }
  return results;
}

/** A plain-text table: target, document count, and the total (Contract §3.1). */
export function formatCountTable(counts: readonly TargetCount[]): string {
  const targetWidth = Math.max(6, ...counts.map((c) => c.collectionPath.length)) + 2;
  const lines = ['target'.padEnd(targetWidth) + 'documents'];
  let total = 0;
  for (const c of counts) {
    lines.push(c.collectionPath.padEnd(targetWidth) + String(c.count));
    total += c.count;
  }
  lines.push('-'.repeat(targetWidth + 9));
  lines.push('TOTAL'.padEnd(targetWidth) + String(total));
  return lines.join('\n');
}

export interface RunFetchOptions {
  limitPerCollection?: number;
  pageSize?: number;
  startedBy?: string | null;
  notes?: string | null;
}

/**
 * Fetch phase. Streams through `runCaptureMode` (T-112, `@shareat/etl/run`), which lands
 * everything append-only and content-hashed into Postgres — so this function, and everything
 * that calls it, needs a real database and cannot be exercised by a pure unit test. Proven by
 * `tests/integration/capture.test.ts` (invariant 14), never by `tests/plan.test.ts`.
 */
export async function runFetch(
  plan: CapturePlan,
  firestore: FirestoreClientLike,
  sourceSystem: string,
  options: RunFetchOptions = {},
): Promise<RunCaptureResult> {
  const reader = new FirestoreSourceReader({
    credential: firestore,
    sourceSystem,
    collections: plan.targets.map((t) => t.collectionPath),
    pageSize: options.pageSize,
    limitPerCollection: options.limitPerCollection,
  });
  return runCaptureMode({ sourceSystem, reader, startedBy: options.startedBy, notes: options.notes });
}

export interface RunPlanOptions extends RunFetchOptions {
  /** `--fetch`. `false` (the default posture) means: count, print, stop (Contract §3.1). */
  fetch: boolean;
}

export interface RunPlanResult {
  counts: readonly TargetCount[];
  fetched: boolean;
  captureResult?: RunCaptureResult;
}

/**
 * The single entry point the CLI drives. ALWAYS counts. Reads documents ONLY when
 * `options.fetch` is `true` (invariant 9) — the `false` branch returns before constructing a
 * reader or touching `runFetch`/`runCaptureMode` at all, which is what makes it provable
 * without a database (`tests/plan.test.ts`); the `true` branch is invariant 14's job.
 */
export async function runPlan(
  plan: CapturePlan,
  firestore: FirestoreClientLike,
  sourceSystem: string,
  options: RunPlanOptions,
): Promise<RunPlanResult> {
  const counts = await countTargets(plan, firestore);
  if (!options.fetch) {
    return { counts, fetched: false };
  }
  const captureResult = await runFetch(plan, firestore, sourceSystem, options);
  return { counts, fetched: true, captureResult };
}
