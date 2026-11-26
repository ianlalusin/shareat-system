/**
 * T-644 S2 - seating a lobby party from the live POS: the pure half. Two steps in ONE order (the Reservations pattern, `Reservations.tsx` saveSeat): the table opens first
 * (`stand.opened` is saved to the outbox, the same event the Orders seat sheet builds), and ONLY THEN is the lobby told (`seatLobbyEntryAction`). If the first step does not
 * save, the lobby is never called. If the second fails the table stays open and the party is remembered so the row can Retry. No React, no clock, no network: every
 * dependency arrives in an argument. docs/tasks/644-lobby-in-erp-pos.md, S2.
 */
import type { NewPosEvent } from '@/lib/pos-device';
import { asStoreMenu, isOptionChoiceValid, storeAnswer, whenOf, type MenuLike, type Variant } from '../_orders/menu-filter';
import type { CartLine } from '../_orders/payloads';
import { handLine, LOBBY_NEEDS_INTERNET, type LobbyLineView, type LobbyResult } from './logic';
import type { PendingSeat } from './pending';

export const SEAT_NEEDS_INTERNET = 'Lobby needs the internet';
export const SEAT_LINK_NOT_SAVED = 'Seated, link not saved';
export const SEAT_NO_SESSION = 'That table could not be opened. Try again.';

/** Whether the Seat button works, and what it says when it does not. Offline is the one case with a sentence: the lobby needs the server. */
export function seatButton(a: { ready: boolean; online: boolean; busy: boolean }): { disabled: boolean; hint: string | null } {
  if (!a.online) return { disabled: true, hint: SEAT_NEEDS_INTERNET };
  return { disabled: !a.ready || a.busy, hint: null };
}

const optionsFit = (v: Variant, ids: readonly string[]): boolean =>
  ids.every((id) => v.optionGroups.some((g) => g.values.some((x) => x.id === id && x.channels.store.orderable))) &&
  v.optionGroups.every((g) =>
    isOptionChoiceValid(
      g,
      ids.filter((id) => g.values.some((x) => x.id === id)),
    ),
  );

/**
 * The party's lines as the Orders cart takes them, matched variantId -> menu item through the tablet's snapshot menu. A line is added only when it can be sold as it
 * stands: the variant is on this menu AND on sale now, any options the diner chose are still offered and satisfy the group rules, and a second package is never stacked on a first
 * (the cart holds one package line, billed per head). Every other line is NOT added: it comes back in `byHand`, for the cashier to tap in.
 */
export function mapLobbyLines(lines: readonly LobbyLineView[], menu: MenuLike | null, at: Date): { cart: CartLine[]; byHand: string[] } {
  const cart: CartLine[] = [];
  const byHand: string[] = [];
  const m = menu ? asStoreMenu(menu) : null;
  const when = m ? whenOf(m, at) : null;
  let packageTaken = false;
  for (const l of lines) {
    const item = m?.items.find((i) => i.variants.some((v) => v.id === l.variantId));
    const variant = item?.variants.find((v) => v.id === l.variantId);
    const ids = l.optionValueIds ?? [];
    const isPackage = item?.itemType === 'package';
    if (!item || !variant || !when || (isPackage ? packageTaken : item.itemType !== 'a_la_carte') || !storeAnswer(variant, when).orderable || !optionsFit(variant, ids)) {
      byHand.push(handLine(l));
      continue;
    }
    if (isPackage) packageTaken = true;
    cart.push({ itemId: item.id, variantId: variant.id, qty: isPackage ? 1 : l.qty, ...(ids.length > 0 ? { optionValueIds: ids } : {}) });
  }
  return { cart, byHand };
}

export type SeatOutcome = { kind: 'seated' } | { kind: 'refused'; message: string } | { kind: 'link-pending'; message: string };

export interface SeatDeps {
  /** Saves ONE event to the outbox (`submitPosEvent`): ok means it is queued for sending. */
  submit: (event: NewPosEvent) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** The server action. A thrown error (no connection) counts as a failure like a refusal. */
  link: (b: PendingSeat) => Promise<LobbyResult>;
  remember: (p: PendingSeat) => void;
  forget: (entryId: string) => void;
}

const tryLink = async (d: Pick<SeatDeps, 'link'>, p: PendingSeat): Promise<LobbyResult> => {
  try {
    return await d.link(p);
  } catch {
    return { ok: false, error: LOBBY_NEEDS_INTERNET };
  }
};

/** Step 1 the table, step 2 the lobby. `event` is the Orders seat sheet's `stand.opened`; its `sessionId` is the one the lobby is told. */
export async function seatLobbyParty(d: SeatDeps, i: { entryId: string; event: NewPosEvent; standLabel: string }): Promise<SeatOutcome> {
  const sessionId = (i.event.payload as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== 'string' || sessionId === '') return { kind: 'refused', message: SEAT_NO_SESSION };
  const opened = await d.submit(i.event);
  if (!opened.ok) return { kind: 'refused', message: opened.message };
  const p: PendingSeat = { entryId: i.entryId, sessionId, standLabel: i.standLabel };
  const r = await tryLink(d, p);
  if (r.ok) {
    d.forget(i.entryId);
    return { kind: 'seated' };
  }
  d.remember(p);
  return { kind: 'link-pending', message: r.error };
}

/** "Retry" on a row that shows "Seated, link not saved": the same lobby call again. Success forgets the note; failure keeps it. */
export async function retryLobbyLink(d: Pick<SeatDeps, 'link' | 'forget'>, p: PendingSeat): Promise<{ ok: true } | { ok: false; message: string }> {
  const r = await tryLink(d, p);
  if (!r.ok) return { ok: false, message: r.error };
  d.forget(p.entryId);
  return { ok: true };
}
