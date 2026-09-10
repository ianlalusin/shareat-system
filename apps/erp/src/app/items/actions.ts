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
import { redirect } from 'next/navigation';
import {
  approveItemRequest,
  clearStoreSellability,
  createItem,
  mergeItems,
  rejectItemRequest,
  requestItem,
  setStoreSellability,
  updateItem,
} from '@shareat/domain';
import type { BaseUnit, ItemKind } from '@shareat/db';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { errorMessage as sharedErrorMessage } from '@/lib/constraint-messages';

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
  const raw = err instanceof Error ? err.message : String(err);
  // The duplicate-name violation is the one people will actually hit, and Postgres's own wording
  // is unreadable. Say what happened and why it is refused.
  if (/items_org_name_key/.test(raw)) {
    return 'An item with that name already exists — names are one per organisation, ignoring case.';
  }
  if (/items_org_code_key/.test(raw)) return 'That item code is already in use.';
  if (/may not 'approve_item'/.test(raw)) {
    return 'Only a super-admin can approve, create or merge items. Submit a request instead.';
  }
  if (/may not 'manage_items'/.test(raw)) {
    return 'Only a manager or admin can change what an item is bought and sold as.';
  }
  return sharedErrorMessage(err);
}

function back(params: Record<string, string>): never {
  redirect(`/items?${new URLSearchParams(params).toString()}`);
}

function backToItem(itemId: string, params: Record<string, string>): never {
  redirect(`/items/${itemId}?${new URLSearchParams(params).toString()}`);
}

/** ⭐ Manager and admin ask. The similarity warning is returned to them immediately. */
export async function requestItemAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let warning = '';
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      requestItem(tx, actor, {
        name: str(formData, 'name'),
        code: str(formData, 'code'),
        kind: str(formData, 'kind') as ItemKind,
        baseUnit: str(formData, 'baseUnit') as BaseUnit,
        reason: str(formData, 'reason') || null,
      }),
    );
    warning = result.similarWarning ?? '';
  } catch (err) {
    back({ error: errorMessage(err) });
  }
  back(
    warning
      ? { ok: 'Request submitted for a super-admin to approve.', warning }
      : { ok: 'Request submitted for a super-admin to approve.' },
  );
}

/** ⛔ Super-admin only — creating an item outright, skipping the request queue. */
export async function createItemAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      createItem(tx, actor, {
        code: str(formData, 'code'),
        name: str(formData, 'name'),
        kind: str(formData, 'kind') as ItemKind,
        baseUnit: str(formData, 'baseUnit') as BaseUnit,
        notes: str(formData, 'notes') || null,
        // ⭐ DEF-130. Read from the form — a missing checkbox is an explicit "no", which for
        // `isPurchasable` means the form's default-ticked box was deliberately unticked.
        isPurchasable: flag(formData, 'isPurchasable'),
        sellableRetail: flag(formData, 'sellableRetail'),
        sellableWholesale: flag(formData, 'sellableWholesale'),
      }),
    );
  } catch (err) {
    back({ error: errorMessage(err) });
  }
  back({ ok: 'Item added.' });
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
    backToItem(itemId, { error: errorMessage(err) });
  }
  backToItem(itemId, { ok: 'Saved. Every store follows this unless it has its own answer below.' });
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
    backToItem(itemId, { error: errorMessage(err) });
  }
  backToItem(itemId, { ok: message });
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
    backToItem(itemId, { error: errorMessage(err) });
  }
  backToItem(itemId, { ok: message });
}

export async function approveItemRequestAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      approveItemRequest(tx, actor, {
        requestId: str(formData, 'requestId'),
        note: str(formData, 'note') || null,
      }),
    );
  } catch (err) {
    back({ error: errorMessage(err) });
  }
  back({ ok: 'Approved — the item exists now and every store can use it.' });
}

export async function rejectItemRequestAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      rejectItemRequest(tx, actor, {
        requestId: str(formData, 'requestId'),
        note: str(formData, 'note'),
      }),
    );
  } catch (err) {
    back({ error: errorMessage(err) });
  }
  back({ ok: 'Rejected, with your reason recorded for the requester.' });
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
    back({ error: errorMessage(err) });
  }
  back({ ok: summary });
}
