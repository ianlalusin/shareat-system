/**
 * Which lines of ONE POS-usage section are held back, and the words for it. T-388 S1 (DEF-618).
 * `docs/tasks/388-pull-short-stock-per-item.md` R1, R4, R4a, R11.
 *
 * PURE: no database, no clock. The caller reads the figures (under the locks of R3) and passes them in; this only
 * decides. The triggers stay the enforcement (RULES 6.3); this decides which lines to ATTEMPT and supplies the
 * numbers for the sentence.
 *
 * A line is all or held: never part-posted. Granularity is the stock item within a room, within the section.
 * Every quantity is compared as thousandths through `stock/quantity.ts`, never as a float or a string.
 */
import { addQuantity, compareQuantity, quantity, ZERO_QUANTITY, type Quantity } from '../stock/quantity';

export interface HoldInputLine {
  readonly key: string;
  readonly section: 'direct' | 'recipe';
  readonly itemId: string;
  readonly locationId: string;
  readonly quantity: string;
}

export interface HeldLine {
  readonly key: string;
  readonly itemId: string;
  readonly locationId: string;
  readonly cause: 'short' | 'frozen' | 'room';
  /** The section's total for this (item, room): the same figure on every held line of one (item, room). */
  readonly need: string;
  /** The room's on-hand for the item. */
  readonly onHand: string;
  /** Set only when the shortfall is store-wide (the item's layers), not the room's. */
  readonly storeOnHand?: string;
}

const pairKey = (itemId: string, locationId: string): string => `${itemId}|${locationId}`;

const figure = (map: ReadonlyMap<string, string>, key: string): Quantity => {
  const raw = map.get(key);
  return raw === undefined ? ZERO_QUANTITY : quantity(raw);
};

/** True when `have` cannot cover `need`. */
const isShort = (have: Quantity, need: Quantity): boolean => compareQuantity(have, need) < 0;

/**
 * R1 / R4 / R4a. `onHand` is keyed `${itemId}|${locationId}` and `layerRemaining` by itemId; a missing key is 0.
 * Precedence per line: `room` > `frozen` > `short`.
 *
 * The store-wide check (the item's layers, which `consume()` itself refuses on) counts only the lines that would
 * otherwise post, so a line already held for its room does not push a sibling line over the store's figure.
 */
export function decideHolds(
  lines: readonly HoldInputLine[],
  onHand: ReadonlyMap<string, string>,
  layerRemaining: ReadonlyMap<string, string>,
  frozenRooms: ReadonlySet<string>,
  unusableRooms: ReadonlySet<string>,
): { readonly post: readonly HoldInputLine[]; readonly held: readonly HeldLine[] } {
  // The section's total per (item, room).
  const needByPair = new Map<string, Quantity>();
  for (const l of lines) {
    const k = pairKey(l.itemId, l.locationId);
    needByPair.set(k, addQuantity(needByPair.get(k) ?? ZERO_QUANTITY, quantity(l.quantity)));
  }
  const needOf = (l: HoldInputLine): Quantity => needByPair.get(pairKey(l.itemId, l.locationId)) ?? ZERO_QUANTITY;

  const causeByKey = new Map<string, 'short' | 'frozen' | 'room'>();
  const storeFigure = new Map<string, Quantity>();

  // Pass 1: the room and the room's own stock.
  const survivors: HoldInputLine[] = [];
  for (const l of lines) {
    if (unusableRooms.has(l.locationId)) causeByKey.set(l.key, 'room');
    else if (frozenRooms.has(l.locationId)) causeByKey.set(l.key, 'frozen');
    else if (isShort(figure(onHand, pairKey(l.itemId, l.locationId)), needOf(l))) causeByKey.set(l.key, 'short');
    else survivors.push(l);
  }

  // Pass 2: the item's layers, store-wide, across every room of the survivors.
  const survivorNeed = new Map<string, Quantity>();
  for (const l of survivors) survivorNeed.set(l.itemId, addQuantity(survivorNeed.get(l.itemId) ?? ZERO_QUANTITY, quantity(l.quantity)));
  for (const l of survivors) {
    const layers = figure(layerRemaining, l.itemId);
    if (isShort(layers, survivorNeed.get(l.itemId) ?? ZERO_QUANTITY)) {
      causeByKey.set(l.key, 'short');
      storeFigure.set(l.key, layers);
    }
  }

  const post: HoldInputLine[] = [];
  const held: HeldLine[] = [];
  for (const l of lines) {
    const cause = causeByKey.get(l.key);
    if (!cause) {
      post.push(l);
      continue;
    }
    const store = storeFigure.get(l.key);
    held.push({
      key: l.key,
      itemId: l.itemId,
      locationId: l.locationId,
      cause,
      need: needOf(l),
      onHand: figure(onHand, pairKey(l.itemId, l.locationId)),
      ...(store === undefined ? {} : { storeOnHand: store }),
    });
  }
  return { post, held };
}

/** R11: `3.000` -> `3`, `0.500` -> `0.5`, `0.000` -> `0`, `10.000` -> `10`. */
export function trimQuantity(q: string): string {
  if (!q.includes('.')) return q;
  return q.replace(/0+$/, '').replace(/\.$/, '');
}

const CLOSING = 'Or untick a held line to finalize without it.';

/**
 * R11: one sentence per held (item, room) (per room for frozen), ordered by room name then item name, then the
 * closing untick sentence ONCE. Nothing held -> [].
 */
export function heldSentences(
  section: 'direct' | 'recipe',
  held: readonly HeldLine[],
  names: { item(id: string): string; unit(id: string): string; room(id: string): string },
): string[] {
  if (held.length === 0) return [];

  interface Entry { readonly room: string; readonly item: string; readonly text: string }
  const entries: Entry[] = [];
  const seen = new Set<string>();
  const frozenCount = new Map<string, number>();
  for (const h of held) if (h.cause === 'frozen') frozenCount.set(h.locationId, (frozenCount.get(h.locationId) ?? 0) + 1);

  for (const h of held) {
    const room = names.room(h.locationId);
    if (h.cause === 'frozen') {
      const k = `frozen|${h.locationId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      entries.push({
        room,
        item: '',
        text: `${room} is being counted, so ${frozenCount.get(h.locationId) ?? 0} line(s) there wait. Finish or cancel the count, then finalize again.`,
      });
      continue;
    }
    const k = `${h.cause}|${h.locationId}|${h.itemId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const item = names.item(h.itemId);
    if (h.cause === 'room') {
      entries.push({ room, item, text: `${room} can't take usage; fix the mapping for ${item}, then finalize again.` });
      continue;
    }
    const verb = section === 'direct' ? 'sold' : 'needed';
    const wide = h.storeOnHand === undefined ? '' : ` (${trimQuantity(h.storeOnHand)} in the whole store)`;
    entries.push({
      room,
      item,
      text:
        `${item}: ${trimQuantity(h.need)} ${names.unit(h.itemId)} ${verb}, ${trimQuantity(h.onHand)} on hand in ${room}${wide}. ` +
        'Receive or count it, then finalize again.',
    });
  }

  entries.sort((a, b) => a.room.localeCompare(b.room) || a.item.localeCompare(b.item));
  return [...entries.map((e) => e.text), CLOSING];
}
