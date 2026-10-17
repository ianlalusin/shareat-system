import { describe, it, expect } from 'vitest';
import { emptyCart, addItem, removeItem, setQty, cartCount, toOrderLines } from '@/lib/cart';

/**
 * T-437 slice T: pure cart helpers. Assumed names (builder must match): emptyCart(), addItem(cart, itemId) (+1),
 * removeItem(cart, itemId) (drops the whole line), setQty(cart, itemId, qty) (<=0 removes), cartCount(cart) (sum of qty),
 * toOrderLines(cart) -> [{itemId, qty}]. Helpers never mutate their input.
 */

describe('cart helpers', () => {
  it('starts empty. Kills: non-empty initial cart', () => {
    expect(cartCount(emptyCart())).toBe(0);
    expect(toOrderLines(emptyCart())).toEqual([]);
  });

  it('addItem twice merges into one line with qty 2. Kills: duplicate lines', () => {
    const c = addItem(addItem(emptyCart(), 'a'), 'a');
    expect(toOrderLines(c)).toEqual([{ itemId: 'a', qty: 2 }]);
    expect(cartCount(c)).toBe(2);
  });

  it('cartCount sums qty across lines. Kills: counts lines instead of qty', () => {
    const c = setQty(addItem(addItem(emptyCart(), 'a'), 'b'), 'a', 5);
    expect(cartCount(c)).toBe(6);
  });

  it('setQty sets exactly; setQty 0 removes the line. Kills: adds instead of sets / zero-qty line left behind', () => {
    let c = setQty(addItem(emptyCart(), 'a'), 'a', 4);
    expect(toOrderLines(c)).toEqual([{ itemId: 'a', qty: 4 }]);
    c = setQty(c, 'a', 0);
    expect(toOrderLines(c)).toEqual([]);
  });

  it('removeItem drops the whole line and leaves others. Kills: removes only one unit / removes everything', () => {
    const c = removeItem(setQty(addItem(emptyCart(), 'a'), 'a', 3), 'a');
    expect(toOrderLines(c)).toEqual([]);
    const two = removeItem(addItem(addItem(emptyCart(), 'a'), 'b'), 'a');
    expect(toOrderLines(two)).toEqual([{ itemId: 'b', qty: 1 }]);
  });

  it('removing an item that is not there is a no-op. Kills: throws / corrupts', () => {
    const c = addItem(emptyCart(), 'a');
    expect(toOrderLines(removeItem(c, 'zzz'))).toEqual([{ itemId: 'a', qty: 1 }]);
  });

  it('does not mutate its input. Kills: in-place mutation (React state bug)', () => {
    const c = addItem(emptyCart(), 'a');
    const snapshot = JSON.stringify(c);
    addItem(c, 'a');
    setQty(c, 'a', 9);
    removeItem(c, 'a');
    expect(JSON.stringify(c)).toBe(snapshot);
  });

  it('a cart line holds no price: runtime shape is exactly itemId + qty. Kills: client-priced bill', () => {
    const c = setQty(addItem(addItem(emptyCart(), 'a'), 'b'), 'b', 3);
    for (const l of toOrderLines(c)) expect(Object.keys(l).sort()).toEqual(['itemId', 'qty']);
    expect(JSON.stringify(c)).not.toMatch(/price|amount|cost|total/i);
  });
});
