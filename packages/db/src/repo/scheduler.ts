/**
 * The only place SQL is written for scheduler runs. T-140.
 *
 * ⚠️ **Every write here runs as the `system` principal**, outside RLS, because the scheduler serves
 * no org's request — it serves all of them in turn. That is exactly what ADR-008's system principal
 * is for, and exactly why it must never be reachable from a request handler. The READ path
 * (`recentRuns`, `lastRunFor`) is org-scoped and safe for a screen.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { organizations } from '../../schema/organizations';
import {
  schedulerRuns,
  type SchedulerFailure,
  type SchedulerJob,
} from '../../schema/scheduler';

export interface OrgToRun {
  id: string;
  name: string;
}

/** Every org the month-end run should visit, or just one when narrowing. */
export async function listOrgsToRun(tx: Tx, orgId?: string): Promise<OrgToRun[]> {
  const rows = await tx
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(orgId ? eq(organizations.id, orgId) : undefined)
    .orderBy(organizations.name);
  return rows;
}

export interface StartRunInput {
  orgId: string;
  job: SchedulerJob;
  period: string;
  trigger: 'cron' | 'manual';
  /** T-396: the run's own clock when the caller injects one (the POS day import is driven by `now`); absent = the database's. */
  startedAt?: Date;
}

/**
 * Opens a run row BEFORE the work starts.
 *
 * ⭐ Written first on purpose. If the process is killed mid-run, the row survives with
 * `finished_at` still null — which reads as *"started and never finished"*, the one outcome a
 * row written at the END could never record.
 */
export async function startRun(tx: Tx, input: StartRunInput): Promise<string> {
  const [row] = await tx.insert(schedulerRuns).values(input).returning({ id: schedulerRuns.id });
  return row!.id;
}

export async function finishRun(
  tx: Tx,
  runId: string,
  result: { postedCount: number; skippedCount: number; failures: SchedulerFailure[] },
): Promise<void> {
  // Notices (`kind: 'notice'`) are stored with the failures but are not failures: they neither count nor
  // change the outcome.
  const failedCount = result.failures.filter((f) => f.kind !== 'notice').length;
  // ⚠️ The outcome is DERIVED from the counts, never passed in — the CHECK constraint refuses a
  // row whose outcome and failure count disagree, and deriving it here means they cannot.
  const outcome =
    failedCount === 0 ? 'ok' : result.postedCount > 0 ? 'partial' : 'failed';

  await tx
    .update(schedulerRuns)
    .set({
      finishedAt: sql`now()`,
      postedCount: result.postedCount,
      skippedCount: result.skippedCount,
      failedCount,
      failures: result.failures.length > 0 ? result.failures : null,
      outcome,
    })
    .where(eq(schedulerRuns.id, runId));
}

/** The job blew up before it could enumerate anything — not one subject failing, the whole job. */
export async function failRun(tx: Tx, runId: string, error: string): Promise<void> {
  await tx
    .update(schedulerRuns)
    .set({ finishedAt: sql`now()`, outcome: 'failed', error })
    .where(eq(schedulerRuns.id, runId));
}

export interface SchedulerRunRow {
  id: string;
  job: SchedulerJob;
  period: string;
  startedAt: Date;
  finishedAt: Date | null;
  postedCount: number;
  skippedCount: number;
  failedCount: number;
  failures: SchedulerFailure[] | null;
  outcome: 'ok' | 'partial' | 'failed';
  error: string | null;
  trigger: string;
}

const COLUMNS = {
  id: schedulerRuns.id,
  job: schedulerRuns.job,
  period: schedulerRuns.period,
  startedAt: schedulerRuns.startedAt,
  finishedAt: schedulerRuns.finishedAt,
  postedCount: schedulerRuns.postedCount,
  skippedCount: schedulerRuns.skippedCount,
  failedCount: schedulerRuns.failedCount,
  failures: schedulerRuns.failures,
  outcome: schedulerRuns.outcome,
  error: schedulerRuns.error,
  trigger: schedulerRuns.trigger,
} as const;

export async function recentRuns(
  tx: Tx,
  orgId: string,
  limit = 20,
): Promise<SchedulerRunRow[]> {
  const rows = await tx
    .select(COLUMNS)
    .from(schedulerRuns)
    .where(eq(schedulerRuns.orgId, orgId))
    .orderBy(desc(schedulerRuns.startedAt))
    .limit(limit);
  return rows as SchedulerRunRow[];
}

/**
 * ⭐ The most recent run of one job — the answer to *"is anybody keeping these books?"*
 *
 * This single row is what would have caught DEF-044 on day one: not the postings (a stopped
 * scheduler makes none, and none looks identical to nothing-to-do) but the **date of the last
 * attempt**.
 */
export async function lastRunFor(
  tx: Tx,
  orgId: string,
  job: SchedulerJob,
): Promise<SchedulerRunRow | undefined> {
  const [row] = await tx
    .select(COLUMNS)
    .from(schedulerRuns)
    .where(and(eq(schedulerRuns.orgId, orgId), eq(schedulerRuns.job, job)))
    .orderBy(desc(schedulerRuns.startedAt))
    .limit(1);
  return row as SchedulerRunRow | undefined;
}

/**
 * T-472: the most recent run of one job that ended `ok` (a failed or partial run said nothing reliable). The bridge asks it
 * where its change-time queries should start.
 */
export async function lastOkRunFor(tx: Tx, orgId: string, job: SchedulerJob): Promise<SchedulerRunRow | undefined> {
  const [row] = await tx
    .select(COLUMNS)
    .from(schedulerRuns)
    .where(and(eq(schedulerRuns.orgId, orgId), eq(schedulerRuns.job, job), eq(schedulerRuns.outcome, 'ok'), sql`${schedulerRuns.finishedAt} is not null`))
    .orderBy(desc(schedulerRuns.startedAt))
    .limit(1);
  return row as SchedulerRunRow | undefined;
}

/** Runs that started and never reported back — a killed process, and invisible without this. */
export async function unfinishedRuns(tx: Tx, orgId: string): Promise<SchedulerRunRow[]> {
  const rows = await tx
    .select(COLUMNS)
    .from(schedulerRuns)
    .where(and(eq(schedulerRuns.orgId, orgId), isNull(schedulerRuns.finishedAt)))
    .orderBy(desc(schedulerRuns.startedAt));
  return rows as SchedulerRunRow[];
}
