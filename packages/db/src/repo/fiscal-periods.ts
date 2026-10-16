/**
 * The only place SQL is written for `fiscal_periods`. T-264 / DEF-284 slice 1.
 *
 * ⛔ **Until this file existed, nothing in the codebase had ever created a fiscal period outside a
 * test or `dev-seed-inventory.ts`'s single hand-rolled row.** The wall `postEntry` and the
 * `journal_entries_period_open` trigger enforce was built and never raised: a freshly bootstrapped
 * production organisation could not post a single journal entry. See `docs/tasks/264-*.md`'s
 * "severity correction" for the full trace.
 */
import { and, asc, desc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import {
  deliveries,
  expenses,
  fiscalPeriods,
  journalEntries,
  periodOverrides,
  suppliers,
  type PeriodOverrideReason,
} from '../../schema';

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
 *  `closeReadiness`, `/findings`) already uses, to this table's own `[starts_on, ends_on]`.
 *  ⭐ Exported (T-344) so the domain layer can turn a `'YYYY-MM'` period into the date range
 *  `closeBlockers` (`fiscal-periods/index.ts`) takes, without a second copy of this arithmetic. */
export function periodBounds(period: string): { startsOn: string; endsOn: string } {
  const [yStr, mStr] = period.split('-');
  return monthBounds(Number(yStr), Number(mStr));
}

/** `date` plus/minus one day, as `YYYY-MM-DD`. Local, like `monthBounds` above — this file's own
 *  convention is small date arithmetic written here rather than imported, so a caller in
 *  `packages/db` never needs `@shareat/core`'s branded `BusinessDate` for a one-line shift. */
function addOneDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
function subtractOneDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
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
  return hasEarlierOpenPeriodBefore(tx, orgId, startsOn);
}

/**
 * `hasEarlierOpenPeriod`'s own query, keyed on a raw date rather than a `'YYYY-MM'` period — T-344
 * §3.3's admin action fills a part-month piece, which has no period string of its own to convert.
 */
export async function hasEarlierOpenPeriodBefore(tx: Tx, orgId: string, beforeDate: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: fiscalPeriods.id })
    .from(fiscalPeriods)
    .where(and(eq(fiscalPeriods.orgId, orgId), lt(fiscalPeriods.startsOn, beforeDate), eq(fiscalPeriods.status, 'open')))
    .limit(1);
  return row !== undefined;
}

/**
 * T-368 S1 (DEF-424) — the latest `starts_on` among `year`'s currently-`closed` periods, or `null`
 * if none. `closeYear`'s own gap check (`fiscal-periods/index.ts`) uses this as the `beforeDate` for
 * `firstCoverageGapBefore`, mirroring `lockYearPeriods` right below: that function only ever
 * transitions a `closed` period to `locked`, never a month that does not exist, so the gap check
 * must be scoped the SAME way — against the latest row `lockYearPeriods` is actually about to touch,
 * never against `year + 1`'s January 1 regardless of how much of the year is still missing. A year
 * can be (and ordinarily is) closed before every one of its months physically exists as a row —
 * H11's own fixture (`t344-fiscal-period-holes.test.ts`) locks Jan-May while Jun-Dec are still
 * missing outright, and the missing months are reported as class B findings only AFTER the year's
 * `closed` status makes them "inside closed books" (`classifyHoles`'s `yearClosed` branch) — they
 * are never required to exist before the close itself.
 */
export async function latestClosedPeriodStartsOnInYear(tx: Tx, orgId: string, year: number): Promise<string | null> {
  const [row] = await tx
    .select({ startsOn: fiscalPeriods.startsOn })
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.orgId, orgId),
        gte(fiscalPeriods.startsOn, `${year}-01-01`),
        lte(fiscalPeriods.endsOn, `${year}-12-31`),
        eq(fiscalPeriods.status, 'closed'),
      ),
    )
    .orderBy(desc(fiscalPeriods.startsOn))
    .limit(1);
  return row?.startsOn ?? null;
}

/**
 * Flips every period of `year` (Jan 1 .. Dec 31) currently `closed` to `locked`, in one statement.
 * T-274, ADR-006 §7.5: *"`closed` -> `locked`. Automatic once the following year's close posts
 * successfully."* Called by `closeYear` in the SAME transaction that posts the closing entry, so a
 * rollback leaves every period exactly as it was and a commit locks them all together.
 *
 * ⭐ **A bare guard, never a pre-read** — same race-safety idiom `closePeriod` above already uses.
 * Only rows currently `status = 'closed'` are touched, so calling this twice (an idempotent replay
 * of `closeYear`) is a safe no-op the second time — the returned count is simply 0, not an error.
 *
 * ⚠️ **Only `closed` periods are touched, never `open` ones.** `closeYear`'s own earlier-open-period
 * gate is what refuses before this could ever run against a year with a month still open; this
 * function does not re-decide that — it only advances what is already `closed`.
 */
export async function lockYearPeriods(tx: Tx, orgId: string, year: number): Promise<number> {
  const rows = await tx
    .update(fiscalPeriods)
    .set({ status: 'locked', updatedAt: sql`now()` })
    .where(
      and(
        eq(fiscalPeriods.orgId, orgId),
        gte(fiscalPeriods.startsOn, `${year}-01-01`),
        lte(fiscalPeriods.endsOn, `${year}-12-31`),
        eq(fiscalPeriods.status, 'closed'),
      ),
    )
    .returning({ id: fiscalPeriods.id });
  return rows.length;
}

export interface CoveragePeriod {
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: 'open' | 'closed' | 'locked';
}

export interface CoverageHole {
  readonly startsOn: string;
  readonly endsOn: string;
}

export interface CoverageHolesResult {
  /** Every period this org has, ordered by `starts_on` — `classifyHoles` (`@shareat/domain`)
   *  reuses this same read to check whether a requested range already overlaps a period, rather
   *  than a second SELECT. */
  readonly periods: CoveragePeriod[];
  /** Every gap in coverage from the org's first period through `through` (inclusive) — interior
   *  gaps between two periods, plus the tail beyond the last one. `[]` for an org with no periods
   *  at all; the job's own zero-period branch (`scheduler/index.ts`) handles that case, not this. */
  readonly holes: CoverageHole[];
  /** The latest `starts_on` among this org's `closed`/`locked` periods, or `null` if it has none.
   *  A hole ending before this date has a closed/locked period starting after it — T-344 §3.2's
   *  class A/B split. (Periods never overlap, so the row with this `starts_on` is, by definition,
   *  the only one that can matter for that comparison.) */
  readonly closeFrontierStartsOn: string | null;
}

/**
 * T-344 §3.1 — the one SQL read `classifyHoles` (`@shareat/domain/fiscal-periods/holes`) builds
 * on: this org's periods, the gaps between and after them through `through`, and the close
 * frontier. Interior gaps are found by walking the ordered rows (Postgres `lag(ends_on) over
 * (order by starts_on)` restated in JS, since the loop also has to compute the frontier from the
 * same rows); the tail is `max(ends_on)+1 .. through` when that is non-empty.
 */
export async function coverageHoles(tx: Tx, orgId: string, through: string): Promise<CoverageHolesResult> {
  const periods = await tx
    .select({ startsOn: fiscalPeriods.startsOn, endsOn: fiscalPeriods.endsOn, status: fiscalPeriods.status })
    .from(fiscalPeriods)
    .where(eq(fiscalPeriods.orgId, orgId))
    .orderBy(asc(fiscalPeriods.startsOn));

  if (periods.length === 0) return { periods: [], holes: [], closeFrontierStartsOn: null };

  const holes: CoverageHole[] = [];
  let prevEnd: string | null = null;
  for (const p of periods) {
    if (prevEnd !== null && p.startsOn > addOneDay(prevEnd)) {
      holes.push({ startsOn: addOneDay(prevEnd), endsOn: subtractOneDay(p.startsOn) });
    }
    if (prevEnd === null || p.endsOn > prevEnd) prevEnd = p.endsOn;
  }
  if (prevEnd !== null && through > prevEnd) {
    holes.push({ startsOn: addOneDay(prevEnd), endsOn: through });
  }

  let closeFrontierStartsOn: string | null = null;
  for (const p of periods) {
    if (
      (p.status === 'closed' || p.status === 'locked') &&
      (closeFrontierStartsOn === null || p.startsOn > closeFrontierStartsOn)
    ) {
      closeFrontierStartsOn = p.startsOn;
    }
  }

  return { periods, holes, closeFrontierStartsOn };
}

/**
 * T-368 S1 (DEF-424) — `closePeriod`/`closeYear`'s own gate: the earliest uncovered range between
 * the org's first period and `beforeDate - 1`, inclusive. Reuses `coverageHoles`'s walk (same
 * SELECT, same hole math) rather than a second query.
 *
 * ⚠️ `coverageHoles(tx, orgId, through)`'s INTERIOR holes are computed purely from the existing
 * rows, with no `through` bound of their own — only its TAIL hole is clipped to `through`. A gap
 * between two periods that both exist LATER than `beforeDate` would therefore still appear in its
 * raw list; filtered out here (`h.endsOn <= through`), since a gap after the month being closed is
 * not "a missing EARLIER month." Holes before the org's first period are never produced by
 * `coverageHoles` itself — its walk only opens a hole once it has seen a first row — so nothing
 * extra is needed for that half of the contract ("holes before the first period are not holes").
 */
export async function firstCoverageGapBefore(
  tx: Tx,
  orgId: string,
  beforeDate: string,
): Promise<CoverageHole | null> {
  const through = subtractOneDay(beforeDate);
  const { holes } = await coverageHoles(tx, orgId, through);
  return holes.find((h) => h.endsOn <= through) ?? null;
}

/**
 * T-344 §3.2, R1.1 — every calendar year `Y` that is "closed" for fiscal-period purposes: a year
 * with at least one `locked` period, OR a posted `journal_entries` row with `source_type =
 * 'year_close'` dated `(Y+1)-01-01` (`close-year.ts`'s own idempotency shape). Both conditions are
 * checked, independently, so a year `closeYear` locked with real periods AND a year whose periods
 * are entirely missing but whose closing entry was posted anyway (H11b's shape) are both caught —
 * `closeYear` itself only ever checks for an earlier OPEN period (`:58`), never a missing one.
 */
export async function closedYears(tx: Tx, orgId: string): Promise<Set<number>> {
  const years = new Set<number>();

  const lockedRows = await tx
    .select({ startsOn: fiscalPeriods.startsOn })
    .from(fiscalPeriods)
    .where(and(eq(fiscalPeriods.orgId, orgId), eq(fiscalPeriods.status, 'locked')));
  for (const row of lockedRows) years.add(Number(row.startsOn.slice(0, 4)));

  const closeEntries = await tx
    .select({ entryDate: journalEntries.entryDate })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.orgId, orgId),
        eq(journalEntries.sourceType, 'year_close'),
        eq(journalEntries.status, 'posted'),
      ),
    );
  for (const row of closeEntries) years.add(Number(row.entryDate.slice(0, 4)) - 1);

  return years;
}

export interface InsertFilledPeriodInput {
  readonly orgId: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: 'closed' | 'locked';
  readonly actorId: string;
  readonly reason: string;
}

/**
 * T-344 §3.1/§3.3 — the one INSERT the admin "fill a missing month" action ends with: `closed_at`
 * and `closed_by`/`created_by` all set together, `fill_reason` carried. `ON CONFLICT DO NOTHING`,
 * bare — the same exclusion-constraint-safe idiom `seedCalendarMonths` above uses — so a second
 * writer racing for the same range loses silently: `null` back means "another writer won", which
 * the caller reports as a refusal, never as a quiet success.
 */
export async function insertFilledPeriod(tx: Tx, input: InsertFilledPeriodInput): Promise<{ id: string } | null> {
  const [row] = await tx
    .insert(fiscalPeriods)
    .values({
      orgId: input.orgId,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      status: input.status,
      closedAt: sql`now()`,
      closedBy: input.actorId,
      createdBy: input.actorId,
      fillReason: input.reason,
    })
    .onConflictDoNothing()
    .returning({ id: fiscalPeriods.id });
  return row ?? null;
}

export interface UnpostedDraft {
  readonly kind: 'expense' | 'delivery';
  readonly id: string;
  readonly dateOn: string;
  /** R1.7 — the supplier's name for an expense (always present, the FK is NOT NULL), or a
   *  delivery's supplier name when it has one. `null` for a delivery with none — `holes.ts`'s
   *  message builder shows that as `"{kind} delivery, no supplier"`, never a raw id (DEF-417). */
  readonly counterpartyName: string | null;
}

/**
 * Every `expenses` or `deliveries` row still `draft`, dated inside `[startsOn, endsOn]`. T-344
 * §3.3 turned this from a `'YYYY-MM'`-period query into a raw date range — `closeBlockers`
 * (`packages/domain/src/fiscal-periods/index.ts`, shared by `closePeriod` and the admin
 * "fill a missing month" action) is its only caller, and the action gates a part-month piece,
 * which has no period string of its own.
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
 *
 * R1.7 joins `suppliers` for `counterpartyName`, never leaked as a raw id (DEF-417): NOT NULL /
 * INNER for `expenses` (the FK is NOT NULL — T-130), LEFT for `deliveries` (the FK is nullable — a
 * commissary delivery may have none).
 */
export async function unpostedDraftsInRange(
  tx: Tx,
  orgId: string,
  startsOn: string,
  endsOn: string,
): Promise<UnpostedDraft[]> {
  const draftExpenses = await tx
    .select({ id: expenses.id, dateOn: expenses.businessDate, counterpartyName: suppliers.name })
    .from(expenses)
    .innerJoin(suppliers, eq(suppliers.id, expenses.supplierId))
    .where(
      and(
        eq(expenses.orgId, orgId),
        eq(expenses.status, 'draft'),
        gte(expenses.businessDate, startsOn),
        lte(expenses.businessDate, endsOn),
      ),
    );
  const draftDeliveries = await tx
    .select({
      id: deliveries.id,
      dateOn: deliveries.deliveredOn,
      deliveryKind: deliveries.kind,
      supplierName: suppliers.name,
    })
    .from(deliveries)
    .leftJoin(suppliers, eq(suppliers.id, deliveries.supplierId))
    .where(
      and(
        eq(deliveries.orgId, orgId),
        eq(deliveries.status, 'draft'),
        gte(deliveries.deliveredOn, startsOn),
        lte(deliveries.deliveredOn, endsOn),
      ),
    );
  return [
    ...draftExpenses.map((e) => ({
      kind: 'expense' as const,
      id: e.id,
      dateOn: e.dateOn,
      counterpartyName: e.counterpartyName,
    })),
    // ⚠️ A delivery with no supplier gets its fallback label HERE, from its own `kind` column
    // (`purchase`/`commissary`/…) — a business classification unrelated to this interface's own
    // `kind: 'expense' | 'delivery'` discriminator, so it is folded into `counterpartyName` rather
    // than exposed as a second field the two could be confused with.
    ...draftDeliveries.map((d) => ({
      kind: 'delivery' as const,
      id: d.id,
      dateOn: d.dateOn,
      counterpartyName: d.supplierName ?? `${d.deliveryKind} delivery, no supplier`,
    })),
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

/**
 * T-430 D4 - the first day on or after `date` that is not inside a closed or locked period.
 *
 * `date` itself when no period row covers it (a missing row is NOT closed) or the covering row is `open`; otherwise the
 * day after the covering period's `ends_on`, repeated. Returns `null` when that answer would be after `today` (every
 * period up to today is shut), so a draft is never dated in the future. `shutBy` names the first shut period passed over
 * (for the note on the drafted bill); null when `date` was already usable.
 */
export async function firstOpenDateOnOrAfter(
  tx: Tx,
  orgId: string,
  date: string,
  today: string,
): Promise<{ date: string; shutBy: { status: 'closed' | 'locked'; startsOn: string; endsOn: string } | null } | null> {
  let d = date;
  let shutBy: { status: 'closed' | 'locked'; startsOn: string; endsOn: string } | null = null;
  for (let i = 0; i < 1200; i++) {
    const [row] = await tx
      .select({ status: fiscalPeriods.status, startsOn: fiscalPeriods.startsOn, endsOn: fiscalPeriods.endsOn })
      .from(fiscalPeriods)
      .where(and(eq(fiscalPeriods.orgId, orgId), lte(fiscalPeriods.startsOn, d), gte(fiscalPeriods.endsOn, d)))
      .limit(1);
    if (!row || row.status === 'open') return d.localeCompare(today) > 0 ? null : { date: d, shutBy };
    shutBy ??= { status: row.status as 'closed' | 'locked', startsOn: row.startsOn, endsOn: row.endsOn };
    const next = new Date(`${row.endsOn}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    d = next.toISOString().slice(0, 10);
    if (d.localeCompare(today) > 0) return null;
  }
  return null;
}
