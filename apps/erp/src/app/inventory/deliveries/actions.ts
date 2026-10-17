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
import { redirectWithFlash } from '@/lib/flash';
import { revalidatePath } from 'next/cache';
import { assertFieldRules, createDeliveryDocument, receiveDeliveryDocument, uploadFile } from '@shareat/domain';
import { INVENTORY_DELIVERY_RULES } from '@shareat/domain/field-rules';
import type { ShortageReason } from '@shareat/db/schema';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../../lib/session';
import { peso } from '../../../lib/format';
import { errorMessage as sharedErrorMessage } from '@/lib/constraint-messages';
import { isPresentable } from '../../../lib/error-shape';

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

/**
 * Strips the throwing function's name — right for a log, useless on screen. Maps the handful of
 * known refusals (T-166's own DB CHECKs and trigger) onto a sentence a cashier or manager can act
 * on; anything else falls back to the raw message with its prefix trimmed.
 *
 * T-343 S5.1d — DEF-450. Every `AuthorizationError` `authorize` throws already carries the S2/S2b
 * `userMessage`; presentable wins first. The old three branches — the two capability-name checks
 * (`receive_delivery`, `allow_over_receipt`) plus the store-scope-refusal shape — answered a
 * generic sentence for every refusal on either capability regardless of the real reason — deleted,
 * not bypassed.
 *
 * T-343 S5.3b — the proof-file branch that used to live here moved into the domain itself
 * (`deliveries/documents.ts`'s own `refuse(…)`, the better of the two wordings), and is deleted
 * from here as dead code: presentable answers first, before this local regex ever runs.
 */
function errorMessage(err: unknown): string {
  if (isPresentable(err)) return sharedErrorMessage(err);
  const raw = err instanceof Error ? err.message : String(err);

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
  if (/,\s*not draft/.test(raw)) {
    return 'This delivery has already been received (or voided) and cannot be received again.';
  }
  if (/was not answered/.test(raw)) {
    return 'Every line needs a received quantity before this delivery can be received.';
  }
  if (/no location and the store has no Receiving/.test(raw)) {
    return 'This store has no active room to park an undecided line in — add one under Inventory › Locations first.';
  }
  // ⚠️ Frozen-room and closed-period refusals were listed here purely to strip their prefix.
  // The shared fallback does precisely that, so both fall through to it now — same sentence,
  // one implementation (T-255).
  return sharedErrorMessage(err);
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
  // T-343 S5.3b R3 — numbered BEFORE the filter drops empty rows, so `lineNo` is the operator's own
  // VISIBLE form row position, not the array index of whatever survives filtering. A middle row
  // left entirely blank must not shift every later row's "Line n" down by one.
  const lines = itemIds
    .map((itemId, i) => ({
      itemId,
      orderedQuantity: orderedQuantities[i] ?? '',
      purchaseUnit: purchaseUnits[i] || 'pcs',
      conversionFactor: conversionFactors[i] || '1',
      // T-328 — was `?? '0'`. The form itself cannot produce a missing `unitCost` for a row that
      // has an itemId (every field is `required`, none `disabled`, all rendered together per row —
      // NewDeliveryForm.tsx checked directly). But this action is reachable by any caller that can
      // build a FormData, not only that form, and `??` only fires on an ARRAY-INDEX gap (this row's
      // position has no matching unitCost entry at all) — a request with a shorter `unitCost` array
      // than `itemId`. `'0'` turned that gap into a silently free line; `''` fails
      // `createDeliveryDocument`'s `parseFourDecimalCost` check with a readable refusal instead,
      // the same as a genuinely blank box already would if the field were not `required`.
      unitCost: unitCosts[i] ?? '',
      locationId: locationIds[i] || null,
      lineNo: i + 1,
    }))
    .filter((l) => l.itemId && l.orderedQuantity);

  let deliveryId = '';
  let warning = '';
  try {
    assertFieldRules(INVENTORY_DELIVERY_RULES, fd);
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
    return await redirectWithFlash('/inventory/deliveries', { store: storeId }, { error: errorMessage(err) });
  }

  revalidatePath('/inventory/deliveries');
  return await redirectWithFlash(
    `/inventory/deliveries/${deliveryId}`,
    {},
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
    return await redirectWithFlash(`/inventory/deliveries/${deliveryId}`, {}, { error: errorMessage(err) });
  }

  revalidatePath('/inventory/deliveries');
  revalidatePath(`/inventory/deliveries/${deliveryId}`);
  return await redirectWithFlash(`/inventory/deliveries/${deliveryId}`, {}, { stamp: 'RECEIVED', ok: message });
}
