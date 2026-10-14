import { afterAll, describe, expect, it, vi } from 'vitest';

import { cast, expectSentenceError, fd, rawItem, rawRule, run, sql } from './t401-s4-common';

/**
 * T-401 S4 (TESTER) - an UNEXPECTED, non-database error inside a domain call (a bug, a TypeError) must reach the person as a
 * generic sentence, never its internal wording, and nothing is written. The domain calls are replaced by ones that throw.
 * Contract: header of t401-s4-common.ts. Mutant: the action shows `err.message` for any Error.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', async () => (await import('./t401-s4-common')).sessionMock());
vi.mock('@shareat/domain', async (orig) => ({
  ...(await orig<typeof import('@shareat/domain')>()),
  createMenuCategory: async () => {
    throw new Error('internal: relation xyz_secret_table.zz_col exploded');
  },
  createMenuItem: async () => {
    throw new TypeError("Cannot read properties of undefined (reading 'xyz_secret_table.zz_col')");
  },
  setMenuOffer: async () => {
    throw new Error('connection to server at "10.0.0.7" failed: xyz_secret_table.zz_col');
  },
  requestMenuItem: async () => {
    throw new RangeError('xyz_secret_table.zz_col out of range');
  },
}));

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

const MENU = () => import('../../src/app/menu/actions');
const PRICES = () => import('../../src/app/menu/prices/actions');
const REQUESTS = () => import('../../src/app/menu/requests/actions');

type C = Awaited<ReturnType<typeof cast>>;
const LEAK = /xyz_secret|zz_col|internal|relation|Cannot read|10\.0\.0\.7|RangeError|TypeError|connection/i;

describe('an unexpected error is shown as a generic sentence, never its internals', () => {
  it.each([
    ['createCategoryAction', MENU, 'admin', (_c: C) => fd({ name: 'Soups' })],
    ['createItemAction', MENU, 'superAdmin', (c: C) => fd({ categoryId: c.categoryId, name: 'Tapa', itemType: 'a_la_carte' })],
    ['submitItemRequestAction', REQUESTS, 'managerA', (c: C) => fd({ storeId: c.storeA, name: 'Wagyu Platter', itemType: 'a_la_carte', confirmed: '1' })],
  ] as const)('%s', async (action, load, who, form) => {
    const c = await cast('s4unx');
    const out = await run(load, action, c[who], form(c));
    expectSentenceError(out.flash.error, action);
    expect(out.flash.error as string).not.toMatch(LEAK);
    expect(out.flash.ok).toBeUndefined();
  });

  it('setPriceAction', async () => {
    const c = await cast('s4unx-p');
    const it = await rawItem(c);
    await rawRule(c, it.variantId);
    const out = await run(PRICES, 'setPriceAction', c.managerA, fd({ storeId: c.storeA, variantId: it.variantId, channel: 'store', amount: '10.00' }));
    expectSentenceError(out.flash.error, 'setPriceAction');
    expect(out.flash.error as string).not.toMatch(LEAK);
    expect(Number((await sql<{ n: number }[]>`select count(*)::int as n from menu_offers where org_id = ${c.orgId}`)[0]!.n)).toBe(0);
  });
});
