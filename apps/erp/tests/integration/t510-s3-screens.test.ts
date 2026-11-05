import { afterAll, describe, expect, it, vi } from 'vitest';

import { createDaypart, setMenuOffer } from '@shareat/domain';
import { asOrg, cast, expectAccessRefused, expectSentenceError, fd, plain, rawItem, rawRule, render, run, sql, type Cast } from './t401-s4-common';

/**
 * T-510 S3 - the ERP screens for menu dayparts: /menu/prices (When, Lunch and Dinner side by side, not offered now, fault flag, who sees
 * pairing controls) and /admin/stores/[id] (lunch and dinner hours). docs/tasks/510-menu-dayparts.md R8, R9.
 * No test depends on which hour it runs in: Lunch is the 12 hours around the current Manila hour and Dinner the other 12, so exactly one holds now
 * and the other opens six hours from now, whatever the clock says (crossing the top of the hour mid-test moves neither). A window on a weekday two days
 * ahead is never open and always more than a day away, which is the "from Monday 10:00" case.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', async () => (await import('./t401-s4-common')).sessionMock());
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

const PRICES = () => import('../../src/app/menu/prices/actions');
const STORES = () => import('../../src/app/admin/stores/actions');
const PRICES_PAGE = () => import('../../src/app/menu/prices/page');
const STORE_PAGE = () => import('../../src/app/admin/stores/[id]/page');
const HOURS_PAGE = () => import('../../src/app/menu/hours/page');
const STORES_LIB = () => import('../../src/app/admin/stores/lib');

const p2 = (n: number) => String(((n % 24) + 24) % 24).padStart(2, '0');
const manilaHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
const LUNCH = { start: `${p2(manilaHour - 6)}:00`, end: `${p2(manilaHour + 6)}:00` };
const DINNER = { start: `${p2(manilaHour + 6)}:00`, end: `${p2(manilaHour - 6)}:00` };
const manilaDow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', weekday: 'short' }).format(new Date()));
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

async function world(hint: string) {
  const c = await cast(`s3-${hint}`);
  const lunch = (await asOrg(c.orgId, (tx) => createDaypart(c.admin, { storeId: c.storeA, name: 'Lunch', days: ALL_DAYS, ...LUNCH }, tx))).id;
  const dinner = (await asOrg(c.orgId, (tx) => createDaypart(c.admin, { storeId: c.storeA, name: 'Dinner', days: ALL_DAYS, ...DINNER }, tx))).id;
  return { c, lunch, dinner };
}
async function pkg(c: Cast, name: string) {
  const it = await rawItem(c, 'package', `${name} ${Math.random().toString(36).slice(2, 7)}`);
  await rawRule(c, it.variantId);
  return it.variantId;
}
const price = (c: Cast, variantId: string, daypartId: string | null, amount: string) =>
  asOrg(c.orgId, (tx) => setMenuOffer(c.superAdmin, { storeId: c.storeA, variantId, channel: 'store', amount, daypartId }, tx));
const rows = (variantId: string) =>
  sql<{ daypart_id: string | null; amount: string | null; withdrawn: boolean }[]>`
    select daypart_id, amount::text as amount, withdrawn from menu_offers where variant_id = ${variantId} order by created_at, id`;

describe('a store with no dayparts looks exactly as before', () => {
  it('shows the plain price and none of the lunch-and-dinner words or controls', async () => {
    const c = await cast('s3-plain');
    const v = await pkg(c, 'Plain');
    const out = await run(PRICES, 'setPriceAction', c.manager, fd({ storeId: c.storeB, variantId: v, channel: 'store', amount: '85.50' }));
    expect(out.flash.ok).toBe('Price saved.');
    for (const who of [c.manager, c.superAdmin]) {
      const html = await render(PRICES_PAGE, who, { search: { store: c.storeB } });
      const t = plain(html);
      expect(t).toContain('85.50');
      expect(html).not.toContain('name="daypartId"');
      expect(t).not.toMatch(/When|Lunch|Dinner|Not offered now|Only a super admin/);
      expect(html).toContain('Withdraw');
    }
  });
});

describe('Lunch and Dinner side by side', () => {
  it('shows every window with its price, marks the one on now, says when a dinner-only package opens, and keeps pairing for the super admin', async () => {
    const w = await world('side');
    const both = await pkg(w.c, 'Pork and Beef');
    await price(w.c, both, w.lunch, '338.00');
    await price(w.c, both, w.dinner, '358.00');
    const dinnerOnly = await pkg(w.c, 'Dinner Special');
    await price(w.c, dinnerOnly, w.dinner, '258.00');
    // a window on a weekday two days ahead: closed now and more than a day away, so the line names the weekday
    const aheadDow = (manilaDow + 2) % 7;
    const brunch = (await asOrg(w.c.orgId, (tx) => createDaypart(w.c.admin, { storeId: w.c.storeA, name: 'Brunch', days: [aheadDow], start: '10:00', end: '12:00' }, tx))).id;
    const brunchOnly = await pkg(w.c, 'Brunch Special');
    await price(w.c, brunchOnly, brunch, '228.00');

    const sa = await render(PRICES_PAGE, w.c.superAdmin, { search: { store: w.c.storeA } });
    const t = plain(sa);
    expect(t).toMatch(/Lunch .*338\.00/);
    expect(t).toMatch(/Dinner .*358\.00/);
    expect(t).toContain(`${LUNCH.start} to ${LUNCH.end}`);
    expect(t).toContain('On now');
    expect(t).toContain(`Not offered now, from ${DINNER.start}`);
    expect(t).toContain(`Not offered now, from ${DAY_NAMES[aheadDow]} 10:00`);
    // super admin: the When select (All day + both windows) and the slot Withdraw controls
    expect(sa).toMatch(/<select[^>]*name="daypartId"/);
    expect(t).toContain('All day');
    expect(sa).toContain('aria-label="Withdraw the Lunch price"');
    expect(t).not.toContain('Only a super admin can change which prices belong to lunch or dinner');
    // 'Change price' exists for the slot and posts that slot's daypart
    expect(sa).toContain(`name="daypartId" value="${w.lunch}"`);

    const mg = await render(PRICES_PAGE, w.c.manager, { search: { store: w.c.storeA } });
    const mt = plain(mg);
    expect(mt).toMatch(/Lunch .*338\.00/);
    expect(mt).toMatch(/Dinner .*358\.00/);
    // manager: may change a slot's price, but no When select, no slot withdraw, and the one-line note
    expect(mg).toContain('aria-label="Change price"');
    expect(mg).not.toMatch(/<select[^>]*name="daypartId"/);
    expect(mg).not.toContain('aria-label="Withdraw the Lunch price"');
    expect(mt).toContain('Only a super admin can change which prices belong to lunch or dinner');
  });

  it('the actions pass the daypart: a manager re-prices a slot; a manager cannot create, re-link or withdraw one; a super admin can', async () => {
    const w = await world('act');
    const v = await pkg(w.c, 'Triple Feast');
    await price(w.c, v, w.lunch, '358.00');
    const form = (extra: Record<string, string>) => fd({ storeId: w.c.storeA, variantId: v, channel: 'store', ...extra });

    const change = await run(PRICES, 'setPriceAction', w.c.managerA, form({ daypartId: w.lunch, amount: '360.00' }));
    expect(change.flash.error).toBeUndefined();
    expect(change.flash.ok).toBe('Price saved.');
    expect((await rows(v)).at(-1)).toMatchObject({ daypart_id: w.lunch, amount: '360.00' });

    const before = (await rows(v)).length;
    const create = await run(PRICES, 'setPriceAction', w.c.managerA, form({ daypartId: w.dinner, amount: '380.00' }));
    expectSentenceError(create.flash.error, 'manager creating a pairing');
    const wd = await run(PRICES, 'withdrawPriceAction', w.c.managerA, form({ daypartId: w.lunch }));
    expectSentenceError(wd.flash.error, 'manager withdrawing a slot');
    expect((await rows(v)).length, 'a refused write wrote nothing').toBe(before);

    const add = await run(PRICES, 'setPriceAction', w.c.superAdmin, form({ daypartId: w.dinner, amount: '380.00' }));
    expect(add.flash.error).toBeUndefined();
    expect((await rows(v)).at(-1)).toMatchObject({ daypart_id: w.dinner, amount: '380.00' });
    const gone = await run(PRICES, 'withdrawPriceAction', w.c.superAdmin, form({ daypartId: w.dinner }));
    expect(gone.flash.ok).toBe('Price withdrawn.');
    expect((await rows(v)).at(-1)).toMatchObject({ daypart_id: w.dinner, withdrawn: true });
  });
});

describe('a price that cannot be resolved shows a red flag, never a price', () => {
  it('an unusable store time zone gives a sentence and no amount', async () => {
    const w = await world('fault');
    const v = await pkg(w.c, 'Seafood Cruise');
    await price(w.c, v, w.lunch, '411.00');
    await sql`update stores set timezone = 'Nowhere/Land' where id = ${w.c.storeA}`;
    const html = await render(PRICES_PAGE, w.c.superAdmin, { search: { store: w.c.storeA } });
    const t = plain(html);
    expect(t).toContain('Check this price');
    expect(t).toMatch(/time zone cannot be read, so no price can be shown/);
    expect(t).not.toContain('411.00');
  });
});

describe('/admin/stores/[id]: lunch and dinner hours', () => {
  it('an admin adds, edits and retires hours; the list shows overnight in words; a live price blocks the retire in a sentence', async () => {
    const c = await cast('s3-hours');
    const f = (extra: Record<string, string | string[]>) => fd({ storeId: c.storeA, ...extra });
    const add = await run(STORES, 'createDaypartAction', c.admin, f({ name: 'Dinner', days: ['0', '1', '2', '3', '4', '5', '6'], start: '17:00', end: '08:00' }));
    expect(add.flash.error).toBeUndefined();
    const [d] = await sql<{ id: string }[]>`select id from menu_dayparts where store_id = ${c.storeA} and name = 'Dinner'`;
    const page = plain(await render(STORE_PAGE, c.admin, { params: { id: c.storeA } }));
    expect(page).toContain('Lunch and dinner hours');
    expect(page).toContain('Dinner 17:00 to 08:00 next day Every day');

    const edit = await run(STORES, 'updateDaypartAction', c.admin, f({ daypartId: d!.id, name: 'Late dinner', days: ['5', '6'], start: '18:00', end: '02:00' }));
    expect(edit.flash.ok).toBe('Hours saved.');
    const [row] = await sql<{ name: string; days: number[]; start_time: string; end_time: string }[]>`
      select name, days, start_time::text, end_time::text from menu_dayparts where id = ${d!.id}`;
    expect(row).toMatchObject({ name: 'Late dinner', days: [5, 6], start_time: '18:00:00', end_time: '02:00:00' });

    const v = await pkg(c, 'Pork and Chicken');
    await asOrg(c.orgId, (tx) => setMenuOffer(c.superAdmin, { storeId: c.storeA, variantId: v, channel: 'store', amount: '298.00', daypartId: d!.id }, tx));
    const blocked = await run(STORES, 'retireDaypartAction', c.admin, f({ daypartId: d!.id }));
    expectSentenceError(blocked.flash.error, 'retire with a live price');
    expect(blocked.flash.error).toMatch(/still has 1 live price/);

    const [e] = await sql<{ id: string }[]>`
      insert into menu_dayparts (org_id, store_id, name, days, start_time, end_time, created_by)
      values (${c.orgId}, ${c.storeA}, 'Spare', '{1}', '01:00', '02:00', ${c.admin.personId}) returning id`;
    const ok = await run(STORES, 'retireDaypartAction', c.admin, f({ daypartId: e!.id }));
    expect(ok.flash.ok).toBe('Hours retired.');
    expect(plain(await render(STORE_PAGE, c.admin, { params: { id: c.storeA } }))).toContain('Retired hours (1)');
  });

  it('a store manager may manage their own store hours; a cashier and a manager of another store may not (nothing written)', async () => {
    const c = await cast('s3-hours-x');
    const f = (name: string, storeId = c.storeA) => fd({ storeId, name, days: ['1'], start: '08:00', end: '17:00' });
    const count = async () => Number((await sql<{ n: number }[]>`select count(*)::int as n from menu_dayparts where org_id = ${c.orgId}`)[0]!.n);
    expect((await run(STORES, 'createDaypartAction', c.managerA, f('Lunch'))).flash.error).toBeUndefined();
    expect(await count()).toBe(1);
    const staff = await run(STORES, 'createDaypartAction', c.staff, f('Nope'));
    expectSentenceError(staff.flash.error, 'cashier');
    const other = await run(STORES, 'createDaypartAction', c.managerA, f('Nope2', c.storeB));
    expectSentenceError(other.flash.error, 'manager of another store');
    expect(await count()).toBe(1);
  });
});

describe("/menu/hours: a store manager's door to the hours", () => {
  it('a manager of store A opens A with controls, never B; a manager of both picks either; a cashier is refused', async () => {
    const c = await cast('s3-door');
    await asOrg(c.orgId, (tx) => createDaypart(c.admin, { storeId: c.storeA, name: 'Lunch', days: ALL_DAYS, start: '08:00', end: '17:00' }, tx));
    await asOrg(c.orgId, (tx) => createDaypart(c.admin, { storeId: c.storeB, name: 'Supper', days: ALL_DAYS, start: '18:00', end: '23:00' }, tx));

    const a = await render(HOURS_PAGE, c.managerA, {});
    expect(plain(a)).toContain('Lunch 08:00 to 17:00');
    expect(a).toContain('>Add hours<');
    expect(a).toContain(`name="storeId" value="${c.storeA}"`);
    expect(a).toContain('name="from" value="hours"');
    expect(plain(a)).not.toContain('Supper');

    const forged = await render(HOURS_PAGE, c.managerA, { search: { store: c.storeB } });
    expect(plain(forged)).toContain('This store is not available to you');
    expect(forged).not.toContain('Supper');
    expect(forged).not.toContain('Add hours');

    const both = await render(HOURS_PAGE, c.manager, { search: { store: c.storeB } });
    expect(plain(both)).toContain('Supper 18:00 to 23:00');
    expect(both).toContain('>Add hours<');
    expect(both).toContain(`name="storeId" value="${c.storeB}"`);

    expectAccessRefused(await render(HOURS_PAGE, c.staff, {}), 'manage_store_settings');
  });

  it('someone without manage_store_settings gets the list and no controls; the actions come back to /menu/hours', async () => {
    const c = await cast('s3-door2');
    await asOrg(c.orgId, (tx) => createDaypart(c.admin, { storeId: c.storeA, name: 'Lunch', days: ALL_DAYS, start: '08:00', end: '17:00' }, tx));
    const { daypartsForStore } = await STORES_LIB();
    const staff = await daypartsForStore(c.staff, c.storeA);
    expect(staff.canManage).toBe(false);
    expect(staff.dayparts.map((d) => d.name)).toEqual(['Lunch']);
    expect((await daypartsForStore(c.managerA, c.storeA)).canManage).toBe(true);
    expect((await daypartsForStore(c.managerA, c.storeB)).canManage).toBe(false);

    const back = await run(STORES, 'createDaypartAction', c.managerA, fd({ storeId: c.storeA, from: 'hours', name: 'Dinner', days: ['1'], start: '17:00', end: '23:00' }));
    expect(back.flash.error).toBeUndefined();
    expect(back.path).toBe('/menu/hours');
    expect(back.nav.get('store')).toBe(c.storeA);
  });
});
