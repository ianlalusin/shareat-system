/**
 * T-641 - the period a question is about, worked out by OUR code in Manila time, never by the model. The model says "this month" or gives two dates; it does not do calendar arithmetic
 * (a model that is asked for "last month" in January gets the year wrong often enough to matter). Every answer names the period it used.
 */
import { addDays, parseBusinessDate, type BusinessDate } from '@shareat/core/datetime';
import { refuse } from '../shared/refusal';

export const PERIOD_NAMES = ['today', 'yesterday', 'this_week', 'this_month', 'last_month', 'this_year'] as const;
export type PeriodName = (typeof PERIOD_NAMES)[number];

export interface ResolvedPeriod {
  /** First day, YYYY-MM-DD. */
  from: string;
  /** Last day, YYYY-MM-DD, included. */
  to: string;
  label: string;
}

/** The longest range one answer may cover. A technical ceiling on how much one tool reads, not a business rule. */
export const MAX_RANGE_DAYS = 366;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (ymd: string): string => `${MONTHS[Number(ymd.slice(5, 7)) - 1] ?? ''} ${ymd.slice(0, 4)}`;

function realDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    return parseBusinessDate(v.trim());
  } catch {
    return null;
  }
}

/**
 * `input.from` and `input.to` together (two real dates, from not after to) win; otherwise `input.period` (default this month). A half-given range, an impossible date or an unknown
 * period name is a plain sentence back to the model, never a quiet fallback to a different period.
 */
export function resolvePeriod(input: { period?: unknown; from?: unknown; to?: unknown }, today: string): ResolvedPeriod {
  const hasFrom = input.from !== undefined && input.from !== null && input.from !== '';
  const hasTo = input.to !== undefined && input.to !== null && input.to !== '';
  if (hasFrom || hasTo) {
    const from = realDate(input.from);
    const to = realDate(input.to);
    if (!from || !to) throw refuse('ask erp: bad date range', 'Give both dates as real calendar dates written YYYY-MM-DD, or use a named period such as this_month.');
    if (from.localeCompare(to) > 0) throw refuse('ask erp: range reversed', 'The first date must not be after the second.');
    // too long when `to` is past the last day a range of MAX_RANGE_DAYS days starting at `from` could reach (dates compare as text, YYYY-MM-DD)
    if (to.localeCompare(addDays(from as BusinessDate, MAX_RANGE_DAYS - 1)) > 0) throw refuse('ask erp: range too long', `Ask for a period of at most ${MAX_RANGE_DAYS} days, or one month at a time.`);
    return { from, to, label: from === to ? from : `${from} to ${to}` };
  }
  const name = input.period === undefined || input.period === null || input.period === '' ? 'this_month' : input.period;
  const monthStart = `${today.slice(0, 7)}-01` as BusinessDate;
  switch (name) {
    case 'today':
      return { from: today, to: today, label: `today (${today})` };
    case 'yesterday': {
      const y = addDays(today as BusinessDate, -1);
      return { from: y, to: y, label: `yesterday (${y})` };
    }
    case 'this_week': {
      const [y, m, d] = today.split('-').map(Number) as [number, number, number];
      const sinceMonday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
      return { from: addDays(today as BusinessDate, -sinceMonday), to: today, label: 'this week (Monday to today)' };
    }
    case 'this_month':
      return { from: monthStart, to: today, label: `${monthName(today)} so far (${monthStart} to ${today})` };
    case 'last_month': {
      const end = addDays(monthStart, -1);
      const start = `${end.slice(0, 7)}-01`;
      return { from: start, to: end, label: monthName(end) };
    }
    case 'this_year':
      return { from: `${today.slice(0, 4)}-01-01`, to: today, label: `${today.slice(0, 4)} so far` };
    default:
      throw refuse('ask erp: unknown period', `Use one of: ${PERIOD_NAMES.join(', ')}, or give from and to as YYYY-MM-DD.`);
  }
}

/** The `YYYYMM` key the budgets use, for the month a period starts in. */
export function budgetPeriodKey(p: ResolvedPeriod): string {
  return p.from.slice(0, 7).replace('-', '');
}
