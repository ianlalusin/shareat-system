'use server';

/**
 * Server actions for `/settings/pos-link`. T-375 S1.
 *
 * ⛔ No rule is re-implemented here. `linkStoreToPos` calls `authorize(tx, actor, 'manage_chart_of_accounts', …)` as
 * its own first statement and owns every refusal sentence (channel, POS store, unverified typed days); this action
 * only reads the form, calls it, and shows whatever sentence comes back.
 */
import { revalidatePath } from 'next/cache';
import { authorize } from '@shareat/auth';
import { storesRepo } from '@shareat/db';
import { createTender, linkStoreToPos, setTenderActive, unlinkStoreFromPos, updateTender } from '@shareat/domain';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { redirectWithFlash } from '../../../lib/flash';
import { posStoreOptions, withOrgPrincipal } from './lib';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** R7: every action lands on its store's card. A blank store id gives a shape the helper drops. */
function anchorOf(storeId: string): string {
  return `store-${storeId}`;
}

/** R1: the web actions always carry the version the page was drawn with. The sentence is the domain's, repeated here. */
const STALE_SENTENCE = 'This tender was changed after this page was opened. The page now shows what is saved. Check it and save again.';

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
    return await redirectWithFlash('/settings/pos-link', storeId ? { store: storeId } : {}, { error: errorMessage(err) }, { anchor: anchorOf(storeId) });
  }
  revalidatePath('/settings/pos-link');
  return await redirectWithFlash('/settings/pos-link', storeId ? { store: storeId } : {}, { ok: `${storeName || 'The store'} is linked to POS.` }, { anchor: anchorOf(storeId) });
}

// ---------------------------------------------------------------------------------------------
// Tenders (T-375 S2). Same rule: createTender, updateTender and setTenderActive each call
// authorize(tx, actor, 'manage_chart_of_accounts', ...) first and own every sentence.
// ---------------------------------------------------------------------------------------------
export async function createTenderAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/settings/pos-link');
  const storeId = str(fd, 'storeId');
  try {
    const kind = str(fd, 'kind');
    await withOrgPrincipal(actor.orgId, (tx) =>
      createTender(tx, actor, {
        storeId,
        name: str(fd, 'name'),
        kind: kind as 'cash' | 'wallet', // R4: never decided here; a blank or unknown kind is the domain's to refuse
        moneyAccountId: str(fd, 'moneyAccountId') || null,
        posV1Alias: str(fd, 'posV1Alias') || null,
      }),
    );
  } catch (err) {
    return await redirectWithFlash('/settings/pos-link', storeId ? { store: storeId } : {}, { error: errorMessage(err) }, { anchor: anchorOf(storeId) });
  }
  revalidatePath('/settings/pos-link');
  return await redirectWithFlash('/settings/pos-link', storeId ? { store: storeId } : {}, { ok: 'Tender added.' }, { anchor: anchorOf(storeId) });
}

export async function updateTenderAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/settings/pos-link');
  const storeId = str(fd, 'storeId');
  try {
    const accountId = str(fd, 'moneyAccountId');
    const kind = str(fd, 'kind');
    const version = str(fd, 'version');
    if (!version) throw new Error(STALE_SENTENCE);
    // R5: the account is forwarded only for a wallet (the form always submits the select); a cash result sends none
    // and the domain clears it. A form with no kind field keeps the old behaviour.
    await withOrgPrincipal(actor.orgId, (tx) =>
      updateTender(tx, actor, {
        tenderId: str(fd, 'tenderId'),
        expectedVersion: version,
        name: str(fd, 'name'),
        posV1Alias: str(fd, 'posV1Alias') || null,
        ...(kind ? { kind: kind as 'cash' | 'wallet' } : {}),
        ...(kind === 'cash' ? {} : accountId ? { moneyAccountId: accountId } : {}),
      }),
    );
  } catch (err) {
    return await redirectWithFlash('/settings/pos-link', storeId ? { store: storeId } : {}, { error: errorMessage(err) }, { anchor: anchorOf(storeId) });
  }
  revalidatePath('/settings/pos-link');
  return await redirectWithFlash('/settings/pos-link', storeId ? { store: storeId } : {}, { ok: 'Tender saved.' }, { anchor: anchorOf(storeId) });
}

export async function setTenderActiveAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/settings/pos-link');
  const storeId = str(fd, 'storeId');
  const isActive = str(fd, 'isActive') === 'true';
  try {
    const version = str(fd, 'version');
    if (!version) throw new Error(STALE_SENTENCE);
    await withOrgPrincipal(actor.orgId, (tx) => setTenderActive(tx, actor, { tenderId: str(fd, 'tenderId'), isActive, expectedVersion: version }));
  } catch (err) {
    return await redirectWithFlash('/settings/pos-link', storeId ? { store: storeId } : {}, { error: errorMessage(err) }, { anchor: anchorOf(storeId) });
  }
  revalidatePath('/settings/pos-link');
  return await redirectWithFlash('/settings/pos-link', storeId ? { store: storeId } : {}, { ok: isActive ? 'Tender restored.' : 'Tender retired.' }, { anchor: anchorOf(storeId) });
}

// ---------------------------------------------------------------------------------------------
// Unlink (T-382, R11/R13). `unlinkStoreFromPos` calls authorize(tx, actor, 'unlink_store_from_pos', ...) first and owns
// every refusal sentence (blank reason, not linked, unverified imported days). This action reads the form, refuses an
// unticked box, calls it, and goes back through the flash: the reason is never in the address.
// ---------------------------------------------------------------------------------------------
export async function unlinkStoreFromPosAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/settings/pos-link');
  const storeId = str(fd, 'storeId');
  let storeName = 'The store';
  try {
    // The reason is kept exactly as typed (the domain trims it); only the box is judged here, AFTER authorize (I1).
    const reason = typeof fd.get('reason') === 'string' ? (fd.get('reason') as string) : '';
    storeName = await withOrgPrincipal(actor.orgId, async (tx) => {
      await authorize(tx, actor, 'unlink_store_from_pos', {});
      if (fd.get('confirm') !== 'on') throw new Error('Tick the box to confirm.');
      await unlinkStoreFromPos(tx, actor, { storeId, reason });
      return (await storesRepo.getById(tx, actor.orgId, storeId))?.name ?? storeName;
    });
  } catch (err) {
    return await redirectWithFlash('/settings/pos-link', storeId ? { store: storeId } : {}, { error: errorMessage(err) }, { anchor: anchorOf(storeId) });
  }
  revalidatePath('/settings/pos-link');
  return await redirectWithFlash('/settings/pos-link', storeId ? { store: storeId } : {}, { ok: `${storeName} is unlinked from POS. Its sales days are typed from now on.` }, { anchor: anchorOf(storeId) });
}
