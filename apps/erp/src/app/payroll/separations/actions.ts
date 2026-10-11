'use server';

/**
 * Server actions for `/payroll/separations`. T-192.
 *
 * ⛔ Every gate is `authorize()` inside the service (`run_payroll`) — same shape as
 * `payroll/actions.ts` and `thirteenth-month/actions.ts`. A gate in a server action protects one
 * caller.
 */
import { postSeparation, voidSeparation } from '@shareat/domain';
import type { SeparationCause } from '@shareat/db/schema';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { redirectWithFlash } from '@/lib/flash';

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
    await withOrgPrincipal(actor.orgId, (tx) =>
      postSeparation(tx, actor, {
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
      }),
    );
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
    await withOrgPrincipal(actor.orgId, (tx) =>
      voidSeparation(tx, actor, { id: str(formData, 'id'), reason: str(formData, 'reason') }),
    );
  } catch (err) {
    return await redirectWithFlash('/payroll/separations', { store }, { error: errorMessage(err) });
  }
  return await redirectWithFlash(
    '/payroll/separations',
    { store },
    { stamp: 'VOID', ok: 'Voided — that employment can be separated again if this was a correction.' },
  );
}
