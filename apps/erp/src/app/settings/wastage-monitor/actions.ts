'use server';

/**
 * Server action for `/settings/wastage-monitor`. T-229 slice 3 (DEF-206).
 *
 * ⛔ The gate is `authorize(tx, actor, 'manage_store_settings', { storeId })` **inside**
 * `setWastageMonitor` — this action does not re-check it, for the reason
 * `settings/attendance/actions.ts:6-9` already states: a gate here would protect only this one
 * caller, and the screen would be one new form away from a hole.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { setWastageMonitor } from '@shareat/domain';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { withOrgPrincipal } from './lib';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function back(storeId: string, params: Record<string, string>): never {
  redirect(`/settings/wastage-monitor?${new URLSearchParams({ store: storeId, ...params }).toString()}`);
}

export async function setWastageMonitorAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/settings/wastage-monitor');
  const storeId = str(fd, 'storeId');
  const label = str(fd, 'personLabel');
  // ⭐ The blank option is a REAL choice — "nobody answers for a wasted order here" — not an
  // absent field. `''` becomes `null`, never the empty-string person id (DEF-087's failure shape).
  const raw = str(fd, 'personId');
  const personId = raw === '' ? null : raw;

  try {
    await withOrgPrincipal(actor.orgId, (tx) => setWastageMonitor(tx, actor, { storeId, personId }));
  } catch (err) {
    back(storeId, { error: errorMessage(err) });
  }
  revalidatePath('/settings/wastage-monitor');
  revalidatePath('/wastage');
  back(storeId, {
    ok:
      personId === null
        ? 'Nobody is named now. A wasted order recorded here will have no one answering for it, ' +
          'and after 15 days the store absorbs it.'
        : `${label || 'That person'} now answers for wasted orders at this store — from now on. ` +
          'Anything already open keeps whatever owner it was created with.',
  });
}
