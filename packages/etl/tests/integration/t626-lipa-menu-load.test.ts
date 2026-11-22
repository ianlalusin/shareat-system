/**
 * T-626 (TESTER) - copy a store's menu, kitchen, hours and payment methods from POS v1, then prove POS v2 reads them. docs/tasks/626-lipa-pos-setup-from-v1.md.
 *
 *   packages/etl/src/pos-v2/load-store-setup.ts   loadStoreSetup(...) with a source that has readMenu(): the menu part of the report
 *   packages/etl/src/pos-v2/check-store-setup.ts  checkStoreSetup(tx, { orgId, storeId, now? }, source) -> { ok, rows, notes }
 * The v1 source is a FAKE holding a made-up small Lipa (no Firestore is touched). Raw SQL builds the world (the POS t525 fixture), so the DATABASE is the oracle.
 * The fixture already has a "Grill" station, a "Cola" at 80.00 and tenders "Cash" and "GCash" with no v1 name: the load meets them, as it will meet what was typed by hand.
 * Runs on any `_test` database.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { buildPosSnapshot, loadStoreMenu } from '@shareat/domain';
import { asOrg, closeAll, fixture, RATES, sql, type Fx } from '../../../domain/tests/integration/_fixtures/t525-pos';
import { superAdminOf } from '../../../domain/tests/integration/_fixtures/t626-super-admin';
import { checkStoreSetup, formatStoreSetupCheck } from '../../src/pos-v2/check-store-setup';
import { formatStoreSetupReport, loadStoreSetup, type V1MenuSetup, type V1StoreSetupSource } from '../../src/pos-v2/load-store-setup';

afterAll(closeAll);

const ALL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pkg = (id: string, name: string, price: number, o: Record<string, unknown> = {}) => ({
  id, name, isEnabled: true, pricePerHead: price, stationId: 'st-grill', refillIds: [] as string[], sortOrder: 1, scheduleId: null as string | null,
  isBundle: false, bundlePrice: null, bundleMaxCap: null, bundleExtraHeadPrice: null, ...o,
});

/** A realistic small Lipa: lunch and dinner copies, one price twice (all day), a bundle, a disabled promo, refills with flavours, add-ons, payment methods. */
const lipa = (o: Partial<V1MenuSetup> = {}): V1MenuSetup => ({
  stations: [
    { id: 'st-grill', name: 'Grill', sortOrder: 1, isActive: true, slaMinutes: null, printOnOutage: false },
    { id: 'st-drinks', name: 'Drinks', sortOrder: 2, isActive: true, slaMinutes: 10, printOnOutage: true },
    { id: 'st-old', name: 'Old Bar', sortOrder: 3, isActive: false, slaMinutes: null, printOnOutage: false },
  ],
  schedules: [
    { id: 'sc-lunch', name: 'Lunch', isActive: true, isArchived: false, days: ALL_DAYS, startTime: '08:00', endTime: '17:00' },
    { id: 'sc-dinner', name: 'Dinner', isActive: true, isArchived: false, days: ALL_DAYS, startTime: '17:00', endTime: '08:00' },
  ],
  packages: [
    pkg('p1', 'LT-Pork and Beef', 399, { scheduleId: 'sc-lunch', refillIds: ['r-pork', 'r-rice'] }),
    pkg('p2', 'DT_Pork and Beef', 449, { scheduleId: 'sc-dinner', refillIds: ['r-pork', 'r-rice'] }),
    pkg('p3', 'LT-Pork and Chicken', 298, { scheduleId: 'sc-lunch' }),
    pkg('p4', 'DT-Pork and Chicken', 298, { scheduleId: 'sc-dinner' }),
    pkg('p5', 'Barkada', 0, { isBundle: true, bundlePrice: 1499, bundleMaxCap: 4, bundleExtraHeadPrice: 349, pricePerHead: null, stationId: 'st-grill' }),
    pkg('p6', 'Valentine Promo', 499, { isEnabled: false }),
  ],
  refills: [
    { id: 'r-pork', name: 'Pork Meat Refill', isEnabled: true, isOther: false, sortOrder: 1, stationId: 'st-grill', globallyActive: true, requiresFlavor: true, allowedFlavorIds: [] },
    { id: 'r-rice', name: 'Plain Rice Refill', isEnabled: true, isOther: true, sortOrder: 2, stationId: 'st-grill', globallyActive: true, requiresFlavor: false, allowedFlavorIds: [] },
    { id: 'r-old', name: 'Old Refill', isEnabled: false, isOther: false, sortOrder: 3, stationId: null, globallyActive: true, requiresFlavor: false, allowedFlavorIds: [] },
  ],
  flavors: [
    { id: 'f-garlic', name: 'Garlic', isEnabled: true, sortOrder: 1, globallyActive: true },
    { id: 'f-spicy', name: 'Spicy', isEnabled: true, sortOrder: 2, globallyActive: true },
    { id: 'f-teri', name: 'Teriyaki', isEnabled: false, sortOrder: 3, globallyActive: true },
  ],
  items: [
    { name: 'Charcoal', groupName: null, variantLabel: null, kind: 'single', subCategory: null, sellingPrice: 120, isActive: true, isArchived: false, isAddon: false, stationId: null, customerEnabled: false, hasModifiers: false },
    { name: 'Iced Tea Glass', groupName: 'Iced Tea', variantLabel: 'Glass', kind: 'variant', subCategory: 'Drinks Menu', sellingPrice: 50, isActive: true, isArchived: false, isAddon: true, stationId: 'st-drinks', customerEnabled: true, hasModifiers: false },
    { name: 'Iced Tea Pitcher', groupName: 'Iced Tea', variantLabel: 'Pitcher', kind: 'variant', subCategory: 'Drinks Menu', sellingPrice: 150, isActive: true, isArchived: false, isAddon: true, stationId: 'st-drinks', customerEnabled: true, hasModifiers: false },
    { name: 'Halo-halo', groupName: null, variantLabel: null, kind: 'single', subCategory: null, sellingPrice: 95, isActive: true, isArchived: false, isAddon: true, stationId: 'st-drinks', customerEnabled: false, hasModifiers: true },
  ],
  payModes: [
    { name: 'Cash', type: 'cash', isActive: true, isArchived: false },
    { name: 'GCash', type: 'online', isActive: true, isArchived: false },
  ],
  charges: [{ name: 'Service charge', isActive: true }],
  ...o,
});
const source = (menu: V1MenuSetup): V1StoreSetupSource => ({ listTables: async () => [], listDiscounts: async () => [], listGlobalDiscounts: async () => [], readMenu: async () => menu });

const world = async () => {
  const f = await fixture();
  return { f, sa: await superAdminOf(f) };
};
const load = (f: Fx, sa: Awaited<ReturnType<typeof superAdminOf>>, menu: V1MenuSetup, dryRun = false) =>
  asOrg(f.orgId, (tx) => loadStoreSetup(tx, sa, { storeId: f.storeId, dryRun }, source(menu)));
const check = (f: Fx, menu: V1MenuSetup, now?: Date) => asOrg(f.orgId, (tx) => checkStoreSetup(tx, { orgId: f.orgId, storeId: f.storeId, now, deps: RATES }, source(menu)));
/** A moment a few days ahead at `hhmm` Manila time: after every row the test writes, so the menu is read as it will be at lunch or dinner. */
const manila = (hhmm: string): Date => new Date(`${new Date(Date.now() + 4 * 86400e3 + 8 * 3600e3).toISOString().slice(0, 10)}T${hhmm}:00+08:00`);

const TABLES = ['menu_items', 'menu_item_variants', 'menu_offers', 'menu_option_offers', 'menu_option_values', 'menu_option_groups', 'menu_option_group_links', 'menu_package_refills', 'menu_depletion_rules', 'menu_dayparts', 'menu_categories', 'kitchen_stations', 'kitchen_routes', 'tenders', 'audit_log'];
const counts = async (f: Fx) => {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = (await sql.unsafe(`select count(*)::int n from ${t} where org_id = '${f.orgId}'`))[0]!.n;
  return out;
};
const priceNow = async (f: Fx, at: Date, name: string): Promise<string | null> => {
  const m = (await asOrg(f.orgId, (tx) => loadStoreMenu(tx, f.orgId, f.storeId, at))).menu;
  const v = m.items.find((i) => i.name === name)?.variants[0];
  return v?.channels.store.orderable ? v.channels.store.amount : null;
};

describe('the loader, menu part', () => {
  it('a DRY RUN reports what a real run would create and writes nothing', async () => {
    const { f, sa } = await world();
    const before = await counts(f);
    const r = await load(f, sa, lipa(), true);
    expect(r.menu!.created.packages).toEqual(['Pork and Beef', 'Pork and Chicken', 'Barkada']);
    expect(await counts(f)).toEqual(before);
    expect(formatStoreSetupReport(r).join('\n')).toMatch(/packages would be created: 3/);
  });

  it('first run creates everything; a second run writes nothing; a hand-set price is a DIFFERENCE and is not overwritten', async () => {
    const { f, sa } = await world();
    const first = await load(f, sa, lipa());
    const m = first.menu!;
    expect(m.created.stations).toEqual(['Drinks']); // Grill was already there and matches
    expect(m.created.hours).toEqual(['Lunch 08:00-17:00', 'Dinner 17:00-08:00']);
    expect(m.created.packages).toEqual(['Pork and Beef', 'Pork and Chicken', 'Barkada']);
    expect(m.created.refills).toEqual(['Pork Meat Refill', 'Plain Rice Refill']);
    expect(m.created.items).toEqual(['Iced Tea', 'Iced Tea Glass', 'Iced Tea Pitcher', 'Halo-halo']);
    expect(m.created.prices).toContain('Pork and Beef Lunch ₱399.00');
    expect(m.created.prices).toContain('Pork and Beef Dinner ₱449.00');
    expect(m.created.prices).toContain('Pork and Chicken all day ₱298.00'); // two copies at one price are one all-day price
    expect(m.created.prices).toContain('Barkada all day ₱1499.00');
    expect(m.created['payment methods']).toEqual(['Cash: v1 name filled in', 'GCash: v1 name filled in']);
    expect(m.created['refill links']).toEqual(['Pork and Beef: 2 refills', 'Pork and Chicken: 2 refills', 'Barkada: 2 refills']);
    expect(m.created.flavours).toContain('Flavour linked to Pork Meat Refill');
    expect(m.skipped.some((s) => s.startsWith('Package Valentine Promo'))).toBe(true);
    expect(m.noStockRule).toContain('Barkada');
    expect(m.notCopied.join(' ')).toMatch(/Service charge/);
    expect(m.differences.join('\n')).not.toMatch(/Pork and Beef/);
    expect(formatStoreSetupReport(first).join('\n') + JSON.stringify(first)).not.toMatch(/st-grill|st-drinks|sc-lunch|sc-dinner|r-pork|f-garlic|"p[1-6]"/); // no v1 document id is ever printed

    const mid = await counts(f);
    const second = await load(f, sa, lipa());
    expect(Object.values(second.menu!.created).flat()).toEqual([]);
    expect(second.menu!.refused).toEqual([]);
    expect(await counts(f)).toEqual(mid);
  });

  it('a value someone already set (Cola 80.00, v1 says 60) is reported as a difference and left alone', async () => {
    const { f, sa } = await world();
    const withCola = lipa({ items: [...lipa().items, { name: 'Cola', groupName: null, variantLabel: null, kind: 'single', subCategory: null, sellingPrice: 60, isActive: true, isArchived: false, isAddon: true, stationId: 'st-grill', customerEnabled: true, hasModifiers: false }] });
    const r = await load(f, sa, withCola);
    expect(r.menu!.differences).toEqual(['Cola (all day): ₱60.00 in v1, ₱80.00 here']);
    const rows = await sql<{ amount: string }[]>`select o.amount::text from menu_offers o where o.variant_id = ${f.menu.cola.variantId}`;
    expect(rows).toEqual([{ amount: '80.00' }]); // no new row, no overwrite
    expect(formatStoreSetupReport(r).join('\n')).toMatch(/Cola \(all day\): ₱60.00 in v1, ₱80.00 here/);
  });

  it('a wallet payment method with no matching tender is listed (it needs a money account), never invented; a cash one is made', async () => {
    const { f, sa } = await world();
    const menu = lipa({ payModes: [{ name: 'Cash', type: 'cash', isActive: true, isArchived: false }, { name: 'QRPH', type: 'online', isActive: true, isArchived: false }, { name: 'Petty', type: 'cash', isActive: true, isArchived: false }] });
    const r = await load(f, sa, menu);
    expect(r.menu!.walletsNeedAccount).toEqual(['QRPH']);
    expect(r.menu!.created['payment methods']).toEqual(['Cash: v1 name filled in', 'Petty']);
    expect((await sql`select 1 from tenders where store_id = ${f.storeId} and name = 'QRPH'`).length).toBe(0);
  });
});

describe('the parity check', () => {
  it('is green right after a load, at lunch and at dinner', async () => {
    const { f, sa } = await world();
    const menu = lipa();
    await load(f, sa, menu);
    for (const at of [manila('12:00'), manila('18:00')]) {
      const c = await check(f, menu, at);
      expect(c.rows.filter((r) => !r.ok)).toEqual([]);
      expect(c.ok).toBe(true);
    }
  });

  it('one missing refill link fails the check and names it', async () => {
    const { f, sa } = await world();
    const menu = lipa();
    await load(f, sa, menu);
    await sql`
      delete from menu_package_refills where package_variant_id = (select v.id from menu_item_variants v join menu_items i on i.id = v.menu_item_id where i.org_id = ${f.orgId} and i.name = 'Pork and Beef')
        and refill_item_id = (select id from menu_items where org_id = ${f.orgId} and name = 'Pork Meat Refill')`;
    const c = await check(f, menu, manila('12:00'));
    expect(c.ok).toBe(false);
    const gap = c.rows.filter((r) => !r.ok);
    expect(gap.map((r) => `${r.kind}: ${r.name}`)).toEqual(['Package: Pork and Beef']);
    expect(gap[0]!.detail).toBe('refill link to Pork Meat Refill missing');
  });

  it('a price or a station that differs fails it too, and so does a v1 payment method with no tender here', async () => {
    const { f, sa } = await world();
    const menu = lipa();
    await load(f, sa, menu);
    const dearer = lipa({ packages: lipa().packages.map((p) => (p.id === 'p5' ? { ...p, bundlePrice: 1599 } : p)), payModes: [...lipa().payModes, { name: 'Bank Transfer', type: 'other', isActive: true, isArchived: false }] });
    const c = await check(f, dearer, manila('12:00'));
    const gaps = c.rows.filter((r) => !r.ok).map((r) => `${r.kind}: ${r.name}`);
    expect(gaps).toEqual(['Package: Barkada', 'Payment method: Bank Transfer', 'Tablet menu: package: Barkada']);
  });

  it('builds the real tablet snapshot when the store has a paired till, and checks the payment methods and stands in it', async () => {
    const { f, sa } = await world();
    const menu = lipa();
    await load(f, sa, menu);
    const c = await asOrg(f.orgId, (tx) => checkStoreSetup(tx, { orgId: f.orgId, storeId: f.storeId, deps: RATES }, source(menu)));
    expect(c.rows.filter((r) => !r.ok)).toEqual([]);
    expect(c.rows.some((r) => r.kind === 'Tablet snapshot' && r.name === 'stands')).toBe(true);
    expect(c.rows.some((r) => r.kind === 'Tablet snapshot' && r.name === 'payment method GCash')).toBe(true);
  });
});

describe('the menu POS v2 serves', () => {
  it('a copied package carries the lunch price at 12:00 and the dinner price at 18:00, an all-day one both times, and has a kitchen route', async () => {
    const { f, sa } = await world();
    await load(f, sa, lipa());
    expect(await priceNow(f, manila('12:00'), 'Pork and Beef')).toBe('399.00');
    expect(await priceNow(f, manila('18:00'), 'Pork and Beef')).toBe('449.00');
    expect(await priceNow(f, manila('12:00'), 'Pork and Chicken')).toBe('298.00');
    expect(await priceNow(f, manila('18:00'), 'Pork and Chicken')).toBe('298.00');
    const menu = (await asOrg(f.orgId, (tx) => loadStoreMenu(tx, f.orgId, f.storeId, manila('12:00')))).menu;
    const beef = menu.items.find((i) => i.name === 'Pork and Beef')!;
    expect(beef.stationId).not.toBeNull();
    expect(menu.notOnPos.map((n) => n.name)).not.toContain('Pork and Beef');
    expect(beef.variants[0]!.refillItemIds).toHaveLength(2);
    // The refill that needs a flavour offers the two flavours the store has on, and not the one it switched off.
    const pork = menu.items.find((i) => i.name === 'Pork Meat Refill')!;
    const flavours = pork.variants[0]!.optionGroups.flatMap((g) => g.values).filter((v) => v.channels.store.orderable).map((v) => v.name);
    expect(flavours).toEqual(['Garlic', 'Spicy']);
  });

  it('the real snapshot the tablet fetches carries the package, orderable, at one of its two prices', async () => {
    const { f, sa } = await world();
    await load(f, sa, lipa());
    const snap = await asOrg(f.orgId, (tx) => buildPosSnapshot(tx, { pairing: { pairingId: f.pairingId, orgId: f.orgId, storeId: f.storeId } }, RATES));
    const beef = snap.body.menu.menu.items.find((i) => i.name === 'Pork and Beef')!;
    const offer = beef.variants[0]!.channels.store;
    expect(offer.orderable && ['399.00', '449.00'].includes(offer.amount ?? '')).toBe(true);
    expect(snap.body.menu.menu.items.some((i) => i.name === 'Iced Tea' && i.variants.length >= 2)).toBe(true);
  });
});

// T-626 audit fixes (BOSS rulings). Not run on the builder's PC (no database): CI runs them.
describe('audit fixes', () => {
  it('ruling 3: a grouped item keeps no unlabelled default; its variants are exactly Glass and Pitcher, both priced', async () => {
    const { f, sa } = await world();
    await load(f, sa, lipa());
    const rows = await sql<{ label: string | null; is_default: boolean; amount: string | null }[]>`
      select v.label, v.is_default, (select min(o.amount)::text from menu_offers o where o.variant_id = v.id and not o.withdrawn) as amount
        from menu_item_variants v join menu_items i on i.id = v.menu_item_id
       where i.org_id = ${f.orgId} and i.name = 'Iced Tea' and v.status = 'active' order by v.label`;
    expect(rows).toEqual([{ label: 'Glass', is_default: true, amount: '50.00' }, { label: 'Pitcher', is_default: false, amount: '150.00' }]);
  });

  it('ruling 4: a package that already has its own refill list keeps it; the v1 extras are a difference and the check fails on them', async () => {
    const { f, sa } = await world();
    const riceOnly = lipa({ packages: lipa().packages.map((p) => (p.id === 'p1' || p.id === 'p2' ? { ...p, refillIds: ['r-rice'] } : p)) });
    await load(f, sa, riceOnly);
    const r = await load(f, sa, lipa());
    expect(r.menu!.differences).toContain("Pork and Beef: v1 also allows Pork Meat Refill; this package already has its own refill list here, so they were not added");
    expect(r.menu!.created['refill links']).toEqual([]);
    const c = await check(f, lipa(), manila('12:00'));
    expect(c.rows.filter((x) => !x.ok).map((x) => `${x.kind}: ${x.name}: ${x.detail}`)).toEqual(['Package: Pork and Beef: refill link to Pork Meat Refill missing']);
  });

  it('rulings 1 and 5: a package with no usable price and an item whose station is switched off are GAPS in the check', async () => {
    const { f, sa } = await world();
    const menu = lipa({
      packages: [...lipa().packages, pkg('p7', 'Mystery Box', 0)],
      items: [...lipa().items, { name: 'Bar Snack', groupName: null, variantLabel: null, kind: 'single', subCategory: null, sellingPrice: 70, isActive: true, isArchived: false, isAddon: true, stationId: 'st-old', customerEnabled: false, hasModifiers: false }],
    });
    await load(f, sa, menu);
    const c = await check(f, menu, manila('12:00'));
    expect(c.ok).toBe(false);
    expect(c.rows.filter((x) => !x.ok && x.kind === 'Not loadable from v1').map((x) => x.name)).toEqual([
      'Package Mystery Box (no usable price in v1)',
      'Item Bar Snack: no kitchen station in v1 (its station Old Bar is switched off), so it has no route',
    ]);
  });

  it('ruling 6: a package on hours switched off in v1 is not loaded and is a NOTE; rulings 2 and 7: unused hours are not made, empty refill lists are noted', async () => {
    const { f, sa } = await world();
    const menu = lipa({
      schedules: [...lipa().schedules, { id: 'sc-late', name: 'Late Night', isActive: false, isArchived: false, days: ALL_DAYS, startTime: '22:00', endTime: '02:00' }, { id: 'sc-bfast', name: 'Breakfast', isActive: true, isArchived: false, days: ALL_DAYS, startTime: '06:00', endTime: '08:00' }],
      packages: [...lipa().packages, pkg('p8', 'Late Promo', 199, { scheduleId: 'sc-late' })],
    });
    const r = await load(f, sa, menu);
    expect(r.menu!.created.packages).toEqual(['Pork and Beef', 'Pork and Chicken', 'Barkada']);
    expect(r.menu!.created.hours).toEqual(['Lunch 08:00-17:00', 'Dinner 17:00-08:00']);
    expect(r.menu!.notes).toEqual([
      'Package Late Promo: not on sale in v1 (its hours are off)',
      "Package Pork and Chicken: v1 lists no refills for it, so it gets every enabled refill (as v1's cashier screen)",
      "Package Barkada: v1 lists no refills for it, so it gets every enabled refill (as v1's cashier screen)",
    ]);
    const c = await check(f, menu, manila('12:00'));
    expect(c.rows.filter((x) => !x.ok)).toEqual([]);
    expect(formatStoreSetupCheck(c).join('\n')).toMatch(/NOTE Package Late Promo: not on sale in v1 \(its hours are off\)/);
  });
});
