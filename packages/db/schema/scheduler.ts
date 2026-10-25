/**
 * What the scheduler did, and — the point of the table — what it FAILED to do. T-140, DEF-044.
 *
 * ## ⭐ This is the one place a figure is stored rather than derived, and that is deliberate
 *
 * Everywhere else in this project a number is read from the ledger because a stored copy drifts.
 * Here the rule genuinely does not apply, and the reason is worth stating so this does not read as
 * a lapse:
 *
 * | | Derivable from the ledger? |
 * |---|---|
 * | A month that POSTED | ✅ the entry is right there |
 * | A month that FAILED | ⛔ **no — a failure leaves no trace by construction** |
 * | A run that never happened | ⛔ **no, and this is DEF-044 exactly** |
 *
 * v1's depreciation stopped for two months, ₱35,483.98 a month went unbooked, and it was found by
 * an **audit** rather than by anybody noticing — because the only evidence of a run was the
 * postings it made, and a run that makes no postings is indistinguishable from one that never
 * ran. **That distinction is what this table exists to record.**
 *
 * ⛔ **Do not add a `balance`, a running total, or anything the ledger already knows.** This table
 * records the RUN, never the money.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

/**
 * The jobs the scheduler performs. One row per job per org per run.
 *
 * `mirror_publish`/`inbox_relay` — T-204, the Firestore sync relay (closes DEF-132/DEF-134).
 * `order_wastage_backstop` — T-178, the 15-day auto-charge/absorb backstop for tracked order
 * wastages. ⚠️ SHARED with the T-140 pattern: adding a job here also needs migration 0126's
 * `scheduler_runs_job_check` widened to match — see that migration's own comment on the risk of a
 * second lane widening the same constraint independently.
 */
export const SCHEDULER_JOBS = [
  'depreciation',
  'amortisation',
  'attendance_sweep',
  'mirror_publish',
  'inbox_relay',
  'order_wastage_backstop',
  /**
   * `finding_observation` — T-214, DAILY. Records that a detector reported a key on a day, which is
   * the clock a `DetectedFinding` cannot carry (see `findings.ts`'s `findingOccurrences`).
   *
   * ⛔ Named here because a writer with no caller is DEF-186 exactly: `replenishAfterUsage` was
   * built, tested, marked done, and invoked by nothing for weeks. ⚠️ And merging is not the finish
   * line — `docs/ops/README.md` says installing and ARMING the timer is, because v1's seed data
   * claimed a depreciation cron that never existed (DEF-044).
   */
  'finding_observation',
  /**
   * `budget_reissue` — T-215, DAILY. Rolls an expense envelope forward on its own schedule so
   * nobody has to remember to recreate it.
   *
   * ⚠️ Two interval families and only one of them creates a row: a RESET interval (daily,
   * weekly, bi-weekly) moves the same budget's window, and a PERIOD interval (monthly, quarterly,
   * annually) inserts the NEXT period's row — and only once that period has arrived. v1's own
   * comment gives the reason and it is ported verbatim: *"never pre-create future months, so the
   * reissue processor can't run away."*
   */
  'budget_reissue',
  /**
   * `recurring_expenses` — T-216 Part 2, DAILY. Drafts the fixed bills that are due, so a branch
   * that forgets rent does not pay it late and off-book.
   *
   * ⛔ **It drafts; it never pays.** Ian, 6-7 Sep 2026, against v1's auto-pay: the job records a
   * PENDING supplier invoice and a DRAFT expense and stops. Nothing reaches the ledger until a
   * person has read the real bill, attached it, verified the invoice and approved the expense.
   * Three of the five hardening rounds v1 needed exist only because a machine could move money
   * unattended.
   *
   * ⚠️ It acts as the TEMPLATE'S CREATOR through the ordinary `recordInvoice`/`createExpense`
   * gates, not as a system principal — so the automation can never do what the person who set it
   * up could not.
   */
  'recurring_expenses',
  /**
   * `orphan_file_sweep` — T-272, DAILY. Sweeps `stored_files` rows nothing has claimed, scoped per
   * org (DEF-299). ⛔ Was global and cross-org by design (DEF-287) until T-272's scope correction
   * found `scheduler_runs.org_id NOT NULL` cannot represent a global run at all — see
   * `docs/tasks/272-def-299-orphan-sweep-timer.md`.
   */
  'orphan_file_sweep',
  /**
   * `fiscal_period_seed` — T-276/DEF-305, MONTHLY, 1st. Tops up a running org's fiscal-period
   * coverage 12 months ahead, and — option (c) — backfills any month that ELAPSED with no period
   * at all (created `open`, never closed retroactively) so `postEntry` never again refuses a fresh
   * org's first entry the way DEF-305's bootstrap gap did. `docs/tasks/276-def-305-fiscal-period-
   * coverage.md`'s "Build slice" §1 is the exact gap-threshold rule.
   */
  'fiscal_period_seed',
  /**
   * `usage_auto_post` - T-401 S6 audit ruling A1, DAILY 14:05 Manila. Posts the POS-pull usage drafts nobody posted by their deadline
   * (`stock/usage-auto-post.ts`). A draft it cannot post is a failure line, so the run is `partial` and the script exits non-zero.
   */
  'usage_auto_post',
  /**
   * `pos_day_import` - T-396, DAILY 06:00 Manila. Drafts yesterday's sales day (and any missed day in the 7-day window)
   * for every store linked to POS v1, as an `open` draft: it never submits, verifies or posts. A refusal is a failure
   * line; a day POS has no sales for is a notice. Needs migration 0209's widening of `scheduler_runs_job_check`.
   */
  'pos_day_import',
  /**
   * `pos_receipt_bridge` - T-472, DAILY 06:30 Manila. Copies yesterday's POS receipts (and any changed since the last run) into
   * `pos_bridge_*`, read-only on Firebase; posts nothing. Needs migration 0216's widening of `scheduler_runs_job_check`.
   * Its job function, run-recording PINNED row and docs/ops unit pair land in S2/S3.
   */
  'pos_receipt_bridge',
] as const;
export type SchedulerJob = (typeof SCHEDULER_JOBS)[number];

export const SCHEDULER_OUTCOMES = ['ok', 'partial', 'failed'] as const;
export type SchedulerOutcome = (typeof SCHEDULER_OUTCOMES)[number];

/**
 * One failure, kept verbatim so the reason survives to the screen.
 *
 * ⚠️ The jsonb column is named `failures` for history, and NOTICES ride along in it: an entry with
 * `kind: 'notice'` is something a run wants said that is NOT a failure (T-368: owed months skipped
 * because their fiscal period is closed). A notice is never counted in `failed_count`, never makes the
 * outcome `partial`/`failed`, and is shown as a plain line, never as a failure. Anything that counts or
 * lists failures must filter on `kind !== 'notice'`.
 */
export interface SchedulerFailure {
  /** The asset or prepaid item that failed. */
  subjectId: string;
  subjectName: string;
  reason: string;
  /** Absent = a failure. `'notice'` = said, not failed. */
  kind?: 'notice';
}

export const schedulerRuns = pgTable(
  'scheduler_runs',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    job: text('job', { enum: SCHEDULER_JOBS }).notNull(),
    /** The period run THROUGH, as `YYYY-MM`. */
    period: text('period').notNull(),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),

    postedCount: integer('posted_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),

    /**
     * ⚠️ The reasons, verbatim. The most likely one is mundane and WILL happen — *"no fiscal
     * period covers 2026-06-30"* — and it has to arrive as a visible line item rather than an
     * exception in a log nobody reads.
     */
    failures: jsonb('failures').$type<SchedulerFailure[]>(),

    outcome: text('outcome', { enum: SCHEDULER_OUTCOMES }).notNull().default('ok'),
    /** Set when the whole job blew up before it could even enumerate its subjects. */
    error: text('error'),

    /** ⭐ `cron` or `manual` — because "nobody has run it since March" and "the cron died in
     *  March and someone has been clicking the button" are different problems. */
    trigger: text('trigger').notNull().default('cron'),
  },
  (t) => [
    index('scheduler_runs_org_job_started_idx').on(t.orgId, t.job, t.startedAt),
    index('scheduler_runs_outcome_idx').on(t.outcome),

    check(
      'scheduler_runs_job_check',
      // ⛔ DEF-217: this list read seven names while `SCHEDULER_JOBS` above held nine, because
      // `budget_reissue` (0131) was added to the live constraint and never here. Inert — migrations
      // build the database and this file does not — but the NEXT widening migration is written by
      // copying this list, and copying the short one would silently drop a job from the constraint
      // and break it at its next run. Both are corrected together in 0136; keep them together.
      sql`${t.job} in ('depreciation', 'amortisation', 'attendance_sweep', 'mirror_publish', 'inbox_relay', 'order_wastage_backstop', 'finding_observation', 'budget_reissue', 'recurring_expenses', 'orphan_file_sweep', 'fiscal_period_seed', 'usage_auto_post', 'pos_day_import', 'pos_receipt_bridge')`,
    ),
    check('scheduler_runs_outcome_check', sql`${t.outcome} in ('ok', 'partial', 'failed')`),
    check('scheduler_runs_period_shape_check', sql`${t.period} ~ '^[0-9]{4}-[0-9]{2}$'`),
    check(
      'scheduler_runs_counts_not_negative_check',
      sql`${t.postedCount} >= 0 and ${t.skippedCount} >= 0 and ${t.failedCount} >= 0`,
    ),
    /** ⚠️ An outcome and its failure count cannot disagree — `ok` with failures, or `failed` with
     *  none, would make the screen lie about the only thing this table exists to report. */
    check(
      'scheduler_runs_outcome_matches_failures_check',
      sql`(${t.outcome} = 'ok' and ${t.failedCount} = 0)
          or (${t.outcome} = 'partial' and ${t.failedCount} > 0 and ${t.postedCount} > 0)
          or (${t.outcome} = 'failed')`,
    ),
  ],
);
