/**
 * T-651 - the ONE order rule for the menu: sort order first, then name (lower case), then id. Pure leaf (no database), so the POS tablet
 * bundle imports it too (`@shareat/domain/menu/order`). A variant list puts the default size first, then the same rule on its label.
 * Plain `<` on lower-cased text, never `localeCompare`: the same answer on every device and every locale.
 */
export interface MenuOrdered {
  sortOrder: number;
  name: string;
  id: string;
}

const lt = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function compareMenuOrder(a: MenuOrdered, b: MenuOrdered): number {
  return a.sortOrder - b.sortOrder || lt(a.name.toLowerCase(), b.name.toLowerCase()) || lt(a.id, b.id);
}

export interface VariantOrdered {
  sortOrder: number;
  label: string | null;
  isDefault: boolean;
  id: string;
}

/** Default size first, then sort order, then label (an unlabelled one reads as ''), then id. */
export function compareVariantOrder(a: VariantOrdered, b: VariantOrdered): number {
  return Number(b.isDefault) - Number(a.isDefault) || compareMenuOrder({ ...a, name: a.label ?? '' }, { ...b, name: b.label ?? '' });
}

/** The step between positions the arrange screen writes (10, 20, 30...), and the gap a new row starts at past the end of its list. */
export const MENU_ORDER_STEP = 10;
