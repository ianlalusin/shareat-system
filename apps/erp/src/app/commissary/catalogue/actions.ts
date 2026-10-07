'use server';

/**
 * Server actions for the commissary-catalogue screen — T-171 / DEF-129, 2026-09-03.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect with a message. ⭐ The actor comes
 * from the session, never the form (T-138) — authorization is `upsertCommissaryLink` /
 * `upsertOffering` / `upsertMap` / `removeMap`'s own FIRST statement, not repeated here. Every
 * mutation runs under the org's RLS principal (`withOrgPrincipal`), the same way the trade-orders
 * and expenses actions do.
 */
import { revalidatePath } from 'next/cache';
import { removeMap, upsertCommissaryLink, upsertMap, upsertOffering } from '@shareat/domain';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { redirectWithFlash } from '@/lib/flash';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function upsertLinkAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/commissary/catalogue');
  const commissaryStoreId = str(fd, 'commissaryStoreId');
  const branchStoreId = str(fd, 'branchStoreId');
  const status = str(fd, 'status') === 'inactive' ? 'inactive' : 'active';

  let message = '';
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      upsertCommissaryLink(tx, actor, { commissaryStoreId, branchStoreId, status }),
    );
    message =
      status === 'active'
        ? result.customerCreated
          ? 'Linked. An internal customer record was created so this branch can be named on a trade order.'
          : 'Linked.'
        : 'Link set to inactive — the branch can no longer be mapped or ordered from here.';
  } catch (err) {
    return await redirectWithFlash('/commissary/catalogue', { commissary: commissaryStoreId }, { error: errorMessage(err) });
  }
  revalidatePath('/commissary/catalogue');
  return await redirectWithFlash('/commissary/catalogue', { commissary: commissaryStoreId }, { ok: message });
}

export async function upsertOfferingAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/commissary/catalogue');
  const commissaryStoreId = str(fd, 'commissaryStoreId');
  const itemId = str(fd, 'itemId');
  const manualCost = str(fd, 'manualCost');
  const statusRaw = str(fd, 'status');
  const status = statusRaw === 'inactive' || statusRaw === 'active' ? statusRaw : undefined;

  let message = '';
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      upsertOffering(tx, actor, { commissaryStoreId, itemId, manualCost: manualCost || null, status }),
    );
    message = status === 'inactive' ? 'Offering deactivated.' : 'Offering saved.';
  } catch (err) {
    return await redirectWithFlash('/commissary/catalogue', { commissary: commissaryStoreId }, { error: errorMessage(err) });
  }
  revalidatePath('/commissary/catalogue');
  return await redirectWithFlash('/commissary/catalogue', { commissary: commissaryStoreId }, { ok: message });
}

export async function upsertMapAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/commissary/catalogue');
  const commissaryStoreId = str(fd, 'commissaryStoreId');
  const branchStoreId = str(fd, 'branchStoreId');

  let message = '';
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      upsertMap(tx, actor, {
        commissaryStoreId,
        branchStoreId,
        commissaryItemId: str(fd, 'commissaryItemId'),
        branchItemId: str(fd, 'branchItemId'),
        isLedgerOnly: fd.get('isLedgerOnly') === 'on',
        expenseCategoryId: str(fd, 'expenseCategoryId') || null,
      }),
    );
    message = 'Mapped. This line can now be received as a real internal transfer.';
  } catch (err) {
    return await redirectWithFlash('/commissary/catalogue', { commissary: commissaryStoreId, branch: branchStoreId }, { error: errorMessage(err) });
  }
  revalidatePath('/commissary/catalogue');
  return await redirectWithFlash('/commissary/catalogue', { commissary: commissaryStoreId, branch: branchStoreId }, { ok: message });
}

export async function removeMapAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/commissary/catalogue');
  const commissaryStoreId = str(fd, 'commissaryStoreId');
  const branchStoreId = str(fd, 'branchStoreId');
  const id = str(fd, 'id');

  let message = '';
  try {
    await withOrgPrincipal(actor.orgId, (tx) => removeMap(tx, actor, { id }));
    message = 'Map row removed.';
  } catch (err) {
    return await redirectWithFlash('/commissary/catalogue', { commissary: commissaryStoreId, branch: branchStoreId }, { error: errorMessage(err) });
  }
  revalidatePath('/commissary/catalogue');
  return await redirectWithFlash('/commissary/catalogue', { commissary: commissaryStoreId, branch: branchStoreId }, { ok: message });
}
