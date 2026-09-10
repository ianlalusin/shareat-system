/**
 * The only place SQL is written for `fiscal_periods`. T-264 / DEF-284 slice 1.
 *
 * ⛔ **Until this file existed, nothing in the codebase had ever created a fiscal period outside a
 * test or `dev-seed-inventory.ts`'s single hand-rolled row.** The wall `postEntry` and the
 * `journal_entries_period_open` trigger enforce was built and never raised: a freshly bootstrapped
 * production organisation could not post a single journal entry. See `docs/tasks/264-*.md`'s
 * "severity correction" for the full trace.
 */
import { desc, eq } from 'drizzle-orm';
import type { Tx } from '../client';
import { fiscalPeriods } from '../../schema';

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
