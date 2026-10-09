import { describe, expect, it } from 'vitest';
import { decideHolds, heldSentences, trimQuantity, type HoldInputLine } from '../../src/pos/usage-holds';
import { quantity, toThousandths } from '../../src/stock/quantity';

/**
 * T-388 S1 - the pure half of DEF-618: which lines of ONE section are held back (R1/R4/R4a) and the words (R11).
 * `docs/tasks/388-pull-short-stock-per-item.md`. Each case names the mutant it kills.
 *
 * Contract choices made here where the spec is silent (the builder reconciles, never these tests):
 *  - `HeldLine.need` is the (item, room) TOTAL of the section (every line of one (item, room) shares it), `onHand` is the
 *    room's figure. Both are compared as quantities (thousandths), never as strings.
 *  - `heldSentences` returns one sentence per held (item, room) (per room for frozen), in room-name then item-name
 *    order, and then the closing untick sentence ONCE as the LAST element. No held lines -> [].
 *  - The store-wide parenthesis sits right after the room: `... on hand in Kitchen (2 in the whole store). Receive ...`.
 *  - `line(s)` in the frozen sentence is literal, as in today's flash.
 */
const ITEM_A = 'item-a';
const ITEM_B = 'item-b';
const KITCHEN = 'room-kitchen';
const DISPLAY = 'room-display';

const line = (key: string, itemId: string, locationId: string, qty: string, section: 'direct' | 'recipe' = 'direct'): HoldInputLine => ({
  key, section, itemId, locationId, quantity: qty,
});
const m = (entries: Record<string, string>): ReadonlyMap<string, string> => new Map(Object.entries(entries));
const none = new Set<string>();
const q = (s: string): bigint => toThousandths(quantity(s));
const rooms = (...r: string[]) => new Set(r);

describe('T-388 decideHolds', () => {
  it('U1 two lines in one room, one item short: only that line is held, the other posts. Mutant: hold the whole room -> red', () => {
    const lines = [line('a', ITEM_A, KITCHEN, '3.000'), line('b', ITEM_B, KITCHEN, '2.000')];
    const out = decideHolds(lines, m({ [`${ITEM_A}|${KITCHEN}`]: '0.000', [`${ITEM_B}|${KITCHEN}`]: '10.000' }),
      m({ [ITEM_A]: '0.000', [ITEM_B]: '10.000' }), none, none);
    expect(out.post.map((l) => l.key)).toEqual(['b']);
    expect(out.held.map((h) => h.key)).toEqual(['a']);
    expect(out.held[0]).toMatchObject({ itemId: ITEM_A, locationId: KITCHEN, cause: 'short' });
    expect(q(out.held[0]!.need)).toBe(3000n);
    expect(q(out.held[0]!.onHand)).toBe(0n);
  });

  it('U2 two lines of the SAME item (two POS items sharing one ingredient, 2 + 2) in one room with 3 on hand: BOTH held. Mutant: per-line check instead of the per-(item, room) sum -> red', () => {
    const lines = [line('r1', ITEM_A, KITCHEN, '2.000', 'recipe'), line('r2', ITEM_A, KITCHEN, '2.000', 'recipe')];
    const out = decideHolds(lines, m({ [`${ITEM_A}|${KITCHEN}`]: '3.000' }), m({ [ITEM_A]: '9.000' }), none, none);
    expect(out.post).toHaveLength(0);
    expect(out.held.map((h) => h.key).sort()).toEqual(['r1', 'r2']);
    for (const h of out.held) {
      expect(h.cause).toBe('short');
      expect(q(h.need), 'need is the (item, room) total').toBe(4000n);
      expect(q(h.onHand)).toBe(3000n);
    }
  });

  it('U2b store-wide: 3 needed in Kitchen, Kitchen on hand 3, but the layers hold only 2: held as short with storeOnHand 2. Mutant: room check only -> posts (and consume() refuses), red', () => {
    const out = decideHolds([line('a', ITEM_A, KITCHEN, '3.000')], m({ [`${ITEM_A}|${KITCHEN}`]: '3.000' }), m({ [ITEM_A]: '2.000' }), none, none);
    expect(out.post).toHaveLength(0);
    expect(out.held).toHaveLength(1);
    expect(out.held[0]).toMatchObject({ key: 'a', cause: 'short' });
    expect(q(out.held[0]!.onHand), "the room's own figure is kept").toBe(3000n);
    expect(out.held[0]!.storeOnHand).toBeDefined();
    expect(q(out.held[0]!.storeOnHand!)).toBe(2000n);
  });

  it('U2b-ii store-wide spans rooms: 2 in Kitchen + 2 in Display (4 needed), layers 3, each room has enough: every line of that item is held. Mutant: store-wide check per room -> posts, red', () => {
    const lines = [line('k', ITEM_A, KITCHEN, '2.000'), line('d', ITEM_A, DISPLAY, '2.000')];
    const out = decideHolds(lines, m({ [`${ITEM_A}|${KITCHEN}`]: '5.000', [`${ITEM_A}|${DISPLAY}`]: '5.000' }), m({ [ITEM_A]: '3.000' }), none, none);
    expect(out.post).toHaveLength(0);
    expect(out.held.map((h) => h.key).sort()).toEqual(['d', 'k']);
  });

  it('U2c a room in unusableRooms holds its lines as `room`, even when also frozen and short. Mutant: precedence wrong -> red', () => {
    const lines = [line('a', ITEM_A, KITCHEN, '3.000')];
    const out = decideHolds(lines, m({ [`${ITEM_A}|${KITCHEN}`]: '0.000' }), m({ [ITEM_A]: '0.000' }), rooms(KITCHEN), rooms(KITCHEN));
    expect(out.held).toHaveLength(1);
    expect(out.held[0]!.cause).toBe('room');
    expect(out.post).toHaveLength(0);
  });

  it('U3 same item, two rooms, one room short: only that room\'s line is held. Mutant: key by item only -> red', () => {
    const lines = [line('k', ITEM_A, KITCHEN, '3.000'), line('d', ITEM_A, DISPLAY, '3.000')];
    const out = decideHolds(lines, m({ [`${ITEM_A}|${KITCHEN}`]: '1.000', [`${ITEM_A}|${DISPLAY}`]: '9.000' }), m({ [ITEM_A]: '10.000' }), none, none);
    expect(out.post.map((l) => l.key)).toEqual(['d']);
    expect(out.held.map((h) => h.key)).toEqual(['k']);
    expect(out.held[0]).toMatchObject({ locationId: KITCHEN, cause: 'short' });
  });

  it('U4 on hand exactly equals the need: posts. Mutant: `<=` for `<` -> red', () => {
    const out = decideHolds([line('a', ITEM_A, KITCHEN, '3.000')], m({ [`${ITEM_A}|${KITCHEN}`]: '3.000' }), m({ [ITEM_A]: '3.000' }), none, none);
    expect(out.post.map((l) => l.key)).toEqual(['a']);
    expect(out.held).toHaveLength(0);
  });

  it('U4b a key missing from the maps is zero on hand: held. Mutant: missing treated as plenty -> red', () => {
    const out = decideHolds([line('a', ITEM_A, KITCHEN, '1.000')], new Map(), new Map(), none, none);
    expect(out.held.map((h) => h.key)).toEqual(['a']);
    expect(out.held[0]!.cause).toBe('short');
  });

  it('U5 a frozen room with plenty of stock: held as frozen; frozen AND short: still frozen. Mutant: shortfall checked first -> red', () => {
    const stocked = decideHolds([line('a', ITEM_A, KITCHEN, '3.000')], m({ [`${ITEM_A}|${KITCHEN}`]: '50.000' }), m({ [ITEM_A]: '50.000' }), rooms(KITCHEN), none);
    expect(stocked.post).toHaveLength(0);
    expect(stocked.held).toHaveLength(1);
    expect(stocked.held[0]!.cause).toBe('frozen');
    const short = decideHolds([line('a', ITEM_A, KITCHEN, '3.000')], m({ [`${ITEM_A}|${KITCHEN}`]: '0.000' }), m({ [ITEM_A]: '0.000' }), rooms(KITCHEN), none);
    expect(short.held[0]!.cause).toBe('frozen');
  });

  it('U5b a frozen room does not hold another room\'s lines. Mutant: any frozen room holds everything -> red', () => {
    const lines = [line('k', ITEM_A, KITCHEN, '1.000'), line('d', ITEM_B, DISPLAY, '1.000')];
    const out = decideHolds(lines, m({ [`${ITEM_A}|${KITCHEN}`]: '9.000', [`${ITEM_B}|${DISPLAY}`]: '9.000' }), m({ [ITEM_A]: '9.000', [ITEM_B]: '9.000' }), rooms(KITCHEN), none);
    expect(out.post.map((l) => l.key)).toEqual(['d']);
    expect(out.held.map((h) => h.key)).toEqual(['k']);
  });

  it('U5c nothing in, nothing out: no lines -> no post, no held', () => {
    const out = decideHolds([], new Map(), new Map(), none, none);
    expect(out.post).toEqual([]);
    expect(out.held).toEqual([]);
  });
});

describe('T-388 trimQuantity (R11)', () => {
  it('U6 trailing zeros trimmed, never an integer zero: 3.000->3, 0.500->0.5, 0.000->0, 10.000->10, 12.340->12.34, 0.050->0.05. Mutant: strip every trailing 0 (10.000 -> 1) -> red', () => {
    expect(trimQuantity('3.000')).toBe('3');
    expect(trimQuantity('0.500')).toBe('0.5');
    expect(trimQuantity('0.000')).toBe('0');
    expect(trimQuantity('10.000')).toBe('10');
    expect(trimQuantity('12.340')).toBe('12.34');
    expect(trimQuantity('0.050')).toBe('0.05');
    expect(trimQuantity('100.000')).toBe('100');
  });
});

describe('T-388 heldSentences (R11, word for word)', () => {
  const names = {
    item: (id: string) => ({ [ITEM_A]: 'Coke', [ITEM_B]: 'Cheese' })[id] ?? id,
    unit: (id: string) => ({ [ITEM_A]: 'pcs', [ITEM_B]: 'kg' })[id] ?? 'u',
    room: (id: string) => ({ [KITCHEN]: 'Kitchen', [DISPLAY]: 'Display' })[id] ?? id,
  };
  const CLOSING = 'Or untick a held line to finalize without it.';
  const held = (key: string, itemId: string, locationId: string, cause: 'short' | 'frozen' | 'room', need: string, onHand: string, storeOnHand?: string) => ({
    key, itemId, locationId, cause, need, onHand, ...(storeOnHand === undefined ? {} : { storeOnHand }),
  });

  it('U6 direct section, short: "{Item}: {need} {unit} sold, {onHand} on hand in {Room}. Receive or count it, then finalize again." then the closing sentence once', () => {
    const out = heldSentences('direct', [held('a', ITEM_A, KITCHEN, 'short', '3.000', '0.000')], names);
    expect(out).toEqual(['Coke: 3 pcs sold, 0 on hand in Kitchen. Receive or count it, then finalize again.', CLOSING]);
  });

  it('U6 recipe section says "needed", not "sold"; 0.500 prints 0.5', () => {
    const out = heldSentences('recipe', [held('a', ITEM_B, KITCHEN, 'short', '2.500', '0.500')], names);
    expect(out).toEqual(['Cheese: 2.5 kg needed, 0.5 on hand in Kitchen. Receive or count it, then finalize again.', CLOSING]);
  });

  it('U6 store-wide: the room\'s figure is kept and "(N in the whole store)" follows the room', () => {
    const out = heldSentences('direct', [held('a', ITEM_A, KITCHEN, 'short', '3.000', '3.000', '2.000')], names);
    expect(out).toEqual(['Coke: 3 pcs sold, 3 on hand in Kitchen (2 in the whole store). Receive or count it, then finalize again.', CLOSING]);
  });

  it('U6 one sentence per (item, room): two held lines of one (item, room) read once, with the summed need', () => {
    const out = heldSentences('recipe', [
      held('r1', ITEM_B, KITCHEN, 'short', '4.000', '3.000'),
      held('r2', ITEM_B, KITCHEN, 'short', '4.000', '3.000'),
    ], names);
    expect(out).toEqual(['Cheese: 4 kg needed, 3 on hand in Kitchen. Receive or count it, then finalize again.', CLOSING]);
  });

  it('U6 frozen: one sentence per frozen ROOM counting its held lines', () => {
    const out = heldSentences('direct', [
      held('a', ITEM_A, KITCHEN, 'frozen', '3.000', '9.000'),
      held('b', ITEM_B, KITCHEN, 'frozen', '1.000', '9.000'),
    ], names);
    expect(out).toEqual(['Kitchen is being counted, so 2 line(s) there wait. Finish or cancel the count, then finalize again.', CLOSING]);
  });

  it('U6 room: "{Room} can\'t take usage; fix the mapping for {Item}, then finalize again."', () => {
    const out = heldSentences('direct', [held('a', ITEM_A, DISPLAY, 'room', '3.000', '0.000')], names);
    expect(out).toEqual(["Display can't take usage; fix the mapping for Coke, then finalize again.", CLOSING]);
  });

  it('U6 stable order: room name, then item name, whatever order the lines came in; the closing sentence stays last and appears once', () => {
    const out = heldSentences('direct', [
      held('1', ITEM_A, KITCHEN, 'short', '1.000', '0.000'),
      held('2', ITEM_B, DISPLAY, 'short', '1.000', '0.000'),
      held('3', ITEM_B, KITCHEN, 'short', '1.000', '0.000'),
      held('4', ITEM_A, DISPLAY, 'short', '1.000', '0.000'),
    ], names);
    expect(out.map((s) => s.split(':')[0])).toEqual(['Cheese', 'Coke', 'Cheese', 'Coke', 'Or untick a held line to finalize without it.']);
    expect(out.map((s) => /in (Kitchen|Display)\./.exec(s)?.[1])).toEqual(['Display', 'Display', 'Kitchen', 'Kitchen', undefined]);
    expect(out.filter((s) => s === CLOSING)).toHaveLength(1);
    expect(out.at(-1)).toBe(CLOSING);
  });

  it('U6 nothing held -> no sentences, no closing line', () => {
    expect(heldSentences('direct', [], names)).toEqual([]);
  });
});
