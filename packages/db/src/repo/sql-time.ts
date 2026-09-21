/**
 * The one definition of "today" for the repo layer — T-218.
 *
 * ## ⛔ Why this file exists at all
 *
 * `current_date` follows the **session** timezone, not Manila. On a UTC production server it reads
 * *yesterday* through Manila's 00:00–08:00, so every business-date comparison built on it is wrong
 * for a third of each day. Migration `0112_t198_day_feed_scope.sql`'s own comment states this as
 * standing bible discipline — *"a production database running UTC is eight hours behind Manila…
 * which is the same discipline the bible requires for business dates everywhere else."*
 *
 * ⭐ **DEF-172 was filed as "four detectors in one file." It was ten sites across four files.** Not
 * because anyone was careless, but because there was nowhere to put the definition, so every query
 * spelled the date for itself and each spelling was an independent chance to get it wrong. **A
 * constant nobody owns is a constant that drifts.** This is the place it is owned.
 *
 * ## ⚠️ The subtler half — two clocks, not one timezone
 *
 * The worst instance was not a timezone at all. `cashRequestFloatAgeing` gated in SQL on Postgres's
 * clock and then recomputed its displayed age in JavaScript from `Date.now()`, so the badge could
 * contradict the gate that admitted the row. **An age belongs in the same statement as the
 * threshold it is judged against**; where that is genuinely impossible (a FIFO walk in TypeScript
 * picks the date), carry `MANILA_TODAY` back as a column and use `daysBetweenDates` — never reach
 * for the process clock.
 *
 * ⚠️ Same defect class as DEF-178. `tests/unit/findings-single-clock.test.ts` is the standing guard
 * over `packages/db/src/repo`.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../client';

/** Today's date in Manila. ⛔ Use this, never bare `current_date`. */
export const MANILA_TODAY = sql`(now() at time zone 'Asia/Manila')::date`;

/**
 * `MANILA_TODAY` as a plain `YYYY-MM-DD` string, for a caller that needs "today" as a value rather
 * than a fragment to embed in a larger query — e.g. seeding a new row's `effective_from`. Keeps the
 * SQL itself inside the repo layer (bible §4.3) instead of exporting the fragment for a caller
 * outside it to embed in its own `sql` template.
 */
export async function manilaToday(tx: Tx): Promise<string> {
  const [row] = (await tx.execute(sql`select ${MANILA_TODAY}::text as today`)) as unknown as {
    today: string;
  }[];
  return row!.today;
}

/**
 * Whole days between two **calendar dates** (`YYYY-MM-DD`).
 *
 * ⭐ **What was actually wrong in the code this replaces, precisely.** It was not wrong for using
 * `Date`; it was wrong for comparing a *date* to an *instant* — `Date.now()` against a date parsed
 * at UTC midnight. That subtraction carries the time of day and the server's offset, so it floors
 * to the wrong day for eight hours out of every twenty-four on a UTC box.
 *
 * ⛔ Here BOTH sides are calendar dates, so parsing both at UTC midnight is exact: the offset
 * cancels. Use it **only** with a `MANILA_TODAY` value fetched alongside the data, so the "today"
 * being measured against is still Postgres's, in Manila, read once.
 */
export function daysBetweenDates(fromIsoDate: string, toIsoDate: string): number {
  return Math.round(
    (Date.parse(`${toIsoDate}T00:00:00Z`) - Date.parse(`${fromIsoDate}T00:00:00Z`)) / 86_400_000,
  );
}
