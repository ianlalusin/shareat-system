'use server';

/**
 * Server actions for the loan screens. T-126.
 *
 * ⛔ The gates live in the services, not here. A gate in a server action protects one caller.
 */
import {
  createLoan,
  disburseLoan,
  recordLoanPayment,
  reverseLoanEntry,
} from '@shareat/domain';
import type { InterestMethod, PaymentFrequency, RatePeriod } from '@shareat/db';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { redirectWithFlash } from '@/lib/flash';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function createLoanAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let id = '';
  try {
    const storeId = str(formData, 'storeId');
    if (!storeId) throw new Error('Choose a store.');
    // T-351 / DEF-481 — the raw string, unparsed: `createLoan` parses it AFTER `authorize()`, in
    // the domain (`whole-number-input.ts`'s `parseWholeNumberInput`), never here.
    const created = await withOrgPrincipal(actor.orgId, (tx) =>
      createLoan(tx, actor, {
        storeId,
        lenderName: str(formData, 'lenderName'),
        name: str(formData, 'name'),
        principalAmount: str(formData, 'principalAmount'),
        interestRate: str(formData, 'interestRate'),
        ratePeriod: str(formData, 'ratePeriod') as RatePeriod,
        interestMethod: str(formData, 'interestMethod') as InterestMethod,
        paymentFrequency: str(formData, 'paymentFrequency') as PaymentFrequency,
        termPeriods: str(formData, 'termPeriods'),
        startDate: str(formData, 'startDate'),
        notes: str(formData, 'notes') || null,
      }),
    );
    id = created.id;
  } catch (err) {
    return await redirectWithFlash('/loans', {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/loans/${id}`, {}, {
    ok: 'Recorded. ⚠️ No money has moved — a signed loan is a commitment until it is drawn.',
  });
}

export async function disburseLoanAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'loanId');
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      disburseLoan(tx, actor, {
        loanId: id,
        amount: str(formData, 'amount'),
        intoMoneyAccountId: str(formData, 'intoMoneyAccountId'),
        on: str(formData, 'on'),
      }),
    );
  } catch (err) {
    return await redirectWithFlash(`/loans/${id}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/loans/${id}`, {}, { ok: 'Drawn. The money is in the account and the debt is on the books.' });
}

export async function recordPaymentAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'loanId');
  let summary = '';
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      recordLoanPayment(tx, actor, {
        loanId: id,
        amount: str(formData, 'amount'),
        fromMoneyAccountId: str(formData, 'fromMoneyAccountId'),
        on: str(formData, 'on'),
      }),
    );
    // ⭐ Shows the SPLIT, not just a total. That is the whole difference from v1, where the split
    // was typed — if the screen hid it, nobody would ever see what the computation decided.
    summary =
      `Paid. ₱${result.split.interest} interest, ₱${result.split.principal} principal. ` +
      (result.paidOff
        ? 'That clears the loan.'
        : `₱${result.outstanding} still outstanding.`);
    const warning = (result as { warning?: string }).warning;
    if (warning) summary += ` ⚠️ ${warning}`;
  } catch (err) {
    return await redirectWithFlash(`/loans/${id}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/loans/${id}`, {}, { ok: summary });
}

export async function reverseEntryAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'loanId');
  try {
    const reason = str(formData, 'reason');
    if (!reason) throw new Error('Say why this is being reversed.');
    await withOrgPrincipal(actor.orgId, (tx) =>
      reverseLoanEntry(tx, actor, { loanId: id, entryId: str(formData, 'entryId'), reason }),
    );
  } catch (err) {
    return await redirectWithFlash(`/loans/${id}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/loans/${id}`, {}, { ok: 'Reversed. The debt is back to what it was.' });
}
