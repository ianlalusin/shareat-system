/**
 * Recurrence arithmetic for expense templates. T-216.
 *
 * ⭐ **Ported from v1's `recurring-expense/recurrence.ts`, which is CORRECT** — the clamping rule
 * especially: a 31st anchor in February lands on the 28th (or 29th), and it is never refused. That
 * is the same decision T-189d already settled for the payroll payout date, reused rather than
 * re-invented.
 *
 * ⚠️ **Two things changed in the port, both deliberate.**
 *
 * 1. **UTC arithmetic, and no `toLocaleDateString`.** v1 builds dates as `new Date(s + 'T00:00:00')`
 *    — local midnight — and formats them with `toLocaleDateString('en-CA')`, local again. The two
 *    cancel out, so v1 is not wrong; it is *load-bearing on the server's timezone being the one it
 *    was written on*. Bible §6 bans a bare `toLocale*` in server code for exactly this class of
 *    surprise, and a recurrence that shifts a rent date by a day when a container's TZ changes is
 *    the kind of defect nobody would suspect the calendar for.
 * 2. **Answers ONE question, not a range.** v1 expands every due date between two dates because its
 *    auto-pay runner scans a window. The v2 job holds a cursor (`next_due_date`) and only ever
 *    needs *"what comes after this one"* — so `nextDueDate` is the whole surface, and the
 *    thousand-iteration guard v1 needs has nothing to guard.
 */

export const RECURRENCE_INTERVALS = ['weekly', 'bi_weekly', 'monthly', 'quarterly', 'annually'] as const;
export type RecurrenceInterval = (typeof RECURRENCE_INTERVALS)[number];

/** Weekly-family anchors are days of the WEEK (0 = Sunday); monthly-family are days of the MONTH. */
export function isWeeklyFamily(interval: RecurrenceInterval): boolean {
  return interval === 'weekly' || interval === 'bi_weekly';
}

/**
 * ⛔ The range rule, and the database carries the same one as a CHECK.
 *
 * ⚠️ 29, 30 and 31 are all VALID monthly anchors even though no month has all of them — they clamp
 * (below). Refusing them would make "the last day of the month" unexpressible, which is one of the
 * commonest real anchors there is.
 */
export function isAnchorValid(interval: RecurrenceInterval, anchorDay: number): boolean {
  if (!Number.isInteger(anchorDay)) return false;
  return isWeeklyFamily(interval) ? anchorDay >= 0 && anchorDay <= 6 : anchorDay >= 1 && anchorDay <= 31;
}

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` → UTC epoch ms at midnight. ⛔ UTC, never local — see this file's header. */
function parse(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
}

function format(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Days in a month, UTC. Day 0 of the NEXT month is the last day of this one. */
function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * The anchor day inside a given month, clamped to that month's length.
 *
 * ⭐ This is the whole of v1's `setDayOfMonth`, and the reason it matters: a template anchored on
 * the 31st is a template that means *the last day*, and a system that refused it would push people
 * to anchor on the 28th and be three days early eight months a year.
 */
export function clampToMonth(year: number, monthIndex: number, anchorDay: number): string {
  const day = Math.min(Math.max(anchorDay, 1), daysInMonth(year, monthIndex));
  return format(Date.UTC(year, monthIndex, day));
}

/**
 * The next due date strictly after `from`.
 *
 * ⚠️ **Strictly after**, always — the job advances its cursor with this, and a function that could
 * return `from` itself would draft the same expense every day for ever.
 */
export function nextDueDate(from: string, interval: RecurrenceInterval, anchorDay: number): string {
  const base = parse(from);

  if (isWeeklyFamily(interval)) {
    const step = interval === 'weekly' ? 7 : 14;
    // ⚠️ Step first, THEN align to the anchor weekday. Aligning first can land on or before `from`
    // — a fortnightly template anchored on the weekday it was just drafted would stand still.
    let ms = base + step * DAY_MS;
    while (new Date(ms).getUTCDay() !== anchorDay) ms += DAY_MS;
    return format(ms);
  }

  const months = interval === 'quarterly' ? 3 : interval === 'annually' ? 12 : 1;
  const d = new Date(base);
  const zero = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  return clampToMonth(Math.floor(zero / 12), zero % 12, anchorDay);
}

/**
 * The FIRST due date on or after `on`, for a template being created today.
 *
 * ⚠️ Not the same function as `nextDueDate`: a template created on the 3rd with a monthly anchor of
 * the 15th is due **this** month, not next. Getting this wrong makes every new template a month
 * late, silently, and only the person waiting for the bill would ever notice.
 */
export function firstDueDate(on: string, interval: RecurrenceInterval, anchorDay: number): string {
  const base = parse(on);

  if (isWeeklyFamily(interval)) {
    let ms = base;
    while (new Date(ms).getUTCDay() !== anchorDay) ms += DAY_MS;
    return format(ms);
  }

  const d = new Date(base);
  const thisMonth = clampToMonth(d.getUTCFullYear(), d.getUTCMonth(), anchorDay);
  if (parse(thisMonth) >= base) return thisMonth;
  return nextDueDate(thisMonth, interval, anchorDay);
}
