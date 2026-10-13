'use server';

/**
 * Server action for the dual-run week page. T-392 S5.
 *
 * ⛔ The gate is NOT here. `recordDualRunDisposition` authorizes `run_cutover`, `view_financial_reports` at the line's
 * store and the admin / super_admin role itself, so a stale page, a forged form or a manager who guessed the field names
 * all end in the same refusal. The form on the page is a hint; this action only carries the answer back.
 */
import { recordDualRunDisposition, type RecordDualRunDispositionInput } from '@shareat/domain';
import { AuthorizationError } from '@shareat/auth';
import { dualRunReadsRepo } from '@shareat/db';
import { withOrgPrincipal } from '../lib';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { redirectWithFlash } from '@/lib/flash';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function recordDualRunDispositionAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const input = {
    storeId: str(formData, 'storeId'),
    weekStart: str(formData, 'weekStart'),
    kind: str(formData, 'kind'),
    lineKey: str(formData, 'lineKey'),
    class: str(formData, 'class'),
    ref: str(formData, 'ref'),
    note: str(formData, 'note'),
  } as RecordDualRunDispositionInput;

  // Where to land again, resolved AFTER the gate: an unauthorized caller never makes a store lookup.
  let path = '/reports/dual-run';
  try {
    await withOrgPrincipal(actor.orgId, async (tx) => {
      await recordDualRunDisposition(tx, actor, input);
      const code = (await dualRunReadsRepo.storesByIds(tx, actor.orgId, [input.storeId]))[0]?.code;
      if (code && /^\d{4}-\d{2}-\d{2}$/.test(input.weekStart)) path = `/reports/dual-run/${encodeURIComponent(code)}/${input.weekStart}`;
    });
  } catch (err) {
    // A refused actor lands on the overview (no lookup before the gate); any other refusal returns to the week.
    if (!(err instanceof AuthorizationError)) {
      const code = await withOrgPrincipal(actor.orgId, async (tx) => (await dualRunReadsRepo.storesByIds(tx, actor.orgId, [input.storeId]))[0]?.code).catch(() => undefined);
      if (code && /^\d{4}-\d{2}-\d{2}$/.test(input.weekStart)) path = `/reports/dual-run/${encodeURIComponent(code)}/${input.weekStart}`;
    }
    return await redirectWithFlash(path, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(path, {}, { ok: 'Recorded. It counts from the next compare run; the pack shows "re-run compare" until then.' });
}
