/**
 * Separation, final pay, and clearance — first slice. T-192.
 * `docs/tasks/192-separation-final-pay-clearance.md`.
 *
 * ⭐ **`separationPayAmount` is an INPUT to `postSeparation`, never computed here.** PH separation
 * pay is owed only for authorized causes (Labor Code Art. 298/299) at cause-specific multipliers;
 * just cause and resignation legally owe none. Ian's own answer, 2026-09-01: no track record of
 * paying it, decide the policy now — so this build captures `cause` for the record and leaves the
 * peso figure to whoever processes the separation, rather than guessing a formula nobody approved.
 *
 * ⛔ **Wages to the separation date are NOT computed here either.** A final pay period's wages are
 * exactly a regular pay run whose `periodEnd` is the last worked day — `postPayRun` (T-189)
 * already does this correctly. This file's job is the two things nothing else computes: the
 * pro-rated 13th month, and the clearance gate.
 */
import { ZERO, add, compare, divideMoney, money, subtract, type Money } from '@shareat/core/money';
import { parseDecimalInput } from '../shared/money-input';
import { employmentRepo, moneyAccountsRepo, separationsRepo, thirteenthMonthRepo, transaction, type Tx } from '@shareat/db';
import type { SeparationCause } from '@shareat/db/schema';
import { authorize, type Actor } from '@shareat/auth';
import { postEntry } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';
import { advanceToRecover } from './compute';
import { outstandingAdvance, PAYROLL_ADVANCE_ACCOUNT } from './index';
import { THIRTEENTH_MONTH_ACCOUNT } from './thirteenth-month';

/** `6150 salary additions` — already in the approved chart. Separation pay is exactly "an
 *  addition to what is otherwise owed," which is what 6150 already means; no new account. */
export const SEPARATION_PAY_ACCOUNT = '6150';

export interface SeparationPreview {
  employmentId: string;
  personId: string;
  thirteenthMonthBasicPayEarned: Money;
  thirteenthMonthGross: Money;
  outstandingAdvance: Money;
}

/** ⭐ Read-only. Prices only the pro-rated 13th month — `separationPayAmount` is a decision made
 *  at post time, not something a preview can compute. */
export async function previewSeparation(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; employmentId: string; separationDate: string },
): Promise<SeparationPreview> {
  await authorize(tx, actor, 'run_payroll', { storeId: input.storeId });

  const employment = await employmentRepo.getEmployment(tx, input.employmentId);
  if (!employment || employment.orgId !== actor.orgId || employment.storeId !== input.storeId) {
    throw new Error('previewSeparation: that employment does not exist at this store.');
  }
  const existing = await separationsRepo.getSeparationByEmployment(tx, actor.orgId, input.employmentId);
  // ⭐ A VOIDED separation is a correction, not a permanent block — same "void frees it to be
  // posted again" shape as pay_runs/thirteenth_month_runs.
  if (existing && existing.status === 'posted') {
    throw new Error('previewSeparation: this employment already has a posted separation on record.');
  }

  const year = Number(input.separationDate.slice(0, 4));
  const basicPayEarned = money(
    await thirteenthMonthRepo.basicPayEarnedInYear(tx, actor.orgId, input.employmentId, year, input.separationDate),
  );
  const gross = divideMoney(basicPayEarned, 12);
  const outstanding = await outstandingAdvance(tx, actor.orgId, employment.personId);

  return {
    employmentId: input.employmentId,
    personId: employment.personId,
    thirteenthMonthBasicPayEarned: basicPayEarned,
    thirteenthMonthGross: gross,
    outstandingAdvance: outstanding,
  };
}

/**
 * Posts a separation: ONE journal entry.
 *
 * ```
 * Dr  6140  13th month pay               thirteenthMonthGross
 * Dr  6150  Salary additions             separationPayAmount   (only if > 0)
 *     Cr  1230  Advances to employees          advanceRecovered   party = the person
 *     Cr  <the money account>                   net
 * ```
 *
 * ⛔ **Refuses without clearance** — `clearanceConfirmedBy` is a required input, not a default.
 * Same self-dealing block as `postPayRun`/`post13thMonthRun`.
 */
export async function postSeparation(
  tx: Tx | null,
  actor: Actor,
  input: {
    storeId: string;
    employmentId: string;
    separationDate: string;
    cause: SeparationCause;
    separationPayAmount: string;
    moneyAccountId: string;
    clearanceConfirmedBy: string;
    clearanceNotes?: string | null;
    entryDate?: string;
    notes?: string | null;
  },
): Promise<{ id: string; netPay: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'run_payroll', { storeId: input.storeId });

    const employment = await employmentRepo.getEmployment(trx, input.employmentId);
    if (!employment || employment.orgId !== actor.orgId || employment.storeId !== input.storeId) {
      throw new Error('postSeparation: that employment does not exist at this store.');
    }
    if (employment.personId === actor.personId) {
      throw new Error(
        'postSeparation: this pays your own employment. ⛔ Somebody else has to post it — an ' +
          'admin paying themselves is exactly the case this block exists for.',
      );
    }

    // ⛔ THE gate. `postSeparation` refuses without it — a database CHECK backs this up
    // (`separations_posted_needs_clearance_check`), but the domain layer is where the message
    // reads as a sentence rather than a constraint name.
    if (!input.clearanceConfirmedBy) {
      throw new Error('postSeparation: clearance must be confirmed by someone before posting.');
    }

    const preview = await previewSeparation(trx, actor, {
      storeId: input.storeId,
      employmentId: input.employmentId,
      separationDate: input.separationDate,
    });

    // T-371 R6 — `separation_pay_amount` is NOT NULL DEFAULT '0', so a blank is OMITTED rather than refused: the
    // column's own default (zero) is what applies, and the same zero is what the arithmetic and the posting use. A typed
    // value is parsed exactly as before (same sentences); nothing guesses a figure out of a malformed one.
    const separationPayTyped = parseDecimalInput(
      input.separationPayAmount,
      '14,2',
      'postSeparation: the separation pay',
      'The separation pay',
      { blank: 'omit' },
    );
    // R13: ZERO is arithmetic only; the writer is given `separationPayTyped`, so a blank is omitted (column DEFAULT '0').
    const separationPay: Money = separationPayTyped ?? ZERO;
    if (compare(separationPay, ZERO) < 0) {
      throw new Error('postSeparation: separation pay cannot be negative.');
    }
    const grossTotal = add(preview.thirteenthMonthGross, separationPay);
    const advanceRecovered = advanceToRecover(grossTotal, preview.outstandingAdvance);
    const netPay = subtract(grossTotal, advanceRecovered);

    const account = await moneyAccountsRepo.getById(trx, actor.orgId, input.moneyAccountId);
    if (!account) throw new Error('postSeparation: that money account does not exist.');
    if (account.storeId !== input.storeId) {
      throw new Error('postSeparation: that money account belongs to another store.');
    }

    const entryDate = input.entryDate ?? input.separationDate;
    const separationId = (
      await separationsRepo.insertPostedSeparation(trx, {
        orgId: actor.orgId,
        storeId: input.storeId,
        employmentId: input.employmentId,
        personId: employment.personId,
        separationDate: input.separationDate,
        cause: input.cause,
        thirteenthMonthBasicPayEarned: preview.thirteenthMonthBasicPayEarned,
        thirteenthMonthGross: preview.thirteenthMonthGross,
        separationPayAmount: separationPayTyped,
        advanceRecovered,
        netPay,
        moneyAccountId: input.moneyAccountId,
        clearanceConfirmedBy: input.clearanceConfirmedBy,
        clearanceNotes: input.clearanceNotes ?? null,
        notes: input.notes ?? null,
        createdBy: actor.personId,
      })
    ).id;

    const lines = [
      ...(compare(preview.thirteenthMonthGross, ZERO) > 0
        ? [{ accountCode: THIRTEENTH_MONTH_ACCOUNT, storeId: input.storeId, debit: preview.thirteenthMonthGross }]
        : []),
      ...(compare(separationPay, ZERO) > 0
        ? [{ accountCode: SEPARATION_PAY_ACCOUNT, storeId: input.storeId, debit: separationPay }]
        : []),
      ...(compare(advanceRecovered, ZERO) > 0
        ? [
            {
              accountCode: PAYROLL_ADVANCE_ACCOUNT,
              storeId: input.storeId,
              credit: advanceRecovered,
              partyType: 'employee',
              partyId: employment.personId,
            },
          ]
        : []),
      ...(compare(netPay, ZERO) > 0
        ? [{ accountCode: account.glAccountCode, storeId: input.storeId, credit: netPay }]
        : []),
    ];

    if (lines.length > 0) {
      const posted = await postEntry(trx, {
        orgId: actor.orgId,
        entryDate,
        sourceType: 'separation',
        sourceId: separationId,
        idempotencyKey: `separation:${separationId}:post`,
        memo: `Separation — ${input.cause} — ${input.separationDate}`,
        postedBy: actor.personId,
        lines,
      });
      await separationsRepo.setSeparationEntry(trx, separationId, posted.entryId);
    }

    return { id: separationId, netPay: netPay };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/** Mirrors `voidPayRun`/`void13thMonthRun`. ⚠️ Does NOT automatically re-include the employment in
 *  a later annual 13th-month run if that run already posted for the year — see task spec §5. */
export async function voidSeparation(
  tx: Tx | null,
  actor: Actor,
  input: { id: string; reason: string; on?: string },
): Promise<{ reversed: boolean }> {
  const run = async (trx: Tx) => {
    const separation = await separationsRepo.getSeparation(trx, actor.orgId, input.id);
    if (!separation) throw new Error('voidSeparation: that separation does not exist.');
    await authorize(trx, actor, 'run_payroll', { storeId: separation.storeId });

    const reason = input.reason.trim();
    if (!reason) throw new Error('voidSeparation: voiding needs a reason.');
    if (separation.status !== 'posted') {
      throw new Error(`voidSeparation: this separation is ${separation.status}, not posted.`);
    }

    let reversed = false;
    if (separation.journalEntryId) {
      await reverseEntry(trx, {
        orgId: actor.orgId,
        entryId: separation.journalEntryId,
        reason,
        reversedBy: actor.personId,
        reversalDate: input.on ?? separation.separationDate,
      } as never);
      reversed = true;
    }

    const ok = await separationsRepo.markSeparationVoided(trx, actor.orgId, input.id, {
      voidedBy: actor.personId,
      reason,
    });
    if (!ok) throw new Error('voidSeparation: this separation was voided by someone else first.');

    return { reversed };
  };
  if (tx) return run(tx);
  return transaction(run);
}
