/**
 * T-375 S5 (S5-lite): read the `sold_items` feed the day's import (or a recheck) already stored.
 *
 * Pure, no I/O. Wire field names come only from `POS_V1_SOLD_ITEMS_FIELDS` (R12). The parser makes no
 * rule about a day's sales: `found: false` is `ok` with no items, and `buildPlan` decides whether an
 * empty day is right (only on a PHP 0 day).
 */
import { POS_V1_SOLD_ITEMS_FIELDS as F } from '@shareat/db/pos-v1/wire';
import { addQuantity, compareQuantity, quantity } from '../stock/quantity';
import type { PosSoldItemInput } from './plan';

export type SoldItemsFromFeed =
  | { readonly ok: true; readonly found: boolean; readonly items: PosSoldItemInput[] }
  | { readonly ok: false; readonly raw: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function soldItemsFromFeed(payload: unknown): SoldItemsFromFeed {
  if (!isRecord(payload)) return { ok: false, raw: 'sold items payload is not an object' };
  if (payload[F.found] === false) return { ok: true, found: false, items: [] };

  const rawItems = payload[F.items];
  if (!Array.isArray(rawItems)) return { ok: false, raw: `${F.items} is not an array` };

  const byKey = new Map<string, { name: string; qty: ReturnType<typeof quantity> }>();
  for (let i = 0; i < rawItems.length; i++) {
    const e: unknown = rawItems[i];
    if (!isRecord(e)) return { ok: false, raw: `${F.items}[${i}] is not an object` };
    const key = e[F.itemKey];
    if (typeof key !== 'string' || key === '') return { ok: false, raw: `${F.items}[${i}].${F.itemKey} is not a non-empty string` };
    const q = e[F.physicalQty];
    if (typeof q !== 'number' || !Number.isFinite(q)) {
      return { ok: false, raw: `${F.items}[${i}].${F.physicalQty} is not a finite number` };
    }
    let qty;
    try {
      qty = quantity(q);
    } catch {
      return { ok: false, raw: `${F.items}[${i}].${F.physicalQty} is not exact to 3 decimal places` };
    }
    const name = e[F.itemName];
    const prior = byKey.get(key);
    if (prior) {
      try {
        prior.qty = addQuantity(prior.qty, qty);
      } catch {
        return { ok: false, raw: `${F.items}[${i}].${F.physicalQty} sums out of range for ${F.itemKey} ${key}` };
      }
    } else {
      byKey.set(key, { name: typeof name === 'string' && name !== '' ? name : key, qty });
    }
  }
  return {
    ok: true,
    found: true,
    items: [...byKey].map(([posItemKey, v]) => ({ posItemKey, posItemName: v.name, physicalQty: v.qty })),
  };
}

/** True iff both have the same item keys with equal quantities; names, order and every other field are ignored. */
export function sameItemsProjection(a: readonly PosSoldItemInput[], b: readonly PosSoldItemInput[]): boolean {
  if (a.length !== b.length) return false;
  const bByKey = new Map(b.map((x) => [x.posItemKey, x.physicalQty]));
  if (bByKey.size !== b.length) return false;
  for (const x of a) {
    const other = bByKey.get(x.posItemKey);
    if (other === undefined || compareQuantity(quantity(x.physicalQty), quantity(other)) !== 0) return false;
  }
  return new Set(a.map((x) => x.posItemKey)).size === a.length;
}
