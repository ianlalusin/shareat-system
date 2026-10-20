'use server';

/**
 * Server actions for the loan screens. T-126.
 *
 * ⛔ The gates live in the services, not here. A gate in a server action protects one caller.
 */
import { LOAN_REVERSE_RULES } from '@shareat/domain/field-rules';
import {
  assertFieldRules,
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
import { verifyAdminApproval } from '@shareat/auth';
import { loadDestructiveTarget, recordApproval } from '@/lib/destructive';
import { refuse } from '@shareat/db';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function createLoanAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let id = '';
  try {
    const storeId = str(formData, 'storeId');
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
    // T-412 Tier P: an administrator's PIN, verified on the server against the RECORD's store.
    const target = await loadDestructiveTarget(actor, 'loan', id, ['record_ap_payment']);
    assertFieldRules(LOAN_REVERSE_RULES, formData);
    const approval = await verifyAdminApproval(null, { actor, storeId: target.storeId, pin: str(formData, 'adminPin'), capability: 'record_ap_payment' });
    const entryId = str(formData, 'entryId');
    await withOrgPrincipal(actor.orgId, async (tx) => {
      const reversed = await reverseLoanEntry(tx, actor, { loanId: id, entryId, reason });
      // A second reversal of the same entry is a harmless no-op in the domain: nothing was approved or changed, so no
      // approval event is written and the person is told.
      if (!reversed.created) throw refuse(`reverseLoanEntry: entry ${entryId} was already reversed`, 'That entry was already reversed - nothing changed.');
      await recordApproval(tx, actor, approval, { capability: 'record_ap_payment', entityType: 'loan_entry', entityId: entryId, storeId: target.storeId });
    });
  } catch (err) {
    return await redirectWithFlash(`/loans/${id}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/loans/${id}`, {}, { stamp: 'REVERSED', ok: 'Reversed. The debt is back to what it was.' });
}
