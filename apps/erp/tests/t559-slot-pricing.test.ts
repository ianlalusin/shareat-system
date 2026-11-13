/**
 * T-559 R2 / R4 (TESTER, written before the code) - everywhere the tablet prices, it uses the daypart slot of the right INSTANT:
 *   - the menu picker prices and orders at NOW (`at`, injected here), and flips at 17:00 with no new menu and no network;
 *   - a pending line's display price is the slot at its own `addedAtDevice`, whatever time it is now (projectOrders);
 *   - the bill (projectBill) uses that same slot price, and the bundle's extra-head price, so the device total equals the server's;
 *   - a package whose window closed is ONE muted line, not a tile; a selected package whose window closed is cleared;
 *   - refills and flavours are NOT window-gated (T-510 R5).
 * docs/tasks/559-pos-offline-daypart-switch.md R2, R4. Every instant is Asia/Manila (UTC+8), Sunday 2026-11-01.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cartRows } from '@/app/pos/_orders/cart-sum';
import { closedPackages, closedPackagesText, displayUnitPrice, goneLines, orderableVariants, pickerCatalog, type PickerItem } from '@/app/pos/_orders/menu-filter';
import { projectOrders } from '@/app/pos/_orders/project';
import { projectBill } from '@/app/pos/_payment/bill';
import type { PosEvent } from '@/lib/pos-device';
import { DAYPARTED_MENU, DP, manila } from './helpers/t559-menu';
import { id, IDS, STANDS } from './helpers/t527-menu';

afterEach(() => {
  vi.useRealTimers();
});

const items = (at: Date, ctx: { packageOpen?: boolean; takeOut?: boolean } = {}) =>
  pickerCatalog(DAYPARTED_MENU, { packageOpen: ctx.packageOpen ?? false, ...(ctx.takeOut ? { takeOut: true } : {}), at }).flatMap((c) => c.items);
const itemOf = (at: Date, itemId: string): PickerItem | undefined => items(at).find((i) => i.id === itemId);
const priceOf = (item: PickerItem) => displayUnitPrice(orderableVariants(item)[0]!, [], item.when);

describe('T-559 R2 / T-527: the picker prices and orders at NOW, and flips at 17:00 with an injected clock', () => {
  it('the dayparted package costs the lunch price at 16:59 and the dinner price at 17:01 from the SAME cached menu', () => {
    expect(priceOf(itemOf(manila('16:59'), DP.pkgDay)!)).toBe('449.00');
    expect(priceOf(itemOf(manila('17:01'), DP.pkgDay)!)).toBe('549.00');
  });
  it('an a la carte item flips too: 100.00 at lunch, 150.00 at dinner, and again 100.00 after 08:00 the next morning', () => {
    expect([priceOf(itemOf(manila('16:59'), DP.dish)!), priceOf(itemOf(manila('17:01'), DP.dish)!), priceOf(itemOf(manila('08:01', '2026-11-02'), DP.dish)!)]).toEqual(['100.00', '150.00', '100.00']);
  });
  it('the boundary instant itself belongs to the NEW window (17:00 sharp is dinner)', () => {
    expect(priceOf(itemOf(manila('17:00'), DP.dish)!)).toBe('150.00');
  });
  it('a menu without slots is unchanged: the channel price at any time, `at` or not', () => {
    const plain = (at: Date) => pickerCatalog({ ...DAYPARTED_MENU, hours: undefined, items: DAYPARTED_MENU.items.map((i) => ({ ...i, variants: i.variants.map(({ slots: _s, ...v }) => v) })) }, { packageOpen: false, at }).flatMap((c) => c.items);
    expect(priceOf(plain(manila('03:00')).find((i) => i.id === DP.dish)!)).toBe('100.00');
    expect(priceOf(plain(manila('20:00')).find((i) => i.id === DP.dish)!)).toBe('100.00');
  });
  it('the items-so-far price follows the same clock', () => {
    const cart = [{ itemId: DP.dish, variantId: DP.dishV, qty: 2 }];
    expect(cartRows(cart, DAYPARTED_MENU, null, manila('16:59'))[0]).toMatchObject({ unit: '100.00', total: '200.00' });
    expect(cartRows(cart, DAYPARTED_MENU, null, manila('17:01'))[0]).toMatchObject({ unit: '150.00', total: '300.00' });
  });
});

describe('T-559 R2: a package whose window closed is ONE muted line; a selected package whose window closed is cleared', () => {
  it('at 16:59 the lunch-only package is a tile; at 17:01 it is no tile, and the one muted line names it and when it opens', () => {
    expect(itemOf(manila('16:59'), DP.pkgLunchOnly)).toMatchObject({ orderable: true });
    expect(itemOf(manila('17:01'), DP.pkgLunchOnly)).toBeUndefined();
    expect(closedPackages(DAYPARTED_MENU, manila('16:59'))).toEqual([]);
    expect(closedPackagesText(closedPackages(DAYPARTED_MENU, manila('16:59')))).toBeNull();
    const closed = closedPackages(DAYPARTED_MENU, manila('17:01'));
    expect(closed).toEqual([{ itemId: DP.pkgLunchOnly, name: 'Lunch Set', availableFrom: '08:00' }]);
    expect(closedPackagesText(closed)).toBe('Not available now: Lunch Set from 08:00');
  });
  it('two closed packages share ONE line', () => {
    expect(closedPackagesText([{ itemId: 'a', name: 'A', availableFrom: '17:00' }, { itemId: 'b', name: 'B', availableFrom: null }])).toBe('Not available now: A from 17:00, B');
  });
  it('a package sold out (withdrawn) is NOT a "closed" line: it stays a greyed "Sold out" tile', () => {
    // as the projection sends a sold-out dayparted variant: withdrawn rows are not slots (only the channel says "withdrawn")
    const menu = structuredClone(DAYPARTED_MENU);
    const v = menu.items.find((i) => i.id === DP.pkgDay)!.variants[0]!;
    v.channels.store = { orderable: false, notOffered: 'withdrawn' };
    delete v.slots;
    const tile = pickerCatalog(menu, { packageOpen: false, at: manila('12:00') }).flatMap((c) => c.items).find((i) => i.id === DP.pkgDay);
    expect(tile).toMatchObject({ orderable: false, label: 'Sold out' });
    expect(closedPackages(menu, manila('12:00'))).toEqual([]);
  });
  it('take-out lists no closed package either (a package cannot be sold there)', () => {
    expect(closedPackages(DAYPARTED_MENU, manila('17:01'), { takeOut: true })).toEqual([]);
  });
  it('goneLines: a selected package whose window just closed is returned for clearing; one still open, and any a la carte line, is not', () => {
    const cart = [{ itemId: DP.pkgLunchOnly, variantId: DP.pkgLunchOnlyV, qty: 1 }, { itemId: DP.dish, variantId: DP.dishV, qty: 1 }, { itemId: DP.pkgDay, variantId: DP.pkgDayV, qty: 1 }];
    expect(goneLines(cart, DAYPARTED_MENU, manila('16:59'))).toEqual([]);
    expect(goneLines(cart, DAYPARTED_MENU, manila('17:01'))).toEqual([cart[0]]);
  });
});

describe('T-559 R2 / T-510 R5: refills and flavours are NOT window-gated', () => {
  it('the picker never lists a refill, open or closed; a refill with a lunch-only slot is untouched by the clock', () => {
    for (const at of [manila('12:00'), manila('20:00')]) expect(items(at, { packageOpen: true }).map((i) => i.id)).not.toContain(DP.refill);
  });
  it('no refill or kitchen code reads a slot or the daypart resolver (a source guard: it stays that way)', () => {
    const dirs = ['../src/app/pos/_refills', '../src/app/pos/_kitchen'].map((d) => join(__dirname, d));
    const offenders: string[] = [];
    for (const dir of dirs) for (const f of readdirSync(dir)) {
      if (!/\.(ts|tsx)$/.test(f)) continue;
      const src = readFileSync(join(dir, f), 'utf8');
      if (/daypart-client|resolveSlot|\.slots\b|storeOfferAt/.test(src)) offenders.push(`${dir}/${f}`);
    }
    expect(offenders).toEqual([]);
  });
});

// ---- a pending line keeps the price of its OWN slot ----------------------------------------------------------------------------------------------------
const SESSION = id(700);
const PERSON = id(2);
const L = { dish1: id(710), dish2: id(711), bundle1: id(712), bundle2: id(713) };
const ev = (seq: number, kind: PosEvent['kind'], payload: Record<string, unknown>, at: Date): PosEvent => ({ seq, kind, personId: PERSON, occurredAtDevice: at.toISOString(), payload });
const line = (lineId: string, menuItemId: string, variantId: string, qty: number, at: Date) => ({ lineId, menuItemId, variantId, qty, addedAtDevice: at.toISOString() });
/** An offline table: opened at 16:58 with a dish added at 16:59, and the same dish added again at 17:01. */
const offlineDish = (): PosEvent[] => [
  ev(1, 'stand.opened', { sessionId: SESSION, mode: 'dine_in', standId: IDS.stand5, headsCashier: 2, openedAtDevice: manila('16:58').toISOString(), lines: [line(L.dish1, DP.dish, DP.dishV, 1, manila('16:59'))] }, manila('16:58')),
  ev(2, 'lines.added', { sessionId: SESSION, lines: [line(L.dish2, DP.dish, DP.dishV, 1, manila('17:01'))] }, manila('17:01')),
];
const view = (pending: PosEvent[]) => projectOrders({ openStands: null, sessions: {} }, pending, { stands: STANDS, menu: DAYPARTED_MENU });
const prices = (v: ReturnType<typeof view>) => Object.fromEntries(v.sessions[SESSION]!.lines.map((l) => [l.id, l.unitPrice]));

describe('T-559 R2 / T-527: a pending line shows the price of its addedAtDevice slot, whatever time it is now', () => {
  it('16:59 is priced at lunch and 17:01 at dinner', () => {
    expect(prices(view(offlineDish()))).toEqual({ [L.dish1]: '100.00', [L.dish2]: '150.00' });
  });
  it('the answer does not move with the wall clock: the same two prices at 12:00, at 17:30 and the next morning', () => {
    vi.useFakeTimers();
    const seen = [manila('12:00'), manila('17:30'), manila('09:00', '2026-11-02')].map((now) => {
      vi.setSystemTime(now);
      return prices(view(offlineDish()));
    });
    for (const p of seen) expect(p).toEqual({ [L.dish1]: '100.00', [L.dish2]: '150.00' });
  });
  it('a line whose slot cannot be told (no price for that minute) shows NO price: it is never guessed from the cached live price', () => {
    const menu = structuredClone(DAYPARTED_MENU);
    const slots = menu.items.find((i) => i.id === DP.dish)!.variants[0]!.slots!;
    menu.items.find((i) => i.id === DP.dish)!.variants[0]!.slots = slots.filter((s) => s.daypartId === DP.lunch); // no dinner slot at all
    const v = projectOrders({ openStands: null, sessions: {} }, offlineDish(), { stands: STANDS, menu });
    expect(Object.fromEntries(v.sessions[SESSION]!.lines.map((l) => [l.id, l.unitPrice]))).toEqual({ [L.dish1]: '100.00', [L.dish2]: null });
  });
});

describe('T-559 R2 / T-528: the bill uses each pending line\'s slot price, bundle and extra-head price included', () => {
  const bill = (pending: PosEvent[]) => {
    const v = view(pending);
    const extraIds = Object.fromEntries(v.sessions[SESSION]!.lines.map((l) => [l.id, `extra-of-${l.id}`]));
    return projectBill({ sessionId: SESSION, view: v.sessions[SESSION], body: undefined, pending, menu: DAYPARTED_MENU, presets: [], extraIds });
  };
  it('two dishes: 100.00 and 150.00', () => {
    const b = bill(offlineDish());
    expect(b.problem).toBeNull();
    expect(b.lines.map((l) => [l.lineId, l.unitPrice])).toEqual([[L.dish1, '100.00'], [L.dish2, '150.00']]);
  });
  it('a bundle of 6 sold to 8 heads: the flat price and the extra-head price of the slot it was ADDED in', () => {
    const open = (at: Date, lineId: string) => [ev(1, 'stand.opened', { sessionId: SESSION, mode: 'dine_in', standId: IDS.stand5, headsCashier: 8, openedAtDevice: at.toISOString(), lines: [line(lineId, DP.bundle, DP.bundleV, 8, at)] }, at)];
    const day = bill(open(manila('16:59'), L.bundle1));
    expect(day.problem).toBeNull();
    expect(day.lines.map((l) => [l.name.startsWith('Party Bundle'), l.qty, l.unitPrice])).toEqual([[true, 1, '1999.00'], [true, 2, '300.00']]);
    const night = bill(open(manila('17:01'), L.bundle2));
    expect(night.lines.map((l) => [l.qty, l.unitPrice])).toEqual([[1, '2399.00'], [2, '400.00']]);
  });
  it('the old behaviour is gone: both lines are NOT priced from the cached live (lunch) price', () => {
    const b = bill(offlineDish());
    expect(b.lines.find((l) => l.lineId === L.dish2)!.unitPrice).not.toBe('100.00');
  });
  it('a pending line with no price for its minute stops the bill (Pay stays off) instead of billing a guess', () => {
    const menu = structuredClone(DAYPARTED_MENU);
    menu.items.find((i) => i.id === DP.dish)!.variants[0]!.slots = menu.items.find((i) => i.id === DP.dish)!.variants[0]!.slots!.filter((s) => s.daypartId === DP.lunch);
    const pending = offlineDish();
    const v = projectOrders({ openStands: null, sessions: {} }, pending, { stands: STANDS, menu });
    const b = projectBill({ sessionId: SESSION, view: v.sessions[SESSION], body: undefined, pending, menu, presets: [], extraIds: {} });
    expect(b.problem).toMatch(/price/i);
  });
});
