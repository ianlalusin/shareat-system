/**
 * Payroll — the rate, the run, the payslip. T-189, Phase 5 slice 1.
 * `docs/tasks/189-pay-rates-and-the-pay-run.md`.
 *
 * ⛔ **This is not a port.** v1's payroll is three shipped slices and a verified tax engine that
 * has produced **zero payslips** — `payrollRuns` does not exist as a collection on any of the
 * seven stores, and not one of 126 staff carries a statutory number. So this builds the smallest
 * thing that actually pays somebody, and the phase plan records what the evidence says to leave
 * out and exactly what would trigger porting the rest.
 */
import { sql } from 'drizzle-orm';
import { ZERO, add, compare, decimal, divideMoney, formatMoney, money, subtract, type Money } from '@shareat/core/money';
import { attendanceConfigRepo, moneyAccountsRepo, payrollRepo, statutoryPaymentsRepo, statutoryRepo, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { parseMoneyInput } from '../shared/money-input';
import { assertFieldRules } from '../shared/field-rules-assert';
import { PAYROLL_PAY_RATE_RULES } from '../field-rules/payroll';
import { postEntry } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';
import { advanceToRecover, computePay, type DayInput } from './compute';
import { refuse } from '../shared/refusal';
import { EXPENSE_FUNDING_ACCOUNTS } from '../expenses/routing';
import {
  AGENCIES,
  computeStatutory,
  type Agency,
  type AgencyPrior,
  type ContributionRate,
  type WithholdingBracket,
} from './statutory';
// T-436: leave pay + the year-end SIL payout. The computation lives in `leave/payroll.ts`; this file only adds its two figures to a slip.
import { applyLeaveToRun, planLeavePayroll, releaseLeaveOfRun, sumMoney, type SilPayoutPlan } from '../leave/payroll';

export * from './compute';
export * from './periods';
// T-190 - the pure statutory engine and the rate-table management functions.
export * from './statutory';
export * from './rates';
// ⚠️ `./thirteenth-month` imports `outstandingAdvance` / `PAYROLL_ADVANCE_ACCOUNT` FROM this file
// (they are only defined here, not in a sibling module) — a deliberate circular import, safe only
// because both are used inside thirteenth-month.ts's function BODIES, never at its module top
// level. Exporting it from the END of this file, after both are already defined below, means the
// live binding is never accessed during the temporal dead zone even on the first evaluation pass.

/** `6100 Salaries and wages` — provisioned in Phase 1, and until now nothing had ever posted to it. */
export const SALARIES_ACCOUNT = '6100';
/**
 * `1230 Advances to employees` — party-bearing, `party_type = 'employee'`.
 *
 * ⚠️ The FOURTH module to name this account: `cash-requests` (STAFF_ADVANCE_CODE),
 * `commissary/discrepancy` (STAFF_CHARGE_ACCOUNT), `owners` (EMPLOYEE_ADVANCE_CODE) and now this.
 * They agree on the code and disagree on the name — worth one shared constant one day, and NOT
 * worth a refactor from inside a payroll task.
 */
export const PAYROLL_ADVANCE_ACCOUNT = '1230';
/** T-190. Employee + employer shares sit on these until T-193 remits them; the employer share is a cost on 6110-6130. */
export const STATUTORY_PAYABLE_ACCOUNT = { sss: '2210', philhealth: '2220', pagibig: '2230' } as const;
export const WITHHOLDING_PAYABLE_ACCOUNT = '2240';
export const STATUTORY_EXPENSE_ACCOUNT = { sss: '6110', philhealth: '6120', pagibig: '6130' } as const;

const AGENCY_LABEL: Record<Agency, string> = { sss: 'SSS', philhealth: 'PhilHealth', pagibig: 'Pag-IBIG' };
const FREQUENCY_LABEL = { monthly: 'monthly', semi_monthly: 'semi-monthly', weekly: 'weekly' } as const;

// -------------------------------------------------------------------------------------

/**
 * Sets what a job pays, from a date.
 *
 * ⛔ **Gated on `set_pay_rate`, which DENIES a manager.** A manager who rosters a team must not be
 * able to raise that team's cost without anyone approving it — the same reasoning the capability
 * matrix already records for `set_cash_policy`.
 *
 * ⛔ A rate is never updated. A wrong one is superseded by a new row, because a payslip already
 * posted was computed under the old one and has to stay explicable.
 */
export async function setPayRate(
  tx: Tx,
  actor: Actor,
  input: {
    employmentId: string;
    storeId: string;
    basis: 'daily' | 'hourly';
    amount: string;
    effectiveFrom: string;
    note?: string | null;
  },
): Promise<{ id: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'set_pay_rate', { storeId: input.storeId });
    // T-440 S9 (ii): the screen's own rules, only once the gate has passed.
    assertFieldRules(PAYROLL_PAY_RATE_RULES, { amount: input.amount, effectiveFrom: input.effectiveFrom });
    const amount = parseMoneyInput(input.amount, 'setPayRate: the amount', 'The pay rate');
    if (compare(amount, ZERO) <= 0) {
      throw new Error('setPayRate: a pay rate has to be more than zero.');
    }
    return payrollRepo.insertPayRate(trx, {
      orgId: actor.orgId,
      employmentId: input.employmentId,
      basis: input.basis,
      amount,
      effectiveFrom: input.effectiveFrom,
      note: input.note ?? null,
      createdBy: actor.personId,
    });
  };
  return run(tx);
}

// -------------------------------------------------------------------------------------

export interface PayslipDraft {
  employmentId: string;
  /**
   * ⭐ Overtime the day recorded that NOBODY HAS APPROVED, so this run does not pay it.
   *
   * ⚠️ Surfaced rather than silently dropped. An unapproved hour that vanishes from the screen is
   * indistinguishable from an hour nobody worked — which is the failure this whole module keeps
   * finding in v1.
   */
  unapprovedOtMinutes: number;
  personId: string;
  personName: string;
  payRateId: string;
  dayIds: string[];
  daysWorked: number;
  minutesWorked: number;
  otMinutes: number;
  nightDiffMinutes: number;
  holidayMinutes: number;
  basicPay: Money;
  otPay: Money;
  nightDiffPay: Money;
  holidayPay: Money;
  /** T-436. Paid leave days at the daily rate in force that day. ⛔ Not part of `basicPay`. */
  leavePay: Money;
  /** T-436. Unused Service Incentive Leave paid in cash at year end (the run covering 31 Dec). ⛔ Not part of `basicPay`. */
  silConversionPay: Money;
  /** T-436. The leave days this slip pays (frozen to the run on post) and the payout rows it takes. */
  leaveDayIds: string[];
  silPayouts: SilPayoutPlan[];
  grossPay: Money;
  advanceRecovered: Money;
  netPay: Money;
  // ---- T-190 statutory lines. The employee shares and withholding come out of the gross; the employer shares are a cost on top.
  sssEe: Money;
  philhealthEe: Money;
  pagibigEe: Money;
  withholding: Money;
  sssEr: Money;
  sssEc: Money;
  philhealthEr: Money;
  pagibigEr: Money;
  taxablePay: Money;
  /** Minimum-wage earner: the daily rate is at or under the store's minimum wage, so no withholding. */
  isMwe: boolean;
  /** Agencies NOT deducted (employee AND employer share 0) because the person has no number on file. */
  skippedAgencies: Agency[];
  /** The rate rows used; null for a skipped agency. */
  sssRateId: string | null;
  philhealthRateId: string | null;
  pagibigRateId: string | null;
}

export interface PayRunPreview {
  /** T-190. What is NOT yet confirmed (each names the agency, the withholding table or the minimum wage). A POST refuses while any is. */
  unconfirmedRates: string[];
  /** T-190. Every person and agency with no number on file: that agency is not deducted for them. */
  missingGovernmentIds: { personId: string; personName: string; agency: Agency }[];
  slips: PayslipDraft[];
  totalGross: Money;
  totalNet: Money;
  totalAdvanceRecovered: Money;
  /** ⛔ Days a manager has not settled. Excluded from pay and COUNTED — a run that silently
   *  skipped them would look identical to a run where nobody worked. */
  needsReviewDays: number;
  /** Employments with payable days but NO rate in force. ⚠️ Refused, never paid at zero. */
  unratedEmployments: { employmentId: string; personName: string; days: number }[];
  /** ⭐ Overtime recorded across the period that nobody has approved. Shown, never paid. */
  unapprovedOtMinutes: number;
  /**
   * ⛔ **T-194 / DEF-111.** Days the attendance engine credited ZERO minutes and on which nobody
   * has yet made an overtime decision. **Held back — not paid, and deliberately NOT frozen**, so
   * the pending overtime survives to be approved and paid by a later run.
   *
   * Same contract as `needsReviewDays`: excluded from pay and COUNTED, because a run that silently
   * skipped them would look identical to a run where nobody worked.
   */
  heldZeroCreditDays: number;
}

/**
 * ⭐ What a run WOULD pay. Read-only — computes, posts nothing, changes nothing.
 *
 * ⚠️ The rate is resolved **per day**, not once per period, so a raise mid-period pays the old
 * rate before it and the new rate after. That is what an effective date means.
 */
export async function previewPayRun(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; periodStart: string; periodEnd: string },
): Promise<PayRunPreview> {
  const run = (trx: Tx) => buildPreview(trx, actor, input, false);
  return run(tx);
}

/**
 * The preview, and the one place the numbers are made. `forPost` takes the person locks (in id order) BEFORE reading month-to-date,
 * so a post and a void for the same person run one after the other and the post sees the void's result (T-190 case 21).
 */
async function buildPreview(
  trx: Tx,
  actor: Actor,
  input: { storeId: string; periodStart: string; periodEnd: string },
  forPost: boolean,
): Promise<PayRunPreview> {
  {
    await authorize(trx, actor, 'run_payroll', { storeId: input.storeId });

    const config = await attendanceConfigRepo.findLive(trx, input.storeId);
    if (!config) {
      throw new Error(
        'previewPayRun: this store has no attendance configuration, so there is no shift length ' +
          'to price overtime or night differential against. Configure attendance first.',
      );
    }

    const days = await payrollRepo.payableDays(trx, actor.orgId, {
      storeId: input.storeId,
      from: input.periodStart,
      to: input.periodEnd,
    });
    const needsReviewDays = await payrollRepo.needsReviewCount(trx, actor.orgId, {
      storeId: input.storeId,
      from: input.periodStart,
      to: input.periodEnd,
    });

    // ⛔ **T-194 / DEF-111 — the hold, and it must happen HERE rather than in the query.**
    //
    // A day credited zero minutes is one the attendance engine refused to make a day of
    // (`compute-day.ts:557` — *"Below the half-day bar there is NO DAY"*), routing the whole stint
    // to pending overtime instead. If such a day entered the run it would be paid ₱0 **and frozen**
    // — and `adjustments.ts` refuses to touch a frozen day, so its overtime could never afterwards
    // be approved. The stint would be silently destroyed, which is the exact opposite of what the
    // pending status exists to do.
    //
    // ⚠️ `approvedOtMinutes === 0` is a DECISION OF ZERO and is NOT held: a manager who looked at
    // the stint and approved nothing has settled that day, so the run pays it ₱0 and freezes it.
    // Only `null` — nobody decided — is held. Do not collapse this to a falsy check; the same
    // distinction is what DEF-109's fix rests on.
    //
    // ⛔ Not a `where` clause: a day filtered out in SQL is invisible to the run and therefore
    // neither frozen nor counted. T-158: *"a rule buried in a query is a rule the next screen
    // forgets."*
    const isHeld = (d: (typeof days)[number]) =>
      d.computedMinutes <= 0 && d.approvedOtMinutes === null;
    const heldZeroCredit = days.filter(isHeld);
    const payable = days.filter((d) => !isHeld(d));

    const byEmployment = new Map<string, typeof days>();
    for (const d of payable) {
      const list = byEmployment.get(d.employmentId) ?? [];
      list.push(d);
      byEmployment.set(d.employmentId, list);
    }

    const roster = await payrollRepo.employmentsForStore(trx, actor.orgId, input.storeId);
    const nameOf = new Map(roster.map((r) => [r.id, r.personName]));

    type Base = Omit<PayslipDraft, StatutoryDraftKeys> & { dailyRate: Money };
    const bases: Base[] = [];
    const unratedEmployments: PayRunPreview['unratedEmployments'] = [];

    // ⭐ T-436: paid leave days and the year-end SIL payout. A person with leave but no attendance (or only the payout) still gets a slip.
    const leavePlan = await planLeavePayroll(trx, actor.orgId, {
      storeId: input.storeId,
      from: input.periodStart,
      to: input.periodEnd,
    });
    const employmentIds = new Set<string>([
      ...byEmployment.keys(),
      ...leavePlan.leaveByEmployment.keys(),
      ...leavePlan.payoutsByEmployment.keys(),
    ]);

    for (const employmentId of employmentIds) {
      const theirDays = byEmployment.get(employmentId) ?? [];
      const leaveLine = leavePlan.leaveByEmployment.get(employmentId);
      const silPayouts = leavePlan.payoutsByEmployment.get(employmentId) ?? [];
      // ⭐ Per-day rate resolution. The LAST day's rate row is the one recorded on the payslip,
      // because that is the rate in force at the end of the period the slip covers.
      const inputs: DayInput[] = [];
      let payRateId: string | null = null;
      let dailyRateAtEnd: Money = ZERO;
      let missingRate = 0;

      for (const d of theirDays) {
        const rate = await payrollRepo.rateInForceOn(trx, actor.orgId, employmentId, d.shiftDay);
        if (!rate) {
          missingRate++;
          continue;
        }
        if (rate.basis !== 'daily') {
          throw new Error(
            `previewPayRun: ${nameOf.get(employmentId) ?? 'this employment'} is on an "${rate.basis}" ` +
              'rate, and only a daily basis has a compute path. Of 126 live v1 staff exactly one ' +
              'was hourly — the path is deliberately unwritten rather than guessed.',
          );
        }
        payRateId = rate.id;
        dailyRateAtEnd = money(rate.amount);
        inputs.push({
          shiftDay: d.shiftDay,
          isHalfDay: d.isHalfDay,
          // ⛔ **APPROVED overtime, never PENDING.** `attendance_days.pendingOtMinutes` carries
          // the attendance lane's warning addressed to this module: *"Recorded, never paid here —
          // the approval gate is Phase 5, and auto-paying it is exactly what the pending status
          // exists to prevent."* T-189 paid it anyway; DEF-109. The gate is now the
          // `overtime_approved` adjustment, and `null` (nobody decided) pays NOTHING.
          //
          // ⚠️ Capped at what was actually worked: a manager cannot approve more overtime than
          // the day recorded, whatever they type.
          otMinutes: Math.min(d.approvedOtMinutes ?? 0, d.pendingOtMinutes),
          nightDiffMinutes: d.nightDiffMinutes,
          holidayMinutes: d.holidayMinutes,
          computedMinutes: d.computedMinutes,
          holidayType: d.holidayType,
          dailyRate: rate.amount,
        });
      }

      if (missingRate > 0) {
        // ⛔ Never paid at zero. A day priced at ₱0 is indistinguishable from a day nobody worked.
        unratedEmployments.push({
          employmentId,
          personName: nameOf.get(employmentId) ?? 'unknown',
          days: missingRate,
        });
      }
      payRateId = payRateId ?? leaveLine?.payRateId ?? silPayouts[silPayouts.length - 1]?.payRateId ?? null;
      if ((inputs.length === 0 && !leaveLine && silPayouts.length === 0) || !payRateId) continue;
      // T-190 audit gap 5: minimum-wage earner status is judged on the daily rate IN FORCE AT period_end, not on the last day worked.
      const rateAtEnd = await payrollRepo.rateInForceOn(trx, actor.orgId, employmentId, input.periodEnd);
      if (rateAtEnd && rateAtEnd.basis === 'daily') dailyRateAtEnd = money(rateAtEnd.amount);
      // DEF-671: a leave-only / SIL-payout-only slip has no worked-day rate. Seed from what it was actually paid at, never ZERO (which reads as MWE).
      if (compare(dailyRateAtEnd, ZERO) === 0) {
        const lastSil = silPayouts[silPayouts.length - 1];
        if (leaveLine && leaveLine.dayIds.length > 0) dailyRateAtEnd = divideMoney(leaveLine.leavePay, leaveLine.dayIds.length);
        else if (lastSil) dailyRateAtEnd = lastSil.dailyRate;
      }

      // ⭐ Every premium is now a per-store SETTING rather than a constant (T-189b, Ian's
      // "configurable to x1.25 or fix amount" and "holiday must be configurable too").
      const pay = computePay(inputs, {
        requiredHoursPerShift: config.requiredHoursPerShift,
        overtimeMode: config.overtimeMode,
        overtimeMultiplier: config.overtimeMultiplier,
        overtimeFixedHourly: config.overtimeFixedHourly,
        nightDiffMultiplier: config.nightDiffMultiplier,
        holidayRegularMultiplier: config.holidayRegularMultiplier,
        holidaySpecialNonWorkingMultiplier: config.holidaySpecialNonWorkingMultiplier,
        holidaySpecialWorkingMultiplier: config.holidaySpecialWorkingMultiplier,
      });

      // ⚠️ What the days recorded but nobody approved. Shown, never paid.
      const unapprovedOtMinutes = theirDays.reduce(
        (n, d) => n + Math.max(0, d.pendingOtMinutes - (d.approvedOtMinutes ?? 0)),
        0,
      );

      const personId = theirDays[0]?.personId ?? leaveLine?.personId ?? silPayouts[0]!.personId;
      const leavePay = leaveLine?.leavePay ?? ZERO;
      const silConversionPay = sumMoney(silPayouts.map((p) => p.amount));
      const grossPay = add(pay.grossPay, leavePay, silConversionPay);
      const outstanding = await outstandingAdvance(trx, actor.orgId, personId);

      bases.push({
        employmentId,
        personId,
        personName: nameOf.get(employmentId) ?? 'unknown',
        payRateId,
        dayIds: theirDays.map((d) => d.id),
        unapprovedOtMinutes,
        ...pay,
        leavePay,
        silConversionPay,
        leaveDayIds: leaveLine?.dayIds ?? [],
        silPayouts,
        // T-436 leave + SIL are compensation: they are in the gross BEFORE the statutory pass reads it.
        grossPay,
        // Placeholders: the statutory pass below sets the advance and the net AFTER the contributions and the withholding.
        advanceRecovered: outstanding,
        netPay: grossPay,
        dailyRate: dailyRateAtEnd,
      });
    }
    for (const u of leavePlan.unrated) {
      unratedEmployments.push({ employmentId: u.employmentId, personName: nameOf.get(u.employmentId) ?? 'unknown', days: u.days });
    }

    bases.sort((a, b) => a.personName.localeCompare(b.personName) || a.employmentId.localeCompare(b.employmentId));

    // ---- T-190: statutory contributions and withholding, from the confirmed tables in force on the run's period_end.
    const { slips, unconfirmedRates, missingGovernmentIds } = await applyStatutory(trx, actor, input, config.payrollPeriodType, bases, forPost);

    return {
      unconfirmedRates,
      missingGovernmentIds,
      slips,
      totalGross: add(ZERO, ...slips.map((s) => s.grossPay)),
      totalNet: add(ZERO, ...slips.map((s) => s.netPay)),
      totalAdvanceRecovered: add(ZERO, ...slips.map((s) => s.advanceRecovered)),
      needsReviewDays,
      unratedEmployments,
      // ⚠️ The store-wide figure must include the HELD days' overtime as well as the payable days'.
      // A held day is *entirely* pending overtime — that is what makes it held — so leaving it out
      // would under-report the very thing the manager is being asked to act on, and would do it
      // most for the days that need acting on most. The per-slip figure stays payable-days-only,
      // because a slip should only account for the days it actually pays.
      unapprovedOtMinutes:
        slips.reduce((n, x) => n + x.unapprovedOtMinutes, 0) +
        heldZeroCredit.reduce((n, d) => n + d.pendingOtMinutes, 0),
      heldZeroCreditDays: heldZeroCredit.length,
    };
  }
}

type StatutoryDraftKeys =
  | 'sssEe' | 'philhealthEe' | 'pagibigEe' | 'withholding' | 'sssEr' | 'sssEc' | 'philhealthEr' | 'pagibigEr'
  | 'taxablePay' | 'isMwe' | 'skippedAgencies' | 'sssRateId' | 'philhealthRateId' | 'pagibigRateId';

function emptyPrior(): AgencyPrior {
  return { base: ZERO, ee: ZERO, er: ZERO, ec: ZERO };
}

/**
 * T-190 S3. Turns the pay of each person into payslip drafts with SSS / PhilHealth / Pag-IBIG / withholding.
 *
 * Lookups are all AS OF the run's `period_end`. A missing row is a typed refusal that names what is missing, never "taxable" or zero;
 * an unconfirmed row is returned in `unconfirmedRates` (the preview warns; `postPayRun` refuses). Month-to-date comes from the person's
 * earlier POSTED, non-voided payslips of the calendar month (any store, any employment), counting an agency only where it WAS deducted;
 * in a post the people are locked first. Within one run a person's second payslip sees the first.
 */
async function applyStatutory(
  trx: Tx,
  actor: Actor,
  input: { storeId: string; periodStart: string; periodEnd: string },
  frequency: 'monthly' | 'semi_monthly' | 'weekly',
  bases: (Omit<PayslipDraft, StatutoryDraftKeys> & { dailyRate: Money })[],
  forPost: boolean,
): Promise<{ slips: PayslipDraft[]; unconfirmedRates: string[]; missingGovernmentIds: PayRunPreview['missingGovernmentIds'] }> {
  if (bases.length === 0) return { slips: [], unconfirmedRates: [], missingGovernmentIds: [] };
  const on = input.periodEnd;
  const unconfirmedRates: string[] = [];

  const rates = {} as Record<Agency, ContributionRate>;
  for (const agency of AGENCIES) {
    const row = await statutoryRepo.rateInForceOn(trx, actor.orgId, agency, on);
    if (!row) {
      throw refuse(
        `previewPayRun: no ${AGENCY_LABEL[agency]} contribution rate is in force on ${on}`,
        `There is no ${AGENCY_LABEL[agency]} contribution rate in force on ${on}. Add and confirm it under payroll rates before running payroll.`,
      );
    }
    if (!row.confirmedAt) unconfirmedRates.push(`${AGENCY_LABEL[agency]} contribution rate (from ${row.effectiveFrom})`);
    rates[agency] = row as unknown as ContributionRate;
  }

  const set = await statutoryRepo.bracketSetInForceOn(trx, actor.orgId, frequency, on);
  if (!set) {
    throw refuse(
      `previewPayRun: no ${frequency} withholding brackets in force on ${on}`,
      `There is no ${FREQUENCY_LABEL[frequency]} withholding tax table in force on ${on}. Add and confirm it under payroll rates before running payroll.`,
    );
  }
  if (!set.confirmed) unconfirmedRates.push(`${FREQUENCY_LABEL[frequency]} withholding tax table (from ${set.effectiveFrom})`);
  const brackets: WithholdingBracket[] = set.rows;

  const minWage = await statutoryRepo.minimumWageInForceOn(trx, actor.orgId, input.storeId, on);
  if (!minWage) {
    throw refuse(
      `previewPayRun: no minimum wage in force on ${on} for store ${input.storeId}`,
      `This store has no minimum wage on file for ${on}. Add and confirm it under payroll rates before running payroll.`,
    );
  }
  if (!minWage.confirmedAt) unconfirmedRates.push(`minimum wage (from ${minWage.effectiveFrom})`);
  const minimum = money(minWage.dailyRate);

  const personIds = [...new Set(bases.map((b) => b.personId))];
  if (forPost) await statutoryRepo.lockPersons(trx, actor.orgId, personIds);
  const ids = new Map((await statutoryRepo.governmentIdsFor(trx, actor.orgId, personIds)).map((r) => [r.personId, r]));

  const priorOf = new Map<string, Record<Agency, AgencyPrior>>();
  for (const personId of personIds) {
    const prior: Record<Agency, AgencyPrior> = { sss: emptyPrior(), philhealth: emptyPrior(), pagibig: emptyPrior() };
    for (const r of await statutoryRepo.monthToDate(trx, actor.orgId, personId, on)) {
      prior[r.agency] = { base: money(r.base), ee: money(r.ee), er: money(r.er), ec: money(r.ec) };
    }
    priorOf.set(personId, prior);
  }

  const missingGovernmentIds: PayRunPreview['missingGovernmentIds'] = [];
  const slips: PayslipDraft[] = [];
  // DEF-670: advance already recovered by this person's EARLIER slips in this run (a second employment must not recover it again).
  const advanceTakenOf = new Map<string, Money>();
  for (const b of bases) {
    const gid = ids.get(b.personId);
    const skipped: Agency[] = [];
    if (!gid?.sssNo) skipped.push('sss');
    if (!gid?.philhealthNo) skipped.push('philhealth');
    if (!gid?.pagibigNo) skipped.push('pagibig');
    for (const agency of skipped) missingGovernmentIds.push({ personId: b.personId, personName: b.personName, agency });

    const isMwe = compare(b.dailyRate, minimum) <= 0;
    const prior = priorOf.get(b.personId)!;
    const { dailyRate: _dailyRate, ...draft } = b;
    void _dailyRate;
    const alreadyTaken = advanceTakenOf.get(b.personId) ?? ZERO;
    // the placeholder carried the outstanding advance; less what this person's earlier slips in the run already took
    const outstanding = compare(draft.advanceRecovered, alreadyTaken) > 0 ? subtract(draft.advanceRecovered, alreadyTaken) : ZERO;
    const r = computeStatutory({
      basicPay: b.basicPay,
      grossPay: b.grossPay,
      isMwe,
      rates,
      prior,
      skipped,
      brackets,
      advanceOutstanding: outstanding,
    });

    // The person's next payslip in this same run (a second employment) must see this one.
    const take = (agency: Agency, base: Money, ee: Money, er: Money, ec: Money) => {
      const p = prior[agency];
      prior[agency] = { base: add(p.base, base), ee: add(p.ee, ee), er: add(p.er, er), ec: add(p.ec, ec) };
    };
    if (!skipped.includes('sss')) take('sss', rates.sss.baseKind === 'gross' ? b.grossPay : b.basicPay, r.sss.ee, r.sss.er, r.sss.ec);
    if (!skipped.includes('philhealth')) take('philhealth', rates.philhealth.baseKind === 'gross' ? b.grossPay : b.basicPay, r.philhealth.ee, r.philhealth.er, ZERO);
    if (!skipped.includes('pagibig')) take('pagibig', rates.pagibig.baseKind === 'gross' ? b.grossPay : b.basicPay, r.pagibig.ee, r.pagibig.er, ZERO);

    advanceTakenOf.set(b.personId, add(alreadyTaken, r.advanceRecovered));

    slips.push({
      ...draft,
      advanceRecovered: r.advanceRecovered,
      netPay: r.netPay,
      sssEe: r.sss.ee,
      philhealthEe: r.philhealth.ee,
      pagibigEe: r.pagibig.ee,
      withholding: r.withholding,
      sssEr: r.sss.er,
      sssEc: r.sss.ec,
      philhealthEr: r.philhealth.er,
      pagibigEr: r.pagibig.er,
      taxablePay: r.taxablePay,
      isMwe,
      skippedAgencies: skipped,
      sssRateId: skipped.includes('sss') ? null : rates.sss.id,
      philhealthRateId: skipped.includes('philhealth') ? null : rates.philhealth.id,
      pagibigRateId: skipped.includes('pagibig') ? null : rates.pagibig.id,
    });
  }
  return { slips, unconfirmedRates, missingGovernmentIds };
}

/**
 * ⭐ What a person still owes on `1230`, read from the LEDGER.
 *
 * ⚠️ v1 records this trap in as many words: *"advance sourced from the AUTHORITATIVE account
 * balance, NOT the projection — else a failed post rebuild double-recovers next period."* There is
 * no projection here to be tempted by, and there must never be one.
 */
export async function outstandingAdvance(
  tx: Tx,
  orgId: string,
  personId: string,
): Promise<Money> {
  const rows = (await tx.execute(
    sql`
      select coalesce(sum(jl.debit - jl.credit), 0)::text as total
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      where je.org_id = ${orgId}
        and je.status <> 'draft'
        and a.code = ${PAYROLL_ADVANCE_ACCOUNT}
        and jl.party_type = 'employee'
        and jl.party_id = ${personId}
    `,
  )) as unknown as { total: string }[];
  // T-371 R3/R4 — the `sum` comes back as numeric text; it is minted through `money()` as it stands, never round-tripped
  // through a float (`Number(...).toFixed(2)` lost exactness past 2^53 and turned a malformed value into "NaN").
  return money(rows[0]?.total ?? '0');
}

// -------------------------------------------------------------------------------------

/**
 * Posts a run: one journal per payslip, then freezes the days it paid.
 *
 * ```
 * Dr  6100  Salaries and wages          gross
 *     Cr  1230  Advances to employees          advance recovered   party = the person
 *     Cr  <the run's money account>             net
 * ```
 *
 * ⛔ **A person may not post a run that pays their own employment.** Bible §16.6 — *"three
 * independent self-dealing blocks, preserve all three."* ⚠️ Admins are NOT exempt here, unlike
 * attendance: an admin paying themselves is precisely the case the block exists for.
 */
export async function postPayRun(
  tx: Tx,
  actor: Actor,
  input: {
    storeId: string;
    periodStart: string;
    periodEnd: string;
    moneyAccountId: string;
    entryDate?: string;
    notes?: string | null;
  },
): Promise<{ runId: string; payslips: number; totalNet: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'run_payroll', { storeId: input.storeId });

    const preview = await buildPreview(trx, actor, input, true);
    // ⚠️ UNRATED IS CHECKED FIRST, and the order is the point. When the only people who worked
    // have no rate, both conditions are true — and "nothing to pay" is the useless half of the
    // answer. Naming who has no rate is what someone can act on.
    if (preview.unratedEmployments.length > 0) {
      const who = preview.unratedEmployments.map((u) => `${u.personName} (${u.days}d)`).join(', ');
      throw new Error(
        `postPayRun: ${who} worked days with no pay rate in force. ⛔ Set a rate first — a day ` +
          'priced at zero is indistinguishable from a day nobody worked.',
      );
    }
    if (preview.slips.length === 0) {
      throw new Error(
        'postPayRun: nothing to pay in that period. ' +
          (preview.needsReviewDays > 0
            ? `${preview.needsReviewDays} day(s) still need a manager's review and are deliberately excluded.`
            : 'No payable attendance days were found.'),
      );
    }

    // ⛔ T-190: a POST uses only CONFIRMED statutory rows (preview works and warns). Names every unconfirmed table.
    if (preview.unconfirmedRates.length > 0) {
      throw refuse(
        `postPayRun: unconfirmed statutory rates: ${preview.unconfirmedRates.join('; ')}`,
        `These payroll tables are not confirmed yet: ${preview.unconfirmedRates.join('; ')}. The accountant must confirm them before payroll can be posted.`,
      );
    }

    // ⛔ Self-dealing. Checked against the EMPLOYMENTS being paid, not the actor's role.
    const own = preview.slips.find((s) => s.personId === actor.personId);
    if (own) {
      throw new Error(
        'postPayRun: this run pays your own employment. ⛔ Somebody else has to post it — an ' +
          'admin paying themselves is exactly the case this block exists for.',
      );
    }

    const account = await moneyAccountsRepo.getById(trx, actor.orgId, input.moneyAccountId);
    if (!account) throw new Error('postPayRun: that money account does not exist.');
    if (account.storeId !== input.storeId) {
      throw new Error('postPayRun: that money account belongs to another store.');
    }
    assertPayrollMoneyAccount(account, 'postPayRun');

    const entryDate = input.entryDate ?? input.periodEnd;
    const runId = (
      await payrollRepo.insertPayRun(trx, {
        orgId: actor.orgId,
        storeId: input.storeId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        moneyAccountId: input.moneyAccountId,
        notes: input.notes ?? null,
        createdBy: actor.personId,
      })
    ).id;

    for (const slip of preview.slips) {
      const payslipId = (
        await payrollRepo.insertPayslip(trx, {
          orgId: actor.orgId,
          runId,
          employmentId: slip.employmentId,
          personId: slip.personId,
          payRateId: slip.payRateId,
          // T-371 — `days_worked` is numeric(6,2); minted at that shape, not passed as a bare string.
          daysWorked: decimal(slip.daysWorked.toFixed(2), '6,2'),
          minutesWorked: slip.minutesWorked,
          otMinutes: slip.otMinutes,
          nightDiffMinutes: slip.nightDiffMinutes,
          holidayMinutes: slip.holidayMinutes,
          basicPay: slip.basicPay,
          otPay: slip.otPay,
          nightDiffPay: slip.nightDiffPay,
          holidayPay: slip.holidayPay,
          leavePay: slip.leavePay,
          silConversionPay: slip.silConversionPay,
          grossPay: slip.grossPay,
          advanceRecovered: slip.advanceRecovered,
          netPay: slip.netPay,
          sssEe: slip.sssEe,
          philhealthEe: slip.philhealthEe,
          pagibigEe: slip.pagibigEe,
          withholding: slip.withholding,
          sssEr: slip.sssEr,
          sssEc: slip.sssEc,
          philhealthEr: slip.philhealthEr,
          pagibigEr: slip.pagibigEr,
          taxablePay: slip.taxablePay,
          isMwe: slip.isMwe,
          skippedAgencies: slip.skippedAgencies,
          sssRateId: slip.sssRateId,
          philhealthRateId: slip.philhealthRateId,
          pagibigRateId: slip.pagibigRateId,
          journalEntryId: null,
        })
      ).id;

      const sssOwed = add(slip.sssEe, slip.sssEr, slip.sssEc);
      const philhealthOwed = add(slip.philhealthEe, slip.philhealthEr);
      const pagibigOwed = add(slip.pagibigEe, slip.pagibigEr);
      const sssCost = add(slip.sssEr, slip.sssEc);
      const credit = (accountCode: string, amount: Money) =>
        compare(amount, ZERO) > 0 ? [{ accountCode, storeId: input.storeId, credit: amount }] : [];
      const debit = (accountCode: string, amount: Money) =>
        compare(amount, ZERO) > 0 ? [{ accountCode, storeId: input.storeId, debit: amount }] : [];

      // ⛔ The §16.7 double-count trap: the EMPLOYEE share is already inside 6100 gross, so only the EMPLOYER share is debited to
      // 6110-6130. Expense = gross + employer share, never more. The payable (2210-2240) holds both sides until T-193 remits.
      const lines = [
        {
          accountCode: SALARIES_ACCOUNT,
          storeId: input.storeId,
          debit: slip.grossPay,
        },
        ...debit(STATUTORY_EXPENSE_ACCOUNT.sss, sssCost),
        ...debit(STATUTORY_EXPENSE_ACCOUNT.philhealth, slip.philhealthEr),
        ...debit(STATUTORY_EXPENSE_ACCOUNT.pagibig, slip.pagibigEr),
        ...credit(STATUTORY_PAYABLE_ACCOUNT.sss, sssOwed),
        ...credit(STATUTORY_PAYABLE_ACCOUNT.philhealth, philhealthOwed),
        ...credit(STATUTORY_PAYABLE_ACCOUNT.pagibig, pagibigOwed),
        ...credit(WITHHOLDING_PAYABLE_ACCOUNT, slip.withholding),
        ...(compare(slip.advanceRecovered, ZERO) > 0
          ? [
              {
                accountCode: PAYROLL_ADVANCE_ACCOUNT,
                storeId: input.storeId,
                credit: slip.advanceRecovered,
                partyType: 'employee',
                partyId: slip.personId,
              },
            ]
          : []),
        ...(compare(slip.netPay, ZERO) > 0
          ? [
              {
                accountCode: account.glAccountCode,
                storeId: input.storeId,
                credit: slip.netPay,
                ...payrollMoneyParty(account),
              },
            ]
          : []),
      ];

      const posted = await postEntry(trx, {
        orgId: actor.orgId,
        entryDate,
        sourceType: 'payrollpayslip',
        sourceId: payslipId,
        idempotencyKey: `payslip:${payslipId}:post`,
        memo: `Payroll ${input.periodStart} to ${input.periodEnd} — ${slip.personName}`,
        postedBy: actor.personId,
        lines,
      });
      await payrollRepo.setPayslipEntry(trx, payslipId, posted.entryId);

      // ⭐ The freeze. `attendance_days.frozen_by_pay_run_id` has waited for this since T-157, and
      // the guard that reads it is already live in `adjudicate.ts` and `adjustments.ts`.
      await payrollRepo.freezeDays(trx, slip.dayIds, runId);
      // ⭐ T-436: the same freeze for the leave days this slip paid, and the year-end payout rows it took.
      await applyLeaveToRun(trx, actor, { runId, storeId: input.storeId, leaveDayIds: slip.leaveDayIds, payouts: slip.silPayouts });
    }

    const ok = await payrollRepo.markPayRunPosted(trx, actor.orgId, runId, actor.personId);
    if (!ok) throw new Error('postPayRun: the run was posted by someone else first.');

    return {
      runId,
      payslips: preview.slips.length,
      totalNet: formatMoney(preview.totalNet),
    };
  };
  return run(tx);
}

/**
 * Voids a posted run: reverses every payslip's entry and ⭐ **unfreezes the days it paid**.
 *
 * ⚠️ This is the ONLY place a freeze is lifted, and it is why the pair is nullable rather than a
 * boolean. A voided run did not pay, so those days must be payable again — leaving them frozen
 * would make the period permanently unpayable by anyone.
 */
export async function voidPayRun(
  tx: Tx,
  actor: Actor,
  input: { runId: string; reason: string; on?: string },
): Promise<{ reversed: number; unfrozenDays: number }> {
  const run = async (trx: Tx) => {
    const found = await payrollRepo.getPayRun(trx, actor.orgId, input.runId);
    if (!found) throw new Error('voidPayRun: that run does not exist.');
    await authorize(trx, actor, 'run_payroll', { storeId: found.storeId });

    const reason = input.reason.trim();
    if (!reason) throw new Error('voidPayRun: voiding a run needs a reason.');
    // T-193: hold the run before judging it, so a statutory payment in flight finishes first and a payment that starts after waits for us.
    const payRun = (await payrollRepo.lockPayRun(trx, actor.orgId, input.runId)) ?? found;
    if (payRun.status !== 'posted') {
      throw new Error(`voidPayRun: this run is ${payRun.status}, not posted.`);
    }

    const standing = await statutoryPaymentsRepo.postedForRun(trx, actor.orgId, input.runId);
    if (standing.length > 0) {
      const first = standing[0]!;
      throw refuse(
        `voidPayRun: run ${input.runId} has a posted statutory payment (${first.referenceNo}).`,
        `This pay run cannot be voided: payment ${first.referenceNo} to the agency for its month is still recorded. Void that payment first, then void the run.`,
      );
    }

    const slips = await payrollRepo.listPayslips(trx, input.runId);
    // ⛔ T-190: lock every affected person (id order) BEFORE the status changes, so a concurrent post's month-to-date sees this void.
    await statutoryRepo.lockPersons(trx, actor.orgId, slips.map((x) => x.personId));
    let reversed = 0;
    for (const slip of slips) {
      if (!slip.journalEntryId) continue;
      await reverseEntry(trx, {
        orgId: actor.orgId,
        entryId: slip.journalEntryId,
        reason,
        reversedBy: actor.personId,
        reversalDate: input.on ?? payRun.periodEnd,
      } as never);
      reversed++;
    }

    const unfrozenDays = await payrollRepo.unfreezeDaysOfRun(trx, input.runId);
    // ⭐ T-436: a voided run did not pay its leave days or its year-end payout, so both are payable again.
    await releaseLeaveOfRun(trx, input.runId);
    const ok = await payrollRepo.markPayRunVoided(trx, actor.orgId, input.runId, {
      voidedBy: actor.personId,
      reason,
    });
    if (!ok) throw new Error('voidPayRun: the run was voided by someone else first.');

    return { reversed, unfrozenDays };
  };
  return run(tx);
}

// -------------------------------------------------------------------------------------
// T-191 — 13th-month pay. See this file's own top comment for why the circular import is safe.
export * from './thirteenth-month';
// T-192 — separation, final pay, clearance. Same circular-import shape and same safety reasoning
// (`outstandingAdvance`/`PAYROLL_ADVANCE_ACCOUNT` used only inside function bodies).
export * from './separation';

/**
 * T-486 (DEF-776) - the party a payroll payout's money-account credit must carry.
 * `1140 E-wallet` requires party `money_account` (migration 0007 `journal_lines_party_requirement`); every other
 * payable account carries none. Same inline shape as `ar/index.ts` collections.
 */
export function payrollMoneyParty(account: { id: string; glAccountCode: string }):
  | { partyType: 'money_account'; partyId: string }
  | Record<string, never> {
  return account.glAccountCode === EXPENSE_FUNDING_ACCOUNTS.ONLINE
    ? { partyType: 'money_account' as const, partyId: account.id }
    : {};
}

/**
 * T-486 (DEF-776) - payroll cannot be paid from `1120 Cash on hand - staff custodian`. A float belongs to one person
 * through a cash request; a payroll payout has no request to attach, and inventing one would corrupt `floatPositionOf`
 * (mirrors `service-charge/index.ts`). Refused BY NAME, before anything is computed or written.
 */
export function assertPayrollMoneyAccount(account: { glAccountCode: string }, fn: string): void {
  if (account.glAccountCode === EXPENSE_FUNDING_ACCOUNTS.CASH_STAFF) {
    throw refuse(
      `${fn}: payroll cannot be paid from a staff cash float (GL 1120).`,
      'That account is a staff cash float, which belongs to one person through a cash request. Payroll cannot be paid from it. Choose an office or e-wallet account.',
    );
  }
}

// T-193 S3 - paying the agencies (circular import is safe: the helpers are only used inside function bodies).
export * from './statutory-payments';
