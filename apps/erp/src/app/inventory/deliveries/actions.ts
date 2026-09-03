'use server';

/**
 * Server actions for the deliveries screen — T-166 / DEF-135.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect with a message. ⭐ The actor comes
 * from the session, never the form (T-138) — authorization is `createDeliveryDocument` /
 * `receiveDeliveryDocument`'s own first statement, not repeated here. Every mutation runs under
 * the org's RLS principal (`withOrgPrincipal`), the same way the AP, trade-orders and
 * commissary-catalogue actions do.
 *
 * ⭐ The photo is UPLOADED here, never typed — same discipline as `ap/actions.ts`'s
 * `recordInvoiceAction`. Upload and the delivery insert share ONE transaction, so a delivery can
 * never reference a file that was not actually written.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createDeliveryDocument, receiveDeliveryDocument, uploadFile } from '@shareat/domain';
import type { ShortageReason } from '@shareat/db/schema';
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

const SHORTAGE_REASON_VALUES: readonly string[] = [
  'supplier_short',
  'damaged_in_transit',
  'damaged_on_arrival',
  'quality_reject',
  'count_correction',
  'other',
];

/** Strips the throwing function's name — right for a log, useless on screen. Maps the handful of
 *  known refusals (authorize denials, T-166's own DB CHECKs and trigger) onto a sentence a
 *  cashier or manager can act on; anything else falls back to the raw message with its prefix
 *  trimmed. */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  if (/may not 'receive_delivery'/.test(raw)) {
    return 'Recording or receiving a delivery needs at least staff access to this store.';
  }
  if (/may not 'allow_over_receipt'/.test(raw)) {
    return 'Only a manager or admin can approve receiving more than what was ordered — untick ' +
      '"allow over-receipt", or ask a manager to receive it.';
  }
  if (/no store scope/.test(raw)) {
    return 'You are not assigned to the store this delivery belongs to.';
  }
  if (/proof file .* does not exist/.test(raw)) {
    return 'That photo could not be found — try attaching it again.';
  }
  if (/must name its supplier/.test(raw)) {
    return 'A supplier delivery must name its supplier.';
  }
  if (/deliveries_supplier_required_check/.test(raw)) {
    return 'A supplier delivery must name its supplier.';
  }
  if (/deliveries_proof_required_check/.test(raw)) {
    return 'A photo of the paper is required before this can be saved.';
  }
  if (/at least one line/.test(raw)) {
    return 'Add at least one line before saving.';
  }
  if (/conversion factor must be greater than zero/.test(raw)) {
    return "Every line's conversion factor must be greater than zero.";
  }
  if (/ordered quantity must be greater than zero/.test(raw)) {
    return "Every line's quantity must be greater than zero.";
  }
  if (/must carry a received quantity/.test(raw)) {
    return 'Every line needs a received quantity, even if it is zero.';
  }
  if (/must carry a shortage reason/.test(raw)) {
    return 'A line received short needs a reason before it can be received.';
  }
  if (/without an over-receipt approval/.test(raw)) {
    return 'A line received over what was ordered needs "allow over-receipt" ticked and a manager to receive it.';
  }
  if (/deliveries_supplier_reference_key/.test(raw)) {
    return 'This supplier and reference number are already recorded on another delivery — check you are not entering the same paper twice.';
  }
  if (/frozen by an active count session/.test(raw)) {
    return raw.replace(/^[a-zA-Z][A-Za-z0-9_.]*:\s*/, '');
  }
  if (/,\s*not draft/.test(raw)) {
    return 'This delivery has already been received (or voided) and cannot be received again.';
  }
  if (/was not answered/.test(raw)) {
    return 'Every line needs a received quantity before this delivery can be received.';
  }
  if (/no location and the store has no Receiving/.test(raw)) {
    return 'This store has no active room to park an undecided line in — add one under Inventory › Locations first.';
  }
  if (/fiscal period .* is (closed|locked)/.test(raw)) {
    return raw.replace(/^[a-zA-Z][A-Za-z0-9_.]*:\s*/, '');
  }
  return raw.replace(/^[a-zA-Z][A-Za-z0-9_.]*:\s*/, '');
}

function back(path: string, params: Record<string, string>): never {
  redirect(`${path}?${new URLSearchParams(params).toString()}`);
}

export async function createDeliveryAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/deliveries');
  const storeId = str(fd, 'storeId');
  const kind = str(fd, 'kind') === 'supplier' ? ('supplier' as const) : ('purchase' as const);
  const supplierId = str(fd, 'supplierId') || null;
  const referenceNo = str(fd, 'referenceNo') || null;
  const deliveredOn = str(fd, 'deliveredOn');

  const itemIds = strs(fd, 'itemId');
  const orderedQuantities = strs(fd, 'orderedQuantity');
  const purchaseUnits = strs(fd, 'purchaseUnit');
  const conversionFactors = strs(fd, 'conversionFactor');
  const unitCosts = strs(fd, 'unitCost');
  const locationIds = strs(fd, 'locationId');
  // A row whose item was never picked is an empty row, not an error — skipped. A row WITH an item
  // and no quantity is a real mistake, and the domain says so.
  const lines = itemIds
    .map((itemId, i) => ({
      itemId,
      orderedQuantity: orderedQuantities[i] ?? '',
      purchaseUnit: purchaseUnits[i] || 'pcs',
      conversionFactor: conversionFactors[i] || '1',
      unitCost: unitCosts[i] ?? '0',
      locationId: locationIds[i] || null,
    }))
    .filter((l) => l.itemId && l.orderedQuantity);

  let deliveryId = '';
  let warning = '';
  try {
    const photo = fd.get('proofPhoto');
    if (!(photo instanceof File) || photo.size === 0) {
      throw new Error('A photo of the paper is required — a link or a typed reference is not evidence.');
    }
    const result = await withOrgPrincipal(actor.orgId, async (tx) => {
      const uploaded = await uploadFile(tx, actor, {
        purpose: 'receipt_photo',
        storeId,
        contentType: photo.type,
        bytes: new Uint8Array(await photo.arrayBuffer()),
      });
      return createDeliveryDocument(tx, actor, {
        storeId,
        kind,
        supplierId: kind === 'supplier' ? supplierId : null,
        referenceNo,
        deliveredOn,
        proofFileId: uploaded.fileId,
        lines,
      });
    });
    deliveryId = result.deliveryId;
    warning = result.warnings.map((w) => w.message).join(' ');
  } catch (err) {
    back('/inventory/deliveries', { store: storeId, error: errorMessage(err) });
  }

  revalidatePath('/inventory/deliveries');
  back(
    `/inventory/deliveries/${deliveryId}`,
    warning
      ? { ok: 'Delivery drafted. Nothing has moved or posted yet — receiving is that step.', warning }
      : { ok: 'Delivery drafted. Nothing has moved or posted yet — receiving is that step.' },
  );
}

export async function receiveDeliveryAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/inventory/deliveries');
  const deliveryId = str(fd, 'deliveryId');

  // ⭐ ONE checkbox for the whole document — matching the screen's single "allow over-receipt"
  // control. It only matters for a line actually received above what was ordered; the trigger
  // (and `receiveDeliveryDocument`'s own `authorize` call) refuse it everywhere else it is ignored.
  const overReceiptOk = fd.get('overReceiptOk') === 'on';

  const lineIds = strs(fd, 'lineId');
  const receivedQuantities = strs(fd, 'receivedQuantity');
  const shortageReasons = strs(fd, 'shortageReason');
  const locationOverrides = strs(fd, 'locationId');

  const lines = lineIds.map((lineId, i) => ({
    lineId,
    receivedQuantity: receivedQuantities[i] || '0',
    shortageReason: SHORTAGE_REASON_VALUES.includes(shortageReasons[i] ?? '')
      ? (shortageReasons[i] as ShortageReason)
      : null,
    overReceiptOk,
    // Empty = "keep whatever room the draft named" (possibly still undecided, i.e. Receiving);
    // never coerced to `null`, which would force a re-park even for an already-chosen room.
    locationId: locationOverrides[i] || undefined,
  }));

  let message = '';
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      receiveDeliveryDocument(tx, actor, { deliveryId, lines }),
    );
    message = `Received. Posted at ${peso(result.totalValue)} — journal ${result.entryId}.`;
  } catch (err) {
    back(`/inventory/deliveries/${deliveryId}`, { error: errorMessage(err) });
  }

  revalidatePath('/inventory/deliveries');
  revalidatePath(`/inventory/deliveries/${deliveryId}`);
  back(`/inventory/deliveries/${deliveryId}`, { ok: message });
}
