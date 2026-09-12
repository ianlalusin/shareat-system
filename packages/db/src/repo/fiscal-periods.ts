/**
 * The only place SQL is written for `fiscal_periods`. T-264 / DEF-284 slice 1.
 *
 * ⛔ **Until this file existed, nothing in the codebase had ever created a fiscal period outside a
 * test or `dev-seed-inventory.ts`'s single hand-rolled row.** The wall `postEntry` and the
 * `journal_entries_period_open` trigger enforce was built and never raised: a freshly bootstrapped
 * production organisation could not post a single journal entry. See `docs/tasks/264-*.md`'s
 * "severity correction" for the full trace.
 */
import { and, desc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { deliveries, expenses, fiscalPeriods, periodOverrides, type PeriodOverrideReason } from '../../schema';

/**
 * `[starts_on, ends_on]` for one calendar month, both `YYYY-MM-DD`, both inclusive.
 *
 * ⚠️ `endsOn` is day 0 of the FOLLOWING month, not the following month's 1st. The table's
 * no-overlap constraint is `EXCLUDE USING gist (org_id WITH =, daterange(starts_on, ends_on, '[]')
 * WITH &&)` — inclusive at BOTH ends — so an `endsOn` one day too late (the next month's 1st,
 * instead of this month's last day) would make two adjacent months share a day and be refused by
 * the database. This is the same day-0 idiom `scheduler/index.ts`'s `endOfPeriod` uses, written
 * locally rather than imported so this task touches nothing in that file.
 */
function monthBounds(year: number, month1based: number): { startsOn: string; endsOn: string } {
  const startsOn = `${year}-${String(month1based).padStart(2, '0')}-01`;
  const endsOn = new Date(Date.UTC(year, month1based, 0)).toISOString().slice(0, 10);
  return { startsOn, endsOn };
}

export interface SeedCalendarMonthsInput {
  /** 1-based. `startMonth: 13` is not normalised — pass a value in 1..12. */
  startYear: number;
  startMonth: number;
  /** How many consecutive calendar months to seed, starting at `startYear`-`startMonth`. */
  months: number;
}

export interface SeedCalendarMonthsResult {
  /** Only the months actually inserted — a month already covered by an existing period (any
   *  status) is silently skipped and not counted here. */
  periodsInserted: number;
  /**
   * ⛔ **Report this. Do not let a caller infer "success" from silence.** A bare `ON CONFLICT DO
   * NOTHING` against an EXCLUDE constraint swallows a PARTIAL overlap exactly like an exact
   * duplicate — an org already covered by one wide legacy period (several test fixtures carry
   * `2020-01-01 .. 2035-12-31`) makes every one of the 12 candidate months conflict, so
   * `periodsInserted` is 0 and nothing failed. That is indistinguishable from "already fully
   * seeded, nothing to do" unless this number is surfaced too — DEF-044's shape, a fix-up that
   * no-ops silently and reports success.
   */
  periodsSkipped: number;
}

/**
 * Seeds `months` consecutive calendar-month periods for one org, all `open`, starting at
 * `startYear`-`startMonth`.
 *
 * ⭐ **Idempotent by the table's own EXCLUDE constraint**, not by a pre-read. Each month is
 * inserted with a bare `ON CONFLICT DO NOTHING` — no target list. ⚠️ This is deliberately NOT the
 * `.onConflictDoNothing({ target: [...] })` form every other repo file in this codebase uses:
 * those target real unique indexes, and this table has none covering `(org_id, starts_on,
 * ends_on)` — the no-overlap rule is an EXCLUDE constraint, not a unique one. A bare `ON CONFLICT
 * DO NOTHING` catches an exclusion-constraint violation the same way it catches a unique one
 * (Postgres, since 9.5); `dev-seed-inventory.ts:132` already relies on exactly this against this
 * exact constraint. So a second run — bootstrap re-run, a repeated backfill — inserts only what is
 * still missing and never throws.
 *
 * ⚠️ **Calls this once per candidate month, not one bulk insert.** `ON CONFLICT DO NOTHING` does
 * not resolve conflicts BETWEEN ROWS WITHIN THE SAME multi-row `INSERT` for an exclusion
 * constraint — a genuine Postgres behaviour, not version-dependent flakiness. Our twelve months
 * are disjoint by construction, so a bulk insert would not actually collide with itself here; one
 * statement per month is simply the easier thing to reason about, at the cost of `months` round
 * trips — an acceptable trade at "12 rows once per org."
 */
export async function seedCalendarMonths(
  tx: Tx,
  orgId: string,
  input: SeedCalendarMonthsInput,
): Promise<SeedCalendarMonthsResult> {
  let year = input.startYear;
  let month = input.startMonth;
  let periodsInserted = 0;

  for (let i = 0; i < input.months; i++) {
    const { startsOn, endsOn } = monthBounds(year, month);
    const rows = await tx
      .insert(fiscalPeriods)
      .values({ orgId, startsOn, endsOn, status: 'open' })
      .onConflictDoNothing()
      .returning({ id: fiscalPeriods.id });
    if (rows.length > 0) periodsInserted += 1;

    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return { periodsInserted, periodsSkipped: input.months - periodsInserted };
}

/**
 * The furthest `ends_on` this org's periods currently reach, or `null` if it has none at all.
 *
 * ⭐ The number that answers "is this org actually fine now?" after a seed or backfill — which
 * `periodsInserted`/`periodsSkipped` alone cannot, precisely because a full skip and a full seed
 * can both report "0 inserted, healthy" for different reasons. Read this AFTER seeding, not
 * before, so it reflects what is actually in the table rather than what the call intended.
 */
export async function latestPeriodEnd(tx: Tx, orgId: string): Promise<string | null> {
  const [row] = await tx
    .select({ endsOn: fiscalPeriods.endsOn })
    .from(fiscalPeriods)
    .where(eq(fiscalPeriods.orgId, orgId))
    .orderBy(desc(fiscalPeriods.endsOn))
    .limit(1);
  return row?.endsOn ?? null;
}

/** T-264 / DEF-284 slice 2 — `'YYYY-MM'`, the string every caller (`listFindings`,
 *  `closeReadiness`, `/findings`) already uses, to this table's own `[starts_on, ends_on]`. */
function periodBounds(period: string): { startsOn: string; endsOn: string } {
  const [yStr, mStr] = period.split('-');
  return monthBounds(Number(yStr), Number(mStr));
}

/**
 * Flips `status` `open` -> `closed` and stamps `closed_at`/`closed_by`, all in ONE statement.
 *
 * ⭐ **Deliberately an UPDATE ... WHERE status = 'open' ... RETURNING, never a read then a
 * write.** Two admins pressing close on the same period a moment apart must not both succeed with
 * different `closed_by` — the `status = 'open'` in the WHERE clause is what makes the second
 * writer's UPDATE match zero rows instead of racing the first. `null` back means "did not close":
 * the period does not exist, or was not `open` (already closed/locked) — the caller decides which.
 */
export async function closePeriod(
  tx: Tx,
  orgId: string,
  period: string,
  closedBy: string,
): Promise<{ periodId: string; closedAt: Date } | null> {
  const { startsOn, endsOn } = periodBounds(period);
  const [row] = await tx
    .update(fiscalPeriods)
    .set({ status: 'closed', closedAt: sql`now()`, closedBy, updatedAt: sql`now()` })
    .where(
      and(
        eq(fiscalPeriods.orgId, orgId),
        eq(fiscalPeriods.startsOn, startsOn),
        eq(fiscalPeriods.endsOn, endsOn),
        eq(fiscalPeriods.status, 'open'),
      ),
    )
    .returning({ id: fiscalPeriods.id, closedAt: fiscalPeriods.closedAt });
  return row ? { periodId: row.id, closedAt: row.closedAt! } : null;
}

/**
 * Whether any period STARTING BEFORE this one is still `open`, for this org.
 *
 * ⭐ ADR-006 §7.4 / the Gates table: periods close in order — December before the January-15th
 * year close, and no month before the one before it. This is an ORDERING rule on the close
 * operation itself, not a standing health signal, so it is a gate here, never a `listFindings`
 * detector (there is nothing to show on a daily screen; it only means anything at the moment
 * someone tries to close a specific period).
 */
export async function hasEarlierOpenPeriod(tx: Tx, orgId: string, period: string): Promise<boolean> {
  const { startsOn } = periodBounds(period);
  const [row] = await tx
    .select({ id: fiscalPeriods.id })
    .from(fiscalPeriods)
    .where(and(eq(fiscalPeriods.orgId, orgId), lt(fiscalPeriods.startsOn, startsOn), eq(fiscalPeriods.status, 'open')))
    .limit(1);
  return row !== undefined;
}

export interface UnpostedDraft {
  readonly kind: 'expense' | 'delivery';
  readonly id: string;
  readonly dateOn: string;
}

/**
 * Every `expenses` or `deliveries` row still `draft`, dated inside this period.
 *
 * ⭐ **Exactly these two tables, not the other eleven with a `'draft'` status in this codebase** —
 * ADR-006 §8.2 names only these two in concrete terms (Ian: *"cashier can't create expense
 * receipt... for receipts, reject new entries, and expenses too"*). `sales_days` was considered and
 * rejected: its statuses are `open | submitted | verified | voided` — no `draft` — and `open` means
 * "today is still happening", not "someone left work unfinished"; gating on it would refuse to
 * close a period whenever a sales day was legitimately still in progress.
 *
 * ⚠️ `journal_entries.status = 'draft'` is deliberately NOT checked here, even though ADR-006's
 * Gates table says "no draft entries dated in the period" with no table named. Confirmed against
 * `repo/journal.ts`: a journal entry is `draft` only WITHIN the transaction that creates it —
 * `postEntry` either flips it to `posted` or the whole transaction rolls back, so a committed
 * `journal_entries` row is never observed at rest as `draft`. A gate against it would be a check
 * that can never fire — worse than no gate, because it would sit in the close checklist looking
 * verified. See the task report for this written up as a finding against ADR-006 itself.
 */
export async function unpostedDraftsInPeriod(tx: Tx, orgId: string, period: string): Promise<UnpostedDraft[]> {
  const { startsOn, endsOn } = periodBounds(period);
  const draftExpenses = await tx
    .select({ id: expenses.id, dateOn: expenses.businessDate })
    .from(expenses)
    .where(
      and(
        eq(expenses.orgId, orgId),
        eq(expenses.status, 'draft'),
        gte(expenses.businessDate, startsOn),
        lte(expenses.businessDate, endsOn),
      ),
    );
  const draftDeliveries = await tx
    .select({ id: deliveries.id, dateOn: deliveries.deliveredOn })
    .from(deliveries)
    .where(
      and(
        eq(deliveries.orgId, orgId),
        eq(deliveries.status, 'draft'),
        gte(deliveries.deliveredOn, startsOn),
        lte(deliveries.deliveredOn, endsOn),
      ),
    );
  return [
    ...draftExpenses.map((e) => ({ kind: 'expense' as const, id: e.id, dateOn: e.dateOn })),
    ...draftDeliveries.map((d) => ({ kind: 'delivery' as const, id: d.id, dateOn: d.dateOn })),
  ];
}

export interface InsertPeriodOverrideInput {
  orgId: string;
  periodId: string;
  entryId: string;
  actorPersonId: string;
  reason: PeriodOverrideReason;
  note?: string | null;
  /** The status `postEntry` resolved for this period at the moment this row is written — 'open'
   *  or 'closed'. Never 'locked': a locked period is refused before any row is written. */
  periodStatusAtPost: 'open' | 'closed';
}

/**
 * T-264 slice 3 (DEF-284, docs/plans/264-slice3-plan.md). The audit-row writer for
 * `period_overrides`. Called by `postEntry` (packages/domain/src/ledger/post-entry.ts), in the
 * SAME transaction, immediately after the entry is posted — so a rollback leaves no row and a
 * commit cannot fail to have one.
 *
 * ⛔ **What the row means, restated here because a repo function is where a future caller looks
 * first: "the override_period_lock capability was invoked for this entry" — NOT "the period lock
 * was bypassed."** Those differ exactly when `periodStatusAtPost = 'open'` (see
 * `packages/db/schema/period-overrides.ts`'s header for why `postEntry` writes this row
 * unconditionally rather than only when the period turned out closed).
 */
export async function insertPeriodOverride(
  tx: Tx,
  input: InsertPeriodOverrideInput,
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(periodOverrides)
    .values({
      orgId: input.orgId,
      periodId: input.periodId,
      entryId: input.entryId,
      actorPersonId: input.actorPersonId,
      reason: input.reason,
      note: input.note ?? null,
      periodStatusAtPost: input.periodStatusAtPost,
    })
    .returning({ id: periodOverrides.id });
  return row!;
}
