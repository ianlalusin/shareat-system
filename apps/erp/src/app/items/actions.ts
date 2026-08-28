'use server';

/**
 * Server actions for the item master. T-145 / T-148.
 *
 * ⛔ The gates live in the services, not here. In particular `approve_item` is super-admin only,
 * and these actions do not check that — `authorize()` does, so a missing check here cannot become
 * a missing check anywhere.
 */
import { redirect } from 'next/navigation';
import {
  approveItemRequest,
  createItem,
  mergeItems,
  rejectItemRequest,
  requestItem,
} from '@shareat/domain';
import type { BaseUnit, ItemKind } from '@shareat/db';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
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
  return raw.replace(/^[a-z][A-Za-z0-9_]*:\s*/, '');
}

function back(params: Record<string, string>): never {
  redirect(`/items?${new URLSearchParams(params).toString()}`);
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
      }),
    );
  } catch (err) {
    back({ error: errorMessage(err) });
  }
  back({ ok: 'Item added.' });
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
