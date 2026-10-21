import { ITEM_KINDS, type ItemKind } from '@shareat/db/schema';

/**
 * T-443 R3. Arrange the item list so a variation sits directly under its parent, indented. Pure: no database, no React.
 *
 * - The list arrives already filtered (by status and, optionally, kind) and ordered by name.
 * - A variation whose parent is NOT in the list (filtered out by kind, or retired and hidden) is shown flat, as if top-level:
 *   it must never disappear because of how the table is filtered.
 * - Everything else keeps the incoming (name) order; children follow their parent, in name order.
 */
export interface FamilyRow<T> {
  item: T;
  /** True for a variation shown under its parent in this list. */
  indented: boolean;
}

export function arrangeFamilies<T extends { id: string; variantOfItemId: string | null }>(rows: readonly T[]): FamilyRow<T>[] {
  const present = new Set(rows.map((r) => r.id));
  const childrenOf = new Map<string, T[]>();
  for (const r of rows) {
    if (r.variantOfItemId !== null && present.has(r.variantOfItemId)) {
      const list = childrenOf.get(r.variantOfItemId) ?? [];
      list.push(r);
      childrenOf.set(r.variantOfItemId, list);
    }
  }
  const out: FamilyRow<T>[] = [];
  for (const r of rows) {
    if (r.variantOfItemId !== null && present.has(r.variantOfItemId)) continue; // placed under its parent
    out.push({ item: r, indented: false });
    for (const c of childrenOf.get(r.id) ?? []) out.push({ item: c, indented: true });
  }
  return out;
}

/** T-443 R3. `?kind=` is read against the one list of kinds; anything else (including a missing value) means "all". */
export function parseKindFilter(value: string | undefined): ItemKind | undefined {
  return (ITEM_KINDS as readonly string[]).includes(value ?? '') ? (value as ItemKind) : undefined;
}
