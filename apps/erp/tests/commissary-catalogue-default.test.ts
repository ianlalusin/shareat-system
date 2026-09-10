import { describe, expect, it } from 'vitest';
import { selectDefaultCommissaryStoreId, type StoreCandidate } from '../src/app/commissary/catalogue/default-store';

/**
 * T-253 / DEF-220. `/commissary/catalogue` used to default to `stores[0]`, which is a branch
 * whenever the branch happens to sort first — every test here asserts the PROPERTY (the returned
 * id is a member of `commissaryStoreIds`), never a store's name, code or array position. A fix
 * that hard-codes a different index or matches a name is the same defect wearing a new number.
 */
describe('selectDefaultCommissaryStoreId', () => {
  it('picks the store that IS a commissary, even when it sits last and sorts last', () => {
    const stores: StoreCandidate[] = [
      { id: 'branch-a' },
      { id: 'branch-b' },
      { id: 'branch-c' },
      { id: 'zzz-commissary' },
    ];
    const commissaryStoreIds = new Set(['zzz-commissary']);

    const result = selectDefaultCommissaryStoreId(stores, commissaryStoreIds, null);

    expect(commissaryStoreIds.has(result!)).toBe(true);
  });

  it('is position-independent: permuting the same stores still returns a commissary id', () => {
    const commissaryStoreIds = new Set(['store-2']);
    const store1: StoreCandidate = { id: 'store-1' };
    const store2: StoreCandidate = { id: 'store-2' };
    const store3: StoreCandidate = { id: 'store-3' };

    const inOrder = [store1, store2, store3];
    const reversed = [store3, store2, store1];
    const commissaryFirst = [store2, store1, store3];

    for (const arrangement of [inOrder, reversed, commissaryFirst]) {
      const result = selectDefaultCommissaryStoreId(arrangement, commissaryStoreIds, null);
      expect(commissaryStoreIds.has(result!)).toBe(true);
    }
  });

  it('prefers the signed-in store when that store is a commissary, even if not first', () => {
    const stores: StoreCandidate[] = [{ id: 'commissary-1' }, { id: 'commissary-2' }, { id: 'branch-1' }];
    const commissaryStoreIds = new Set(['commissary-1', 'commissary-2']);

    const result = selectDefaultCommissaryStoreId(stores, commissaryStoreIds, 'commissary-2');

    expect(result).toBe('commissary-2');
  });

  it('ignores the signed-in store when it is not a commissary, and falls through to one that is', () => {
    const stores: StoreCandidate[] = [{ id: 'branch-signed-in' }, { id: 'commissary-1' }];
    const commissaryStoreIds = new Set(['commissary-1']);

    const result = selectDefaultCommissaryStoreId(stores, commissaryStoreIds, 'branch-signed-in');

    expect(result).not.toBe('branch-signed-in');
    expect(commissaryStoreIds.has(result!)).toBe(true);
  });

  it('returns undefined when the org has no commissary at all — never silently picks a branch', () => {
    const stores: StoreCandidate[] = [{ id: 'branch-1' }, { id: 'branch-2' }, { id: 'branch-3' }];
    const commissaryStoreIds = new Set<string>();

    const result = selectDefaultCommissaryStoreId(stores, commissaryStoreIds, null);

    expect(result).toBeUndefined();
  });

  it('negative control: an empty store list also yields undefined', () => {
    const result = selectDefaultCommissaryStoreId([], new Set<string>(), null);

    expect(result).toBeUndefined();
  });

  it('negative control: a signed-in store id that matches no store in the list is not returned by itself', () => {
    const stores: StoreCandidate[] = [{ id: 'commissary-1' }];
    const commissaryStoreIds = new Set(['commissary-1', 'ghost-store']);

    // 'ghost-store' is a commissary but not in `stores` — the function must not invent a result
    // for it; it must still return an id drawn from `stores`.
    const result = selectDefaultCommissaryStoreId(stores, commissaryStoreIds, 'ghost-store');

    expect(result).toBe('commissary-1');
  });
});
