import { beforeAll, describe, expect, it } from 'vitest';
import { POS_V1_SOLD_ITEMS_FIELDS as I } from '../../../db/src/pos-v1/wire';
import { posV1SoldItemsBody } from '../../../db/src/pos-v1/fixtures';

/**
 * T-375 S5 (S5-lite) - `soldItemsFromFeed` and `sameItemsProjection` (`packages/domain/src/pos/v1-sold-items.ts`).
 * `docs/tasks/375-pos-v1-day-feed.md` S5 tests SI1-SI4.
 *
 * TESTER, not BUILDER. Pure, no I/O. Every refusal has its positive control in the same describe.
 *
 * ## Why these are red on HEAD
 * `v1-sold-items.ts` does not exist. It is imported DYNAMICALLY (preloaded in `beforeAll`), so each leg fails on
 * "Failed to resolve import ../../src/pos/v1-sold-items" - a missing module is the honest red for a new file (the S3
 * derive test's pattern). Nothing else here is red for another reason.
 *
 * ## The target shape (spec "BUILDER", read once and written down)
 *   soldItemsFromFeed(payload: unknown)
 *     -> { ok: true, found: boolean, items: PosSoldItemInput[] }      PosSoldItemInput = { posItemKey, posItemName, physicalQty }
 *      | { ok: false, raw: string }                                    raw names the failing field and the index
 *   - `physicalQty` is a `Quantity` string (3 dp): the JSON number 3 reads as '3.000', 2.5 as '2.500';
 *   - a missing name falls back to the key; two entries with one key are summed; `found: false` -> ok, [], found false.
 *   sameItemsProjection(a, b): same set of keys with equal quantities; names, order, every other field ignored.
 * Wire field names are read from `POS_V1_SOLD_ITEMS_FIELDS` (R12), never spelled here.
 */
type Item = { posItemKey: string; posItemName: string; physicalQty: string };
type Ok = { ok: true; found: boolean; items: Item[] };
type Bad = { ok: false; raw: string };
interface Mod {
  soldItemsFromFeed: (payload: unknown) => Ok | Bad;
  sameItemsProjection: (a: readonly Item[], b: readonly Item[]) => boolean;
}

let mod: Mod | null = null;
let loadError: unknown = null;
beforeAll(async () => {
  try {
    mod = (await import('../../src/pos/v1-sold-items')) as unknown as Mod;
  } catch (err) {
    loadError = err;
  }
});
function m(): Mod {
  if (!mod) throw new Error(`v1-sold-items.ts did not load: ${String((loadError as Error | null)?.message ?? loadError)}`);
  return mod;
}

/** A wire entry in POS's own names, built from the one constants table. */
const entry = (key: string, qty: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  [I.itemKey]: key,
  [I.physicalQty]: qty,
  ...extra,
});
const feed = (items: unknown, found = true): Record<string, unknown> => ({ [I.found]: found, [I.items]: items });
const named = (key: string, name: string, qty: number) => entry(key, qty, { [I.itemName]: name });

const A3 = { posItemKey: 'a', posItemName: 'A', physicalQty: '3.000' };
const B2 = { posItemKey: 'b', posItemName: 'B', physicalQty: '2.000' };

describe('SI1 - a readable feed becomes items', () => {
  it('a name is kept, a missing name falls back to the key, quantities are exact to 3 dp', () => {
    const r = m().soldItemsFromFeed(feed([named('a', 'A', 3), entry('b', 2.5)]));
    expect(r).toEqual({
      ok: true,
      found: true,
      items: [
        { posItemKey: 'a', posItemName: 'A', physicalQty: '3.000' },
        { posItemKey: 'b', posItemName: 'b', physicalQty: '2.500' },
      ],
    });
  });

  it('two entries with one key are summed into one', () => {
    const r = m().soldItemsFromFeed(feed([named('a', 'A', 1), named('a', 'A', 2)]));
    expect(r).toEqual({ ok: true, found: true, items: [{ posItemKey: 'a', posItemName: 'A', physicalQty: '3.000' }] });
  });

  it('a negative physical quantity is ACCEPTED as it is (a refund day nets below zero); the control for SI3', () => {
    const r = m().soldItemsFromFeed(feed([named('a', 'A', -2)]));
    expect(r).toEqual({ ok: true, found: true, items: [{ posItemKey: 'a', posItemName: 'A', physicalQty: '-2.000' }] });
  });

  it('reads the real test payload builder output too (the fixture and the parser agree)', () => {
    const body = posV1SoldItemsBody([{ key: 'item-a', physicalQty: 3, grossAmount: 300 }]);
    const r = m().soldItemsFromFeed(body);
    expect(r).toEqual({ ok: true, found: true, items: [{ posItemKey: 'item-a', posItemName: 'item-a', physicalQty: '3.000' }] });
  });
});

describe('SI2 - found false', () => {
  it('is ok, empty, and says found false (the sales rule is buildPlan\'s, not the parser\'s)', () => {
    expect(m().soldItemsFromFeed({ [I.found]: false })).toEqual({ ok: true, found: false, items: [] });
    expect(m().soldItemsFromFeed(posV1SoldItemsBody([], { found: false }))).toEqual({ ok: true, found: false, items: [] });
  });

  it('control: SI1\'s result carries found true', () => {
    const r = m().soldItemsFromFeed(feed([named('a', 'A', 3)]));
    expect(r.ok && r.found).toBe(true);
  });
});

describe('SI3 - an unreadable feed is refused, naming its field', () => {
  const refused = (payload: unknown): string => {
    const r = m().soldItemsFromFeed(payload);
    expect(r.ok, 'must be refused').toBe(false);
    return (r as Bad).raw;
  };

  it('control: the same shape with good values reads (SI1)', () => {
    expect(m().soldItemsFromFeed(feed([named('a', 'A', 3), named('b', 'B', 2)])).ok).toBe(true);
  });

  it('a payload that is null', () => {
    expect(typeof refused(null)).toBe('string');
  });

  it('items that are not an array: the raw names the items field', () => {
    expect(refused({ [I.found]: true, [I.items]: { nope: 1 } })).toContain(I.items);
  });

  it('an empty item key: the raw names the key field and the entry index', () => {
    const raw = refused(feed([named('a', 'A', 3), entry('', 1)]));
    expect(raw).toContain(I.itemKey);
    expect(raw).toMatch(/\b1\b/);
  });

  it('a physicalQty that is a string "3": the raw names physicalQty and the index (a number is required)', () => {
    const raw = refused(feed([named('a', 'A', 3), entry('b', '3')]));
    expect(raw).toContain(I.physicalQty);
    expect(raw).toMatch(/\b1\b/);
  });

  it('a physicalQty of 1.2345 (not exact to 3 dp) is refused, never rounded', () => {
    const raw = refused(feed([entry('a', 1.2345)]));
    expect(raw).toContain(I.physicalQty);
    expect(raw).toMatch(/\b0\b/);
  });

  it('a non-finite or missing physicalQty is refused', () => {
    expect(refused(feed([{ [I.itemKey]: 'a' }]))).toContain(I.physicalQty);
  });
});

describe('SI4 - sameItemsProjection', () => {
  it('true for {A 3, B 2} against {B 2, A 3} with other names (billable and every other field are not in the type)', () => {
    const swapped = [
      { posItemKey: 'b', posItemName: 'Different B name', physicalQty: '2.000' },
      { posItemKey: 'a', posItemName: 'Different A name', physicalQty: '3.000' },
    ];
    expect(m().sameItemsProjection([A3, B2], swapped)).toBe(true);
  });

  it('false when a quantity differs ({A 4, B 2})', () => {
    expect(m().sameItemsProjection([A3, B2], [{ ...A3, physicalQty: '4.000' }, B2])).toBe(false);
  });

  it('false when the key sets differ: {A 3} against {A 3, B 0}', () => {
    expect(m().sameItemsProjection([A3], [A3, { posItemKey: 'b', posItemName: 'B', physicalQty: '0.000' }])).toBe(false);
    expect(m().sameItemsProjection([A3, { posItemKey: 'b', posItemName: 'B', physicalQty: '0.000' }], [A3])).toBe(false);
  });

  it('quantities compare as numbers, not text: 3.000 equals 3.000 written from 3', () => {
    const viaParser = m().soldItemsFromFeed(feed([named('a', 'A', 3)]));
    expect(viaParser.ok).toBe(true);
    expect(m().sameItemsProjection([A3], (viaParser as Ok).items)).toBe(true);
  });
});
