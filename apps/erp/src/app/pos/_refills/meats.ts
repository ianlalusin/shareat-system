/**
 * T-529 R2 - the meats a table can ask for: exactly the refills its PACKAGE lists (`refillItemIds`), named from the menu. Never every refill on the menu:
 * two packages on one floor offer different lists, and a refill that belongs to no package never shows. The server re-checks every one (T-524).
 */
import type { MenuLike } from '../_orders/menu-filter';
import { asStoreMenu } from '../_orders/menu-filter';

export function refillMeats(menu: MenuLike, packageVariantId: string): { itemId: string; name: string }[] {
  const m = asStoreMenu(menu);
  const variant = m.items.flatMap((i) => i.variants).find((v) => v.id === packageVariantId);
  const names = new Map(m.items.map((i) => [i.id, i.name]));
  return (variant?.refillItemIds ?? []).flatMap((itemId) => {
    const name = names.get(itemId);
    return name === undefined ? [] : [{ itemId, name }];
  });
}
