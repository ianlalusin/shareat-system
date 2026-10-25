/**
 * payReimbursement — settling `2130 Reimbursements payable to employees`. DEF-157.
 * `docs/POSTING-PATTERNS.md`'s `reimbursement.payout`: **DR 2130 (party=employee) · CR the
 * money account.** Pure balance sheet — the expense itself was already recognised when
 * `routeExpense` credited 2130 (T-122's `expense.reimbursable` pattern).
 *
 * Mirrors `loans/index.ts`'s `recordLoanPayment` shape: the outstanding balance is derived from
 * the ledger (`expensesRepo.reimbursablePayableOf`), never stored, and an overpayment is refused
 * rather than absorbed — there is no "employee advance" account for reimbursement to overflow
 * into, so paying more than is owed is simply a mistake to catch, not a case to model.
 *
 * T-369 S1 (DEF-198): the cap is what is owed AT `input.storeId` (N2), drawing on another store's
 * account needs `transfer_funds` there (N1), and two payouts for one person are serialised by an
 * advisory lock taken before the cap is read (N3). `payoutId` makes a replay return the entry it
 * already posted instead of a second one — looked up before the cap, since the cap may now be 0.
 */
import { authorize, type Actor } from '@shareat/auth';
import { advisoryLocksRepo, expensesRepo, journalRepo, moneyAccountsRepo, type Tx } from '@shareat/db';
import { compare, equals, money, ZERO } from '@shareat/core/money';
import type { PeriodOverrideReason } from '@shareat/db/schema';
import { checkDraw } from '../money-accounts/overdraft';
import { postEntry } from '../ledger/post-entry';
import { withInterStoreLegs } from '../ledger/inter-store';
import { parseMoneyInput } from '../shared/money-input';
import { EXPENSE_FUNDING_ACCOUNTS } from './routing';
import { refuse, gone } from '../shared/refusal';
import { assertFieldRules } from '../shared/field-rules-assert';
import { EXPENSE_REIMBURSEMENT_RULES } from '../field-rules/expenses';

/** "January 2026" - the month a fiscal period covers, for a sentence a person reads. */
function monthLabel(startsOn: string): string {
  return new Date(`${startsOn}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const PAYOUT_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PayReimbursementInput {
  storeId: string;
  employeeId: string;
  amount: string;
  fromMoneyAccountId: string;
  on: string;
  /** T-369 S1 (N3): one id per payout FORM, minted server-side when the page renders. The posting's
   *  idempotency key is derived from it, so a double click or a replay posts once. */
  payoutId: string;
  memo?: string;
  /** T-369 S5a (DEF-314): post this one payout into a CLOSED month. Carries a reason and a note and NO
   *  actor - the person who answers for it is the function's own `actor` (I4), checked against
   *  `override_period_lock` inside `postEntry`. Never reaches a `locked` month. */
  periodOverride?: { reason: PeriodOverrideReason; note?: string | null };
}

export interface PayReimbursementResult {
  entryId: string;
  /** Outstanding AFTER this payment, derived, AT `input.storeId`. */
  outstanding: string;
  /** False when `payoutId` had already posted: this is that entry, returned again, nothing new. */
  created: boolean;
  warning?: string;
}

export async function payReimbursement(
  tx: Tx,
  actor: Actor,
  input: PayReimbursementInput,
): Promise<PayReimbursementResult> {
  const run = async (trx: Tx) => {
    // Same capability as an AP or loan payment — cash leaving the business to settle a
    // liability, gated the same way every other outgoing payment in this codebase is.
    await authorize(trx, actor, 'record_ap_payment', { storeId: input.storeId });
    // T-440 / S9: the screen's own rules judge the boxes AFTER the gate (T-364 order). Moved here from the action.
    assertFieldRules(EXPENSE_REIMBURSEMENT_RULES, { amount: input.amount, on: input.on, fromMoneyAccountId: input.fromMoneyAccountId });

    // The payoutId becomes part of the idempotency key, so a blank or malformed one would make
    // every such payout share a key (the second would "replay" the first). Refused here, not by
    // the form: the domain cannot trust that a caller minted one.
    if (typeof input.payoutId !== 'string' || !PAYOUT_ID_SHAPE.test(input.payoutId)) {
      throw refuse(
        'payReimbursement: payoutId is missing or is not a uuid.',
        'This payment form is missing its reference. Reload the page and try again.',
      );
    }

    const amount = parseMoneyInput(input.amount, 'payReimbursement: the amount', 'The reimbursement amount');
    // T-371 (C4): judged on the parsed brand, exactly — `Number(…) <= 0` read a NaN as "not zero or less".
    if (compare(amount, ZERO) <= 0) {
      throw refuse('payReimbursement: the amount has to be greater than zero.', 'The amount has to be greater than zero.');
    }
    const account = await moneyAccountsRepo.getById(trx, actor.orgId, input.fromMoneyAccountId);
    if (!account) throw gone('payReimbursement: that money account does not exist.', 'money account');
    // The domain refuses these itself — the picker not offering them is presentation only.
    if (!account.isActive) {
      throw refuse('payReimbursement: that money account is retired.', 'That money account is retired.');
    }
    if (account.custodian === 'staff') {
      throw refuse(
        'payReimbursement: a staff float cannot fund a reimbursement payout.',
        'Pay from a store account, not a staff float.',
      );
    }
    // N1: the credit lands on `account`, so drawing on another store's account needs the right to
    // move money THERE — the same gate `approve.ts` and `ap/index.ts` apply to their cross-store draws.
    if (account.storeId !== input.storeId) {
      await authorize(trx, actor, 'transfer_funds', { storeId: account.storeId });
    }

    // N3: serialise per payee BEFORE the first cap read, so the second payout reads what the
    // first committed.
    await advisoryLocksRepo.lockReimbursementPayee(trx, input.employeeId);

    // N3: the deterministic key makes a replay a no-op. It is looked up BEFORE the cap check:
    // after a committed payout the balance can be 0, and a replay must return that entry rather
    // than be refused as "nothing owed".
    const idempotencyKey = `reimbursement:${input.employeeId}:payout:${input.payoutId}`;
    const replayed = await journalRepo.findEntryByIdempotencyKey(trx, actor.orgId, idempotencyKey);
    if (replayed) {
      // The same payoutId must mean the same payout: a replay carrying other figures is not a
      // double click, so it is refused rather than answered with the first entry as if it matched.
      const lines = await journalRepo.findLinesForEntryWithAccountCodes(trx, replayed.id);
      const debit = lines.find((l) => l.accountCode === EXPENSE_FUNDING_ACCOUNTS.REIMBURSABLE_TO_EMPLOYEES);
      const credit = lines.find(
        (l) =>
          l.accountCode === account.glAccountCode &&
          (account.glAccountCode !== '1140' || l.partyId === account.id),
      );
      const same =
        !!debit &&
        !!credit &&
        debit.storeId === input.storeId &&
        // T-369 S8: the credit sits at the ACCOUNT's store. A pre-S8 cross-store payout (credit at the owing
        // store) replayed now is the defective shape and is refused here, not answered as a match.
        credit.storeId === account.storeId &&
        equals(money(debit.debit), amount) &&
        equals(money(credit.credit), amount);
      if (!same) {
        throw refuse(
          'payReimbursement: payoutId was already posted with a different amount, store or account.',
          'This payment was already recorded with different figures. Reload the page and try again.',
        );
      }
      const now = await expensesRepo.reimbursablePayableOf(trx, actor.orgId, input.employeeId, input.storeId);
      return { entryId: replayed.id, outstanding: now.outstanding, created: false };
    }

    // T-369 S5a: say, in words, when the payout's month will not take it - before the cap and before
    // `postEntry`, whose own refusal is a developer sentence carrying ids. A closed month needs the
    // override; a locked one cannot take it at all.
    // The override is passed on to `postEntry` ONLY when this period is closed. For an open month it is
    // ignored: `postEntry` would otherwise authorise `override_period_lock` and write an audit row for
    // an override nobody needed - and refuse an ordinary manager who never needed one.
    let periodOverride: typeof input.periodOverride;
    if (/^\d{4}-\d{2}-\d{2}$/.test(input.on)) {
      const period = await journalRepo.findPeriodForDate(trx, actor.orgId, input.on);
      if (period?.status === 'closed') periodOverride = input.periodOverride;
      if (period?.status === 'locked') {
        throw refuse(
          `payReimbursement: the fiscal period covering ${input.on} is locked.`,
          `${monthLabel(period.startsOn)} is locked. Nothing can be posted into it, not even with the closed-month override — pick a date in an open month.`,
        );
      }
      if (period?.status === 'closed' && !input.periodOverride) {
        throw refuse(
          `payReimbursement: the fiscal period covering ${input.on} is closed and no periodOverride was given.`,
          `${monthLabel(period.startsOn)} is closed. Pick a date in an open month, or ask an administrator to post this one entry into it.`,
        );
      }
    }

    // N2: the cap is what is owed AT the store the debit lands on, not the organisation's total.
    const position = await expensesRepo.reimbursablePayableOf(trx, actor.orgId, input.employeeId, input.storeId);
    // T-371 (R4, C4): the derived balance is re-minted and judged exactly. Both sides are (14,2), so the old `+ 0.005`
    // float tolerance is an exact `compare` now; a NaN can no longer read as "nothing owed" or "within the cap".
    const outstanding = money(position.outstanding);
    if (compare(outstanding, ZERO) <= 0) {
      throw refuse(
        'payReimbursement: this employee has nothing outstanding on 2130 at this store.',
        'This employee has no unpaid reimbursement at this store.',
      );
    }
    if (compare(amount, outstanding) > 0) {
      throw refuse(
        `payReimbursement: ${amount} is more than the ${position.outstanding} owed. There is ` +
          'no account for a reimbursement overpayment to land in — check the amount.',
        `${amount} is more than the ${position.outstanding} owed. There is no account for a reimbursement overpayment to land in — check the amount.`,
      );
    }

    const warning = await checkDraw(
      trx,
      actor.orgId,
      account,
      amount,
      'payReimbursement',
    );

    // T-369 S8 (DEF-551): the money-account credit goes at the ACCOUNT's store (`balanceOf` reads a safe there);
    // the debt stays at the owing store, and a cross-store draw gains the 1250/2150 pair between them.
    const memo = input.memo ?? 'Reimbursement payout';
    const lines = await withInterStoreLegs(trx, actor.orgId, {
      owingStoreId: input.storeId,
      memo,
      lines: [
        {
          accountCode: EXPENSE_FUNDING_ACCOUNTS.REIMBURSABLE_TO_EMPLOYEES,
          storeId: input.storeId,
          debit: amount,
          partyType: 'employee',
          partyId: input.employeeId,
        },
        {
          accountCode: account.glAccountCode,
          storeId: account.storeId,
          credit: amount,
          ...(account.glAccountCode === '1140'
            ? { partyType: 'money_account' as const, partyId: account.id }
            : {}),
        },
      ],
    });

    const result = await postEntry(trx, {
      orgId: actor.orgId,
      entryDate: input.on,
      sourceType: 'reimbursement_payout',
      sourceId: input.employeeId,
      idempotencyKey,
      memo,
      postedBy: actor.personId,
      ...(periodOverride
        ? { periodOverride: { actor, reason: periodOverride.reason, note: periodOverride.note ?? null } }
        : {}),
      lines,
    });

    const after = await expensesRepo.reimbursablePayableOf(trx, actor.orgId, input.employeeId, input.storeId);

    return {
      entryId: result.entryId,
      outstanding: after.outstanding,
      created: true,
      ...(warning ? { warning } : {}),
    };
  };
  return run(tx);
}
