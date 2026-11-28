/**
 * T-651 - the one menu order rule (packages/domain/src/menu/order.ts): sort order, then name (lower case), then id; default size first.
 * Each test has a mutant that turns it red (listed in the hand-back, applied by hand).
 */
import { describe, expect, it } from 'vitest';
import { compareMenuOrder, compareVariantOrder } from '../../src/menu/order';

const row = (id: string, name: string, sortOrder: number) => ({ id, name, sortOrder });
const ordered = (rows: ReturnType<typeof row>[]) => [...rows].sort(compareMenuOrder).map((r) => r.id);

describe('compareMenuOrder', () => {
  it('sort order wins over the name', () => {
    expect(ordered([row('a', 'Apple', 20), row('b', 'Zebra', 10)])).toEqual(['b', 'a']);
  });

  it('a tie falls to the name, ignoring case', () => {
    expect(ordered([row('1', 'cola', 0), row('2', 'Banana', 0), row('3', 'Apple', 0)])).toEqual(['3', '2', '1']);
  });

  it('a tie on both falls to the id, so the order never depends on how the rows arrived', () => {
    expect(ordered([row('b', 'Same', 5), row('a', 'Same', 5)])).toEqual(['a', 'b']);
    expect(ordered([row('a', 'Same', 5), row('b', 'Same', 5)])).toEqual(['a', 'b']);
  });
});

describe('compareVariantOrder', () => {
  const v = (id: string, label: string | null, sortOrder: number, isDefault = false) => ({ id, label, sortOrder, isDefault });
  const ids = (rows: ReturnType<typeof v>[]) => [...rows].sort(compareVariantOrder).map((r) => r.id);

  it('the default size is first even when another has a lower sort order', () => {
    expect(ids([v('large', 'Large', 0), v('reg', null, 50, true), v('small', 'Small', 10)])).toEqual(['reg', 'large', 'small']);
  });

  it('the others follow sort order, then label, then id', () => {
    expect(ids([v('c', 'Zed', 1), v('b', 'Beta', 1), v('a', 'Alpha', 2), v('d', 'Beta', 1)])).toEqual(['b', 'd', 'c', 'a']);
  });
});
