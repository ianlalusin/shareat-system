/**
 * T-436 - Service Incentive Leave arithmetic. PURE: no database, no clock.
 * `docs/tasks/436-leave-tracking.md` D3 (service start) and D7 (entitlement).
 *
 * Labor Code Art. 95: 5 days a year, paid, once the employee has a year of service. Pro-rating in the anniversary year is
 * COMPANY POLICY, not law - the accountant / HR should confirm it with DOLE (spec D7).
 */

import { cmpIso, isoOnOrBefore } from './dates';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function parts(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

function daysIn(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** The 1-year anniversary of a service start (29 Feb clamps to 28 Feb in a non-leap year). */
export function silAnniversary(serviceStart: string): string {
  const { y, m, d } = parts(serviceStart);
  const day = Math.min(d, daysIn(y + 1, m));
  return `${pad(y + 1, 4)}-${pad(m)}-${pad(day)}`;
}

/**
 * The paid SIL days a person has in calendar `year`:
 *  - 5 if the anniversary is on or before 1 Jan of `year`;
 *  - in the anniversary year `ceil(5 x M / 12)`, M = calendar months left COUNTING the anniversary month (1 Jun or 15 Jun -> 7 -> 3);
 *  - 0 before that year.
 * Rounded UP, never down or half-up (1 Dec -> M = 1 -> 1 day).
 */
export function silEntitlementDays(serviceStart: string, year: number): number {
  const anniversary = silAnniversary(serviceStart);
  if (isoOnOrBefore(anniversary, `${pad(year, 4)}-01-01`)) return 5;
  const a = parts(anniversary);
  if (a.y !== year) return 0;
  const monthsLeft = 13 - a.m;
  return Math.floor((5 * monthsLeft + 11) / 12);
}

export interface ServiceSpan {
  startedOn: string;
  endedOn: string | null;
}

function nextDay(date: string): string {
  const { y, m, d } = parts(date);
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d + 1);
  return t.toISOString().slice(0, 10);
}

/**
 * Service start = the earliest `started_on` of the person's CURRENT unbroken chain of org employments as of the end of
 * `year` (spec D3). A chain breaks on any day with no open employment: A until 31 Dec and B from 1 Jan is one chain; A
 * until 30 Dec and B from 1 Jan is two. Returns `null` when the person had no employment by then.
 */
export function serviceStartFor(spans: readonly ServiceSpan[], year: number): string | null {
  const limit = `${pad(year, 4)}-12-31`;
  const relevant = spans.filter((s) => isoOnOrBefore(s.startedOn, limit)).sort((a, b) => cmpIso(a.startedOn, b.startedOn));
  if (relevant.length === 0) return null;
  let chainStart = relevant[0]!.startedOn;
  let chainEnd: string | null = relevant[0]!.endedOn; // null = still open
  for (const s of relevant.slice(1)) {
    const touches = chainEnd === null || isoOnOrBefore(s.startedOn, nextDay(chainEnd));
    if (touches) {
      if (chainEnd !== null) chainEnd = s.endedOn === null ? null : cmpIso(s.endedOn, chainEnd) === 1 ? s.endedOn : chainEnd;
    } else {
      chainStart = s.startedOn;
      chainEnd = s.endedOn;
    }
  }
  return chainStart;
}
