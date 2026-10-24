/**
 * Loans — disbursement, payment, interest. T-126, bible row 158.
 *
 * > **Ian, 2026-08-27:** *"that loan model in v1 is really flawed. I suggest build a standard one
 * > for loan and we will build on top of it later to cater our case."*
 *
 * So this is the standard shape, deliberately: a debt, money in, money out, interest recognised
 * when paid. ⛔ **What is NOT here is v1's specifics** — the channel auto-deduct wired through a
 * single `channelCfg.loanId`, and the cross-store paydown funded by an inter-store payable. Those
 * layer on top; they are not what a loan is.
 */
import { authorize, type Actor } from '@shareat/auth';
import { journalRepo, loansRepo, moneyAccountsRepo, type Tx } from '@shareat/db';
import { compare, decimal, money, subtract, ZERO, type Decimal, type Money } from '@shareat/core/money';
import { checkDraw } from '../money-accounts/overdraft';
import { parseMoneyInput } from '../shared/money-input';
import { parseWholeNumberInput } from '../shared/whole-number-input';
import { refuse } from '../shared/refusal';
import { assertFieldRules } from '../shared/field-rules-assert';
import { LOAN_ADD_RULES, LOAN_DRAW_RULES, LOAN_PAYMENT_RULES } from '../field-rules/loans';
import { postEntry } from '../ledger/post-entry';
import { authorizeOtherStores, withInterStoreLegs } from '../ledger/inter-store';
import { reverseEntry } from '../ledger/reverse-entry';
import { accruedInterest, splitPayment, type PaymentSplit } from './interest';

export * from './interest';

export const LOAN_LIABILITY_CODE = '2400';
export const INTEREST_EXPENSE_CODE = '7200';

export interface CreateLoanInput {
  storeId: string;
  lenderName: string;
  name: string;
  principalAmount: string;
  interestRate: string;
  ratePeriod: 'day' | 'month' | 'year';
  interestMethod: 'straight' | 'amortizing' | 'equal_principal';
  paymentFrequency: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual';
  /** T-351 / DEF-481 — a raw form string, parsed here (after `authorize()`) by
   *  `parseWholeNumberInput`, never in the action. A number still works for every direct caller. */
  termPeriods: number | string;
  startDate: string;
  notes?: string | null;
}

/**
 * Records the agreement. ⚠️ **No money moves here** — a signed loan that has not been drawn is a
 * commitment, not a debt, and posting it on signature would show cash the business does not have.
 */
export async function createLoan(
  tx: Tx,
  actor: Actor,
  input: CreateLoanInput,
): Promise<{ id: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'manage_chart_of_accounts', {});
    // T-440: the screen's own rules judge the boxes, AFTER the gate (T-364 order: nothing about the data is said before it).
    // `termPeriods` may arrive as a number from a direct caller; the rule reads text.
    assertFieldRules(LOAN_ADD_RULES, { ...input, termPeriods: String(input.termPeriods) });
    const name = input.name.trim();
    const lender = input.lenderName.trim();
    const principal = parseMoneyInput(input.principalAmount, 'createLoan: the amount agreed', 'The amount agreed');
    if (compare(principal, ZERO) <= 0) {
      throw refuse('createLoan: the amount agreed has to be greater than zero.', 'The amount agreed has to be greater than zero.');
    }
    // S5.5v Amendment A2 item 5 — must not narrow what was already accepted (".5", "1." stay
    // valid): shape first, then the VALUE ceiling — a leading-zero run like "00012.5" is a digit
    // run, not the value, so it saves as 12.5, not a refusal.
    // T-371 R2/R3: the accepted set is unchanged (".5" and "1." included); the VALUE ceiling is now the column's own,
    // decided by minting `loans.interest_rate`'s numeric(8,4) brand — `decimal()` refuses 10000 and above exactly, where
    // `Number(rate) > 9999.9999` let a NaN-adjacent float decide.
    const rawRate = input.interestRate.trim();
    let rate: Decimal<'8,4'> | null = null;
    if (/^(?=.*\d)\d*(?:\.\d{0,4})?$/.test(rawRate)) {
      try {
        rate = decimal(`${rawRate.startsWith('.') ? '0' : ''}${rawRate.replace(/\.$/, '')}`, '8,4');
      } catch {
        rate = null;
      }
    }
    if (rate === null) {
      throw refuse(
        `createLoan: the interest rate — "${input.interestRate}" is not a valid rate. Use a number from 0 to 9999.9999 with up to four decimal places.`,
        `The interest rate — "${input.interestRate}" is not a valid rate. Use a number from 0 to 9999.9999 with up to four decimal places.`,
      );
    }
    // T-351 / DEF-481 — parsed here, after `authorize()`, on the VALUE (never the digit run):
    // "000012" is 12, not refused for its length.
    const termPeriods = parseWholeNumberInput(input.termPeriods, 'createLoan: the number of payments', 'The number of payments', 1, 99999);
    return loansRepo.insertLoan(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      lenderName: lender,
      name,
      principalAmount: principal,
      interestRate: rate,
      ratePeriod: input.ratePeriod,
      interestMethod: input.interestMethod,
      paymentFrequency: input.paymentFrequency,
      termPeriods,
      startDate: input.startDate,
      notes: input.notes?.trim() || null,
      createdBy: actor.personId,
    });
  };
  return run(tx);
}

/**
 * The money arrives. **DR the money account · CR `2400`**, party = the loan.
 *
 * ⚠️ Drawable in stages: `disbursed` is what actually landed, which is why the position derives
 * outstanding from it rather than from the agreed principal.
 */
export async function disburseLoan(
  tx: Tx,
  actor: Actor,
  input: { loanId: string; amount: string; intoMoneyAccountId: string; on: string; memo?: string },
): Promise<{ entryId: string }> {
  const run = async (trx: Tx) => {
    const loan = await loansRepo.getById(trx, actor.orgId, input.loanId);
    if (!loan) throw new Error(`disburseLoan: loan ${input.loanId} does not exist.`);
    await authorize(trx, actor, 'record_ap_payment', { storeId: loan.storeId });
    // T-440 / S9: the screen's own rules judge the boxes AFTER the gate (T-364 order). Moved here from the action.
    assertFieldRules(LOAN_DRAW_RULES, { amount: input.amount, intoMoneyAccountId: input.intoMoneyAccountId, on: input.on });

    const amount = parseMoneyInput(input.amount, 'disburseLoan: the amount', 'The loan amount');
    if (compare(amount, ZERO) <= 0) {
      throw refuse('disburseLoan: the amount has to be greater than zero.', 'The loan amount has to be greater than zero.');
    }
    const account = await moneyAccountsRepo.getById(trx, actor.orgId, input.intoMoneyAccountId);
    if (!account) throw new Error('disburseLoan: that money account does not exist in this org.');
    // T-369 S8b (DEF-556): drawing a loan INTO another store's account moves money there - the owing store's
    // document needs the right to move money at that store too.
    if (account.storeId !== loan.storeId) {
      await authorize(trx, actor, 'transfer_funds', { storeId: account.storeId });
    }

    const position = await loansRepo.positionOf(trx, actor.orgId, loan.id);
    // ⛔ A draw beyond the agreement is not a bigger loan — it is a second agreement, and it needs
    // its own terms rather than quietly inflating these.
    // T-371 R4/C4: both are re-minted database values and the difference is exact centavos, so the old float
    // tolerance (`+ 0.005`) has nothing left to absorb.
    const remaining = subtract(money(loan.principalAmount), money(position.disbursed));
    if (compare(amount, remaining) > 0) {
      throw new Error(
        `disburseLoan: ${amount} exceeds the ${remaining} still undrawn on this ` +
          'agreement. Record a separate loan for anything beyond it.',
      );
    }

    const memo = input.memo ?? `Loan disbursement — ${loan.name} (${loan.lenderName})`;
    // The money-account debit sits at the ACCOUNT's store; a cross-store draw gains the 1250/2150 pair (money
    // landed at that store, so it owes the loan's store).
    const lines = await withInterStoreLegs(trx, actor.orgId, {
      owingStoreId: loan.storeId,
      memo,
      lines: [
        { accountCode: account.glAccountCode, storeId: account.storeId, debit: amount,
          ...(account.glAccountCode === '1140'
            ? { partyType: 'money_account' as const, partyId: account.id }
            : {}) },
        // ⭐ The party is THE LOAN, not the lender: a lender can hold two loans, and v1's own data
        // has exactly that.
        { accountCode: LOAN_LIABILITY_CODE, storeId: loan.storeId, credit: amount,
          partyType: 'loan' as const, partyId: loan.id },
      ],
    });
    const result = await postEntry(trx, {
      orgId: actor.orgId,
      entryDate: input.on,
      sourceType: 'loan_disbursement',
      sourceId: loan.id,
      idempotencyKey: `loan:${loan.id}:disbursement:${input.on}:${amount}`,
      memo,
      postedBy: actor.personId,
      lines,
    });
    return { entryId: result.entryId };
  };
  return run(tx);
}

export interface RecordPaymentResult {
  entryId: string;
  split: PaymentSplit;
  /** Outstanding AFTER this payment, derived. */
  outstanding: string;
  /** True when this payment cleared the debt. */
  paidOff: boolean;
}

/**
 * A payment. **DR `2400` principal · DR `7200` interest · CR the money account.**
 *
 * ⭐ **The split is COMPUTED, not accepted.** v1 takes it from the caller with a suggestion the
 * caller may ignore, so the number deciding how fast a debt retires is hand-typed. Interest accrued
 * since the last payment is taken first; principal takes the remainder.
 */
export async function recordLoanPayment(
  tx: Tx,
  actor: Actor,
  input: {
    loanId: string;
    amount: string;
    fromMoneyAccountId: string;
    on: string;
    memo?: string;
  },
): Promise<RecordPaymentResult> {
  const run = async (trx: Tx) => {
    const loan = await loansRepo.getById(trx, actor.orgId, input.loanId);
    if (!loan) throw new Error(`recordLoanPayment: loan ${input.loanId} does not exist.`);
    await authorize(trx, actor, 'record_ap_payment', { storeId: loan.storeId });
    // T-440 / S9: the screen's own rules judge the boxes AFTER the gate (T-364 order). Moved here from the action.
    assertFieldRules(LOAN_PAYMENT_RULES, { amount: input.amount, fromMoneyAccountId: input.fromMoneyAccountId, on: input.on });

    const amount = parseMoneyInput(input.amount, 'recordLoanPayment: the amount', 'The payment amount');
    if (compare(amount, ZERO) <= 0) {
      throw refuse('recordLoanPayment: the amount has to be greater than zero.', 'The payment amount has to be greater than zero.');
    }
    const account = await moneyAccountsRepo.getById(trx, actor.orgId, input.fromMoneyAccountId);
    if (!account) throw new Error('recordLoanPayment: that money account does not exist.');
    // T-369 S8b (DEF-556): paying from another store's account draws on money THERE; the loan's store alone
    // holding `record_ap_payment` is not enough. Before `positionOf`, so a non-holder reads nothing.
    if (account.storeId !== loan.storeId) {
      await authorize(trx, actor, 'transfer_funds', { storeId: account.storeId });
    }

    const position = await loansRepo.positionOf(trx, actor.orgId, loan.id);
    const outstanding = money(position.outstanding);
    if (compare(outstanding, ZERO) <= 0) {
      throw new Error(`recordLoanPayment: ${loan.name} has nothing outstanding.`);
    }

    // Interest runs from the last payment, or from the loan's start if there has been none.
    const since = (await loansRepo.lastPaymentDate(trx, actor.orgId, loan.id)) ?? loan.startDate;
    const accrued = accruedInterest({
      outstanding,
      principal: money(loan.principalAmount),
      ratePercent: Number(loan.interestRate),
      ratePeriod: loan.ratePeriod,
      method: loan.interestMethod,
      since,
      until: input.on,
    });

    const split = splitPayment({
      payment: amount,
      outstanding,
      accrued,
    });

    // ⛔ An overpayment is money the lender owes back, not a negative loan. Refused rather than
    // absorbed, so somebody decides what to do with it.
    if (compare(split.overpayment, ZERO) > 0) {
      throw new Error(
        `recordLoanPayment: ${input.amount} is more than this loan needs — ${split.interest} ` +
          `interest plus ${position.outstanding} principal. The extra ${split.overpayment} would ` +
          'be an overpayment, which is a refund from the lender rather than part of this debt.',
      );
    }

    // ⚠️ T-139's rule: a cashier account WARNS (its takings are not in the ledger until the day is
    // verified), an office account REFUSES. One implementation, shared (row 154).
    const warning = await checkDraw(
      trx,
      actor.orgId,
      account,
      amount,
      'recordLoanPayment',
    );

    const paymentLines = [
      ...(compare(split.principal, ZERO) > 0
        ? [{
            accountCode: LOAN_LIABILITY_CODE,
            storeId: loan.storeId,
            debit: split.principal,
            partyType: 'loan' as const,
            partyId: loan.id,
          }]
        : []),
      ...(compare(split.interest, ZERO) > 0
        ? [{ accountCode: INTEREST_EXPENSE_CODE, storeId: loan.storeId, debit: split.interest }]
        : []),
      {
        accountCode: account.glAccountCode,
        // T-369 S8b: the credit sits at the ACCOUNT's store - `balanceOf` reads a safe there.
        storeId: account.storeId,
        credit: amount,
        ...(account.glAccountCode === '1140'
          ? { partyType: 'money_account' as const, partyId: account.id }
          : {}),
      },
    ];
    const lines = await withInterStoreLegs(trx, actor.orgId, {
      owingStoreId: loan.storeId,
      memo: input.memo ?? `Loan payment — ${loan.name}`,
      lines: paymentLines,
    });

    const paymentId = crypto.randomUUID();
    const result = await postEntry(trx, {
      orgId: actor.orgId,
      entryDate: input.on,
      sourceType: 'loan_payment',
      sourceId: loan.id,
      idempotencyKey: `loan:${loan.id}:payment:${paymentId}`,
      memo: input.memo ?? `Loan payment — ${loan.name}`,
      postedBy: actor.personId,
      lines,
    });

    const after = await loansRepo.positionOf(trx, actor.orgId, loan.id);
    const paidOff = compare(money(after.outstanding), ZERO) <= 0;
    // ⚠️ Derived, not stamped: the ledger decides, the column records.
    if (paidOff && loan.status === 'active') {
      await loansRepo.setStatus(trx, actor.orgId, loan.id, { status: 'paid_off' });
    }

    return {
      entryId: result.entryId,
      split,
      outstanding: after.outstanding,
      paidOff,
      ...(warning ? { warning } : {}),
    };
  };
  return run(tx);
}

/**
 * ⛔ Reverse, never delete. And re-opens a `paid_off` loan, because the debt is back.
 *
 * DEF-156: `entryId` is caller-supplied, so before touching anything this confirms the entry
 * actually carries a `2400` line partied to THIS loan — checked by party, not by `source_type`,
 * the same reason `positionOf` reads that way (DEF-145: a repayment can legitimately arrive as a
 * leg inside an unrelated document, e.g. a channel settlement's dock). Without this check, anyone
 * holding `record_ap_payment` at this loan's store could reverse any posted entry in the org by
 * naming its id here.
 */
export async function reverseLoanEntry(
  tx: Tx,
  actor: Actor,
  input: { loanId: string; entryId: string; reason: string },
): Promise<{ reversalEntryId: string; /** false: the entry was already reversed, nothing new was written (T-412). */ created: boolean }> {
  const run = async (trx: Tx) => {
    const loan = await loansRepo.getById(trx, actor.orgId, input.loanId);
    if (!loan) throw new Error(`reverseLoanEntry: loan ${input.loanId} does not exist.`);
    await authorize(trx, actor, 'record_ap_payment', { storeId: loan.storeId });

    const reason = input.reason.trim();
    if (!reason) throw new Error('reverseLoanEntry: a reason is required.');

    const lines = await journalRepo.findLinesForEntryWithAccountCodes(trx, input.entryId);
    const belongsToThisLoan = lines.some(
      (l) =>
        l.accountCode === LOAN_LIABILITY_CODE &&
        l.partyType === 'loan' &&
        l.partyId === loan.id,
    );
    if (!belongsToThisLoan) {
      throw new Error(
        `reverseLoanEntry: entry ${input.entryId} does not belong to loan ${loan.id} — it carries ` +
          `no ${LOAN_LIABILITY_CODE} line partied to this loan.`,
      );
    }
    // T-369 S9 A1 (DEF-573): undoing a posting that moved another store's money moves it again - `transfer_funds`
    // at every other store the entry's lines touch. After the ownership check, so a foreign entry id still gets the
    // existing refusal and its stores are not probed.
    await authorizeOtherStores(trx, actor, { lines, documentStoreId: loan.storeId });

    const reversal = await reverseEntry(trx, {
      entryId: input.entryId,
      reason,
      reversedBy: actor.personId,
    });

    const after = await loansRepo.positionOf(trx, actor.orgId, loan.id);
    if (compare(money(after.outstanding), ZERO) > 0 && loan.status === 'paid_off') {
      // ⚠️ Otherwise a reversed final payment would leave a settled-looking loan that still owes
      // money — the exact state a stored total gets stuck in.
      await loansRepo.setStatus(trx, actor.orgId, loan.id, { status: 'active' });
    }
    return { reversalEntryId: reversal.reversalEntryId, created: reversal.created };
  };
  return run(tx);
}
