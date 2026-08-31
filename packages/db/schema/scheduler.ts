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

/** The jobs the month-end run performs. One row per job per org per run. */
export const SCHEDULER_JOBS = ['depreciation', 'amortisation', 'attendance_sweep'] as const;
export type SchedulerJob = (typeof SCHEDULER_JOBS)[number];

export const SCHEDULER_OUTCOMES = ['ok', 'partial', 'failed'] as const;
export type SchedulerOutcome = (typeof SCHEDULER_OUTCOMES)[number];

/** One failure, kept verbatim so the reason survives to the screen. */
export interface SchedulerFailure {
  /** The asset or prepaid item that failed. */
  subjectId: string;
  subjectName: string;
  reason: string;
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

    check('scheduler_runs_job_check', sql`${t.job} in ('depreciation', 'amortisation', 'attendance_sweep')`),
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
