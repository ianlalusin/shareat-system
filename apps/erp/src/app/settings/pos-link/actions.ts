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
import { posV1Repo, storesRepo } from '@shareat/db';
import {
  assertFieldRules,
  createPaymentOption,
  linkStoreToPos,
  setPaymentOptionStatus,
  setTenderActive,
  switchOnPaymentOption,
  unlinkStoreFromPos,
  updatePaymentOption,
  updateTender,
} from '@shareat/domain';
import { SETTINGS_POS_UNLINK_RULES } from '@shareat/domain/field-rules';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { redirectWithFlash } from '../../../lib/flash';
import { keepTyping } from '../../../lib/keep-typing';
import { posStoreOptions, withOrgPrincipal } from './lib';
import { PAYMENT_OPTION_EDIT, POS_LINK_EDIT, TENDER_EDIT } from './typed-forms';
import { loadDestructiveTarget, retypeRefusalError } from '@/lib/destructive';
import { retypeMatches } from '@/lib/retype';

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
  // T-389: only a store that is ALREADY linked has an EditableRecord to reopen; the first link is an add form (N1).
  let editingLink = false;
  try {
    // Authorise BEFORE any POS bridge call: someone who may not link must not make this server call POS.
    await withOrgPrincipal(actor.orgId, (tx) => authorize(tx, actor, 'manage_chart_of_accounts', { storeId }));
    editingLink = (await withOrgPrincipal(actor.orgId, (tx) => posV1Repo.listLinks(tx, actor.orgId))).some((l) => l.storeId === storeId && !l.unlinkedAt);
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
    // T-389: a refused Save keeps the typing (signed flash, never the URL) so a linked store's record reopens holding it.
    return await redirectWithFlash(
      '/settings/pos-link',
      storeId ? { store: storeId } : {},
      { error: errorMessage(err), typed: editingLink ? keepTyping(fd, POS_LINK_EDIT, storeId, { actorId: actor.personId }) : undefined },
      { anchor: anchorOf(storeId) },
    );
  }
  revalidatePath('/settings/pos-link');
  return await redirectWithFlash('/settings/pos-link', storeId ? { store: storeId } : {}, { ok: `${storeName || 'The store'} is linked to POS.` }, { anchor: anchorOf(storeId) });
}

// ---------------------------------------------------------------------------------------------
// Tenders (T-375 S2; T-629: a tender is a store's switch for a master payment option). Same rule: switchOnPaymentOption, updateTender and setTenderActive each call
// authorize(tx, actor, 'manage_chart_of_accounts', ...) first and own every sentence.
// ---------------------------------------------------------------------------------------------
/**
 * R7: an ok sentence names the tender, read back from the database after the write commits, never trusted from the
 * form. The read-back is only a label: if it cannot be read the write must still stand, so it falls back to a plain word.
 */
async function savedName(orgId: string, tenderId: string): Promise<string> {
  try {
    // Its own read, AFTER the write committed: a failing lookup can never abort or roll back the write.
    return await withOrgPrincipal(orgId, async (tx) => (await posV1Repo.getTenderById(tx, orgId, tenderId))?.name ?? 'Tender');
  } catch {
    return 'Tender';
  }
}

/** T-629: switch a master payment option on at a store (a wallet names the store's money account). */
export async function switchOnPaymentOptionAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/settings/pos-link');
  const storeId = str(fd, 'storeId');
  let name = 'Payment option';
  try {
    const { id } = await withOrgPrincipal(actor.orgId, async (tx) =>
      switchOnPaymentOption(tx, actor, {
        storeId,
        paymentOptionId: str(fd, 'paymentOptionId'),
        moneyAccountId: str(fd, 'moneyAccountId') || null,
        posV1Alias: str(fd, 'posV1Alias') || null,
      }),
    );
    name = await savedName(actor.orgId, id);
  } catch (err) {
    return await redirectWithFlash('/settings/pos-link', storeId ? { store: storeId } : {}, { error: errorMessage(err) }, { anchor: anchorOf(storeId) });
  }
  revalidatePath('/settings/pos-link');
  return await redirectWithFlash('/settings/pos-link', storeId ? { store: storeId } : {}, { ok: `${name} switched on.` }, { anchor: anchorOf(storeId) });
}

export async function updateTenderAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/settings/pos-link');
  const storeId = str(fd, 'storeId');
  const tenderId = str(fd, 'tenderId');
  let name = 'Tender';
  try {
    const accountId = str(fd, 'moneyAccountId');
    const version = str(fd, 'version');
    if (!version) throw new Error(STALE_SENTENCE);
    // T-629: the name and kind are the payment option's; only the store's own money account (a wallet's: a cash form sends none) and POS name move here.
    await withOrgPrincipal(actor.orgId, async (tx) => {
      await updateTender(tx, actor, {
        tenderId,
        expectedVersion: version,
        posV1Alias: str(fd, 'posV1Alias') || null,
        ...(accountId ? { moneyAccountId: accountId } : {}),
      });
    });
    name = await savedName(actor.orgId, tenderId);
  } catch (err) {
    // DEF-617 / T-389: the refused Save carries what was typed in the signed flash (never the URL), so the record
    // reopens in edit mode holding it. A STALE refusal keeps nothing: the page redraws the tender locked with what is
    // saved (the other user's change).
    const message = errorMessage(err);
    return await redirectWithFlash(
      '/settings/pos-link',
      storeId ? { store: storeId } : {},
      { error: message, typed: keepTyping(fd, TENDER_EDIT, tenderId, { actorId: actor.personId, stale: message === STALE_SENTENCE }) },
      { anchor: anchorOf(storeId) },
    );
  }
  revalidatePath('/settings/pos-link');
  return await redirectWithFlash('/settings/pos-link', storeId ? { store: storeId } : {}, { ok: `${name} saved.` }, { anchor: anchorOf(storeId) });
}

export async function setTenderActiveAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/settings/pos-link');
  const storeId = str(fd, 'storeId');
  const isActive = str(fd, 'isActive') === 'true';
  let name = 'Tender';
  try {
    const version = str(fd, 'version');
    if (!version) throw new Error(STALE_SENTENCE);
    const tenderId = str(fd, 'tenderId');
    // T-412 Tier R: RETIRING a tender needs its name retyped (the server compares it with the name IT loads); restoring is
    // not destructive and needs nothing.
    if (!isActive) {
      const target = await loadDestructiveTarget(actor, 'tender', tenderId, ['manage_chart_of_accounts']);
      if (!retypeMatches(str(fd, 'confirmName'), target.name ?? '')) throw retypeRefusalError(target.name ?? '');
    }
    await withOrgPrincipal(actor.orgId, (tx) => setTenderActive(tx, actor, { tenderId, isActive, expectedVersion: version }));
    name = await savedName(actor.orgId, tenderId);
  } catch (err) {
    return await redirectWithFlash('/settings/pos-link', storeId ? { store: storeId } : {}, { error: errorMessage(err) }, { anchor: anchorOf(storeId) });
  }
  revalidatePath('/settings/pos-link');
  return await redirectWithFlash('/settings/pos-link', storeId ? { store: storeId } : {}, { ok: `${name} ${isActive ? 'switched on' : 'switched off'}.` }, { anchor: anchorOf(storeId) });
}

// ---------------------------------------------------------------------------------------------
// Payment options (T-629): the org's master list. createPaymentOption, updatePaymentOption and setPaymentOptionStatus each call
// authorize(tx, actor, 'manage_chart_of_accounts', {}) first and own every sentence. The feedback lands on the master section.
// ---------------------------------------------------------------------------------------------
const OPTIONS_ANCHOR = 'payment-options';

export async function createPaymentOptionAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/settings/pos-link');
  let name = 'Payment option';
  try {
    const made = await withOrgPrincipal(actor.orgId, (tx) => createPaymentOption(tx, actor, { name: str(fd, 'name'), kind: str(fd, 'kind') as 'cash' | 'wallet' }));
    name = (await withOrgPrincipal(actor.orgId, (tx) => posV1Repo.getPaymentOptionById(tx, actor.orgId, made.id)))?.name ?? name;
  } catch (err) {
    return await redirectWithFlash('/settings/pos-link', {}, { error: errorMessage(err) }, { anchor: OPTIONS_ANCHOR });
  }
  revalidatePath('/settings/pos-link');
  return await redirectWithFlash('/settings/pos-link', {}, { ok: `${name} added to the payment options.` }, { anchor: OPTIONS_ANCHOR });
}

export async function updatePaymentOptionAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/settings/pos-link');
  const paymentOptionId = str(fd, 'paymentOptionId');
  try {
    const kind = str(fd, 'kind');
    await withOrgPrincipal(actor.orgId, (tx) =>
      updatePaymentOption(tx, actor, { paymentOptionId, name: str(fd, 'name'), ...(kind ? { kind: kind as 'cash' | 'wallet' } : {}) }),
    );
  } catch (err) {
    return await redirectWithFlash(
      '/settings/pos-link',
      {},
      { error: errorMessage(err), typed: keepTyping(fd, PAYMENT_OPTION_EDIT, paymentOptionId, { actorId: actor.personId, stale: false }) },
      { anchor: OPTIONS_ANCHOR },
    );
  }
  revalidatePath('/settings/pos-link');
  return await redirectWithFlash('/settings/pos-link', {}, { ok: 'Payment option saved.' }, { anchor: OPTIONS_ANCHOR });
}

export async function setPaymentOptionStatusAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/settings/pos-link');
  const status = str(fd, 'status') === 'retired' ? 'retired' : 'active';
  try {
    await withOrgPrincipal(actor.orgId, (tx) => setPaymentOptionStatus(tx, actor, { paymentOptionId: str(fd, 'paymentOptionId'), status }));
  } catch (err) {
    return await redirectWithFlash('/settings/pos-link', {}, { error: errorMessage(err) }, { anchor: OPTIONS_ANCHOR });
  }
  revalidatePath('/settings/pos-link');
  return await redirectWithFlash('/settings/pos-link', {}, { ok: status === 'retired' ? 'Payment option retired.' : 'Payment option restored.' }, { anchor: OPTIONS_ANCHOR });
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
    // T-412 Tier R: the person retypes the store's name (this replaces the old tick box); the server compares it with the
    // name IT loads.
    const target = await loadDestructiveTarget(actor, 'store', storeId, ['unlink_store_from_pos']);
    if (!retypeMatches(str(fd, 'confirmName'), target.name ?? '')) throw retypeRefusalError(target.name ?? '');
    // T-440: the reason's rule is the one the form shows live (field-rules/settings.ts); judged after the gate and the retype.
    assertFieldRules(SETTINGS_POS_UNLINK_RULES, fd);
    storeName = await withOrgPrincipal(actor.orgId, async (tx) => {
      await authorize(tx, actor, 'unlink_store_from_pos', {});
      await unlinkStoreFromPos(tx, actor, { storeId, reason });
      return (await storesRepo.getById(tx, actor.orgId, storeId))?.name ?? storeName;
    });
  } catch (err) {
    return await redirectWithFlash('/settings/pos-link', storeId ? { store: storeId } : {}, { error: errorMessage(err) }, { anchor: anchorOf(storeId) });
  }
  revalidatePath('/settings/pos-link');
  return await redirectWithFlash('/settings/pos-link', storeId ? { store: storeId } : {}, { ok: `${storeName} is unlinked from POS. Its sales days are typed from now on.` }, { anchor: anchorOf(storeId) });
}
