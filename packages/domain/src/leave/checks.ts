/**
 * T-436 - the rules an approval (or a manager's record) is judged by, in the order they are checked:
 * worked date -> per-birth limit -> monthly / yearly cap -> Service Incentive Leave. Every refusal is typed and carries the
 * numbers. ⛔ Every count here is PERSON-keyed and must be read UNDER the person's leave lock (`lockPersonLeave`), or two
 * approvals can both pass a cap that only one may.
 */
import { employmentRepo, leaveRepo, type EmploymentRow, type LeaveTypeRow, type Tx } from '@shareat/db';
import { isoBefore, isoOnOrAfter, isoOnOrBefore } from './dates';
import { leaveRefusal } from './refusal';
import { silAnniversary, silEntitlementDays, serviceStartFor } from './sil';

export interface DayIn {
  date: string;
  kind: 'leave' | 'rest_day';
}

const pad = (n: number) => String(n).padStart(2, '0');

function lastDayOfMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Real leave days only: a `rest_day` row is not leave, pays nothing, uses no SIL and counts toward no cap. */
export const leaveKindDays = (days: readonly DayIn[]): string[] => days.filter((d) => d.kind === 'leave').map((d) => d.date);

// ---------------------------------------------------------------------------------------------
// Caps

/**
 * ⭐ Most specific wins: store+position > position > store > org default. A more specific row that says "no limit" (NULL) still
 * wins over a less specific one that sets a limit. Ties between two position rows (a job holding two positions) take the more generous.
 */
export function pickCap(
  rows: readonly leaveRepo.CapRow[],
  storeId: string,
  positionIds: readonly string[],
): leaveRepo.CapRow | null {
  const score = (r: leaveRepo.CapRow) => (r.storeId !== null ? 1 : 0) + (r.positionId !== null ? 2 : 0);
  const generosity = (r: leaveRepo.CapRow) => (r.monthlyCap ?? 1e9) + (r.yearlyCap ?? 1e9);
  const applicable = rows.filter(
    (r) => (r.storeId === null || r.storeId === storeId) && (r.positionId === null || positionIds.includes(r.positionId)),
  );
  let best: leaveRepo.CapRow | null = null;
  for (const r of applicable) {
    if (!best || score(r) > score(best) || (score(r) === score(best) && generosity(r) > generosity(best))) best = r;
  }
  return best;
}

async function enforceCaps(tx: Tx, c: CheckContext, leaveDates: string[]): Promise<void> {
  // Per-birth kinds (maternity, paternity) are NEVER under monthly / yearly caps (spec D2): a cap on file is ignored.
  if (c.type.legalPerBirthDays !== null || leaveDates.length === 0) return;

  const positionIds = await leaveRepo.positionIdsOfEmployment(tx, c.employment.id);
  const candidates = await leaveRepo.candidateCaps(tx, {
    orgId: c.orgId,
    leaveType: c.type.code,
    storeId: c.employment.storeId,
    positionIds,
  });
  const cap = pickCap(candidates, c.employment.storeId, positionIds);
  const monthly = cap?.monthlyCap ?? null;
  const yearly = cap?.yearlyCap ?? c.type.legalYearlyDays ?? null;

  if (monthly !== null) {
    const months = [...new Set(leaveDates.map((d) => d.slice(0, 7)))].sort();
    for (const key of months) {
      const [y, m] = key.split('-').map(Number) as [number, number];
      const existing = await leaveRepo.countApprovedDays(tx, {
        personId: c.personId,
        leaveType: c.type.code,
        from: `${key}-01`,
        to: `${key}-${pad(lastDayOfMonth(y, m))}`,
      });
      const adding = leaveDates.filter((d) => d.startsWith(key)).length;
      if (existing + adding > monthly) {
        throw leaveRefusal(
          'LEAVE_CAP_MONTHLY',
          existing >= monthly
            ? `${c.type.code}: ${existing} of ${monthly} this month already used (${MONTH_NAMES[m - 1]} ${y}). The monthly limit is reached.`
            : `${c.type.code}: ${existing} of ${monthly} used in ${MONTH_NAMES[m - 1]} ${y}, and ${adding} more day(s) would go over the monthly limit.`,
        );
      }
    }
  }

  if (yearly !== null) {
    const years = [...new Set(leaveDates.map((d) => d.slice(0, 4)))].sort();
    for (const key of years) {
      const existing = await leaveRepo.countApprovedDays(tx, {
        personId: c.personId,
        leaveType: c.type.code,
        from: `${key}-01-01`,
        to: `${key}-12-31`,
      });
      const adding = leaveDates.filter((d) => d.startsWith(key)).length;
      if (existing + adding > yearly) {
        throw leaveRefusal(
          'LEAVE_CAP_YEARLY',
          existing >= yearly
            ? `${c.type.code}: ${existing} of ${yearly} this year already used (${key}). The yearly limit is reached.`
            : `${c.type.code}: ${existing} of ${yearly} used in ${key}, and ${adding} more day(s) would go over the yearly limit.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Per-birth limits (maternity 105, paternity 7 and the first 4 deliveries)

async function enforceBirth(tx: Tx, c: CheckContext, leaveDates: string[]): Promise<void> {
  const limit = c.type.legalPerBirthDays;
  if (limit === null) return;
  if (!c.birthDate) {
    throw leaveRefusal('LEAVE_BIRTH_REQUIRED', `${c.type.code} leave is counted per birth: enter the date of the birth.`);
  }
  if (leaveDates.length === 0) return;
  const existing = await leaveRepo.countBirthDays(tx, { personId: c.personId, leaveType: c.type.code, birthDate: c.birthDate });

  if (c.type.legalMaxBirths !== null && existing === 0) {
    const others = await leaveRepo.countOtherBirths(tx, { personId: c.personId, leaveType: c.type.code, exceptBirthDate: c.birthDate });
    if (others >= c.type.legalMaxBirths) {
      throw leaveRefusal(
        'LEAVE_BIRTH_LIMIT',
        `${c.type.code}: ${others} of ${c.type.legalMaxBirths} deliveries already covered. The law allows it for the first ${c.type.legalMaxBirths} deliveries only.`,
      );
    }
  }
  if (existing + leaveDates.length > limit) {
    throw leaveRefusal(
      'LEAVE_BIRTH_LIMIT',
      `${c.type.code}: ${existing} of ${limit} days already used for this birth, and ${leaveDates.length} more would go over the legal limit of ${limit} days per birth.`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Service Incentive Leave

export interface SilBalance {
  entitlement: number;
  used: number;
  remaining: number;
  serviceStart: string | null;
}

/** The derived balance: entitlement for the year minus approved PAID draws-SIL days. Never stored. */
export async function computeSilBalance(tx: Tx, orgId: string, personId: string, year: number): Promise<SilBalance> {
  const spans = await leaveRepo.listEmploymentSpans(tx, orgId, personId);
  const serviceStart = serviceStartFor(spans, year);
  const entitlement = serviceStart ? silEntitlementDays(serviceStart, year) : 0;
  const used = await leaveRepo.countSilUsed(tx, { orgId, personId, year });
  return { entitlement, used, remaining: Math.max(0, entitlement - used), serviceStart };
}

async function enforceSil(tx: Tx, c: CheckContext, leaveDates: string[]): Promise<void> {
  if (leaveDates.length === 0) return;
  const years = [...new Set(leaveDates.map((d) => Number(d.slice(0, 4))))].sort();
  for (const year of years) {
    const dates = leaveDates.filter((d) => d.startsWith(String(year)));
    if (await leaveRepo.yearIsClosed(tx, c.orgId, c.personId, year)) {
      throw leaveRefusal(
        'SIL_YEAR_CLOSED',
        `Service Incentive Leave for ${year} has already been paid out in cash, so no more paid days can be approved for ${year}. Approve it as unpaid, or void the payout first.`,
      );
    }
    const balance = await computeSilBalance(tx, c.orgId, c.personId, year);
    if (!balance.serviceStart) {
      throw leaveRefusal('SIL_BEFORE_ANNIVERSARY', 'This person has no service record yet, so Service Incentive Leave cannot be paid. Approve it as unpaid instead.');
    }
    const anniversary = silAnniversary(balance.serviceStart);
    const early = dates.filter((d) => isoBefore(d, anniversary));
    if (early.length > 0) {
      throw leaveRefusal(
        'SIL_BEFORE_ANNIVERSARY',
        `Service Incentive Leave starts after one year of service (${anniversary}); ${early[0]} is before that. Approve it as unpaid instead.`,
      );
    }
    if (balance.used + dates.length > balance.entitlement) {
      throw leaveRefusal(
        'SIL_BALANCE_EXHAUSTED',
        `Service Incentive Leave: ${balance.used} of ${balance.entitlement} paid days already used in ${year}, and ${dates.length} more would go over. Approve it as unpaid instead.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------

export interface CheckContext {
  orgId: string;
  personId: string;
  employment: EmploymentRow;
  type: LeaveTypeRow;
  birthDate: string | null;
}

/**
 * The effective pay mode. A kind that is unpaid by nature and draws no SIL (no-show, maternity / paternity - paid by SSS, other
 * unpaid leave) can never be made paid here. A kind that draws SIL (sick, personal, emergency, SIL itself) may be paid or unpaid.
 */
export function effectivePaid(type: LeaveTypeRow, wanted: boolean | undefined): { paid: boolean; overridden: boolean } {
  const want = wanted ?? type.paid;
  const paid = want && (type.paid || type.drawsSil);
  return { paid, overridden: paid !== type.paid };
}

/** Runs every rule for the days a request would make live. Throws the first typed refusal; returns the effective pay mode. */
export async function checkAndPrice(
  tx: Tx,
  c: CheckContext,
  days: readonly DayIn[],
  wantedPaid: boolean | undefined,
): Promise<{ paid: boolean; overridden: boolean }> {
  const leaveDates = leaveKindDays(days);

  const worked = await leaveRepo.workedDates(tx, c.personId, leaveDates);
  if (worked.length > 0) {
    throw leaveRefusal(
      'LEAVE_DAY_WORKED',
      `This person has attendance on ${worked.join(', ')}, so it cannot be recorded as leave. Void or adjust the attendance day first.`,
    );
  }
  await enforceBirth(tx, c, leaveDates);
  await enforceCaps(tx, c, leaveDates);

  const price = effectivePaid(c.type, wantedPaid);
  if (price.paid && c.type.drawsSil) await enforceSil(tx, c, leaveDates);
  return price;
}

/** Whether `date` falls inside the employment (started_on .. ended_on inclusive). */
export function withinEmployment(e: { startedOn: string; endedOn: string | null }, date: string): boolean {
  return isoOnOrAfter(date, e.startedOn) && (e.endedOn === null || isoOnOrBefore(date, e.endedOn));
}

export async function loadEmployment(tx: Tx, id: string): Promise<EmploymentRow | undefined> {
  return employmentRepo.getEmployment(tx, id);
}
