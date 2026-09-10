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
 */
import { authorize, type Actor } from '@shareat/auth';
import { expensesRepo, moneyAccountsRepo, transaction, type Tx } from '@shareat/db';
import { checkDraw } from '../money-accounts/overdraft';
import { postEntry } from '../ledger/post-entry';
import { parseMoneyInput } from '../shared/money-input';
import { EXPENSE_FUNDING_ACCOUNTS } from './routing';

export interface PayReimbursementInput {
  storeId: string;
  employeeId: string;
  amount: string;
  fromMoneyAccountId: string;
  on: string;
  memo?: string;
}

export interface PayReimbursementResult {
  entryId: string;
  /** Outstanding AFTER this payment, derived. */
  outstanding: string;
  warning?: string;
}

export async function payReimbursement(
  tx: Tx | null,
  actor: Actor,
  input: PayReimbursementInput,
): Promise<PayReimbursementResult> {
  const run = async (trx: Tx) => {
    // Same capability as an AP or loan payment — cash leaving the business to settle a
    // liability, gated the same way every other outgoing payment in this codebase is.
    await authorize(trx, actor, 'record_ap_payment', { storeId: input.storeId });

    const amount = parseMoneyInput(input.amount, 'payReimbursement: the amount');
    if (Number(amount) <= 0) {
      throw new Error('payReimbursement: the amount has to be greater than zero.');
    }
    const account = await moneyAccountsRepo.getById(trx, actor.orgId, input.fromMoneyAccountId);
    if (!account) throw new Error('payReimbursement: that money account does not exist.');

    const position = await expensesRepo.reimbursablePayableOf(trx, actor.orgId, input.employeeId);
    if (Number(position.outstanding) <= 0) {
      throw new Error('payReimbursement: this employee has nothing outstanding on 2130.');
    }
    if (Number(amount) > Number(position.outstanding) + 0.005) {
      throw new Error(
        `payReimbursement: ${amount} is more than the ${position.outstanding} owed. There is ` +
          'no account for a reimbursement overpayment to land in — check the amount.',
      );
    }

    const warning = await checkDraw(
      trx,
      actor.orgId,
      account,
      Number(amount),
      'payReimbursement',
    );

    const paymentId = crypto.randomUUID();
    const result = await postEntry(trx, {
      orgId: actor.orgId,
      entryDate: input.on,
      sourceType: 'reimbursement_payout',
      sourceId: input.employeeId,
      idempotencyKey: `reimbursement:${input.employeeId}:payout:${paymentId}`,
      memo: input.memo ?? 'Reimbursement payout',
      postedBy: actor.personId,
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
          storeId: input.storeId,
          credit: amount,
          ...(account.glAccountCode === '1140'
            ? { partyType: 'money_account' as const, partyId: account.id }
            : {}),
        },
      ],
    });

    const after = await expensesRepo.reimbursablePayableOf(trx, actor.orgId, input.employeeId);

    return {
      entryId: result.entryId,
      outstanding: after.outstanding,
      ...(warning ? { warning } : {}),
    };
  };
  if (tx) return run(tx);
  return transaction(run);
}
