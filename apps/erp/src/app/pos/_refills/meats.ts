/**
 * T-529 R2 - the meats a table can ask for: exactly the refills its PACKAGE lists (`refillItemIds`), named from the menu. Never every refill on the menu:
 * two packages on one floor offer different lists, and a refill that belongs to no package never shows. The server re-checks every one (T-524).
 */
import type { MenuLike } from '../_orders/menu-filter';
import { asStoreMenu } from '../_orders/menu-filter';

/** T-566: `flavours` are the meat's option values on sale at the store (v1 shows one choice per meat); `flavourRequired` = a group of them has a minimum above 0. */
export interface RefillMeat {
  itemId: string;
  name: string;
  flavours: { id: string; name: string }[];
  flavourRequired: boolean;
}

export function refillMeats(menu: MenuLike, packageVariantId: string): RefillMeat[] {
  const m = asStoreMenu(menu);
  const variant = m.items.flatMap((i) => i.variants).find((v) => v.id === packageVariantId);
  const items = new Map(m.items.map((i) => [i.id, i]));
  return (variant?.refillItemIds ?? []).flatMap((itemId) => {
    const item = items.get(itemId);
    if (item === undefined) return [];
    const groups = (item.variants.find((v) => v.isDefault) ?? item.variants[0])?.optionGroups ?? [];
    const onSale = groups.map((g) => ({ min: g.minSelections, values: g.values.filter((v) => v.channels.store.orderable) })).filter((g) => g.values.length > 0);
    return [{ itemId, name: item.name, flavours: onSale.flatMap((g) => g.values.map((v) => ({ id: v.id, name: v.name }))), flavourRequired: onSale.some((g) => g.min > 0) }];
  });
}
