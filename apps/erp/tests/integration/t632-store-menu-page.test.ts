import { afterAll, describe, expect, it, vi } from 'vitest';

import { switchVariantOn } from '@shareat/domain';
import { asOrg, cast, plain, rawItem, rawRule, render, sql, uid, type Cast } from './t401-s4-common';

/**
 * T-632 - the /menu/stores/[storeId] page draws what the domain read says. MUTANT: drop the chip from page.tsx (or its `item.noStation` test)
 * -> the "Not on the tablet: no kitchen station" test goes red.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', async () => (await import('./t401-s4-common')).sessionMock());
vi.mock('@/components/shell/Page', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), Page: ({ children }: { children: unknown }) => children }));

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

const PAGE = () => import('../../src/app/menu/stores/[storeId]/page');
const CHIP = 'Not on the tablet: no kitchen station';

async function item(c: Cast, name: string, routed: boolean, on: boolean) {
  const it = await rawItem(c, 'a_la_carte', name);
  await rawRule(c, it.variantId);
  if (routed) {
    const [s] = await sql<{ id: string }[]>`insert into kitchen_stations (org_id, store_id, name, created_by) values (${c.orgId}, ${c.storeA}, ${uid('Grill')}, ${c.admin.personId}) returning id`;
    await sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by) values (${c.orgId}, ${c.storeA}, ${it.itemId}, ${s!.id}, ${c.admin.personId})`;
  }
  if (on) await asOrg(c.orgId, (tx) => switchVariantOn(c.admin, { storeId: c.storeA, variantId: it.variantId, prices: [{ amount: '75.00' }] }, tx));
  return it;
}

describe('T-632 page', () => {
  it('shows the no-station chip for an item that is on without a kitchen route, and for no other', async () => {
    const c = await cast('t632-page');
    await item(c, 'Bare Bulalo', false, true);
    await item(c, 'Routed Rice', true, true);
    await item(c, 'Unsold Soup', false, false);
    const t = plain(await render(PAGE, c.admin, { params: { storeId: c.storeA } }));
    expect(t).toContain('Bare Bulalo');
    expect(t).toContain('Routed Rice');
    expect(t).toContain('Unsold Soup');
    expect(t.split(CHIP).length - 1, 'one chip, only on the item without a station').toBe(1);
    expect(t).toContain('1 on with no kitchen station');
    expect(t).toContain('2 on · 1 off');
  });

  it('a store outside the person\'s scope is never drawn', async () => {
    const c = await cast('t632-page-scope');
    await item(c, 'Hidden Halo', false, true);
    let drawn = '';
    try {
      drawn = plain(await render(PAGE, c.managerA, { params: { storeId: c.storeB } }));
    } catch {
      // notFound() throws; either outcome is fine, the store's menu is not drawn.
    }
    expect(drawn).not.toContain('Hidden Halo');
  });
});
