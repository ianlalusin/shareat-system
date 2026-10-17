/**
 * T-436 S5 - what leave does to payroll. Spec D9-D12.
 *
 * Kept out of `payroll/index.ts` on purpose (another lane is changing that file at the same time): payroll calls THREE things here -
 * `planLeavePayroll` (read-only, used by the preview), `applyLeaveToRun` (post) and `releaseLeaveOfRun` (void) - and
 * `settleSilAtSeparation` / `releaseSilOfSeparation` from the separation module.
 *
 * ## What is paid, and where it goes
 * - `leave_pay`: each approved, PAID, real leave day filed at the store, at the daily rate in force THAT day - no overtime, night
 *   differential or holiday premium. Maternity and paternity are recorded unpaid here (SSS pays maternity; paternity pay is T-190/T-193).
 * - `sil_conversion_pay`: the person's unused SIL days x the designated employment's rate on 31 Dec, in the run of that
 *   employment's store whose period contains 31 Dec. ONE payout per PERSON per year, whatever number of concurrent jobs.
 * - ⛔ NEITHER is part of `basic_pay`: the 13th month reads `basic_pay`, and PD 851 excludes leave conversions from it.
 *
 * Freezing: a paid leave day freezes to the run (`frozen_by_pay_run_id`), exactly as an attendance day does; the payout row freezes in
 * the same transaction, so a second run finds it taken. Voiding the run releases both.
 */
import { advisoryLocksRepo, journalRepo, leaveRepo, payrollRepo, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { ZERO, add, decimal, money, multiply, type Money } from '@shareat/core/money';
import { refuse } from '../shared/refusal';
import { postEntry } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';
import { audit } from './audit';
import { computeSilBalance } from './checks';
import { cmpIso, isoAfter, isoBefore, isoOnOrAfter, isoOnOrBefore } from './dates';

/** `6100 Salaries and wages` - the same account a payslip's gross debits. */
const SALARIES_ACCOUNT = '6100';
export const SIL_COMMUTATION_SOURCE = 'silcommutation';

export interface LeavePayLine {
  employmentId: string;
  personId: string;
  dayIds: string[];
  leavePay: Money;
  /** The rate row in force on the LAST paid leave day. */
  payRateId: string | null;
}

export interface SilPayoutPlan {
  personId: string;
  employmentId: string;
  year: number;
  /** Whole days. */
  days: number;
  dailyRate: Money;
  amount: Money;
  payRateId: string;
}

export interface LeavePayrollPlan {
  leaveByEmployment: Map<string, LeavePayLine>;
  payoutsByEmployment: Map<string, SilPayoutPlan[]>;
  /** Paid leave days or a payout that cannot be priced because the job has no rate in force. Refused by the caller, never paid at zero. */
  unrated: { employmentId: string; personId: string; days: number }[];
}

/** Money, summed. `[]` is ZERO. */
export const sumMoney = (values: readonly Money[]): Money => add(ZERO, ...values);

export async function planLeavePayroll(
  tx: Tx,
  orgId: string,
  input: { storeId: string; from: string; to: string },
): Promise<LeavePayrollPlan> {
  const plan: LeavePayrollPlan = { leaveByEmployment: new Map(), payoutsByEmployment: new Map(), unrated: [] };
  const missing = new Map<string, { personId: string; days: number }>();
  const noteMissing = (employmentId: string, personId: string) => {
    const m = missing.get(employmentId) ?? { personId, days: 0 };
    m.days += 1;
    missing.set(employmentId, m);
  };

  // --- leave pay -------------------------------------------------------------------------
  const days = await leaveRepo.payableLeaveDays(tx, orgId, input);
  for (const d of days) {
    const rate = await payrollRepo.rateInForceOn(tx, orgId, d.employmentId, d.leaveDate);
    if (!rate) {
      noteMissing(d.employmentId, d.personId);
      continue;
    }
    if (rate.basis !== 'daily') {
      throw refuse(
        `leave pay: employment ${d.employmentId} is on an "${rate.basis}" rate and only a daily basis has a compute path`,
        'This person is paid by the hour, and leave pay is only worked out for a daily rate. Set a daily rate before running payroll.',
      );
    }
    const line = plan.leaveByEmployment.get(d.employmentId) ?? {
      employmentId: d.employmentId,
      personId: d.personId,
      dayIds: [],
      leavePay: ZERO,
      payRateId: null,
    };
    line.dayIds.push(d.id);
    line.leavePay = add(line.leavePay, money(rate.amount));
    line.payRateId = rate.id;
    plan.leaveByEmployment.set(d.employmentId, line);
  }

  // --- the year-end SIL payout -------------------------------------------------------------
  // Every 31 Dec the period covers (a run is a fortnight or a month, so that is one at most; the loop is for the shape, not the count).
  const years: number[] = [];
  if (cmpIso(input.from, input.to) !== 1) {
    for (let y = Number(input.from.slice(0, 4)); years.length < 3 && y !== Number(input.to.slice(0, 4)) + 1; y++) years.push(y);
  }
  for (const year of years) {
    const dec31 = `${year}-12-31`;
    if (isoBefore(dec31, input.from) || isoAfter(dec31, input.to)) continue;
    const candidates = await leaveRepo.personsOpenAtStoreOn(tx, orgId, input.storeId, dec31);
    // ⛔ Each person's leave lock is taken (in a stable order, person id) BEFORE their balance is read, so an approval that
    // committed or is committing is seen: the cash days and the approved paid days can never exceed the entitlement together.
    // postPayRun reads this plan inside its own transaction, so the locks are held until the payout rows are written.
    for (const c of [...candidates].sort((a, b) => cmpIso(a.personId, b.personId))) {
      await advisoryLocksRepo.lockPersonLeave(tx, c.personId);
      const spans = await leaveRepo.listEmploymentSpans(tx, orgId, c.personId);
      const open = spans.filter((s) => isoOnOrBefore(s.startedOn, dec31) && (s.endedOn === null || isoOnOrAfter(s.endedOn, dec31)));
      // Designated: open on 31 Dec with the EARLIEST started_on (ties: lowest id). `listEmploymentSpans` is ordered by (started_on, id).
      const designated = open[0];
      if (!designated || designated.storeId !== input.storeId) continue;
      if (await leaveRepo.yearIsClosed(tx, orgId, c.personId, year)) continue;
      const balance = await computeSilBalance(tx, orgId, c.personId, year);
      if (balance.remaining <= 0) continue;
      const rate = await payrollRepo.rateInForceOn(tx, orgId, designated.id, dec31);
      if (!rate) {
        noteMissing(designated.id, c.personId);
        continue;
      }
      const dailyRate = money(rate.amount);
      const entry: SilPayoutPlan = {
        personId: c.personId,
        employmentId: designated.id,
        year,
        days: balance.remaining,
        dailyRate,
        amount: multiply(dailyRate, String(balance.remaining)),
        payRateId: rate.id,
      };
      plan.payoutsByEmployment.set(designated.id, [...(plan.payoutsByEmployment.get(designated.id) ?? []), entry]);
    }
  }

  for (const [employmentId, m] of missing) plan.unrated.push({ employmentId, personId: m.personId, days: m.days });
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Post and void a run

/** Freezes the leave days a payslip paid and takes the payout rows for the run. Inside postPayRun's transaction. */
export async function applyLeaveToRun(
  tx: Tx,
  by: Actor,
  input: { runId: string; storeId: string; leaveDayIds: readonly string[]; payouts: readonly SilPayoutPlan[] },
): Promise<void> {
  await leaveRepo.freezeLeaveDays(tx, input.leaveDayIds, input.runId);
  for (const p of input.payouts) {
    await advisoryLocksRepo.lockPersonLeave(tx, p.personId); // already held from the plan; re-taking it in one transaction is free
    const claimed = await leaveRepo.claimCommutation(tx, {
      orgId: by.orgId,
      personId: p.personId,
      year: p.year,
      employmentId: p.employmentId,
      days: decimal(p.days.toFixed(2), '6,2'),
      dailyRate: p.dailyRate,
      amount: p.amount,
      createdBy: by.personId,
      payer: { runId: input.runId },
    });
    if (!claimed) {
      throw refuse(
        `postPayRun: the ${p.year} Service Incentive Leave payout of person ${p.personId} is already taken`,
        `The ${p.year} unused-leave payout for one of the people in this run has already been paid by another run or a final pay. Reload and preview the run again.`,
      );
    }
    await audit(tx, by, 'sil.commuted', {
      storeId: input.storeId,
      entityId: claimed.id,
      after: { personId: p.personId, year: p.year, days: p.days, amount: p.amount, employmentId: p.employmentId, payer: 'pay_run' },
    });
  }
}

/** Voiding a run lifts its leave freeze and releases its payouts: those days and that payout are payable again. */
export async function releaseLeaveOfRun(tx: Tx, runId: string): Promise<{ unfrozenLeaveDays: number; releasedPayouts: number }> {
  const unfrozenLeaveDays = await leaveRepo.unfreezeLeaveDaysOfRun(tx, runId);
  const released = await leaveRepo.releaseCommutationsOfRun(tx, runId);
  return { unfrozenLeaveDays, releasedPayouts: released.length };
}

// ---------------------------------------------------------------------------------------------
// Final pay (separation)

/**
 * When a person's LAST open employment is separated before 31 Dec, their unused SIL days are paid in the separation's final pay
 * instead of at year end: writes the payout row with `separation_id` and posts its own journal entry (Dr 6100, Cr the money account).
 * Does nothing when the person still holds another job, has no unused days, or the year's payout is already taken.
 */
export async function settleSilAtSeparation(
  tx: Tx,
  by: Actor,
  input: { storeId: string; employmentId: string; personId: string; separationId: string; separationDate: string; entryDate: string; moneyAccountGlCode: string },
): Promise<{ amount: Money } | null> {
  const year = Number(input.separationDate.slice(0, 4));
  // ⛔ Under the person's leave lock BEFORE the balance is read: a paid SIL approval racing this payout is either seen or queued.
  await advisoryLocksRepo.lockPersonLeave(tx, input.personId);
  const spans = await leaveRepo.listEmploymentSpans(tx, by.orgId, input.personId);
  const stillEmployed = spans.some(
    (s) => s.id !== input.employmentId && isoOnOrBefore(s.startedOn, `${year}-12-31`) && (s.endedOn === null || isoAfter(s.endedOn, input.separationDate)),
  );
  if (stillEmployed) return null;
  if (await leaveRepo.yearIsClosed(tx, by.orgId, input.personId, year)) return null;

  const balance = await computeSilBalance(tx, by.orgId, input.personId, year);
  if (balance.remaining <= 0) return null;
  const rate = await payrollRepo.rateInForceOn(tx, by.orgId, input.employmentId, input.separationDate);
  if (!rate) return null;
  const dailyRate = money(rate.amount);
  const amount = multiply(dailyRate, String(balance.remaining));

  const claimed = await leaveRepo.claimCommutation(tx, {
    orgId: by.orgId,
    personId: input.personId,
    year,
    employmentId: input.employmentId,
    days: decimal(balance.remaining.toFixed(2), '6,2'),
    dailyRate,
    amount,
    createdBy: by.personId,
    payer: { separationId: input.separationId },
  });
  if (!claimed) return null;

  await postEntry(tx, {
    orgId: by.orgId,
    entryDate: input.entryDate,
    sourceType: SIL_COMMUTATION_SOURCE,
    sourceId: input.separationId,
    idempotencyKey: `${SIL_COMMUTATION_SOURCE}:${input.separationId}:post`,
    memo: `Unused Service Incentive Leave paid at final pay (${balance.remaining} day(s), ${year})`,
    postedBy: by.personId,
    lines: [
      { accountCode: SALARIES_ACCOUNT, storeId: input.storeId, debit: amount },
      { accountCode: input.moneyAccountGlCode, storeId: input.storeId, credit: amount },
    ],
  });
  await audit(tx, by, 'sil.commuted', {
    storeId: input.storeId,
    entityId: claimed.id,
    after: { personId: input.personId, year, days: balance.remaining, amount, employmentId: input.employmentId, payer: 'separation' },
  });
  return { amount };
}

/** Voiding a separation releases its payout row and reverses the journal entry it posted. */
export async function releaseSilOfSeparation(
  tx: Tx,
  by: Actor,
  input: { separationId: string; reason: string; reversalDate: string },
): Promise<{ released: number }> {
  const released = await leaveRepo.releaseCommutationOfSeparation(tx, input.separationId);
  if (released.length === 0) return { released: 0 };
  const entries = await postedEntriesOfSeparation(tx, by.orgId, input.separationId);
  for (const entryId of entries) {
    await reverseEntry(tx, {
      orgId: by.orgId,
      entryId,
      reason: input.reason,
      reversedBy: by.personId,
      reversalDate: input.reversalDate,
    } as never);
  }
  return { released: released.length };
}

async function postedEntriesOfSeparation(tx: Tx, orgId: string, separationId: string): Promise<string[]> {
  const rows = await journalRepo.findPostedEntriesBySource(tx, orgId, SIL_COMMUTATION_SOURCE, separationId);
  return rows.filter((r) => r.sourceId === separationId).map((r) => r.id);
}
