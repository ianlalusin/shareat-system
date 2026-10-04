'use server';

/**
 * Server actions for `/settings/pos-link`. T-375 S1.
 *
 * ⛔ No rule is re-implemented here. `linkStoreToPos` calls `authorize(tx, actor, 'manage_chart_of_accounts', …)` as
 * its own first statement and owns every refusal sentence (channel, POS store, unverified typed days); this action
 * only reads the form, calls it, and shows whatever sentence comes back.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { authorize } from '@shareat/auth';
import { linkStoreToPos } from '@shareat/domain';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { posStoreOptions, withOrgPrincipal } from './lib';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function back(params: Record<string, string>): never {
  redirect(`/settings/pos-link?${new URLSearchParams(params).toString()}`);
}

const TAX_TYPES = ['vat_inclusive', 'vat_exclusive', 'non_vat'] as const;

export async function linkStoreToPosAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/settings/pos-link');
  const storeId = str(fd, 'storeId');
  const storeName = str(fd, 'storeName');
  const posStoreId = str(fd, 'posStoreId');
  const taxRaw = str(fd, 'posTaxType');
  try {
    // Authorise BEFORE any POS bridge call: someone who may not link must not make this server call POS.
    await withOrgPrincipal(actor.orgId, (tx) => authorize(tx, actor, 'manage_chart_of_accounts', { storeId }));
    // Picker mode (the bridge answers): the id must be one POS listed, and the stored name is POS's, never the
    // form's. Bridge down: the text box path, with the typed name.
    let posStoreName: string;
    const options = await posStoreOptions();
    if (options) {
      const hit = options.find((o) => o.id === posStoreId);
      if (!hit) throw new Error('That is not one of the stores POS lists. Choose a POS store from the list.');
      posStoreName = hit.name || hit.id;
    } else {
      posStoreName = str(fd, 'posStoreName');
    }
    if (!(TAX_TYPES as readonly string[]).includes(taxRaw)) {
      throw new Error("Choose the tax type shown in the POS store's settings.");
    }
    await withOrgPrincipal(actor.orgId, (tx) =>
      linkStoreToPos(tx, actor, {
        storeId,
        posStoreId,
        posStoreName,
        salesChannelId: str(fd, 'salesChannelId'),
        posTaxType: taxRaw as (typeof TAX_TYPES)[number],
      }),
    );
  } catch (err) {
    back({ error: errorMessage(err), store: storeId });
  }
  revalidatePath('/settings/pos-link');
  back({ ok: `${storeName || 'The store'} is linked to POS.`, store: storeId });
}
