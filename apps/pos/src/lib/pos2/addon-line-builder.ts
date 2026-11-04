import { serverTimestamp } from 'firebase/firestore';
import { stripUndefined } from '@/lib/firebase/utils';
import type { SelectedModifier } from '@/lib/types';

export type AddonLineInput = {
  addon: {
    id: string;
    displayName: string;
    subCategory?: string | null;
    barcode?: string | null;
    sellingPrice: number | string;
    kitchenLocationId?: string | null;
    kitchenLocationName?: string | null;
  };
  qty: number;
  modifiers: SelectedModifier[];
  modifiersText: string;
  modifiersTotal: number;
  note?: string;
};

export type BuiltAddonLine = { lineId: string; payload: Record<string, unknown> };

/** The add-on bill line exactly as AddonsPOSModal.performAdd wrote it (T-518 ruling 3). */
export function buildAddonLine(input: AddonLineInput, actor: { uid: string; username: string }): BuiltAddonLine {
  const { addon, qty, modifiers, modifiersText, modifiersTotal } = input;
  const lineNote = (input.note ?? '').trim();
  const priceNum = Number(addon.sellingPrice);
  const safeUnitPrice = Number.isFinite(priceNum) ? priceNum : 0;
  // Same item with different modifier picks must land on separate lines.
  const modHash = modifiers.length ? modifiers.map((m) => m.valueId).sort().join('-') : '';
  const lineId = modHash ? `addon_${addon.id}_${safeUnitPrice}_${modHash}` : `addon_${addon.id}_${safeUnitPrice}`;
  const payload = stripUndefined({
    id: lineId,
    type: 'addon',
    itemId: addon.id,
    itemName: addon.displayName,
    category: addon.subCategory ?? null,
    barcode: addon.barcode ?? null,
    unitPrice: safeUnitPrice,
    qtyOrdered: qty,
    discountType: null,
    discountValue: 0,
    discountQty: 0,
    freeQty: 0,
    voidedQty: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    updatedByUid: actor.uid,
    updatedByName: actor.username,
    kitchenLocationId: addon.kitchenLocationId ?? null,
    kitchenLocationName: addon.kitchenLocationName ?? null,
    modifiers: modifiers.length ? modifiers : null,
    modifiersText: modifiersText || null,
    modifiersTotal: modifiers.length ? modifiersTotal : null,
    note: lineNote || null,
  }) as Record<string, unknown>;
  return { lineId, payload };
}

/** Same lineId = one entry with qty summed (position kept); else appended. Pure. */
export function mergeAddonLine(lines: BuiltAddonLine[], next: BuiltAddonLine): BuiltAddonLine[] {
  if (!lines.some((l) => l.lineId === next.lineId)) return [...lines, next];
  return lines.map((l) =>
    l.lineId === next.lineId
      ? { ...l, payload: { ...l.payload, qtyOrdered: Number(l.payload.qtyOrdered) + Number(next.payload.qtyOrdered) } }
      : l,
  );
}
