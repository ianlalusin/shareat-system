import type { Product } from "@/lib/types";

/**
 * A minimal, product-like interface to allow variant helpers
 * to work on different but related types like Product and InventoryItem.
 */
export type ProductLike = {
  id?: string;
  name?: string | null;
  kind?: "single" | "group" | "variant" | null;
  groupId?: string | null;
  groupName?: string | null;
  variantLabel?: string | null;
  variant?: string | null; // legacy
  uom?: string;
  barcode?: string | null; // allow null
};


/**
 * Gets the kind of the product, defaulting to "single" if not specified.
 * This ensures backward compatibility with older product documents.
 * @param product The product object.
 * @returns The kind of the product: "single", "group", or "variant".
 */
export function getKind(product: ProductLike): "single" | "group" | "variant" {
    return product.kind ?? "single";
}

/**
 * Gets the effective variant label for a product.
 * It prioritizes the new `variantLabel` field but falls back to the legacy `variant` field.
 * @param product The product object.
 * @returns The variant label string, or null if none exists.
 */
export function getEffectiveVariantLabel(product: ProductLike): string | null {
    return product.variantLabel ?? product.variant ?? null;
}

/**
 * Checks if a product is a sellable SKU (Stock Keeping Unit).
 * A product is sellable if its kind is not "group".
 * @param product The product object.
 * @returns True if the product is a sellable SKU.
 */
export function isSellableSku(product: ProductLike): boolean {
    const kind = getKind(product);
    return kind !== "group";
}

/**
 * Gets a consistent key for grouping product variants.
 * For true variants, it uses the `groupId`. For all other products (single, legacy),
 * it uses the product's own ID, making them their own "group".
 * @param product The product object.
 * @returns The group key string.
 */
export function getGroupKey(product: ProductLike): string {
    const kind = getKind(product);
    if (kind === "variant" && product.groupId) {
        return product.groupId;
    }
    return product.id || "";
}

/**
 * Gets the display name for a product group.
 * It prioritizes the `groupName` field and falls back to the product's own `name`.
 * @param product The product object.
 * @returns The group title string.
 */
export function getGroupTitle(product: ProductLike): string {
    return product.groupName ?? product.name ?? "";
}

/**
 * Gets the full display name for a product, including its variant label if applicable.
 * e.g., "Coke (500ml)"
 * This function correctly handles both new variants and legacy single-variant products.
 * @param product The product object.
 * @returns The formatted display name string.
 */
export function getDisplayName(product: ProductLike): string {
    const vLabel = getEffectiveVariantLabel(product);
    const kind = getKind(product);

    // Only append variant label to sellable SKUs, not to the group itself.
    if (vLabel && kind !== "group") {
        return `${product.name} (${vLabel})`;
    }

    return product.name || "";
}

/**
 * Resolves a family's display picture: the first item in the list that actually
 * has an image. Used on POS user-facing screens as the family tile picture and
 * as the fallback for variants that have no picture of their own. Pass the
 * items in a stable order (e.g. sorted by display name) so "first" is
 * deterministic.
 * @returns The first non-empty imageUrl, or null if none of the items have one.
 */
export function resolveFamilyImageUrl(
    items: { imageUrl?: string | null }[],
): string | null {
    for (const it of items) {
        if (it.imageUrl) return it.imageUrl;
    }
    return null;
}

export type FamilyRow<T extends ProductLike> =
    | { kind: "family"; groupId: string; groupName: string; variants: T[] }
    | { kind: "single"; item: T };

/**
 * Groups a flat, already-sorted list into family rows for display — every
 * `kind: "variant"` item with a `groupId` joins its family (keyed by
 * `groupId`, labeled via `getGroupTitle`); everything else stands alone.
 *
 * Unlike a Product family, there is no "group" root item here (a store never
 * carries one in inventory), so there's no orphan case to detect: each
 * variant already carries its own mirrored `groupName`, so grouping needs no
 * cross-reference back to the live product catalog.
 *
 * A family's row is inserted at the position of its first-seen variant, and
 * later variants of the same family join that row wherever they appear in
 * `items` — so callers don't need their input pre-clustered, only sorted.
 */
export function groupIntoFamilies<T extends ProductLike>(items: T[]): FamilyRow<T>[] {
    const rows: FamilyRow<T>[] = [];
    const familyIndexByGroupId = new Map<string, number>();

    for (const item of items) {
        if (getKind(item) === "variant" && item.groupId) {
            const groupId = item.groupId;
            let idx = familyIndexByGroupId.get(groupId);
            if (idx === undefined) {
                idx = rows.length;
                familyIndexByGroupId.set(groupId, idx);
                rows.push({ kind: "family", groupId, groupName: getGroupTitle(item), variants: [] });
            }
            (rows[idx] as { kind: "family"; groupId: string; groupName: string; variants: T[] }).variants.push(item);
        } else {
            rows.push({ kind: "single", item });
        }
    }

    return rows;
}
