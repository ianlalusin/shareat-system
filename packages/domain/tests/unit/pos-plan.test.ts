import { describe, expect, it } from 'vitest';
import { explodePosSales, type MapLookup, type RecipeLookup } from '../../src/pos/plan';

const LOC = 'loc-kitchen';

function maps(entries: Record<string, MapLookup>): Map<string, MapLookup> {
  return new Map(Object.entries(entries));
}

describe('T-177 pos/plan.ts — 1. physical quantity, direct map', () => {
  it('⭐ 10 sold, 2 comped, 1 voided → 11 consumed (already netted by POS), quantityPerSale 1', () => {
    const lines = explodePosSales({
      posItems: [{ posItemKey: 'coke', posItemName: 'Coke', physicalQty: '11' }],
      mapsByPosItemKey: maps({ coke: { mode: 'direct', itemId: 'item-coke', recipeId: null, quantityPerSale: '1', locationId: null } }),
      recipesById: new Map(),
      defaultLocationId: LOC,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ section: 'direct', itemId: 'item-coke', quantity: '11.000', blocked: false });
  });

  it('quantityPerSale scales the direct line (e.g. 1 pos sale = 2 pieces)', () => {
    const lines = explodePosSales({
      posItems: [{ posItemKey: 'chopsticks-box', posItemName: 'Chopsticks Box', physicalQty: '3' }],
      mapsByPosItemKey: maps({ 'chopsticks-box': { mode: 'direct', itemId: 'item-chopsticks', recipeId: null, quantityPerSale: '2', locationId: null } }),
      recipesById: new Map(),
      defaultLocationId: LOC,
    });
    expect(lines[0]!.quantity).toBe('6.000');
  });
});

describe('T-177 pos/plan.ts — 2. recipe explosion, per-line blocking (not v1\'s all-or-nothing)', () => {
  const recipe: RecipeLookup = {
    outputQuantity: '1',
    lines: [
      { itemId: 'item-cheese', quantity: '200', unit: 'g', itemBaseUnit: 'kg' }, // converts fine
      { itemId: 'item-sauce', quantity: '1', unit: 'box', itemBaseUnit: 'kg' }, // unconvertible
    ],
  };

  it('an unconvertible unit blocks THAT LINE only, not the pull', () => {
    const lines = explodePosSales({
      posItems: [{ posItemKey: 'samgyup-box', posItemName: 'Samgyup Box', physicalQty: '5' }],
      mapsByPosItemKey: maps({ 'samgyup-box': { mode: 'recipe', itemId: null, recipeId: 'recipe-1', quantityPerSale: null, locationId: null } }),
      recipesById: new Map([['recipe-1', recipe]]),
      defaultLocationId: LOC,
    });

    expect(lines).toHaveLength(2);
    const cheese = lines.find((l) => l.itemId === 'item-cheese')!;
    const sauce = lines.find((l) => l.itemId === 'item-sauce')!;

    expect(cheese.blocked).toBe(false);
    // 200g * 5 sales / 1 output = 1000g = 1.000kg
    expect(cheese.quantity).toBe('1.000');

    expect(sauce.blocked).toBe(true);
    expect(sauce.quantity).toBeNull();
    expect(sauce.blockReason).toMatch(/cannot be.*converted/);
  });
});

describe('T-177 pos/plan.ts — 3. a no_stock map consumes nothing and is not an orphan', () => {
  it('produces no line at all', () => {
    const lines = explodePosSales({
      posItems: [{ posItemKey: 'delivery-fee', posItemName: 'Delivery Fee', physicalQty: '4' }],
      mapsByPosItemKey: maps({ 'delivery-fee': { mode: 'no_stock', itemId: null, recipeId: null, quantityPerSale: null, locationId: null } }),
      recipesById: new Map(),
      defaultLocationId: LOC,
    });
    expect(lines).toHaveLength(0);
  });
});

describe('T-177 pos/plan.ts — 4. an unmapped item lands in the orphan section', () => {
  it('no map at all → one orphan line, no item, no quantity', () => {
    const lines = explodePosSales({
      posItems: [{ posItemKey: 'mystery-item', posItemName: 'Mystery Item', physicalQty: '2' }],
      mapsByPosItemKey: new Map(),
      recipesById: new Map(),
      defaultLocationId: LOC,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ section: 'orphan', itemId: null, quantity: null, blocked: false });
  });
});

describe('T-177 pos/plan.ts — location resolution', () => {
  it('a map override wins over the pull-level default', () => {
    const lines = explodePosSales({
      posItems: [{ posItemKey: 'coke', posItemName: 'Coke', physicalQty: '1' }],
      mapsByPosItemKey: maps({
        coke: { mode: 'direct', itemId: 'item-coke', recipeId: null, quantityPerSale: '1', locationId: 'loc-display' },
      }),
      recipesById: new Map(),
      defaultLocationId: LOC,
    });
    expect(lines[0]!.locationId).toBe('loc-display');
  });

  it('falls back to the pull-level default when the map has no override', () => {
    const lines = explodePosSales({
      posItems: [{ posItemKey: 'coke', posItemName: 'Coke', physicalQty: '1' }],
      mapsByPosItemKey: maps({ coke: { mode: 'direct', itemId: 'item-coke', recipeId: null, quantityPerSale: '1', locationId: null } }),
      recipesById: new Map(),
      defaultLocationId: LOC,
    });
    expect(lines[0]!.locationId).toBe(LOC);
  });
});

describe('T-177 pos/plan.ts — a missing or invalid recipe blocks, never throws', () => {
  it('recipeId points nowhere → one blocked recipe-section line', () => {
    const lines = explodePosSales({
      posItems: [{ posItemKey: 'samgyup-box', posItemName: 'Samgyup Box', physicalQty: '5' }],
      mapsByPosItemKey: maps({ 'samgyup-box': { mode: 'recipe', itemId: null, recipeId: 'recipe-ghost', quantityPerSale: null, locationId: null } }),
      recipesById: new Map(),
      defaultLocationId: LOC,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.blocked).toBe(true);
  });

  it('zero sold this day skips the explosion entirely (nothing to explode)', () => {
    const lines = explodePosSales({
      posItems: [{ posItemKey: 'samgyup-box', posItemName: 'Samgyup Box', physicalQty: '0' }],
      mapsByPosItemKey: maps({ 'samgyup-box': { mode: 'recipe', itemId: null, recipeId: 'recipe-1', quantityPerSale: null, locationId: null } }),
      recipesById: new Map([['recipe-1', { outputQuantity: '1', lines: [{ itemId: 'x', quantity: '1', unit: 'kg', itemBaseUnit: 'kg' }] }]]),
      defaultLocationId: LOC,
    });
    expect(lines).toHaveLength(0);
  });
});
