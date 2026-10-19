'use server';

/**
 * Server actions for the item master. T-145 / T-148 / T-149.
 *
 * ⛔ The gates live in the services, not here. In particular `approve_item` is super-admin only,
 * and these actions do not check that — `authorize()` does, so a missing check here cannot become
 * a missing check anywhere.
 *
 * ⭐ DEF-130 (2026-09-03): the three T-149 flags are read from the form now. Until then
 * `createItemAction` never passed them, both columns default to `false`, and there was no edit
 * screen — so every item made through the app was sold to nobody, and a wholesale order on it was
 * refused by `createTradeOrder`'s own gate. The per-store override actions below are the "Lipa
 * makes it, another branch buys it" half of the same task.
 */
import {
  approveItemRequest,
  changeItemBaseUnit,
  clearStoreSellability,
  createItem,
  mergeItems,
  renameItem,
  rejectItemRequest,
  requestItem,
  setItemStatus,
  setStoreSellability,
  suggestItemCode,
  updateItem,
  assertFieldRules,
  type ItemCodeSuggestion,
} from '@shareat/domain';
import { ITEMS_REJECT_RULES, ITEMS_RENAME_RULES, ITEMS_REQUEST_RULES } from '@shareat/domain/field-rules';
import { AuthorizationError, can } from '@shareat/auth';
import type { BaseUnit, ItemKind } from '@shareat/db';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { redirectWithFlash } from '@/lib/flash';
import { keepTyping } from '@/lib/keep-typing';
import { ITEM_FLAGS, ITEM_RENAME, ITEM_STORE_SELLABILITY, ITEM_UNIT } from './typed-forms';
import { errorMessage as sharedErrorMessage } from '@/lib/constraint-messages';
import { isPresentable } from '../../lib/error-shape';
import { loadDestructiveTarget, retypeRefusalError } from '@/lib/destructive';
import { retypeMatches } from '@/lib/retype';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** A checkbox: present means ticked, absent means not. Never "unknown". */
function flag(fd: FormData, key: string): boolean {
  const v = fd.get(key);
  return v === 'on' || v === 'true';
}

/**
 * A tri-state select: `yes` / `no` / anything else meaning *"no opinion — follow the org"*.
 * ⚠️ The distinction between `false` and `null` is the whole point of `store_item_sellability`
 * (T-149): `false` freezes today's default into a copy that stops tracking it.
 */
function tri(fd: FormData, key: string): boolean | null {
  const v = str(fd, key);
  return v === 'yes' ? true : v === 'no' ? false : null;
}

function errorMessage(err: unknown): string {
  if (isPresentable(err)) return sharedErrorMessage(err);
  const raw = err instanceof Error ? err.message : String(err);
  // The duplicate-name violation is the one people will actually hit, and Postgres's own wording
  // is unreadable. Say what happened and why it is refused.
  if (/items_org_name_key/.test(raw)) {
    return 'An item with that name already exists — names are one per organisation, ignoring case. To reuse the name, ask a super-admin to rename the existing item first.';
  }
  if (/items_org_code_key/.test(raw)) {
    return "That item code is already in use. To reuse it, ask a super-admin to change the existing item's code first.";
  }
  return sharedErrorMessage(err);
}

/** ⭐ Manager and admin ask. The similarity warning is returned to them immediately. */
export async function requestItemAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let warning = '';
  try {
    // T-386 I3: a request takes no code; the domain judges only name, kind and unit, so a posted `code` is neither read nor judged.
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      requestItem(tx, actor, {
        name: str(formData, 'name'),
        // T-386 R6: a request takes no code (I3); whatever a hand-made form posts is not read.
        kind: str(formData, 'kind') as ItemKind,
        baseUnit: str(formData, 'baseUnit') as BaseUnit,
        reason: str(formData, 'reason') || null,
        // T-378 R7 (DEF-599): the ticks travel with the request, so approval can carry them to the item.
        isPurchasable: flag(formData, 'isPurchasable'),
        sellableRetail: flag(formData, 'sellableRetail'),
        sellableWholesale: flag(formData, 'sellableWholesale'),
      }),
    );
    warning = result.similarWarning ?? '';
  } catch (err) {
    return await redirectWithFlash('/items', {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(
    '/items',
    {},
    warning
      ? { ok: 'Request submitted for a super-admin to approve.', warning }
      : { ok: 'Request submitted for a super-admin to approve.' },
  );
}

/** ⛔ Super-admin only — creating an item outright, skipping the request queue. */
export async function createItemAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  try {
    await withOrgPrincipal(actor.orgId, async (tx) => {
      // T-440 S9 (iii): `createItem` is also called by the master-data script, so the field check stays here, and runs only for
      // a caller its first authorize() ('approve_item') would let in; anyone else is refused by that gate before any field sentence.
      if (await can(tx, actor, 'approve_item', {})) assertFieldRules(ITEMS_REQUEST_RULES, formData);
      return createItem(tx, actor, {
        // T-386 R5/R7: blank or absent allocates from the name; a typed code is a super-admin override.
        code: str(formData, 'code') || undefined,
        name: str(formData, 'name'),
        kind: str(formData, 'kind') as ItemKind,
        baseUnit: str(formData, 'baseUnit') as BaseUnit,
        notes: str(formData, 'notes') || null,
        // ⭐ DEF-130. Read from the form — a missing checkbox is an explicit "no", which for
        // `isPurchasable` means the form's default-ticked box was deliberately unticked.
        isPurchasable: flag(formData, 'isPurchasable'),
        sellableRetail: flag(formData, 'sellableRetail'),
        sellableWholesale: flag(formData, 'sellableWholesale'),
      });
    });
  } catch (err) {
    return await redirectWithFlash('/items', {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/items', {}, { ok: 'Item added.' });
}

/**
 * ⭐ DEF-130. The ORGANISATION's answer for an existing item. `manage_items` — a manager or admin,
 * not the super-admin bar that creating the identity itself carries.
 */
export async function updateItemFlagsAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const itemId = str(formData, 'itemId');
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      updateItem(tx, actor, itemId, {
        isPurchasable: flag(formData, 'isPurchasable'),
        sellableRetail: flag(formData, 'sellableRetail'),
        sellableWholesale: flag(formData, 'sellableWholesale'),
      }),
    );
  } catch (err) {
    return await redirectWithFlash(`/items/${itemId}`, {}, { error: errorMessage(err), typed: keepTyping(formData, ITEM_FLAGS, itemId, { actorId: actor.personId }) });
  }
  return await redirectWithFlash(`/items/${itemId}`, {}, { ok: 'Saved. Every store follows this unless it has its own answer below.' });
}

/**
 * ⭐ DEF-130. What ONE store does with the item, where it differs. All three left at "follow the
 * organisation" is not an override at all — the domain refuses that shape as noise that looks
 * like a decision — so it is treated as clearing the override, which is what the person meant.
 */
export async function setStoreSellabilityAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const itemId = str(formData, 'itemId');
  const storeId = str(formData, 'storeId');
  const isPurchasable = tri(formData, 'isPurchasable');
  const sellableRetail = tri(formData, 'sellableRetail');
  const sellableWholesale = tri(formData, 'sellableWholesale');
  const nothingSaid = isPurchasable === null && sellableRetail === null && sellableWholesale === null;
  let message = '';
  try {
    if (nothingSaid) {
      const { cleared } = await withOrgPrincipal(actor.orgId, (tx) =>
        clearStoreSellability(tx, actor, { storeId, itemId }),
      );
      message = cleared
        ? 'Override cleared — this store follows the organisation again.'
        : 'Nothing to save: every answer was "follow the organisation", and this store already does.';
    } else {
      await withOrgPrincipal(actor.orgId, (tx) =>
        setStoreSellability(tx, actor, {
          storeId,
          itemId,
          isPurchasable,
          sellableRetail,
          sellableWholesale,
          note: str(formData, 'note') || null,
        }),
      );
      message = 'Store override saved. Only the answers you set here differ; the rest still track the organisation.';
    }
  } catch (err) {
    return await redirectWithFlash(`/items/${itemId}`, {}, { error: errorMessage(err), typed: keepTyping(formData, ITEM_STORE_SELLABILITY, storeId, { actorId: actor.personId }) });
  }
  return await redirectWithFlash(`/items/${itemId}`, {}, { ok: message });
}

export async function clearStoreSellabilityAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const itemId = str(formData, 'itemId');
  const storeId = str(formData, 'storeId');
  let message = '';
  try {
    const { cleared } = await withOrgPrincipal(actor.orgId, (tx) =>
      clearStoreSellability(tx, actor, { storeId, itemId }),
    );
    message = cleared ? 'Override cleared — this store follows the organisation again.' : 'This store had no override to clear.';
  } catch (err) {
    return await redirectWithFlash(`/items/${itemId}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/items/${itemId}`, {}, { ok: message });
}

/** ⛔ T-378 R4. Super-admin only (`approve_item`), and only while the item has no history (the database decides). */
export async function changeItemUnitAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const itemId = str(formData, 'itemId');
  const baseUnit = str(formData, 'baseUnit') as BaseUnit;
  let message = '';
  try {
    const { changed } = await withOrgPrincipal(actor.orgId, (tx) =>
      changeItemBaseUnit(tx, actor, { itemId, baseUnit }),
    );
    message = changed ? `Unit changed to ${baseUnit}.` : `The unit is already ${baseUnit}.`;
  } catch (err) {
    // T-378 S4-R2 (DEF-600): the generic approve_item sentence names the wrong verb; say the real reason.
    if (err instanceof AuthorizationError) {
      return await redirectWithFlash(`/items/${itemId}`, {}, { error: "Only a super-admin can change an item's unit.", typed: keepTyping(formData, ITEM_UNIT, itemId, { actorId: actor.personId }) });
    }
    return await redirectWithFlash(`/items/${itemId}`, {}, { error: errorMessage(err), typed: keepTyping(formData, ITEM_UNIT, itemId, { actorId: actor.personId }) });
  }
  return await redirectWithFlash(`/items/${itemId}`, {}, { ok: message });
}

/** ⛔ T-383 R1. Super-admin only (`approve_item`). A blank goes to the database as blank, so its CHECK speaks. */
export async function renameItemAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const itemId = str(formData, 'itemId');
  let message = '';
  try {
    const { changed } = await withOrgPrincipal(actor.orgId, async (tx) => {
      // T-440 S9 (iii): the field check stays here, and runs only for a caller `renameItem`'s first authorize()
      // ('approve_item') would let in; anyone else is refused by that gate before any field sentence.
      if (await can(tx, actor, 'approve_item', {})) assertFieldRules(ITEMS_RENAME_RULES, formData);
      return renameItem(tx, actor, {
        itemId,
        name: str(formData, 'name'),
        code: str(formData, 'code'),
        // T-386 R8 (q4): the code stays unless this tick is on.
        adoptSuggestedCode: flag(formData, 'adoptSuggestedCode'),
      });
    });
    message = changed ? 'Renamed.' : 'Nothing to change.';
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return await redirectWithFlash(`/items/${itemId}`, {}, { error: 'Only a super-admin can rename, retire or restore an item.', typed: keepTyping(formData, ITEM_RENAME, itemId, { actorId: actor.personId }) });
    }
    // The rename form is on the item's own page, so here (and only here) the way out is the page itself.
    return await redirectWithFlash(`/items/${itemId}`, {}, { error: errorMessage(err).replace('ask a super-admin to rename the existing item first.', 'rename the existing item on its page first.').replace("ask a super-admin to change the existing item's code first.", "change the existing item's code on its page first."), typed: keepTyping(formData, ITEM_RENAME, itemId, { actorId: actor.personId }) });
  }
  return await redirectWithFlash(`/items/${itemId}`, {}, { ok: message });
}

/** Shown in the Retire section when the form arrives without a clear Retire or Restore choice. Nothing is written. */
const RETIRE_CHOICE_SENTENCE = 'Choose Retire or Restore, then try again.';

/** ⛔ T-383 R3. Retire (`inactive`) or restore (`active`); super-admin only (`approve_item`). Reversible, audited. */
export async function setItemStatusAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const itemId = str(formData, 'itemId');
  const requested = str(formData, 'status');
  if (requested !== 'active' && requested !== 'inactive') {
    return await redirectWithFlash(`/items/${itemId}`, {}, { error: RETIRE_CHOICE_SENTENCE }, { anchor: 'retire' });
  }
  const status = requested;
  let message = '';
  try {
    // T-412 Tier R: RETIRING needs the item's name retyped (the server compares it with the name IT loads); restoring is not
    // destructive and needs nothing. The operation is the one requested here, never a flag the form claims.
    if (status === 'inactive') {
      const target = await loadDestructiveTarget(actor, 'item', itemId, ['approve_item']);
      if (!retypeMatches(str(formData, 'confirmName'), target.name ?? '')) throw retypeRefusalError(target.name ?? '');
    }
    const { changed } = await withOrgPrincipal(actor.orgId, (tx) => setItemStatus(tx, actor, { itemId, status }));
    message = !changed ? 'No change: it already is.' : status === 'inactive' ? 'Retired. Its records stay.' : 'Restored.';
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return await redirectWithFlash(`/items/${itemId}`, {}, { error: 'Only a super-admin can rename, retire or restore an item.' }, { anchor: 'retire' });
    }
    return await redirectWithFlash(`/items/${itemId}`, {}, { error: errorMessage(err) }, { anchor: 'retire' });
  }
  return await redirectWithFlash(`/items/${itemId}`, {}, { ok: message }, { anchor: 'retire' });
}

export async function approveItemRequestAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  // T-378 R5 / REV-11: the approve form always submits `baseUnit`. Absent field -> undefined (the request's
  // value); a blank submitted field stays '' and the CHECK refuses it.
  const confirmed = formData.has('baseUnit');
  let approvedCode = '';
  try {
    const approved = await withOrgPrincipal(actor.orgId, (tx) =>
      approveItemRequest(tx, actor, {
        requestId: str(formData, 'requestId'),
        note: str(formData, 'note') || null,
        // T-386 R7: blank or absent allocates from the request's name; a typed code is a super-admin override.
        code: str(formData, 'code') || undefined,
        baseUnit: confirmed ? (str(formData, 'baseUnit') as BaseUnit) : undefined,
        isPurchasable: confirmed ? flag(formData, 'isPurchasable') : undefined,
        sellableRetail: confirmed ? flag(formData, 'sellableRetail') : undefined,
        sellableWholesale: confirmed ? flag(formData, 'sellableWholesale') : undefined,
      }),
    );
    approvedCode = approved.code;
  } catch (err) {
    return await redirectWithFlash('/items', {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/items', {}, { ok: `Approved as ${approvedCode}.` });
}

/**
 * T-386 R10. What `ItemCodeField` calls while a name is typed: the suggested code and the items that already share its letters.
 * Read-only. A person without `manage_items` gets the empty answer rather than a throw (the field simply shows nothing).
 */
export async function suggestItemCodeAction(name: string, forItemId?: string): Promise<ItemCodeSuggestion> {
  const actor = await requireActor();
  return withOrgPrincipal(actor.orgId, async (tx) => {
    // T-402 S2 (A2): the non-logging check, so typing a name is not a logged denial for someone without manage_items.
    if (!(await can(tx, actor, 'manage_items', {}))) return { stem: null, code: null, full: false, sameStem: [] };
    return suggestItemCode(tx, actor, { name, ...(forItemId ? { forItemId } : {}) });
  });
}

export async function rejectItemRequestAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  try {
    await withOrgPrincipal(actor.orgId, async (tx) => {
      // T-440 S9 (iii): the field check stays here, and runs only for a caller `rejectItemRequest`'s first authorize()
      // ('approve_item') would let in; anyone else is refused by that gate before any field sentence.
      if (await can(tx, actor, 'approve_item', {})) assertFieldRules(ITEMS_REJECT_RULES, formData);
      return rejectItemRequest(tx, actor, {
        requestId: str(formData, 'requestId'),
        note: str(formData, 'note'),
      });
    });
  } catch (err) {
    return await redirectWithFlash('/items', {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/items', {}, { ok: 'Rejected, with your reason recorded for the requester.' });
}

/** ⛔ Super-admin only, and effectively irreversible — every reference moves to the winner. */
export async function mergeItemsAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let summary = '';
  try {
    const report = await withOrgPrincipal(actor.orgId, (tx) =>
      mergeItems(tx, actor, {
        loserId: str(formData, 'loserId'),
        winnerId: str(formData, 'winnerId'),
      }),
    );
    summary =
      `Merged. Moved ${report.invoiceLines} invoice line(s), ${report.priceListRates} price ` +
      `list rate(s) and ${report.supplierLinks} supplier link(s).`;
  } catch (err) {
    return await redirectWithFlash('/items', {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/items', {}, { ok: summary });
}
