import { mergeAddonLine, type BuiltAddonLine } from './addon-line-builder';

export const addChosen = mergeAddonLine;

/** qty + delta; a result <= 0 removes the line; unknown id = unchanged. Pure. */
export function changeChosenQty(list: BuiltAddonLine[], lineId: string, delta: number): BuiltAddonLine[] {
  return list.flatMap((l) => {
    if (l.lineId !== lineId) return [l];
    const qty = Number(l.payload.qtyOrdered) + delta;
    return qty > 0 ? [{ ...l, payload: { ...l.payload, qtyOrdered: qty } }] : [];
  });
}

export function removeChosen(list: BuiltAddonLine[], lineId: string): BuiltAddonLine[] {
  return list.filter((l) => l.lineId !== lineId);
}
