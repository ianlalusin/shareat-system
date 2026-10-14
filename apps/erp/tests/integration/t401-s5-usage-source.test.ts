import { afterAll, describe, expect, it, vi } from 'vitest';

import type { Actor } from '@shareat/auth';
import { expectAccessRefused, expectSentenceError, fd, plain, render, run, sql as sqlS4 } from './t401-s4-common';
import {
  count, makeDay, rawLink, rawMap, rawRule, rawSwitch, rawVariant, sold, sql, world, type World,
} from '../../../../packages/domain/tests/integration/t401-s5-setup';

/**
 * T-401 S5 (TESTER) - /menu/usage-source: link, seed from map, unlink, compare, switch to menu rules and back.
 * Spec: docs/tasks/401-erp-menu-catalog-master.md section 5 (`/menu/usage-source`), R7, I24; harness: t401-s4-common.ts (same session / flash jar).
 *
 * ======================================================================================================================
 * THE CONTRACT THE BUILDER FOLLOWS (pinned by the tester; the spec fixes the screen, not the action names)
 * ======================================================================================================================
 *  apps/erp/src/app/menu/usage-source/actions.ts  ('use server'), redirect `/menu/usage-source` with nav { store: storeId }.
 *  Each is `export async function xAction(fd: FormData): Promise<void>`, ends in redirectWithFlash, never puts typed text in the URL.
 *    linkItemAction        storeId, posItemKey, variantId, locationId?   gate manage_pos_map @ store (admin and above; manager REFUSED, T-403)   ok 'Link saved.'
 *    seedLinkAction        storeId, posItemKey, variantId                gate manage_pos_map @ store                                           ok 'Linked from the POS map.'
 *    unlinkItemAction      storeId, posItemKey                           gate manage_pos_map @ store                                           ok 'Link removed.'
 *    switchSourceAction    storeId, source ('menu_rules' | 'v1_pos_map'), acceptDifferences? ('1'), reason?
 *                                                                        gate switch_usage_source @ store (admin and above)
 *                          ok 'Switched to menu rules.' / 'Switched back to POS item maps.'; a refusal is the domain's sentence (it names the day and the key).
 *  apps/erp/src/app/menu/usage-source/page.tsx   default export Page({ searchParams }), `dynamic = 'force-dynamic'`, requirePageAccess('/menu/usage-source')
 *    (read gate view_menu). ?store=<id> (default: the first store the person is scoped to). Store picker `<select name="store">` lists ONLY the person's
 *    stores by name. Shows the source in force ("Menu rules" or "POS item maps"), the switch history (each row: source, reason, difference count), the
 *    links table, and with ?compare=1 the comparison: every difference as "<business date as 'Aug 17, 2026'> <key>"; with none it says "No differences".
 *  Red today: apps/erp/src/app/menu/usage-source/** does not exist ("is not exported by the module").
 *
 * Mutants killed: an action gated by a weaker capability (manager switches / links); a switch that skips the comparison; the reason typed into the
 * redirect URL; the picker listing every org store; a refusal that leaks database wording; compare=1 writing a row.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', async () => (await import('./t401-s4-common')).sessionMock());
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
  await sqlS4.end({ timeout: 5 });
});

const ACTIONS = () => import('../../src/app/menu/usage-source/actions');
const PAGE = () => import('../../src/app/menu/usage-source/page');

/** Store A: 'pork-belly' map 0.25 vs rule 0.5 (sold 17 Aug only) and 'same' (map == rule); a variant with no rule and a map for 'cheese-plate' (to seed). */
async function scene(hint: string) {
  const w = await world(hint);
  const vSame = await rawVariant(w, 'Rice Bowl');
  await rawRule(w, vSame, { mode: 'direct', itemId: w.rice, quantityPerSale: '0.1' });
  await rawLink(w, w.a.storeId, 'same', vSame);
  await rawMap(w, w.a.storeId, 'same', { mode: 'direct', itemId: w.rice, quantityPerSale: '0.1' });
  const vPork = await rawVariant(w, 'Pork Belly');
  await rawRule(w, vPork, { mode: 'direct', itemId: w.pork, quantityPerSale: '0.5' });
  await rawLink(w, w.a.storeId, 'pork-belly', vPork);
  await rawMap(w, w.a.storeId, 'pork-belly', { mode: 'direct', itemId: w.pork, quantityPerSale: '0.25', name: 'pork-belly' });
  await rawMap(w, w.a.storeId, 'cheese-plate', { mode: 'direct', itemId: w.cheese, quantityPerSale: '0.25', name: 'Cheese Plate' });
  const vCheese = await rawVariant(w, 'Cheese Plate');
  const vFree = await rawVariant(w, 'Free Rule');
  await rawRule(w, vFree, { mode: 'no_stock' });
  for (const date of ['2026-08-16', '2026-08-17', '2026-08-18']) {
    await makeDay(w, w.a.storeId, date, sold([{ key: 'same', qty: 2 }, ...(date === '2026-08-17' ? [{ key: 'pork-belly', qty: 4 }] : [])]));
  }
  return { w, vPork, vCheese, vFree };
}

const n = async (table: string, w: World, extra = '') =>
  Number((await sql.unsafe<{ n: string }[]>(`select count(*)::text as n from ${table} where org_id = '${w.orgId}' ${extra}`))[0]!.n);
const switches = (w: World) => sql<{ source: string; reason: string | null; difference_count: number | null }[]>`
  select source, reason, difference_count from menu_usage_source_switches where store_id = ${w.a.storeId} order by created_at, id`;

describe('capabilities: every action refuses a manager and staff, writes nothing, and says why in a sentence; an admin succeeds', () => {
  it('link / seed / unlink / switch', async () => {
    const { w, vFree, vCheese } = await scene('s5cap');
    // a never-switched store is already on maps (switching to maps is a refused no-op), so put it on menu rules first
    await rawSwitch(w, w.a.storeId, 'menu_rules', 'setup', 0);
    const cases: { name: string; form: FormData; rows: () => Promise<number>; ok: string; delta: number }[] = [
      { name: 'linkItemAction', form: fd({ storeId: w.a.storeId, posItemKey: 'water', variantId: vFree }), rows: () => n('menu_pos_v1_links', w), ok: 'Link saved.', delta: 1 },
      { name: 'seedLinkAction', form: fd({ storeId: w.a.storeId, posItemKey: 'cheese-plate', variantId: vCheese }), rows: () => n('menu_pos_v1_links', w), ok: 'Linked from the POS map.', delta: 1 },
      { name: 'switchSourceAction', form: fd({ storeId: w.a.storeId, source: 'v1_pos_map' }), rows: () => n('menu_usage_source_switches', w), ok: 'Switched back to POS item maps.', delta: 1 },
    ];
    for (const c of cases) {
      const before = await c.rows();
      for (const who of [w.manager, w.staff] as Actor[]) {
        const out = await run(ACTIONS, c.name, who, c.form);
        expectSentenceError(out.flash.error, `${c.name} as ${who === w.manager ? 'manager' : 'staff'}`);
        expect(out.flash.ok).toBeUndefined();
        expect(await c.rows(), `${c.name}: a refusal writes nothing`).toBe(before);
      }
      const ok = await run(ACTIONS, c.name, w.admin, c.form);
      expect(ok.flash.error, `${c.name} as admin`).toBeUndefined();
      expect(ok.flash.ok).toBe(c.ok);
      expect(ok.path).toBe('/menu/usage-source');
      expect(ok.nav.get('store')).toBe(w.a.storeId);
      expect(await c.rows()).toBe(before + c.delta);
    }
    const un = await run(ACTIONS, 'unlinkItemAction', w.manager, fd({ storeId: w.a.storeId, posItemKey: 'water' }));
    expectSentenceError(un.flash.error, 'unlink as manager');
    const unOk = await run(ACTIONS, 'unlinkItemAction', w.admin, fd({ storeId: w.a.storeId, posItemKey: 'water' }));
    expect(unOk.flash.ok).toBe('Link removed.');
    expect(await n('menu_pos_v1_links', w, "and pos_item_key = 'water' and status = 'active'")).toBe(0);
  }, 240_000);
});

describe('the switch form', () => {
  it('refused with a difference (the sentence names day and key), then accepted with a reason that is NOT in the URL; switching back needs nothing', async () => {
    const { w } = await scene('s5sw');
    const refused = await run(ACTIONS, 'switchSourceAction', w.admin, fd({ storeId: w.a.storeId, source: 'menu_rules' }));
    expectSentenceError(refused.flash.error, 'switch with a difference');
    expect(refused.flash.error).toMatch(/Aug 17/);
    expect(refused.flash.error).toMatch(/pork-belly/);
    expect(await switches(w)).toEqual([]);

    const reason = 'Chef confirmed the new pork belly portion';
    const ok = await run(ACTIONS, 'switchSourceAction', w.admin, fd({ storeId: w.a.storeId, source: 'menu_rules', acceptDifferences: '1', reason }));
    expect(ok.flash.error).toBeUndefined();
    expect(ok.flash.ok).toBe('Switched to menu rules.');
    expect(ok.url, 'nothing typed rides in the address').not.toContain(encodeURIComponent(reason));
    expect(ok.url).not.toMatch(/reason=/);
    expect(await switches(w)).toEqual([{ source: 'menu_rules', reason, difference_count: 1 }]);

    const back = await run(ACTIONS, 'switchSourceAction', w.admin, fd({ storeId: w.a.storeId, source: 'v1_pos_map' }));
    expect(back.flash.ok).toBe('Switched back to POS item maps.');
    expect((await switches(w)).map((r) => r.source)).toEqual(['menu_rules', 'v1_pos_map']);
  }, 240_000);

  it('accepting differences with no reason is refused in a sentence and writes nothing', async () => {
    const { w } = await scene('s5nr');
    const out = await run(ACTIONS, 'switchSourceAction', w.admin, fd({ storeId: w.a.storeId, source: 'menu_rules', acceptDifferences: '1' }));
    expectSentenceError(out.flash.error, 'acceptDifferences without a reason');
    expect(await switches(w)).toEqual([]);
  }, 240_000);
});

describe('the page', () => {
  it('shows the source in force, the history with its reason, and (?compare=1) each difference by day and key, writing nothing', async () => {
    const { w } = await scene('s5pg');
    await rawSwitch(w, w.a.storeId, 'menu_rules', 'Chef confirmed the new pork belly portion', 1);
    const rowsBefore = await Promise.all(['menu_usage_source_switches', 'pos_usage_pulls', 'audit_log'].map((t) => count(t, w.orgId)));
    const html = plain(await render(PAGE, w.admin, { search: { store: w.a.storeId, compare: '1' } }));
    expect(html).toContain('Menu rules');
    expect(html).toContain('Chef confirmed the new pork belly portion');
    expect(html).toMatch(/Aug 17, 2026\s+pork-belly/);
    expect(await Promise.all(['menu_usage_source_switches', 'pos_usage_pulls', 'audit_log'].map((t) => count(t, w.orgId))), 'rendering the comparison writes nothing').toEqual(rowsBefore);
  }, 240_000);

  it('the picker lists only the stores the person is scoped to; staff are shown the access-refused card (view_menu)', async () => {
    const { w } = await scene('s5pk');
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${w.orgId}, 'Admin Lipa') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${w.orgId}, 'admin')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${w.a.storeId})`;
    const lipaOnly: Actor = { personId: p!.id, orgId: w.orgId };
    const html = await render(PAGE, lipaOnly, {});
    expect(plain(html)).toContain('Lipa');
    expect(plain(html), 'a store outside the scope is never drawn').not.toContain('Malvar');
    expect(html).not.toContain(w.b.storeId);
    const both = plain(await render(PAGE, w.admin, {}));
    expect(both).toContain('Lipa');
    expect(both).toContain('Malvar');
    expectAccessRefused(await render(PAGE, w.staff, {}), 'view_menu');
  }, 240_000);
});
