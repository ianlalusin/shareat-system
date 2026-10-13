/**
 * T-401 S3 - the store-menu projection (pure). docs/tasks/401-erp-menu-catalog-master.md "S3 projection types".
 * Invariants I9, I10, I14, I15. project.ts is new: until it exists every test fails at the import.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectStoreMenu } from '../../src/menu/project';

const AT = new Date('2026-10-14T00:00:00.000Z');
const S = 'store-a';

const priceFixed = (amount: string | null) => ({
  withdrawn: false, pricingMode: 'fixed' as const, amount, bundleHeads: null, extraHeadAmount: null, markupPercent: null, fixedMarkupAmount: null,
});
const offer = (variantId: string, channel: 'store' | 'online', amount: string | null) => ({
  ...priceFixed(amount), variantId, channel, effectiveFrom: new Date('2026-01-01T00:00:00Z'), basis: null,
});

function base(over: Record<string, unknown> = {}): any {
  return {
    categories: [{ id: 'c1', name: 'Mains', parentId: null, sortOrder: 1, status: 'active' }],
    items: [
      { id: 'i1', categoryId: 'c1', name: 'Burger', description: null, itemType: 'a_la_carte', soldALaCarte: true, soldInPackageSession: false, dinerOrderable: true, sortOrder: 1, status: 'active' },
      { id: 'ip', categoryId: 'c1', name: 'Unli', description: null, itemType: 'package', soldALaCarte: true, soldInPackageSession: false, dinerOrderable: true, sortOrder: 2, status: 'active' },
      { id: 'r1', categoryId: 'c1', name: 'Pork', description: null, itemType: 'refill', soldALaCarte: false, soldInPackageSession: false, dinerOrderable: true, sortOrder: 3, status: 'active' },
      { id: 'r2', categoryId: 'c1', name: 'Beef', description: null, itemType: 'refill', soldALaCarte: false, soldInPackageSession: false, dinerOrderable: true, sortOrder: 4, status: 'active' },
    ],
    variants: [
      { id: 'v1', menuItemId: 'i1', label: null, isDefault: true, sortOrder: 1, status: 'active' },
      { id: 'vp', menuItemId: 'ip', label: null, isDefault: true, sortOrder: 1, status: 'active' },
      { id: 'vr1', menuItemId: 'r1', label: null, isDefault: true, sortOrder: 1, status: 'active' },
      { id: 'vr2', menuItemId: 'r2', label: null, isDefault: true, sortOrder: 1, status: 'active' },
    ],
    optionGroups: [
      { id: 'gA', name: 'Sauce', selectionMode: 'single', minSelections: 0, maxSelections: 1, status: 'active' },
      { id: 'gB', name: 'Size', selectionMode: 'single', minSelections: 1, maxSelections: 1, status: 'active' },
    ],
    optionValues: [
      { id: 'oa', optionGroupId: 'gA', name: 'BBQ', sortOrder: 1, status: 'active' },
      { id: 'ob', optionGroupId: 'gB', name: 'Large', sortOrder: 1, status: 'active' },
    ],
    optionGroupLinks: [],
    packageRefills: [],
    stores: [{
      storeId: S, at: AT,
      offers: [
        offer('v1', 'store', '100.00'), offer('vp', 'store', '399.00'), offer('vr1', 'store', null), offer('vr2', 'store', null),
      ],
      optionOffers: [
        { optionValueId: 'oa', channel: 'store', priceDelta: '0.00' }, { optionValueId: 'ob', channel: 'store', priceDelta: '10.00' },
      ],
      upcoming: [],
    }],
    ...over,
  };
}

const proj = (snap: any) => projectStoreMenu(snap, S, AT);
const variantOf = (p: any, id: string) => p.menu.items.flatMap((i: any) => i.variants).find((v: any) => v.id === id);
const groupIds = (p: any, id: string): string[] => variantOf(p, id).optionGroups.map((g: any) => g.id);

describe('I9 - a variant option links replace its item links', () => {
  const link = (id: string, optionGroupId: string, t: { menuItemId?: string; variantId?: string }) =>
    ({ id, optionGroupId, menuItemId: t.menuItemId ?? null, variantId: t.variantId ?? null, sortOrder: 1, status: 'active' });

  it('item links A, variant links B: the variant shows B only (mutant: union A and B)', () => {
    const p = proj(base({ optionGroupLinks: [link('l1', 'gA', { menuItemId: 'i1' }), link('l2', 'gB', { variantId: 'v1' })] }));
    expect(groupIds(p, 'v1')).toEqual(['gB']);
  });
  it('a variant without links shows its item group A', () => {
    const p = proj(base({ optionGroupLinks: [link('l1', 'gA', { menuItemId: 'i1' })] }));
    expect(groupIds(p, 'v1')).toEqual(['gA']);
  });
  it('only the variant that has own links is replaced; a sibling inherits the item groups', () => {
    const snap = base({
      variants: [
        { id: 'v1', menuItemId: 'i1', label: null, isDefault: true, sortOrder: 1, status: 'active' },
        { id: 'v1b', menuItemId: 'i1', label: 'Double', isDefault: false, sortOrder: 2, status: 'active' },
        ...base().variants.slice(1),
      ],
      optionGroupLinks: [link('l1', 'gA', { menuItemId: 'i1' }), link('l2', 'gB', { variantId: 'v1' })],
    });
    snap.stores[0].offers.push(offer('v1b', 'store', '150.00'));
    const p = proj(snap);
    expect(groupIds(p, 'v1')).toEqual(['gB']);
    expect(groupIds(p, 'v1b')).toEqual(['gA']);
  });
  it('a retired own link does not count as having links: the item groups apply', () => {
    const p = proj(base({ optionGroupLinks: [link('l1', 'gA', { menuItemId: 'i1' }), { ...link('l2', 'gB', { variantId: 'v1' }), status: 'retired' }] }));
    expect(groupIds(p, 'v1')).toEqual(['gA']);
  });
});

describe('I10 - package refills: package to refill only; empty never means all', () => {
  it('a package with no rows projects no refills (mutant: empty means all)', () => {
    const p = proj(base());
    expect(variantOf(p, 'vp').refillItemIds).toEqual([]);
  });
  it('a package lists exactly its rows, sorted by id; the unlisted refill is absent', () => {
    const p = proj(base({ packageRefills: [{ packageVariantId: 'vp', refillItemId: 'r1', status: 'active' }] }));
    expect(variantOf(p, 'vp').refillItemIds).toEqual(['r1']);
    const p2 = proj(base({ packageRefills: [
      { packageVariantId: 'vp', refillItemId: 'r2', status: 'active' }, { packageVariantId: 'vp', refillItemId: 'r1', status: 'active' }] }));
    expect(variantOf(p2, 'vp').refillItemIds).toEqual(['r1', 'r2']);
  });
  it('a retired row is not listed; a non-package variant always has []', () => {
    const p = proj(base({ packageRefills: [
      { packageVariantId: 'vp', refillItemId: 'r1', status: 'retired' }, { packageVariantId: 'vp', refillItemId: 'r2', status: 'active' }] }));
    expect(variantOf(p, 'vp').refillItemIds).toEqual(['r2']);
    expect(variantOf(p, 'v1').refillItemIds).toEqual([]);
  });
  it('a refill that does not appear in this projection (no offer at the store) is not listed', () => {
    const snap = base({ packageRefills: [
      { packageVariantId: 'vp', refillItemId: 'r1', status: 'active' }, { packageVariantId: 'vp', refillItemId: 'r2', status: 'active' }] });
    snap.stores[0].offers = snap.stores[0].offers.filter((o: any) => o.variantId !== 'vr2');
    expect(variantOf(proj(snap), 'vp').refillItemIds).toEqual(['r1']);
  });
});

/** Independent canonical serialisation (keys sorted by code unit, no whitespace) for the hash check. */
const canon = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
};
const shuffleKeys = (v: any): any => {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return v;
  if (Array.isArray(v)) return v.map(shuffleKeys);
  return Object.fromEntries(Object.keys(v).reverse().map((k) => [k, shuffleKeys(v[k])]));
};

describe('I14 - projection is pure, deterministic, carrier-neutral', () => {
  it('same snapshot twice gives the same hash and equal output; schemaVersion is 1', () => {
    const snap = base();
    const a = proj(snap);
    const b = proj(snap);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a).toEqual(b);
    expect(a.menu.schemaVersion).toBe(1);
    expect(a.menu.storeId).toBe(S);
  });
  it('shuffled key order and row order give the same hash (mutant: hash over non-canonical JSON)', () => {
    const snap = base();
    const reordered = shuffleKeys({ ...snap, items: [...snap.items].reverse(), variants: [...snap.variants].reverse(), categories: [...snap.categories].reverse() });
    expect(proj(reordered).contentHash).toBe(proj(snap).contentHash);
  });
  it('contentHash is the lowercase hex sha256 of the canonical JSON of menu only', () => {
    const p = proj(base());
    expect(p.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.contentHash).toBe(createHash('sha256').update(canon(p.menu), 'utf8').digest('hex'));
  });
  it('the same menu at another instant (and with upcoming rows) has the same hash: nextChangeAt and at are not hashed', () => {
    const later = base();
    later.stores[0].at = new Date('2026-10-15T00:00:00.000Z');
    later.stores[0].upcoming = [new Date('2026-12-01T00:00:00Z')];
    expect(projectStoreMenu(later, S, new Date('2026-10-15T00:00:00.000Z')).contentHash).toBe(proj(base()).contentHash);
  });
  it('a price change changes the hash', () => {
    const snap = base();
    snap.stores[0].offers[0] = offer('v1', 'store', '101.00');
    expect(proj(snap).contentHash).not.toBe(proj(base()).contentHash);
  });
  it('does not mutate its input', () => {
    const snap = base();
    const before = JSON.stringify(snap);
    proj(snap);
    expect(JSON.stringify(snap)).toBe(before);
  });
  it('throws on an unknown store and on an `at` that differs from the instant the rows were read at', () => {
    expect(() => projectStoreMenu(base(), 'nope', AT)).toThrow();
    expect(() => projectStoreMenu(base(), S, new Date(AT.getTime() + 1))).toThrow();
  });
  it('project.ts imports no firebase, @shareat/db, or fetch', () => {
    const src = readFileSync(resolve(__dirname, '../../src/menu/project.ts'), 'utf8');
    const imports = [...src.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+['"]([^'"]+)['"]/gms)].map((m) => m[1] ?? '');
    expect(imports.filter((s) => /firebase|@shareat\/db|\/db\//.test(s))).toEqual([]);
    expect(/\bfetch\s*\(/.test(src)).toBe(false);
    expect(/firebase/i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))).toBe(false);
  });
});

describe('I15 - nextChangeAt names the next scheduled change', () => {
  const withUpcoming = (dates: string[]) => {
    const snap = base();
    snap.stores[0].upcoming = dates.map((d) => new Date(d));
    return proj(snap).nextChangeAt;
  };
  it('a future offer at T gives nextChangeAt = T as ISO text', () => {
    expect(withUpcoming(['2026-11-01T00:00:00.000Z'])).toBe('2026-11-01T00:00:00.000Z');
  });
  it('several, unordered: the earliest (mutant: returns last instead of next)', () => {
    expect(withUpcoming(['2026-12-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'])).toBe('2026-11-01T00:00:00.000Z');
  });
  it('none gives null', () => {
    expect(withUpcoming([])).toBeNull();
  });
  it('a date at or before `at` is ignored (strictly after)', () => {
    expect(withUpcoming(['2026-10-14T00:00:00.000Z', '2026-10-01T00:00:00.000Z'])).toBeNull();
    expect(withUpcoming(['2026-10-14T00:00:00.000Z', '2026-10-20T00:00:00.000Z'])).toBe('2026-10-20T00:00:00.000Z');
  });
});

const online = (variantId: string, over: Record<string, unknown>) => ({ ...offer(variantId, 'online', null), ...over });
const chan = (p: any, id: string) => variantOf(p, id).channels;

describe('visibility: a variant appears only if orderable on at least one channel', () => {
  it('no offer row at all: the variant, then its item, then its category, are hidden', () => {
    const snap = base();
    snap.stores[0].offers = [offer('vp', 'store', '399.00')];
    const p = proj(snap);
    expect(variantOf(p, 'v1')).toBeUndefined();
    expect(p.menu.items.map((i: any) => i.id)).toEqual(['ip']);
    snap.stores[0].offers = [];
    const empty = proj(snap);
    expect(empty.menu.items).toEqual([]);
    expect(empty.menu.categories).toEqual([]);
  });
  it('withdrawn on both channels hides it; online-only shows it with the store channel carrying its reason', () => {
    const snap = base();
    snap.stores[0].offers = [{ ...offer('v1', 'store', null), withdrawn: true }, { ...offer('v1', 'online', null), withdrawn: true }];
    expect(variantOf(proj(snap), 'v1')).toBeUndefined();
    snap.stores[0].offers = [{ ...offer('v1', 'store', null), withdrawn: true }, offer('v1', 'online', '90.00')];
    const c = chan(proj(snap), 'v1');
    expect(c.online).toEqual({ orderable: true, amount: '90.00', bundleHeads: null, extraHeadAmount: null });
    expect(c.store).toEqual({ orderable: false, notOffered: 'withdrawn' });
  });
  it('a retired variant or a retired item is hidden even with offers', () => {
    const a = base();
    a.variants[0].status = 'retired';
    expect(variantOf(proj(a), 'v1')).toBeUndefined();
    const b = base();
    b.items[0].status = 'retired';
    expect(proj(b).menu.items.map((i: any) => i.id)).not.toContain('i1');
  });
  it('a category appears iff it holds an appearing item or parents an appearing category', () => {
    const snap = base({
      categories: [
        { id: 'c1', name: 'Mains', parentId: null, sortOrder: 1, status: 'active' },
        { id: 'c2', name: 'Burgers', parentId: 'c1', sortOrder: 1, status: 'active' },
        { id: 'c3', name: 'Empty', parentId: null, sortOrder: 2, status: 'active' },
      ],
    });
    snap.items = snap.items.map((i: any) => ({ ...i, categoryId: 'c2' }));
    expect(proj(snap).menu.categories.map((c: any) => c.id)).toEqual(['c1', 'c2']);
  });
  it('dinerOrderable is passed through and not folded into orderable', () => {
    const snap = base();
    snap.items[0].dinerOrderable = false;
    const p = proj(snap);
    expect(p.menu.items.find((i: any) => i.id === 'i1')?.dinerOrderable).toBe(false);
    expect(chan(p, 'v1').store.orderable).toBe(true);
  });
  it('an option value appears iff active and orderable on a channel; channels are independent', () => {
    const snap = base({ optionGroupLinks: [{ id: 'l1', optionGroupId: 'gA', menuItemId: 'i1', variantId: null, sortOrder: 1, status: 'active' }] });
    snap.optionValues.push({ id: 'oz', optionGroupId: 'gA', name: 'Zesty', sortOrder: 2, status: 'active' });
    snap.optionValues.push({ id: 'or', optionGroupId: 'gA', name: 'Old', sortOrder: 3, status: 'retired' });
    snap.stores[0].optionOffers.push({ optionValueId: 'oz', channel: 'online', priceDelta: '5.00' }, { optionValueId: 'or', channel: 'store', priceDelta: '1.00' });
    const g = variantOf(proj(snap), 'v1').optionGroups[0];
    expect(g.values.map((v: any) => v.id)).toEqual(['oa', 'oz']);
    expect(g.values[0].channels).toEqual({ store: { orderable: true, priceDelta: '0.00' }, online: { orderable: false, notOffered: 'no_offer' } });
    expect(g.values[1].channels.online).toEqual({ orderable: true, priceDelta: '5.00' });
    expect(g.values[1].channels.store).toEqual({ orderable: false, notOffered: 'no_offer' });
  });
  it('a group whose values all drop still appears with values []; a retired group is skipped', () => {
    const snap = base({ optionGroupLinks: [
      { id: 'l1', optionGroupId: 'gA', menuItemId: 'i1', variantId: null, sortOrder: 1, status: 'active' },
      { id: 'l2', optionGroupId: 'gB', menuItemId: 'i1', variantId: null, sortOrder: 2, status: 'active' }] });
    snap.stores[0].optionOffers = [];
    snap.optionGroups[1].status = 'retired';
    const gs = variantOf(proj(snap), 'v1').optionGroups;
    expect(gs.map((g: any) => g.id)).toEqual(['gA']);
    expect(gs[0].values).toEqual([]);
  });
});

describe('notOffered reasons land on the right channel; amounts come from resolveOfferPrice', () => {
  it('no_offer: a channel with no row in force', () => {
    expect(chan(proj(base()), 'v1').online).toEqual({ orderable: false, notOffered: 'no_offer' });
  });
  it('withdrawn online while store is live', () => {
    const snap = base();
    snap.stores[0].offers.push(online('v1', { withdrawn: true }));
    const c = chan(proj(snap), 'v1');
    expect(c.online).toEqual({ orderable: false, notOffered: 'withdrawn' });
    expect(c.store.orderable).toBe(true);
  });
  it('no_basis: a rule row whose store basis is missing', () => {
    const snap = base();
    snap.stores[0].offers.push(online('v1', { pricingMode: 'percent_markup', markupPercent: '10.0000', basis: null }));
    expect(chan(proj(snap), 'v1').online).toEqual({ orderable: false, notOffered: 'no_basis' });
  });
  it('rule_below_zero: a fixed markup that goes negative is not offered, never 0.00', () => {
    const snap = base();
    snap.stores[0].offers.push(online('v1', { pricingMode: 'fixed_markup', fixedMarkupAmount: '-500.00', basis: priceFixed('100.00') }));
    expect(chan(proj(snap), 'v1').online).toEqual({ orderable: false, notOffered: 'rule_below_zero' });
  });
  it('a percent rule shows the resolveOfferPrice amount (85.50 at +7.5% = 91.91); a bundle inherits heads', () => {
    const snap = base();
    snap.stores[0].offers.push(online('v1', { pricingMode: 'percent_markup', markupPercent: '7.5000', basis: priceFixed('85.50') }));
    snap.stores[0].offers.push(online('vp', {
      pricingMode: 'percent_markup', markupPercent: '-10.0000',
      basis: { ...priceFixed('1000.00'), bundleHeads: 4, extraHeadAmount: '99.00' },
    }));
    const p = proj(snap);
    expect(chan(p, 'v1').online).toEqual({ orderable: true, amount: '91.91', bundleHeads: null, extraHeadAmount: null });
    expect(chan(p, 'vp').online).toEqual({ orderable: true, amount: '900.00', bundleHeads: 4, extraHeadAmount: '89.10' });
  });
  it('a fixed row passes its text through untouched, bundle columns included; a refill has amount null', () => {
    const snap = base();
    snap.stores[0].offers[1] = { ...offer('vp', 'store', '399.00'), bundleHeads: 4, extraHeadAmount: '100.00' };
    const p = proj(snap);
    expect(chan(p, 'vp').store).toEqual({ orderable: true, amount: '399.00', bundleHeads: 4, extraHeadAmount: '100.00' });
    expect(chan(p, 'vr1').store).toEqual({ orderable: true, amount: null, bundleHeads: null, extraHeadAmount: null });
  });
});

describe('sort orders (UTF-16 code unit; input order never matters)', () => {
  const cat = (id: string, name: string, sortOrder: number) => ({ id, name, parentId: null, sortOrder, status: 'active' });
  it('categories and items by (sortOrder, name, id); uppercase sorts before lowercase', () => {
    const snap = base({ categories: [cat('c3', 'b', 1), cat('c2', 'a', 1), cat('c1', 'Z', 1), cat('c0', 'zz', 0)] });
    snap.items = snap.items.map((i: any, n: number) => ({ ...i, categoryId: ['c0', 'c1', 'c2', 'c3'][n], sortOrder: 5, name: ['a', 'a', 'B', 'a'][n] }));
    const p = proj(snap);
    expect(p.menu.categories.map((c: any) => c.id)).toEqual(['c0', 'c1', 'c2', 'c3']);
    expect(p.menu.items.map((i: any) => i.id)).toEqual(['r1', 'i1', 'ip', 'r2']);
  });
  it('categories come in tree order: parent before its children, siblings by (sortOrder, name, id)', () => {
    const snap = base({
      categories: [
        { id: 'cC', name: 'Alpha', parentId: 'cP', sortOrder: 0, status: 'active' },
        { id: 'cP', name: 'Zeta', parentId: null, sortOrder: 1, status: 'active' },
        { id: 'cR', name: 'Beta', parentId: null, sortOrder: 1, status: 'active' },
      ],
    });
    snap.items = snap.items.map((i: any) => ({ ...i, categoryId: i.id === 'i1' ? 'cC' : 'cR' }));
    // A flat sort would put the child cC first (sortOrder 0, name Alpha). Tree order: root Beta, root Zeta, then Zeta child.
    expect(proj(snap).menu.categories.map((c: any) => c.id)).toEqual(['cR', 'cP', 'cC']);
  });
  it('variants: default first, then sortOrder, label, id', () => {
    const v = (id: string, label: string | null, isDefault: boolean, sortOrder: number) => ({ id, menuItemId: 'i1', label, isDefault, sortOrder, status: 'active' });
    const snap = base({ variants: [v('x3', 'B', false, 2), v('x1', 'Z', false, 1), v('x2', 'A', false, 2), v('x0', null, true, 9), ...base().variants.slice(1)] });
    for (const id of ['x0', 'x1', 'x2', 'x3']) snap.stores[0].offers.push(offer(id, 'store', '10.00'));
    const item = proj(snap).menu.items.find((i: any) => i.id === 'i1');
    expect(item?.variants.map((x: any) => x.id)).toEqual(['x0', 'x1', 'x2', 'x3']);
  });
  it('option groups by (link sortOrder, name, id); values by (sortOrder, name, id)', () => {
    const snap = base({
      optionGroupLinks: [
        { id: 'l1', optionGroupId: 'gA', menuItemId: 'i1', variantId: null, sortOrder: 2, status: 'active' },
        { id: 'l2', optionGroupId: 'gB', menuItemId: 'i1', variantId: null, sortOrder: 1, status: 'active' }],
    });
    snap.optionValues.push({ id: 'o0', optionGroupId: 'gA', name: 'Aaa', sortOrder: 1, status: 'active' });
    snap.optionValues.push({ id: 'o9', optionGroupId: 'gA', name: 'Zzz', sortOrder: 0, status: 'active' });
    snap.stores[0].optionOffers.push({ optionValueId: 'o0', channel: 'store', priceDelta: '0.00' }, { optionValueId: 'o9', channel: 'store', priceDelta: '0.00' });
    const gs = variantOf(proj(snap), 'v1').optionGroups;
    expect(gs.map((g: any) => g.id)).toEqual(['gB', 'gA']);
    expect(gs[1].values.map((x: any) => x.id)).toEqual(['o9', 'o0', 'oa']);
  });
  it('reversing every input list does not change the output', () => {
    const snap = base({ packageRefills: [{ packageVariantId: 'vp', refillItemId: 'r1', status: 'active' }, { packageVariantId: 'vp', refillItemId: 'r2', status: 'active' }] });
    const rev = { ...snap, items: [...snap.items].reverse(), variants: [...snap.variants].reverse(), optionValues: [...snap.optionValues].reverse(),
      packageRefills: [...snap.packageRefills].reverse(), stores: [{ ...snap.stores[0], offers: [...snap.stores[0].offers].reverse() }] };
    expect(proj(rev).menu).toEqual(proj(snap).menu);
  });
});

describe('S3 audit gaps: category edge cases, withdrawn basis, full-reversal hash', () => {
  const cat = (id: string, parentId: string | null, name = id, sortOrder = 1, status = 'active') => ({ id, name, parentId, sortOrder, status });
  const oneItemIn = (categoryId: string, categories: unknown[]) => {
    const snap = base({ categories });
    snap.items = snap.items.map((i: any) => ({ ...i, categoryId }));
    return snap;
  };
  const catIds = (p: any): string[] => p.menu.categories.map((c: any) => c.id);

  it('a category cycle A to B to A loses nothing and is deterministic under reversal', () => {
    const cats = [cat('A', 'B'), cat('B', 'A')];
    const snap = oneItemIn('A', cats);
    const p = proj(snap);
    expect([...catIds(p)].sort()).toEqual(['A', 'B']);
    expect(p.menu.items.length).toBe(4);
    expect(proj(oneItemIn('A', [...cats].reverse())).contentHash).toBe(p.contentHash);
  });
  it('a self-parent category appears once with its items', () => {
    const p = proj(oneItemIn('A', [cat('A', 'A')]));
    expect(catIds(p)).toEqual(['A']);
    expect(p.menu.items.length).toBe(4);
  });
  it('a category whose parent is missing is treated as a root and still appears', () => {
    const p = proj(oneItemIn('A', [cat('A', 'ghost')]));
    expect(catIds(p)).toEqual(['A']);
    expect(p.menu.items.length).toBe(4);
  });
  it('a parent with no appearing item of its own is still shown as the ancestor of one that has', () => {
    const p = proj(oneItemIn('C', [cat('G', null), cat('P', 'G'), cat('C', 'P')]));
    expect(catIds(p)).toEqual(['G', 'P', 'C']);
  });
  it('an online rule whose store basis is withdrawn is not offered: withdrawn', () => {
    const snap = base();
    snap.stores[0].offers.push(online('v1', { pricingMode: 'percent_markup', markupPercent: '10.0000', basis: { ...priceFixed(null), withdrawn: true } }));
    expect(chan(proj(snap), 'v1').online).toEqual({ orderable: false, notOffered: 'withdrawn' });
  });
  it('an item in a retired category is not projected (no dangling categoryId)', () => {
    const snap = base({ categories: [cat('c1', null), cat('c2', null, 'c2', 2, 'retired')] });
    snap.items[0].categoryId = 'c2';
    const p = proj(snap);
    expect(p.menu.items.map((i: any) => i.id)).not.toContain('i1');
    expect(catIds(p)).not.toContain('c2');
    for (const i of p.menu.items) expect(catIds(p)).toContain(i.categoryId);
  });
  it('an item whose category is absent is not projected', () => {
    const snap = base();
    snap.items[0].categoryId = 'ghost';
    const p = proj(snap);
    expect(p.menu.items.map((i: any) => i.id)).not.toContain('i1');
    for (const i of p.menu.items) expect(catIds(p)).toContain(i.categoryId);
  });
  it('reversing categories, optionValues, optionGroupLinks and optionGroups too gives the same hash', () => {
    const snap = base({
      categories: [cat('c1', null, 'Mains'), cat('c2', 'c1', 'Sub', 2)],
      optionGroupLinks: [
        { id: 'l1', optionGroupId: 'gA', menuItemId: 'i1', variantId: null, sortOrder: 2, status: 'active' },
        { id: 'l2', optionGroupId: 'gB', menuItemId: 'i1', variantId: null, sortOrder: 1, status: 'active' }],
    });
    snap.items[1].categoryId = 'c2';
    snap.optionValues.push({ id: 'o0', optionGroupId: 'gA', name: 'Aaa', sortOrder: 1, status: 'active' });
    snap.stores[0].optionOffers.push({ optionValueId: 'o0', channel: 'store', priceDelta: '0.00' });
    const rev = {
      ...snap, categories: [...snap.categories].reverse(), optionValues: [...snap.optionValues].reverse(),
      optionGroupLinks: [...snap.optionGroupLinks].reverse(), optionGroups: [...snap.optionGroups].reverse(),
      stores: [{ ...snap.stores[0], optionOffers: [...snap.stores[0].optionOffers].reverse() }],
    };
    expect(proj(rev).contentHash).toBe(proj(snap).contentHash);
  });
});
