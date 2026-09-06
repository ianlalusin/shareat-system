'use server';

/**
 * Server actions for the usage/wastage screen — T-168 / DEF-135.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect with a message. ⭐ The actor comes
 * from the session, never the form (T-138) — authorization is `saveUsageDraft`/`postUsage`/
 * `voidUsage`/`deleteUsageDraft`'s own first statement, not repeated here. Every mutation runs
 * under the org's RLS principal (`withOrgPrincipal`), the same way the trade-orders and
 * commissary-catalogue actions do.
 *
 * ⭐ Two return shapes have to be handled here, not one: `postUsage`/`voidUsage`/`saveUsageDraft`/
 * `deleteUsageDraft` can either THROW (an `authorize()` denial, or a DB trigger — the reserved
 * room, the freeze, the immutable/terminal guards) or return `{ ok: false, reason }` (an ordinary
 * business refusal). Both have to redirect with a readable `?error=`, and — critically — neither
 * redirect call may sit INSIDE the `try` block, because `redirect()` itself throws, and a redirect
 * thrown inside its own `try` would be caught and re-reported as a garbled error.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { deleteUsageDraft, postUsage, replenishAfterUsage, saveUsageDraft, voidUsage } from '@shareat/domain';
import { toBusinessDate } from '@shareat/core/datetime';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../../lib/session';
import { peso } from '../../../lib/format';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** Repeated fields — one per dynamic line row. Parallel arrays, in document order. */
function strs(fd: FormData, key: string): string[] {
  return fd.getAll(key).map((v) => (typeof v === 'string' ? v.trim() : ''));
}

/** Strips the throwing function's name — right for a log, useless on screen. Maps the handful of
 *  known refusals (authorize denials, T-168's DB triggers) onto a sentence a floor worker or
 *  manager can act on; anything else falls back to the raw message with its prefix trimmed. */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  if (/may not 'record_stock_movement'/.test(raw)) {
    return 'Recording a usage needs at least staff access to this store.';
  }
  if (/may not 'record_wastage'/.test(raw)) {
    return 'Recording a wastage needs at least staff access to this store.';
  }
  if (/may not 'post_usage'/.test(raw)) {
    return 'Only a manager or admin can post — a floor worker can draft, but posting is what moves stock and the books.';
  }
  if (/may not 'void_usage_record'/.test(raw)) {
    return 'Only a manager or admin can void a posted record.';
  }
  if (/is a parking spot/.test(raw)) {
    return 'The Receiving room is a parking spot for new deliveries — it cannot be a usage source.';
  }
  if (/storage room; only an operating room/.test(raw)) {
    return 'That room is a storage room — usage can only be recorded from an operating room (kitchen, bar, display case).';
  }
  if (/is inactive and cannot be a usage source/.test(raw)) {
    return 'That room is inactive and cannot be a usage source.';
  }
  if (/is frozen by an active count session/.test(raw)) {
    return raw.replace(/^[a-zA-Z][A-Za-z0-9_.]*:\s*/, '');
  }
  if (/a posted usage record is immutable/.test(raw)) {
    return 'That record has already been posted — void it and record a new one, rather than editing it.';
  }
  if (/a voided usage record is terminal/.test(raw)) {
    return 'That record has already been voided and cannot be posted again — record a new one.';
  }
  if (/only .* is on hand/.test(raw)) {
    return raw.replace(/^[a-zA-Z][A-Za-z0-9_.]*:\s*/, '');
  }
  if (/fiscal period .* is (closed|locked)/.test(raw)) {
    return raw.replace(/^[a-zA-Z][A-Za-z0-9_.]*:\s*/, '');
  }
  return raw.replace(/^[a-zA-Z][A-Za-z0-9_.]*:\s*/, '');
}

function back(path: string, params: Record<string, string>): never {
  redirect(`${path}?${new URLSearchParams(params).toString()}`);
}

export async function saveUsageDraftAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/usage');
  const storeId = str(fd, 'storeId');
  const kind = str(fd, 'kind') === 'wastage' ? ('wastage' as const) : ('usage' as const);
  const locationId = str(fd, 'locationId');
  const usedOn = str(fd, 'usedOn');
  const reasonCode = str(fd, 'reasonCode') || null;
  const departmentId = str(fd, 'departmentId') || null;

  const itemIds = strs(fd, 'itemId');
  const quantities = strs(fd, 'quantity');
  // A row whose item was never picked is an empty row, not an error — skipped. A row WITH an item
  // and no quantity is a real mistake, and the domain says so.
  const lines = itemIds
    .map((itemId, i) => ({ itemId, quantity: quantities[i] ?? '' }))
    .filter((l) => l.itemId && l.quantity);

  let result: Awaited<ReturnType<typeof saveUsageDraft>> | undefined;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) =>
      saveUsageDraft(tx, actor, { orgId: actor.orgId, storeId, locationId, kind, usedOn, reasonCode, departmentId, lines }),
    );
  } catch (err) {
    back('/inventory/usage', { store: storeId, error: errorMessage(err) });
  }
  if (!result!.ok) {
    back('/inventory/usage', { store: storeId, error: result!.reason });
  }

  revalidatePath('/inventory/usage');
  back(`/inventory/usage/${result!.recordId}`, {
    ok: 'Draft saved. Nothing has posted — post is the step that moves stock and hits the books.',
  });
}

export async function postUsageAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/usage');
  const recordId = str(fd, 'recordId');

  let result: Awaited<ReturnType<typeof postUsage>> | undefined;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) => postUsage(tx, actor, { recordId }));
  } catch (err) {
    back(`/inventory/usage/${recordId}`, { error: errorMessage(err) });
  }
  if (!result!.ok) {
    back(`/inventory/usage/${recordId}`, { error: result!.reason });
  }

  // ⭐ T-223 / DEF-186 — THE low-stock auto-order's only caller, and the reason it must be here.
  //
  // `replenishAfterUsage` opens its OWN transaction and never throws, precisely so a cook can record
  // what they used when the ordering subsystem is down. That only works if it runs AFTER the usage
  // transaction has committed — and the layer that can do that is the layer that opened it, which is
  // this action. `postUsage` and `postUsageRecord` are both handed a `tx` they do not own, which is
  // why neither could ever have been the caller (auto-order.ts's own header).
  //
  // ⛔ It went unwired from T-175 until 2026-09-06: built, tested, and invoked by nothing, so the
  // auto-order had never run once in production. DEF-186.
  const replenish = await replenishAfterUsage({
    orgId: actor.orgId,
    branchStoreId: result!.storeId,
    orderedOn: toBusinessDate(),
    createdBy: actor.personId,
    // ⚠️ Scoped to what this post touched, never a whole-store sweep on every usage record.
    itemIds: result!.itemIds,
  });

  revalidatePath('/inventory/usage');
  revalidatePath(`/inventory/usage/${recordId}`);
  if (replenish.orderId) revalidatePath('/inventory/low-stock');

  // ⛔ **The failure is reported, never swallowed — that IS the defect this task closes.** The post
  // is already committed and stands either way, so this is a clause on the success message and not
  // an error banner: an error over a successful post teaches people to ignore banners.
  const posted = `Posted at FIFO cost ${peso(result!.totalCost)} — journal ${result!.entryIds.join(', ')}.`;
  const replenishNote = replenish.failed
    ? ` ⚠️ The low-stock auto-order did not run: ${replenish.failed}. Your post is unaffected; add any reorder lines by hand.`
    : replenish.appended.length > 0
      ? ` Low stock: ${replenish.appended.length} line(s) added to the open commissary order.`
      : '';
  back(`/inventory/usage/${recordId}`, { ok: posted + replenishNote });
}

export async function deleteUsageDraftAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/usage');
  const recordId = str(fd, 'recordId');
  const storeId = str(fd, 'storeId');

  let result: Awaited<ReturnType<typeof deleteUsageDraft>> | undefined;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) => deleteUsageDraft(tx, actor, { recordId }));
  } catch (err) {
    back(`/inventory/usage/${recordId}`, { error: errorMessage(err) });
  }
  if (!result!.ok) {
    back(`/inventory/usage/${recordId}`, { error: result!.reason });
  }

  revalidatePath('/inventory/usage');
  back('/inventory/usage', { store: storeId, ok: 'Draft deleted.' });
}

export async function voidUsageAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/usage');
  const recordId = str(fd, 'recordId');
  const reason = str(fd, 'reason');

  let result: Awaited<ReturnType<typeof voidUsage>> | undefined;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) => voidUsage(tx, actor, { recordId, reason }));
  } catch (err) {
    back(`/inventory/usage/${recordId}`, { error: errorMessage(err) });
  }
  if (!result!.ok) {
    back(`/inventory/usage/${recordId}`, { error: result!.reason });
  }

  revalidatePath('/inventory/usage');
  revalidatePath(`/inventory/usage/${recordId}`);
  back(`/inventory/usage/${recordId}`, {
    ok:
      result!.reversalEntryIds.length > 0
        ? `Voided. Stock and the FIFO layers are restored, and the entry is reversed — journal ${result!.reversalEntryIds.join(', ')}.`
        : 'Voided. Stock and the FIFO layers are restored.',
  });
}
