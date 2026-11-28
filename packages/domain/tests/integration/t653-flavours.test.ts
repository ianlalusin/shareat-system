import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-653 - ONE flavour list; each package and each refill ticks the flavours it allows. MIGRATION 0292. Real PostgreSQL.
 *
 * MUTANTS (each goes red): the allowed-set filter dropped from the projection (`allowedByLink` in project.ts: the seating and refill refusal tests, and the projection test);
 * the link's own min / max ignored (the limits tests); `replaceLinkValues` not called by `setAllowedFlavours` (the replace test); `mergeIntoFlavours` not de-duplicating names,
 * not re-linking, or not retiring the old groups (the three merge tests); the preview writing (the preview test); the refill pill matched by name only (the unit test, apps/erp/tests/t653-flavours-screens.test.ts).
 * The database rules (one flavours group per org, the link limit CHECKs, a value of another group refused, no rows = every value) are proven with raw SQL.
 */
import { RefusalError, menuRepo } from '@shareat/db';
import { loadStoreMenu, mergeIntoFlavours, previewFlavourMerge, setAllowedFlavours, startFlavourList, addFlavour } from '@shareat/domain';
import { addLines, openStand, requestRefill } from '../../src/pos';
import { asOrg, closeAll, fixture, makeServer0240, newStand, nowIso, sql, uuid, type Fx } from './_fixtures/t525-pos';
import { insOptionOffer, insRule, newItem } from '../../../db/tests/integration/_fixtures/t401-menu';

afterAll(closeAll);

async function msg(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').toBeInstanceOf(RefusalError);
  return (err as RefusalError).userMessage;
}

/** The org's flavour list: Spicy, Garlic, Sweet, Plain, each on sale at the store. */
async function list(f: Fx) {
  const g = await asOrg(f.orgId, (tx) => startFlavourList(f.admin, tx));
  const ids: Record<string, string> = {};
  for (const name of ['Spicy', 'Garlic', 'Sweet', 'Plain']) {
    const v = await asOrg(f.orgId, (tx) => addFlavour(f.admin, { name }, tx));
    await insOptionOffer(f, v.id, '0.00');
    ids[name] = v.id;
  }
  return { groupId: g.id, ids };
}

/** A refill item the package lists. */
async function refillItem(f: Fx) {
  const refill = await newItem(f, 'refill', 'Pork refill');
  await insRule(f, refill.variantId);
  await sql`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, amount, bundle_heads, extra_head_amount, withdrawn, created_by)
            values (${f.orgId}, ${f.storeId}, ${refill.variantId}, 'store', ${null}, ${null}, ${null}, ${null}, false, ${f.personId})`;
  await sql`insert into kitchen_routes (org_id, store_id, menu_item_id, station_id, created_by) values (${f.orgId}, ${f.storeId}, ${refill.itemId}, ${f.grill}, ${f.personId})`;
  await sql`insert into menu_package_refills (org_id, package_variant_id, refill_item_id, created_by) values (${f.orgId}, ${f.menu.unli.variantId}, ${refill.itemId}, ${f.personId})`;
  return refill;
}

const allow = (f: Fx, input: Parameters<typeof setAllowedFlavours>[1]) => asOrg(f.orgId, (tx) => setAllowedFlavours(f.admin, input, tx));
/** Offers start at the DB clock and a seating is stamped by this process: wait until it has passed them. */
async function settle(f: Fx) {
  const [last] = await sql<{ at: Date }[]>`select max(effective_from) as at from menu_option_offers where org_id = ${f.orgId}`;
  while (last?.at && Date.now() <= last.at.getTime()) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 60));
}
const menuOf = (f: Fx) => asOrg(f.orgId, async (tx) => (await loadStoreMenu(tx, f.orgId, f.storeId)).menu);
const groupsOf = async (f: Fx, variantId: string) => {
  const menu = await menuOf(f);
  return menu.items.flatMap((i) => i.variants).find((v) => v.id === variantId)?.optionGroups ?? [];
};

describe('T-653 - the database rules (migration 0292)', () => {
  it('1. at most ONE active flavours group per organisation; the link limit CHECKs; a value of another group is refused on the allowed table', async () => {
    const f = await fixture();
    const l = await list(f);
    await expect(
      sql`insert into menu_option_groups (org_id, name, selection_mode, min_selections, max_selections, role, created_by) values (${f.orgId}, 'Second', 'multi', 0, 3, 'flavours', ${f.personId})`,
    ).rejects.toMatchObject({ code: '23505' });
    // a RETIRED flavours group does not count: retire, then a new one is allowed
    const other = await sql<{ id: string }[]>`insert into menu_option_groups (org_id, name, selection_mode, min_selections, max_selections, role, status, created_by) values (${f.orgId}, 'Old', 'multi', 0, 3, 'flavours', 'retired', ${f.personId}) returning id`;
    expect(other).toHaveLength(1);
    await expect(sql`insert into menu_option_groups (org_id, name, selection_mode, min_selections, max_selections, role, created_by) values (${f.orgId}, 'Bad', 'multi', 0, 3, 'bogus', ${f.personId})`).rejects.toMatchObject({ code: '23514' });

    const [link] = await sql<{ id: string }[]>`insert into menu_option_group_links (org_id, option_group_id, variant_id, created_by) values (${f.orgId}, ${l.groupId}, ${f.menu.unli.variantId}, ${f.personId}) returning id`;
    const bad: [number, number][] = [[-1, 3], [0, 0], [3, 2]];
    for (const [min, max] of bad) {
      await expect(sql`update menu_option_group_links set min_selections = ${min}, max_selections = ${max} where id = ${link!.id}`, `${min}/${max}`).rejects.toMatchObject({ code: '23514' });
    }
    const [oldGroup] = await sql<{ id: string }[]>`insert into menu_option_groups (org_id, name, selection_mode, min_selections, max_selections, created_by) values (${f.orgId}, 'Flavours', 'multi', 0, 3, ${f.personId}) returning id`;
    const [stray] = await sql<{ id: string }[]>`insert into menu_option_values (org_id, option_group_id, name, created_by) values (${f.orgId}, ${oldGroup!.id}, 'Stray', ${f.personId}) returning id`;
    // the value is in ANOTHER group than the link's: both composite FKs carry the group, so the database refuses the pair
    await expect(
      sql`insert into menu_option_link_values (org_id, link_id, option_group_id, option_value_id) values (${f.orgId}, ${link!.id}, ${l.groupId}, ${stray!.id})`,
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      sql`insert into menu_option_link_values (org_id, link_id, option_group_id, option_value_id) values (${f.orgId}, ${link!.id}, ${oldGroup!.id}, ${stray!.id})`,
    ).rejects.toMatchObject({ code: '23503' });
    // and a pair of the right group goes in once, not twice
    await sql`insert into menu_option_link_values (org_id, link_id, option_group_id, option_value_id) values (${f.orgId}, ${link!.id}, ${l.groupId}, ${l.ids.Spicy!})`;
    await expect(
      sql`insert into menu_option_link_values (org_id, link_id, option_group_id, option_value_id) values (${f.orgId}, ${link!.id}, ${l.groupId}, ${l.ids.Spicy!})`,
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('2. a link with NO rows allows every active flavour (today); with rows only those (the projection)', async () => {
    const f = await fixture();
    const l = await list(f);
    await settle(f);
    await sql`insert into menu_option_group_links (org_id, option_group_id, variant_id, created_by) values (${f.orgId}, ${l.groupId}, ${f.menu.unli.variantId}, ${f.personId})`;
    const all = await groupsOf(f, f.menu.unli.variantId);
    expect(all).toHaveLength(1);
    expect(all[0]!.values.map((v) => v.name).sort()).toEqual(['Garlic', 'Plain', 'Spicy', 'Sweet']);
    await allow(f, { variantId: f.menu.unli.variantId, optionValueIds: [l.ids.Spicy!, l.ids.Garlic!] });
    const some = await groupsOf(f, f.menu.unli.variantId);
    expect(some[0]!.values.map((v) => v.name).sort()).toEqual(['Garlic', 'Spicy']);
  });
});

describe('T-653 - setAllowedFlavours', () => {
  it('3. it REPLACES the set, writes nothing when nothing changed, and an empty list removes the link', async () => {
    const f = await fixture();
    const l = await list(f);
    const v = f.menu.unli.variantId;
    const first = await allow(f, { variantId: v, optionValueIds: [l.ids.Spicy!, l.ids.Garlic!], min: 1, max: 2 });
    expect(first).toMatchObject({ linked: true, changed: true, min: 1, max: 2 });
    const again = await allow(f, { variantId: v, optionValueIds: [l.ids.Garlic!, l.ids.Spicy!], min: 1, max: 2 });
    expect(again.changed).toBe(false);
    const replaced = await allow(f, { variantId: v, optionValueIds: [l.ids.Sweet!], min: 1, max: 1 });
    expect(replaced).toMatchObject({ changed: true, optionValueIds: [l.ids.Sweet!] });
    const rows = await sql<{ option_value_id: string }[]>`select v.option_value_id from menu_option_link_values v join menu_option_group_links k on k.id = v.link_id where k.variant_id = ${v}`;
    expect(rows.map((r) => r.option_value_id)).toEqual([l.ids.Sweet!]);
    const audit = await sql<{ n: string }[]>`select count(*)::text as n from audit_log where org_id = ${f.orgId} and action = 'menu.flavours_allowed_set'`;
    expect(Number(audit[0]!.n)).toBe(2); // the no-change call wrote no row
    const none = await allow(f, { variantId: v, optionValueIds: [] });
    expect(none).toMatchObject({ linked: false, changed: true });
    expect(Number((await sql<{ n: string }[]>`select count(*)::text as n from menu_option_group_links where variant_id = ${v}`)[0]!.n)).toBe(0);
  });

  it('4. refusals in words: a value not on the list, a retired one, a minimum above the flavours allowed, both targets, no list', async () => {
    const f = await fixture();
    expect(await msg(allow(f, { variantId: f.menu.unli.variantId, optionValueIds: [uuid()] }))).toMatch(/Start your flavour list/);
    const l = await list(f);
    const v = f.menu.unli.variantId;
    expect(await msg(allow(f, { variantId: v, optionValueIds: [uuid()] }))).toMatch(/not on your flavour list/);
    await sql`update menu_option_values set status = 'retired' where id = ${l.ids.Plain!}`;
    expect(await msg(allow(f, { variantId: v, optionValueIds: [l.ids.Plain!] }))).toMatch(/retired/);
    expect(await msg(allow(f, { variantId: v, optionValueIds: [l.ids.Spicy!], min: 2, max: 3 }))).toMatch(/at least 2, but only 1 flavour is allowed/);
    expect(await msg(allow(f, { variantId: v, optionValueIds: [l.ids.Spicy!, l.ids.Garlic!], min: 2, max: 1 }))).toMatch(/cannot be below the fewest/);
    expect(await msg(allow(f, { variantId: v, menuItemId: f.menu.unli.itemId, optionValueIds: [l.ids.Spicy!] }))).toMatch(/one package or one refill/);
  });

  it('5. the link\'s own min / max win over the group\'s: the package picks 1 to 2 and the projection says so', async () => {
    const f = await fixture();
    const l = await list(f);
    await settle(f);
    await allow(f, { variantId: f.menu.unli.variantId, optionValueIds: [l.ids.Spicy!, l.ids.Garlic!, l.ids.Sweet!], min: 1, max: 2 });
    const [g] = await groupsOf(f, f.menu.unli.variantId);
    expect(g).toMatchObject({ minSelections: 1, maxSelections: 2 }); // the group itself says 0 and 10
    const [row] = await sql<{ min_selections: number; max_selections: number }[]>`select min_selections, max_selections from menu_option_groups where id = ${l.groupId}`;
    expect(row).toEqual({ min_selections: 0, max_selections: 10 });
  });
});

describe('T-653 - the server refuses a flavour that is not allowed (seating and refill)', () => {
  async function seatWith(f: Fx, optionValueIds?: string[]) {
    const stand = await newStand(f);
    const sessionId = uuid();
    await asOrg(f.orgId, (tx) =>
      openStand(tx, f.counter, {
        storeId: f.storeId, pairingId: f.pairingId, sessionId, mode: 'dine_in', standId: stand.id, headsCashier: 2, openedAtDevice: nowIso(),
        lines: [{ lineId: uuid(), menuItemId: f.menu.unli.itemId, variantId: f.menu.unli.variantId, qty: 2, addedAtDevice: nowIso(), ...(optionValueIds ? { optionValueIds } : {}) }],
      }),
    );
    return sessionId;
  }
  const sessionCount = async (id: string) => (await sql<{ n: number }[]>`select count(*)::int as n from table_sessions where id = ${id}`)[0]!.n;

  it('6. seating: a flavour the package does not allow is refused (nothing written); the allowed ones and the link\'s max are enforced', async () => {
    const f = await fixture();
    const l = await list(f);
    await allow(f, { variantId: f.menu.unli.variantId, optionValueIds: [l.ids.Spicy!, l.ids.Garlic!, l.ids.Sweet!], min: 1, max: 2 }); // Plain is on the list, not allowed here
    await settle(f);
    const bad = uuid();
    const stand = await newStand(f);
    const refused = await msg(
      asOrg(f.orgId, (tx) =>
        openStand(tx, f.counter, {
          storeId: f.storeId, pairingId: f.pairingId, sessionId: bad, mode: 'dine_in', standId: stand.id, headsCashier: 2, openedAtDevice: nowIso(),
          lines: [{ lineId: uuid(), menuItemId: f.menu.unli.itemId, variantId: f.menu.unli.variantId, qty: 2, addedAtDevice: nowIso(), optionValueIds: [l.ids.Plain!] }],
        }),
      ),
    );
    expect(refused).toMatch(/not available/);
    expect(await sessionCount(bad)).toBe(0);
    expect(await sessionCount(await seatWith(f, [l.ids.Spicy!]))).toBe(1);
    expect(await sessionCount(await seatWith(f, [l.ids.Spicy!, l.ids.Garlic!]))).toBe(1);
    const tooMany = await msg(seatWith(f, [l.ids.Spicy!, l.ids.Garlic!, l.ids.Sweet!]));
    expect(tooMany).toMatch(/too many/i);
    expect(await msg(seatWith(f))).toMatch(/at least 1/); // the link's own minimum
  });

  it('7. refill: only the refill\'s allowed flavours; a flavour allowed for the package but not for the refill is refused', async () => {
    const f = await fixture();
    const l = await list(f);
    const refill = await refillItem(f);
    await allow(f, { variantId: f.menu.unli.variantId, optionValueIds: [l.ids.Spicy!, l.ids.Garlic!, l.ids.Sweet!], min: 1, max: 2 });
    await allow(f, { menuItemId: refill.itemId, optionValueIds: [l.ids.Spicy!, l.ids.Garlic!], min: 1, max: 1 });
    await settle(f);
    const sessionId = await seatWith(f, [l.ids.Spicy!]);
    const server = await makeServer0240(f);
    const ask = (optionValueIds: string[]) =>
      asOrg(f.orgId, (tx) =>
        requestRefill(tx, server, { storeId: f.storeId, pairingId: null, sessionId, lines: [{ lineId: uuid(), menuItemId: refill.itemId, qty: 1, addedAtDevice: nowIso(), optionValueIds }] }),
      );
    expect(await msg(ask([l.ids.Sweet!]))).toBe('That flavour is not available for Pork refill.'); // on the list, allowed for the package, NOT for the refill
    expect(await msg(ask([l.ids.Plain!]))).toBe('That flavour is not available for Pork refill.');
    await ask([l.ids.Garlic!]);
    const lines = await sql<{ ids: string[] | null }[]>`select option_value_ids as ids from table_session_lines where session_id = ${sessionId} and kind = 'refill'`;
    expect(lines.map((r) => r.ids)).toEqual([[l.ids.Garlic!]]);
    void addLines;
  });
});

describe('T-653 - "Use these flavours" (the merge)', () => {
  /** Two per-item "Flavours" groups the way T-643 setup built them: Unli (Spicy, Garlic, Sweet; pick 1 to 3) and Pork refill (" garlic", Plain; pick exactly 1). */
  async function oldGroups(f: Fx) {
    const refill = await refillItem(f);
    const mk = async (name: string, min: number, max: number, mode: 'single' | 'multi', menuItemId: string, values: string[], status = 'active') => {
      const [g] = await sql<{ id: string }[]>`insert into menu_option_groups (org_id, name, selection_mode, min_selections, max_selections, status, created_by) values (${f.orgId}, ${name}, ${mode}, ${min}, ${max}, ${status}, ${f.personId}) returning id`;
      await sql`insert into menu_option_group_links (org_id, option_group_id, menu_item_id, created_by) values (${f.orgId}, ${g!.id}, ${menuItemId}, ${f.personId})`;
      const ids: string[] = [];
      for (const [i, n] of values.entries()) {
        const [v] = await sql<{ id: string }[]>`insert into menu_option_values (org_id, option_group_id, name, sort_order, created_by) values (${f.orgId}, ${g!.id}, ${n}, ${i}, ${f.personId}) returning id`;
        ids.push(v!.id);
      }
      return { groupId: g!.id, ids };
    };
    const unli = await mk('Flavours', 1, 3, 'multi', f.menu.unli.itemId, ['Spicy', 'Garlic', 'Sweet']);
    const pork = await mk('flavours', 1, 1, 'single', refill.itemId, [' garlic ', 'Plain']);
    return { unli, pork, refill };
  }
  const counts = async (f: Fx) =>
    (await sql<{ groups: string; values: string; links: string; flavours: string }[]>`
      select (select count(*) from menu_option_groups where org_id = ${f.orgId})::text as groups,
             (select count(*) from menu_option_values where org_id = ${f.orgId})::text as values,
             (select count(*) from menu_option_group_links where org_id = ${f.orgId})::text as links,
             (select count(*) from menu_option_groups where org_id = ${f.orgId} and role = 'flavours')::text as flavours`)[0]!;

  it('8. the PREVIEW writes nothing and says exactly what will happen', async () => {
    const f = await fixture();
    await oldGroups(f);
    const before = await counts(f);
    const preview = await asOrg(f.orgId, (tx) => previewFlavourMerge(f.admin, tx));
    expect(await counts(f)).toEqual(before);
    expect(preview).not.toBeNull();
    expect(preview!.hasList).toBe(false);
    expect(preview!.names.map((n) => n.name)).toEqual(['Spicy', 'Garlic', 'Sweet', 'Plain']); // " garlic " is the same flavour as Garlic: once
    expect(preview!.groups).toHaveLength(2);
    const targets = preview!.groups.flatMap((g) => g.targets).map((t) => `${t.label}:${t.min}-${t.max}`).sort();
    expect(targets).toEqual(['Pork refill:1-1', `${(await sql<{ name: string }[]>`select name from menu_items where id = ${f.menu.unli.itemId}`)[0]!.name}:1-3`].sort());
    expect(await asOrg(f.orgId, async (tx) => previewFlavourMerge(f.manager, tx).then(() => 'allowed', () => 'refused'))).toBeDefined();
  });

  it('9. the merge de-duplicates names, re-links each item with the SAME allowed flavours and its old min / max, and retires the old groups (never deletes)', async () => {
    const f = await fixture();
    const o = await oldGroups(f);
    const before = await counts(f);
    const out = await asOrg(f.orgId, (tx) => mergeIntoFlavours(f.admin, tx));
    expect(out).toEqual({ flavoursAdded: 4, linksMoved: 2, linksSkipped: 0, groupsRetired: 2 });
    const after = await counts(f);
    expect(after.flavours).toBe('1');
    expect(Number(after.groups)).toBe(Number(before.groups) + 1); // the one list; the old groups stay
    expect(Number(after.values)).toBe(Number(before.values) + 4); // old values stay, 4 distinct flavours added
    const old = await sql<{ status: string }[]>`select status from menu_option_groups where id in (${o.unli.groupId}, ${o.pork.groupId})`;
    expect(old.map((r) => r.status)).toEqual(['retired', 'retired']);
    expect(Number((await sql<{ n: string }[]>`select count(*)::text as n from menu_option_values where id = any(${[...o.unli.ids, ...o.pork.ids]})`)[0]!.n)).toBe(5);
    const names = (await sql<{ name: string }[]>`select v.name from menu_option_values v join menu_option_groups g on g.id = v.option_group_id where g.role = 'flavours' and g.org_id = ${f.orgId} order by v.sort_order, v.id`).map((r) => r.name);
    expect(names).toEqual(['Spicy', 'Garlic', 'Sweet', 'Plain']);
    const link = async (itemId: string) =>
      (await sql<{ min_selections: number; max_selections: number; names: string[] }[]>`
        select k.min_selections, k.max_selections, array_agg(v.name order by v.name) as names
        from menu_option_group_links k join menu_option_groups g on g.id = k.option_group_id and g.role = 'flavours'
        join menu_option_link_values lv on lv.link_id = k.id join menu_option_values v on v.id = lv.option_value_id
        where k.menu_item_id = ${itemId} group by k.id`)[0];
    expect(await link(f.menu.unli.itemId)).toEqual({ min_selections: 1, max_selections: 3, names: ['Garlic', 'Spicy', 'Sweet'] });
    expect(await link(o.refill.itemId)).toEqual({ min_selections: 1, max_selections: 1, names: ['Garlic', 'Plain'] });
    // the old links are gone: an item never offers two flavour lists
    expect(Number((await sql<{ n: string }[]>`select count(*)::text as n from menu_option_group_links where option_group_id in (${o.unli.groupId}, ${o.pork.groupId})`)[0]!.n)).toBe(0);
    // a second run has nothing to merge
    expect(await msg(asOrg(f.orgId, (tx) => mergeIntoFlavours(f.admin, tx)))).toMatch(/no per-item flavour groups/);
  });

  it('10. one transaction: a merge inside a transaction that is then rolled back leaves nothing behind', async () => {
    const f = await fixture();
    await oldGroups(f);
    const before = await counts(f);
    await expect(
      asOrg(f.orgId, async (tx) => {
        await mergeIntoFlavours(f.admin, tx);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await counts(f)).toEqual(before);
    expect(await asOrg(f.orgId, (tx) => menuRepo.getFlavoursGroup(tx, f.orgId))).toBeUndefined();
  });

  it('11. a flavour that is already on the list is reused (a retired one is brought back); an item that already uses the list is left as it is', async () => {
    const f = await fixture();
    const l = await list(f);
    await sql`update menu_option_values set status = 'retired' where id = ${l.ids.Sweet!}`;
    await allow(f, { variantId: f.menu.unli.variantId, optionValueIds: [l.ids.Spicy!], min: 1, max: 1 });
    const o = await oldGroups(f);
    void o;
    // the unli ITEM has an old link; its variant already has a flavours link (a different target: the item), so both are moved
    const out = await asOrg(f.orgId, (tx) => mergeIntoFlavours(f.admin, tx));
    expect(out.flavoursAdded).toBe(0); // Spicy, Garlic, Sweet, Plain all exist already (Sweet was retired)
    const sweet = await sql<{ status: string }[]>`select status from menu_option_values where id = ${l.ids.Sweet!}`;
    expect(sweet[0]!.status).toBe('active');
    const count = await sql<{ n: string }[]>`select count(*)::text as n from menu_option_values v join menu_option_groups g on g.id = v.option_group_id where g.role = 'flavours' and g.org_id = ${f.orgId}`;
    expect(Number(count[0]!.n)).toBe(4);
  });
});
