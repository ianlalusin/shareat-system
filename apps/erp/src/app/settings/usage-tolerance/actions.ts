'use server';

/**
 * Server actions for `/settings/usage-tolerance`. T-401 S6.
 *
 * ⛔ No rule is re-implemented here. `setOrgUsageTolerance` and `setItemUsageTolerance` call `authorize(tx, actor,
 * 'set_menu_depletion', …)` as their own first statement (admin only: a manager is refused) and own the refusal sentence for a
 * value that is not a fraction from 0 to 1; this action reads the form, calls them and shows the sentence that comes back.
 */
import { revalidatePath } from 'next/cache';
import { setItemUsageTolerance, setOrgUsageTolerance } from '@shareat/domain';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { redirectWithFlash } from '../../../lib/flash';
import { withOrgPrincipal } from './lib';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function setOrgUsageToleranceAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/settings/usage-tolerance');
  const tolerance = str(fd, 'tolerance');
  try {
    await withOrgPrincipal(actor.orgId, (tx) => setOrgUsageTolerance(tx, actor, { tolerance }));
  } catch (err) {
    return await redirectWithFlash('/settings/usage-tolerance', {}, { error: errorMessage(err) });
  }
  revalidatePath('/settings/usage-tolerance');
  return await redirectWithFlash('/settings/usage-tolerance', {}, { ok: 'The organisation-wide usage tolerance is saved.' });
}

/** An empty `tolerance` clears the item's own setting, so the organisation-wide one applies to it again. */
export async function setItemUsageToleranceAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/settings/usage-tolerance');
  const itemId = str(fd, 'itemId');
  const tolerance = str(fd, 'tolerance');
  try {
    await withOrgPrincipal(actor.orgId, (tx) => setItemUsageTolerance(tx, actor, { itemId, tolerance: tolerance === '' ? null : tolerance }));
  } catch (err) {
    return await redirectWithFlash('/settings/usage-tolerance', {}, { error: errorMessage(err) });
  }
  revalidatePath('/settings/usage-tolerance');
  return await redirectWithFlash(
    '/settings/usage-tolerance',
    {},
    { ok: tolerance === '' ? "The item's own tolerance is cleared. The organisation-wide one applies to it." : "The item's own usage tolerance is saved." },
  );
}
