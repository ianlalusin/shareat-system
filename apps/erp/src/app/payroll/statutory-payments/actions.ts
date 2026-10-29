'use server';

/**
 * Server actions for `/payroll/statutory-payments`. T-193 S5.
 *
 * Both take the actor from the session and hand the form's figures to the domain, which authorizes `remit_statutory`, judges
 * every figure and writes. Nothing is written here. A refusal comes back as the domain's own sentence on the form's page.
 */
import { recordStatutoryPayment, voidStatutoryPayment } from '@shareat/domain';
import { withOrgPrincipal, isAgency, agencyLabel } from './lib';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { periodOverrideProblem, readPeriodOverride } from '../../../lib/period-override';
import { redirectWithFlash, type Nav } from '@/lib/flash';
import { keepTyping } from '@/lib/keep-typing';
import { STATUTORY_PAYMENT_RECORD } from './typed-forms';
import { verifyAdminApproval } from '@shareat/auth';
import { loadDestructiveTarget, recordApproval } from '@/lib/destructive';

const BASE = '/payroll/statutory-payments';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}
function all(fd: FormData, key: string): string[] {
  return fd.getAll(key).map((v) => (typeof v === 'string' ? v.trim() : ''));
}

/** The form's store lines: a store left blank is not a line (the form offers every store that owes something). */
function linesOf(fd: FormData): { storeId: string; amount: string }[] | string {
  const stores = all(fd, 'lineStoreId');
  const amounts = all(fd, 'lineAmount');
  if (stores.length !== amounts.length) return 'This form is out of date. Reload the page and try again.';
  const lines: { storeId: string; amount: string }[] = [];
  stores.forEach((storeId, i) => {
    if (amounts[i] !== '') lines.push({ storeId, amount: amounts[i]! });
  });
  return lines;
}

export async function recordStatutoryPaymentAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const agency = str(formData, 'agency');
  const month = str(formData, 'month');
  const back = `${BASE}/new`;
  const nav: Nav = {
    ...(isAgency(agency) ? { agency } : {}),
    ...(/^\d{4}-\d{2}-01$/.test(month) ? { period: month.slice(0, 7) } : {}),
  };

  // What the person typed rides back in the signed flash cookie on a refusal, never in the address.
  const typed = () => keepTyping(formData, STATUTORY_PAYMENT_RECORD, '', { actorId: actor.personId });
  const lines = linesOf(formData);
  if (typeof lines === 'string') return await redirectWithFlash(back, nav, { error: lines, typed: typed() });
  // A ticked closed-month box that is not finished is refused out loud, never dropped quietly into the closed-month refusal.
  const unfinished = periodOverrideProblem(formData);
  if (unfinished) return await redirectWithFlash(back, nav, { error: unfinished, typed: typed() });
  const asked = readPeriodOverride(formData);

  const paymentId = str(formData, 'paymentId');
  let outcome: { id: string; created: boolean };
  try {
    outcome = await withOrgPrincipal(actor.orgId, (tx) =>
      recordStatutoryPayment(tx, actor, {
        paymentId,
        agency: agency as Parameters<typeof recordStatutoryPayment>[2]['agency'],
        month,
        paidOn: str(formData, 'paidOn'),
        moneyAccountId: str(formData, 'moneyAccountId'),
        referenceNo: str(formData, 'referenceNo'),
        lines,
        penalty: str(formData, 'penalty'),
        notes: str(formData, 'notes') || null,
        // The person answering for the override is always the signed-in actor, never a field.
        ...(asked ? { periodOverride: { actor, reason: asked.reason, note: asked.note ?? null } } : {}),
      }),
    );
  } catch (err) {
    return await redirectWithFlash(back, nav, { error: errorMessage(err), typed: typed() });
  }
  return await redirectWithFlash(
    `${BASE}/${outcome.id}`,
    {},
    {
      stamp: 'POSTED',
      ok: outcome.created
        ? `Recorded the ${agencyLabel(agency)} payment. It is posted to the ledger.`
        : `This ${agencyLabel(agency)} payment was already recorded. Nothing was posted twice.`,
    },
  );
}

export async function voidStatutoryPaymentAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const paymentId = str(formData, 'paymentId');
  const on = str(formData, 'on');
  let id: string;
  try {
    // T-412 Tier P: an administrator's PIN, verified on the server before the domain call. The payment spans stores, so the approval
    // is the organisation's own (the record has no store of its own).
    const target = await loadDestructiveTarget(actor, 'statutory_payment', paymentId, ['remit_statutory']);
    const approval = await verifyAdminApproval(null, { actor, storeId: target.storeId, pin: str(formData, 'adminPin'), capability: 'remit_statutory' });
    id = await withOrgPrincipal(actor.orgId, async (tx) => {
      const voided = await voidStatutoryPayment(tx, actor, { paymentId, reason: str(formData, 'reason'), ...(on ? { on } : {}) });
      await recordApproval(tx, actor, approval, { capability: 'remit_statutory', entityType: 'statutory_payment', entityId: paymentId, storeId: target.storeId });
      return voided.id;
    });
  } catch (err) {
    return await redirectWithFlash(/^[0-9a-f-]{36}$/i.test(paymentId) ? `${BASE}/${paymentId}` : BASE, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`${BASE}/${id}`, {}, { stamp: 'VOID', ok: 'Voided. The payment is reversed in the ledger and the month is owed again.' });
}
