'use server';

/**
 * Server actions for `/payroll/separations`. T-192.
 *
 * ⛔ Every gate is `authorize()` inside the service (`run_payroll`) — same shape as
 * `payroll/actions.ts` and `thirteenth-month/actions.ts`. A gate in a server action protects one
 * caller.
 */
import { assertFieldRules, postSeparation, voidSeparation } from '@shareat/domain';
import { PAYROLL_SEPARATION_RULES } from '@shareat/domain/field-rules';
import type { SeparationCause } from '@shareat/db/schema';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { redirectWithFlash } from '@/lib/flash';
import { verifyAdminApproval } from '@shareat/auth';
import { loadDestructiveTarget, recordApproval } from '@/lib/destructive';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function postSeparationAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const store = str(formData, 'storeId');
  const employmentId = str(formData, 'employmentId');
  const separationDate = str(formData, 'separationDate');
  try {
    // T-412 Tier P: posting a separation pays out and ends the employment. An administrator's PIN, verified on the server
    // against the EMPLOYMENT's store (the record), not the form's `storeId`.
    const target = await loadDestructiveTarget(actor, 'employment', employmentId, ['run_payroll']);
    assertFieldRules(PAYROLL_SEPARATION_RULES, formData);
    const approval = await verifyAdminApproval(null, { actor, storeId: target.storeId, pin: str(formData, 'adminPin'), capability: 'run_payroll' });
    await withOrgPrincipal(actor.orgId, async (tx) => {
      await postSeparation(tx, actor, {
        storeId: store,
        employmentId,
        separationDate,
        cause: str(formData, 'cause') as SeparationCause,
        // T-371 R6 — a blank goes to the domain AS a blank; the column (NOT NULL DEFAULT '0') decides, not this form.
        separationPayAmount: str(formData, 'separationPayAmount'),
        moneyAccountId: str(formData, 'moneyAccountId'),
        clearanceConfirmedBy: str(formData, 'clearanceConfirmed') === 'on' ? actor.personId : '',
        clearanceNotes: str(formData, 'clearanceNotes') || null,
        notes: str(formData, 'notes') || null,
      });
      await recordApproval(tx, actor, approval, { capability: 'run_payroll', entityType: 'employment', entityId: employmentId, storeId: target.storeId });
    });
  } catch (err) {
    // ⭐ Keeps the form's selection alive on a rejection — a validation error should not also
    // throw away which employment and date were being processed.
    return await redirectWithFlash(
      '/payroll/separations',
      { store, employmentId },
      { error: errorMessage(err), keep: { separationDate } },
    );
  }
  return await redirectWithFlash('/payroll/separations', { store }, { ok: 'Separation posted.' });
}

export async function voidSeparationAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const store = str(formData, 'storeId');
  try {
    // T-412 Tier P: an administrator's PIN, verified on the server against the RECORD's store (not the page's `storeId` field).
    const separationId = str(formData, 'id');
    const target = await loadDestructiveTarget(actor, 'separation', separationId, ['run_payroll']);
    const approval = await verifyAdminApproval(null, { actor, storeId: target.storeId, pin: str(formData, 'adminPin'), capability: 'run_payroll' });
    await withOrgPrincipal(actor.orgId, async (tx) => {
      await voidSeparation(tx, actor, { id: separationId, reason: str(formData, 'reason') });
      await recordApproval(tx, actor, approval, { capability: 'run_payroll', entityType: 'separation', entityId: separationId, storeId: target.storeId });
    });
  } catch (err) {
    return await redirectWithFlash('/payroll/separations', { store }, { error: errorMessage(err) });
  }
  return await redirectWithFlash(
    '/payroll/separations',
    { store },
    { stamp: 'VOID', ok: 'Voided — that employment can be separated again if this was a correction.' },
  );
}
