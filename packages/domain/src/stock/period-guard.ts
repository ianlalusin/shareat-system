/**
 * Stock in a CLOSED month - refused in plain words, before any write. T-369 S4 (DEF-302; Ian ruling (a),
 * 2026-09-30). `docs/tasks/369-unwired-money-screens.md` section S4.
 *
 * ⛔ A closed month's stock stays as it was, and the closed-month override (`override_period_lock`)
 * does NOT reach stock, ever (I5): there is no override input on any function that calls this.
 *
 * ⛔ This is a SENTENCE, not the enforcement (I3). Migration 0145's trigger still refuses a stock
 * movement dated into a closed period, and still would if every call to this were deleted; what this
 * adds is the reason in words, found BEFORE the first write so that nothing half-posts, in place of the
 * trigger's raw P0001 text ("cannot move stock into a closed period (moved_at = ...)").
 */
import { journalRepo, type Tx } from '@shareat/db';
import { parseBusinessDate } from '@shareat/core/datetime';
import { humanDate } from '../shared/refusal';

/** "September 2026" - the month a fiscal period covers. */
function monthLabel(startsOn: string): string {
  return new Date(`${startsOn}T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * The refusal sentence when `date` falls in a `closed` or `locked` fiscal period, else `null`: an open
 * month, a date no period covers, and a malformed date all return `null` and behave exactly as before
 * (the trigger is still there for the last two). `doing` is the verb the person did: "produced",
 * "received", "returned", "voided", ...
 */
export async function closedStockPeriodSentence(
  tx: Tx,
  orgId: string,
  date: string,
  doing: string,
): Promise<string | null> {
  let day: ReturnType<typeof parseBusinessDate>;
  try {
    day = parseBusinessDate(date);
  } catch {
    return null;
  }
  const period = await journalRepo.findPeriodForDate(tx, orgId, date);
  if (!period || period.status === 'open') return null;
  return (
    `${monthLabel(period.startsOn)} is ${period.status}. Stock can't be ${doing} on ${humanDate(day)} — ` +
    "a closed month's stock stays as it was, and the closed-month override doesn't change that. " +
    'Use a date in an open month.'
  );
}

/**
 * The same refusal for a flow that moves stock at NOW rather than on a date the person chose: there is no
 * date to pick, so it does not tell them to ("Use a date in an open month"). `now` is the instant the
 * movement will be stamped with, and the date tested is its UTC date - exactly what migration 0145's trigger
 * sees - not the Manila business date, which can sit in a different month in the first hours of the 1st.
 */
export async function closedStockPeriodSentenceToday(
  tx: Tx,
  orgId: string,
  now: Date,
  doing: string,
): Promise<string | null> {
  const period = await journalRepo.findPeriodForDate(tx, orgId, now.toISOString().slice(0, 10));
  if (!period || period.status === 'open') return null;
  return `${monthLabel(period.startsOn)} is ${period.status}. Stock can't be ${doing} today — a closed month's stock stays as it was.`;
}
