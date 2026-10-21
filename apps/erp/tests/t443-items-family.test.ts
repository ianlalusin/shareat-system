import { describe, expect, it } from 'vitest';
import { arrangeFamilies, parseKindFilter } from '../src/app/items/family';

/** T-443 R3: pure arrangement of the items table - a variation sits under its parent; a variation whose parent is filtered out stays visible. */
const row = (id: string, variantOfItemId: string | null = null) => ({ id, variantOfItemId });

describe('T-443 arrangeFamilies', () => {
  it('puts variations directly under their parent, indented, keeping name order elsewhere', () => {
    const rows = [row('a-kimchi'), row('b-kimchi-250', 'a-kimchi'), row('c-onion'), row('d-kimchi-500', 'a-kimchi')];
    expect(arrangeFamilies(rows).map((r) => `${r.indented ? '  ' : ''}${r.item.id}`)).toEqual([
      'a-kimchi',
      '  b-kimchi-250',
      '  d-kimchi-500',
      'c-onion',
    ]);
  });

  it('shows a variation flat (never hides it) when its parent is not in the list', () => {
    const out = arrangeFamilies([row('b-kimchi-250', 'a-kimchi'), row('c-onion')]);
    expect(out.map((r) => [r.item.id, r.indented])).toEqual([
      ['b-kimchi-250', false],
      ['c-onion', false],
    ]);
  });

  it('returns every row exactly once', () => {
    const rows = [row('p'), row('c1', 'p'), row('c2', 'p'), row('lonely', 'gone')];
    expect(arrangeFamilies(rows).map((r) => r.item.id).sort()).toEqual(['c1', 'c2', 'lonely', 'p']);
  });
});

describe('T-443 parseKindFilter', () => {
  it('accepts a known kind and ignores anything else', () => {
    expect(parseKindFilter('supply')).toBe('supply');
    expect(parseKindFilter('meat_slab')).toBe('meat_slab');
    expect(parseKindFilter('nonsense')).toBeUndefined();
    expect(parseKindFilter('')).toBeUndefined();
    expect(parseKindFilter(undefined)).toBeUndefined();
  });
});
