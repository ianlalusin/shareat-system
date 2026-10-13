/**
 * T-401 S2, "S1 audit rulings" (binding): the S2 domain must create the default variant in the SAME transaction as the item, and
 * refuse re-activating an item without one. docs/tasks/401-erp-menu-catalog-master.md section 7 end ("Exactly one default variant (I7)
 * is the database guaranteeing at most one plus the retire check"). TESTER, not BUILDER. Real Postgres.
 *
 * ## Assumed contract
 *   (Actor: SUPER ADMIN - add_menu_item; admin is refused, Q2. editMenuItem stays manage_menu, admin may.)
 *   createMenuItem(actor, { categoryId, name, itemType, soldALaCarte?, ... }, tx?) -> { id, defaultVariantId }
 *   editMenuItem(actor, { id, status: 'active' }, tx?)    re-activates a retired item (there is no separate reactivate function in the spec)
 *   A refusal is a throw or { ok:false, reason }; the item stays retired.
 *
 * ## Red today
 * `createMenuItem is not a function`. Mutants: the variant is created after the item in a second transaction (or not at all);
 * editMenuItem flips status without looking for an active default variant.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { createMenuItem, editMenuItem } from '@shareat/domain';

import { asOrg, attempt, auditCount, cast, rawItem, sql } from './_fixtures/t401-s2-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('createMenuItem creates its default variant in the same transaction (S1 audit ruling)', () => {
  it('one item, exactly one variant: default, unlabelled, active; the returned ids name them', async () => {
    const c = await cast('lc-create');
    const r = await asOrg(c.orgId, (tx) => createMenuItem(c.superAdmin, { categoryId: c.categoryId, name: 'Samgyupsal', itemType: 'a_la_carte' }, tx));
    const vs = await sql<{ id: string; label: string | null; is_default: boolean; status: string }[]>`
      select id, label, is_default, status from menu_item_variants where menu_item_id = ${r.id}`;
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({ id: r.defaultVariantId, label: null, is_default: true, status: 'active' });
  });

  it('every item type gets one (a package and a refill too: a refill is a variant that cannot carry a price, not a variant-less item)', async () => {
    const c = await cast('lc-types');
    for (const itemType of ['package', 'refill'] as const) {
      const r = await asOrg(c.orgId, (tx) => createMenuItem(c.superAdmin, { categoryId: c.categoryId, name: `Thing ${itemType}`, itemType }, tx));
      const [n] = await sql<{ n: number }[]>`select count(*)::int as n from menu_item_variants where menu_item_id = ${r.id} and is_default`;
      expect(n!.n, itemType).toBe(1);
    }
  });

  it('the item and its variant share the caller transaction: roll the tx back and NEITHER exists (mutant: variant made on another connection / after commit)', async () => {
    const c = await cast('lc-tx');
    await expect(
      asOrg(c.orgId, async (tx) => {
        await createMenuItem(c.superAdmin, { categoryId: c.categoryId, name: 'Ghost', itemType: 'a_la_carte' }, tx);
        throw new Error('rollback on purpose');
      }),
    ).rejects.toThrow('rollback on purpose');
    const [i] = await sql<{ n: number }[]>`select count(*)::int as n from menu_items where org_id = ${c.orgId} and name = 'Ghost'`;
    const [v] = await sql<{ n: number }[]>`select count(*)::int as n from menu_item_variants where org_id = ${c.orgId} and menu_item_id not in (select id from menu_items)`;
    expect(i!.n).toBe(0);
    expect(v!.n).toBe(0);
    const [any] = await sql<{ n: number }[]>`select count(*)::int as n from menu_item_variants where org_id = ${c.orgId}`;
    expect(any!.n, 'no variant of any item survived the rollback').toBe(0);
  });

  it('a refused create (duplicate name + type) leaves no half-built item and no extra variant', async () => {
    const c = await cast('lc-dup');
    await rawItem(c, 'a_la_carte', 'Samgyupsal');
    const r = await asOrg(c.orgId, (tx) =>
      attempt(() => createMenuItem(c.superAdmin, { categoryId: c.categoryId, name: 'samgyupsal', itemType: 'a_la_carte' }, tx)));
    expect(r.failed, 'a duplicate (org, type, lower(name)) item was accepted').toBe(true);
    const [i] = await sql<{ n: number }[]>`select count(*)::int as n from menu_items where org_id = ${c.orgId}`;
    const [v] = await sql<{ n: number }[]>`select count(*)::int as n from menu_item_variants where org_id = ${c.orgId}`;
    expect([i!.n, v!.n]).toEqual([1, 1]);
  });
});

describe('re-activating an item without an active default variant is refused (S1 audit ruling; mutant: status flipped blindly)', () => {
  it('retired item + retired default variant: editMenuItem status active is refused, the item stays retired, no audit row', async () => {
    const c = await cast('lc-react-bad');
    const { itemId } = await rawItem(c);
    await sql`update menu_items set status = 'retired' where id = ${itemId}`;
    await sql`update menu_item_variants set status = 'retired' where menu_item_id = ${itemId}`;
    const before = await auditCount(c.orgId);
    const r = await asOrg(c.orgId, (tx) => attempt(() => editMenuItem(c.admin, { id: itemId, status: 'active' }, tx)));
    expect(r.failed, 'the item came back active with no sellable default variant').toBe(true);
    const [row] = await sql<{ status: string }[]>`select status from menu_items where id = ${itemId}`;
    expect(row!.status).toBe('retired');
    expect(await auditCount(c.orgId)).toBe(before);
  });

  it('control: retired item whose default variant is still active CAN be re-activated (the refusal above is about the variant, not the verb)', async () => {
    const c = await cast('lc-react-ok');
    const { itemId } = await rawItem(c);
    await sql`update menu_items set status = 'retired' where id = ${itemId}`;
    const r = await asOrg(c.orgId, (tx) => attempt(() => editMenuItem(c.admin, { id: itemId, status: 'active' }, tx)));
    expect(r.failed, `refused: ${r.message}`).toBe(false);
    const [row] = await sql<{ status: string }[]>`select status from menu_items where id = ${itemId}`;
    expect(row!.status).toBe('active');
  });
});
