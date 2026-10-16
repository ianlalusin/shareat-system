import type { SavedQrCode } from "@/lib/types";

/**
 * Picks the single QR customers should see on the online-ordering page.
 *
 * Firestore rules cannot enforce "at most one flagged doc per store", so this
 * function is the invariant's actual enforcement point: it deterministically
 * picks ONE candidate even if two documents are somehow flagged at once. The
 * same input — in any array order — must always return the same document.
 *
 * Only considers codes that are both flagged (`useForOnlineOrders === true`)
 * and active (`isActive === true`): an inactive QR must never be shown to a
 * customer. Ties are broken by `sortOrder` ascending, then `id` ascending
 * (lexicographic), so the pick never depends on read/array order.
 */
export function pickOnlineQr(codes: SavedQrCode[]): SavedQrCode | null {
  const candidates = codes.filter(
    (code) => code.useForOnlineOrders === true && code.isActive === true,
  );

  if (candidates.length === 0) return null;

  const sorted = [...candidates].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  return sorted[0];
}

/**
 * Computes which documents must change to make `targetId` the only QR flagged
 * for online orders — the write plan for TASK 3's atomic batch.
 *
 * - `targetId` non-null: the target gets `useForOnlineOrders: true`; every
 *   OTHER code currently `true` gets `false`. Codes already in the right
 *   state are omitted, so a caller applying this plan never issues a
 *   pointless write.
 * - `targetId` null: an explicit unflag — every currently-true code gets
 *   `false`.
 *
 * Returns an empty array when nothing needs to change.
 */
export function planFlagChange(
  codes: SavedQrCode[],
  targetId: string | null,
): Array<{ id: string; useForOnlineOrders: boolean }> {
  const plan: Array<{ id: string; useForOnlineOrders: boolean }> = [];

  for (const code of codes) {
    const shouldBeFlagged = targetId !== null && code.id === targetId;
    const isFlagged = code.useForOnlineOrders === true;
    if (shouldBeFlagged !== isFlagged) {
      plan.push({ id: code.id, useForOnlineOrders: shouldBeFlagged });
    }
  }

  return plan;
}
