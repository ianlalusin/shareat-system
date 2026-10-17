/**
 * 13th-month pay — the annual statutory bonus. T-191, phase-5-payroll.md's next slice after T-189.
 * `docs/tasks/191-thirteenth-month-pay.md`.
 *
 * ⭐ **The hard part is already done.** `payslips.basicPay` already excludes overtime, night
 * differential and holiday premiums (T-189's own gross identity), which is *exactly* DOLE's
 * statutory basis for 13th-month pay — "total basic salary actually earned during the calendar
 * year ÷ 12." Absences and short shifts already reduce it, because it is derived from actual
 * attendance, not an annualised full-year salary. So this is not a new payroll engine: it sums
 * what T-189 already posted correctly, divides by 12, and pays it out through the same posting
 * pattern `postPayRun` already established.
 *
 * ⛔ **Not built on `pay_runs`/`payslips`** — see `schema/thirteenth-month.ts`'s own top comment
 * for why forcing that fit would have meant satisfying CHECKs that mean nothing for this shape.
 */
import { ZERO, add, compare, formatMoney, divideMoney, money, subtract, type Money } from '@shareat/core/money';
import { thirteenthMonthRepo, payrollRepo, moneyAccountsRepo, transaction, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { postEntry } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';
import { refuse } from '../shared/refusal';
import { advanceToRecover } from './compute';
import { outstandingAdvance, PAYROLL_ADVANCE_ACCOUNT } from './index';

/** `6140 13th month pay` — provisioned in Phase 1, unused until now. */
export const THIRTEENTH_MONTH_ACCOUNT = '6140';

/**
 * T-190. The 13th month and other benefits are exempt from contributions and withholding up to this much a year per person
 * (RA 10963 s32(B)(7)(e), PHP 90,000). It is fixed by law and is NOT one of the effective-dated rate tables: the exemption has
 * no deduction to compute, it only decides whether the run may pay. Above it the run refuses and names the person (nobody is
 * near it today; the accountant decides what to do).
 */
export const THIRTEENTH_MONTH_EXEMPT_CEILING = money('90000.00');

/**
 * T-343 S5.5q / DEF-465 — the range is the one the system already enforces:
 * `thirteenth_month_runs_year_check` (`packages/db/schema/thirteenth-month.ts`, migration 0115). No
 * other year validation exists in `packages/` to reuse.
 */
function assertRunYear(fn: string, year: number): void {
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    throw refuse(
      `${fn}: year must be a whole number from 2020 to 2100, got ${year}.`,
      'The year must be a whole number from 2020 to 2100.',
    );
  }
}

export interface ThirteenthMonthPayoutDraft {
  employmentId: string;
  personId: string;
  personName: string;
  basicPayEarned: Money;
  grossPay: Money;
  advanceRecovered: Money;
  netPay: Money;
}

export interface ThirteenthMonthPreview {
  payouts: ThirteenthMonthPayoutDraft[];
  totalGross: Money;
  totalNet: Money;
  totalAdvanceRecovered: Money;
}

/**
 * ⭐ What a run WOULD pay. Read-only — computes, posts nothing, changes nothing.
 *
 * Every employment at the store — `employmentsForStore` already includes ended ones. 13th-month
 * is owed to staff who left mid-year too; that is a different question from T-192's separate
 * final-pay bundling, and this function does not need to know which employments are still open.
 */
export async function preview13thMonthRun(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; year: number },
): Promise<ThirteenthMonthPreview> {
  await authorize(tx, actor, 'run_payroll', { storeId: input.storeId });
  assertRunYear('preview13thMonthRun', input.year);

  const roster = await payrollRepo.employmentsForStore(tx, actor.orgId, input.storeId);
  const payouts: ThirteenthMonthPayoutDraft[] = [];
  let totalGross = ZERO;
  let totalNet = ZERO;
  let totalAdvanceRecovered = ZERO;

  for (const emp of roster) {
    // ⛔ T-192's fix: a posted separation already paid this job's pro-rated 13th month once. The
    // annual run must not also pay it — see thirteenth-month.ts's schema comment and
    // hasPostedSeparationInYear's own doc.
    if (await thirteenthMonthRepo.hasPostedSeparationInYear(tx, actor.orgId, emp.id, input.year)) continue;

    const earned = money(await thirteenthMonthRepo.basicPayEarnedInYear(tx, actor.orgId, emp.id, input.year));
    // ⭐ No payslips that year — nothing owed, nothing paid. Excluded, not paid at ₱0, same
    // reasoning previewPayRun uses for "only people who worked."
    if (compare(earned, ZERO) <= 0) continue;

    const gross = divideMoney(earned, 12);
    // T-190: the exemption is per PERSON per year, across jobs and across runs already posted.
    const alreadyPaid = money(await thirteenthMonthRepo.paidInYearForPerson(tx, actor.orgId, emp.personId, input.year));
    const thisRunSoFar = payouts.filter((p) => p.personId === emp.personId).reduce((n, p) => add(n, p.grossPay), ZERO);
    const yearToDate = add(alreadyPaid, thisRunSoFar, gross);
    if (compare(yearToDate, THIRTEENTH_MONTH_EXEMPT_CEILING) > 0) {
      throw refuse(
        `preview13thMonthRun: ${emp.personName} would reach ${yearToDate} of 13th month in ${input.year}, over the ${THIRTEENTH_MONTH_EXEMPT_CEILING} exemption`,
        `${emp.personName}'s 13th month for ${input.year} would be over the PHP 90,000 tax-exempt limit. Ask the accountant how to treat the excess before this run is posted.`,
      );
    }
    const outstanding = await outstandingAdvance(tx, actor.orgId, emp.personId);
    const advanceRecovered = advanceToRecover(gross, outstanding);
    const netPay = subtract(gross, advanceRecovered);

    payouts.push({
      employmentId: emp.id,
      personId: emp.personId,
      personName: emp.personName,
      basicPayEarned: earned,
      grossPay: gross,
      advanceRecovered,
      netPay,
    });
    totalGross = add(totalGross, gross);
    totalNet = add(totalNet, netPay);
    totalAdvanceRecovered = add(totalAdvanceRecovered, advanceRecovered);
  }

  return { payouts, totalGross, totalNet, totalAdvanceRecovered };
}

/**
 * Posts a run: one journal per payout.
 *
 * ```
 * Dr  6140  13th month pay               gross
 *     Cr  1230  Advances to employees          advance recovered   party = the person
 *     Cr  <the run's money account>             net
 * ```
 *
 * ⛔ **A person may not post a run that pays their own employment** — same block, same reasoning,
 * as `postPayRun`: an admin paying themselves is precisely the case it exists for.
 */
export async function post13thMonthRun(
  tx: Tx | null,
  actor: Actor,
  input: {
    storeId: string;
    year: number;
    moneyAccountId: string;
    entryDate?: string;
    notes?: string | null;
  },
): Promise<{ runId: string; payouts: number; totalNet: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'run_payroll', { storeId: input.storeId });
    assertRunYear('post13thMonthRun', input.year);

    const preview = await preview13thMonthRun(trx, actor, { storeId: input.storeId, year: input.year });
    if (preview.payouts.length === 0) {
      throw new Error(
        `post13thMonthRun: nothing to pay for ${input.year} — no employment at this store has ` +
          'posted basic pay for that year.',
      );
    }

    const own = preview.payouts.find((p) => p.personId === actor.personId);
    if (own) {
      throw new Error(
        'post13thMonthRun: this run pays your own employment. ⛔ Somebody else has to post it — ' +
          'an admin paying themselves is exactly the case this block exists for.',
      );
    }

    const account = await moneyAccountsRepo.getById(trx, actor.orgId, input.moneyAccountId);
    if (!account) throw new Error('post13thMonthRun: that money account does not exist.');
    if (account.storeId !== input.storeId) {
      throw new Error('post13thMonthRun: that money account belongs to another store.');
    }

    const entryDate = input.entryDate ?? `${input.year}-12-24`;
    const runId = (
      await thirteenthMonthRepo.insertThirteenthMonthRun(trx, {
        orgId: actor.orgId,
        storeId: input.storeId,
        year: input.year,
        moneyAccountId: input.moneyAccountId,
        notes: input.notes ?? null,
        createdBy: actor.personId,
      })
    ).id;

    for (const payout of preview.payouts) {
      const payoutId = (
        await thirteenthMonthRepo.insertThirteenthMonthPayout(trx, {
          orgId: actor.orgId,
          runId,
          employmentId: payout.employmentId,
          personId: payout.personId,
          basicPayEarned: payout.basicPayEarned,
          grossPay: payout.grossPay,
          advanceRecovered: payout.advanceRecovered,
          netPay: payout.netPay,
          journalEntryId: null,
        })
      ).id;

      const lines = [
        {
          accountCode: THIRTEENTH_MONTH_ACCOUNT,
          storeId: input.storeId,
          debit: payout.grossPay,
        },
        ...(compare(payout.advanceRecovered, ZERO) > 0
          ? [
              {
                accountCode: PAYROLL_ADVANCE_ACCOUNT,
                storeId: input.storeId,
                credit: payout.advanceRecovered,
                partyType: 'employee',
                partyId: payout.personId,
              },
            ]
          : []),
        ...(compare(payout.netPay, ZERO) > 0
          ? [
              {
                accountCode: account.glAccountCode,
                storeId: input.storeId,
                credit: payout.netPay,
              },
            ]
          : []),
      ];

      const posted = await postEntry(trx, {
        orgId: actor.orgId,
        entryDate,
        sourceType: 'thirteenthmonthpayout',
        sourceId: payoutId,
        idempotencyKey: `thirteenth-month-payout:${payoutId}:post`,
        memo: `13th-month pay ${input.year} — ${payout.personName}`,
        postedBy: actor.personId,
        lines,
      });
      await thirteenthMonthRepo.setThirteenthMonthPayoutEntry(trx, payoutId, posted.entryId);
    }

    const ok = await thirteenthMonthRepo.markThirteenthMonthRunPosted(trx, actor.orgId, runId, actor.personId);
    if (!ok) throw new Error('post13thMonthRun: the run was posted by someone else first.');

    return {
      runId,
      payouts: preview.payouts.length,
      totalNet: formatMoney(preview.totalNet),
    };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/** Mirrors `voidPayRun` — reverses every payout's journal entry, marks the run voided. No
 *  day-freeze/unfreeze step: a 13th-month payout never freezes attendance days. */
export async function void13thMonthRun(
  tx: Tx | null,
  actor: Actor,
  input: { runId: string; reason: string; on?: string },
): Promise<{ reversed: number }> {
  const run = async (trx: Tx) => {
    const thirteenthRun = await thirteenthMonthRepo.getThirteenthMonthRun(trx, actor.orgId, input.runId);
    if (!thirteenthRun) throw new Error('void13thMonthRun: that run does not exist.');
    await authorize(trx, actor, 'run_payroll', { storeId: thirteenthRun.storeId });

    const reason = input.reason.trim();
    if (!reason) throw new Error('void13thMonthRun: voiding a run needs a reason.');
    if (thirteenthRun.status !== 'posted') {
      throw new Error(`void13thMonthRun: this run is ${thirteenthRun.status}, not posted.`);
    }

    const payouts = await thirteenthMonthRepo.listThirteenthMonthPayouts(trx, input.runId);
    let reversed = 0;
    for (const payout of payouts) {
      if (!payout.journalEntryId) continue;
      await reverseEntry(trx, {
        orgId: actor.orgId,
        entryId: payout.journalEntryId,
        reason,
        reversedBy: actor.personId,
        reversalDate: input.on ?? `${thirteenthRun.year}-12-31`,
      } as never);
      reversed++;
    }

    const ok = await thirteenthMonthRepo.markThirteenthMonthRunVoided(trx, actor.orgId, input.runId, {
      voidedBy: actor.personId,
      reason,
    });
    if (!ok) throw new Error('void13thMonthRun: the run was voided by someone else first.');

    return { reversed };
  };
  if (tx) return run(tx);
  return transaction(run);
}
