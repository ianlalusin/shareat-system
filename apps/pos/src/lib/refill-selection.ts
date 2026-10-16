/**
 * Refill selection state transitions — pure, no React, no Firestore.
 *
 * This lives outside the component because the modal previously kept `cart` and
 * `activeRefillId` in sync by hand, and they could drift apart: deselecting a
 * refill that was NOT the focused one moved focus onto the entry that had just
 * been removed, after which the two states stayed permanently out of phase and
 * the flavor picker could never reappear.
 *
 * Invariant enforced here: `activeId` is either null, the id of an entry that
 * IS in the cart, or a focus-only panel id (e.g. "Other Refills") that never
 * has a cart entry.
 */

export type FlavorCarrying = { flavorIds: string[] };

export type SelectionResult<T> = { cart: Map<string, T>; activeId: string | null };

/**
 * A refill that requires a flavor may only stay selected once it has one. The
 * entry currently being edited is exempt — that is the one the customer is
 * still choosing a flavor for.
 */
export function pruneFlavorless<T extends FlavorCarrying>(
  cart: Map<string, T>,
  activeId: string | null,
  needsFlavor: (refillId: string) => boolean
): Map<string, T> {
  const next = new Map(cart);
  for (const [id, item] of next) {
    if (id === activeId) continue;
    if (needsFlavor(id) && item.flavorIds.length === 0) next.delete(id);
  }
  return next;
}

/**
 * Applies one tap on a refill card.
 *
 * - unselected            -> select it and focus it
 * - selected, not focused -> just focus it (so its flavor can be changed
 *                           without losing the flavor already picked)
 * - selected and focused  -> deselect and clear focus
 *
 * Omit `createItem` for a focus-only panel such as "Other Refills": the tap
 * moves focus but never creates a cart entry.
 */
export function applyRefillTap<T extends FlavorCarrying>(opts: {
  cart: Map<string, T>;
  activeId: string | null;
  tappedId: string;
  needsFlavor: (refillId: string) => boolean;
  createItem?: () => T;
}): SelectionResult<T> {
  const { cart, activeId, tappedId, needsFlavor, createItem } = opts;

  const inCart = cart.has(tappedId);
  const isFocused = activeId === tappedId;

  const next = new Map(cart);
  let nextActive: string | null;

  if (!createItem) {
    nextActive = isFocused ? null : tappedId;
  } else if (inCart && isFocused) {
    next.delete(tappedId);
    nextActive = null;
  } else if (!inCart) {
    next.set(tappedId, createItem());
    nextActive = tappedId;
  } else {
    nextActive = tappedId;
  }

  return { cart: pruneFlavorless(next, nextActive, needsFlavor), activeId: nextActive };
}

/** True when the flavor picker should be on screen for this state. */
export function picksFlavorFor<T>(cart: Map<string, T>, activeId: string | null): T | null {
  return activeId ? cart.get(activeId) ?? null : null;
}
