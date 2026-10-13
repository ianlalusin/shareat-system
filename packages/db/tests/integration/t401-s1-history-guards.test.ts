/**
 * T-401 S1 audit round - history guards ALWAYS (replica mode), retired targets, stable parents, monotonic history.
 * TESTER. Real Postgres, raw SQL as the migration role (a superuser, so session_replication_role can be set).
 * Refusal text is matched loosely on the words a refusal must contain.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { insOffer, insOptionOffer, insRule, insSwitch, insWithdrawn, menuFixture, newItem, newOption, refusal, sql } from './_fixtures/t401-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** Run fn inside a transaction in replica mode (ordinary ENABLE ORIGIN triggers do not fire). Returns fn's error. */
async function inReplica(fn: (tx: typeof sql) => PromiseLike<unknown>) {
  return refusal(() =>
    sql.begin(async (tx) => {
      await tx.unsafe(`set local session_replication_role = 'replica'`);
      await fn(tx as unknown as typeof sql);
    }),
  );
}

// =================================================================================================
describe('H1 -- the four history UPDATE guards are ENABLE ALWAYS: an UPDATE is refused even in replica mode', () => {
  it('(sanity) the connection is a superuser, so replica mode is really in force', async () => {
    const [r] = await sql<{ s: boolean }[]>`select rolsuper s from pg_roles where rolname = current_user`;
    expect(r!.s).toBe(true);
  });

  it.each([
    ['menu_offers', 'amount'],
    ['menu_option_offers', 'price_delta'],
    ['menu_depletion_rules', 'quantity_per_sale'],
    ['menu_usage_source_switches', 'difference_count'],
  ])('%s: UPDATE under session_replication_role = replica is refused and the row is unchanged', async (table, col) => {
    const f = await menuFixture(`h1-${table}`);
    await insRule(f, f.variantId);
    const { valueId } = await newOption(f);
    if (table === 'menu_offers') await insOffer(f, f.variantId, '10.00');
    if (table === 'menu_option_offers') await insOptionOffer(f, valueId, '5.00');
    if (table === 'menu_usage_source_switches') await insSwitch(f, 'menu_rules', 'signed off', 1);
    const [{ id, before }] = (await sql.unsafe(`select id, ${col}::text as before from ${table} where org_id = '${f.orgId}' limit 1`)) as unknown as [{ id: string; before: string }];
    const err = await inReplica((tx) => tx.unsafe(`update ${table} set ${col} = 1.5 where id = '${id}'`));
    expect(err, `${table}: an UPDATE in replica mode was ACCEPTED (the guard is ENABLE ORIGIN, not ALWAYS)`).toBeDefined();
    expect(err!.message).toMatch(/append-only/i);
    const [{ after }] = (await sql.unsafe(`select ${col}::text as after from ${table} where id = '${id}'`)) as unknown as [{ after: string }];
    expect(after).toBe(before);
  });

  it('live tgenabled is A (ENABLE ALWAYS) for an UPDATE trigger on each of the four history tables', async () => {
    const rows = await sql<{ t: string; e: string }[]>`
      select c.relname t, tg.tgenabled::text e
        from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
       where not tg.tgisinternal and (tg.tgtype & 16) <> 0
         and c.relname in ('menu_offers', 'menu_option_offers', 'menu_depletion_rules', 'menu_usage_source_switches')`;
    for (const t of ['menu_offers', 'menu_option_offers', 'menu_depletion_rules', 'menu_usage_source_switches']) {
      const mine = rows.filter((r) => r.t === t);
      expect(mine.length, `${t}: no UPDATE trigger at all`).toBeGreaterThan(0);
      expect(mine.map((r) => r.e), `${t}: UPDATE guard is not ENABLE ALWAYS`).toContain('A');
    }
  });
});

// =================================================================================================
describe('R -- retired targets take no live offer', () => {
  async function siblingVariant(f: Awaited<ReturnType<typeof menuFixture>>) {
    const sib = await newItem(f, 'a_la_carte');
    const [v] = await sql<{ id: string }[]>`
      insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by)
      values (${f.orgId}, ${sib.itemId}, 'Large', false, 1, 'active', ${f.personId}) returning id`;
    await insRule(f, v!.id);
    return { itemId: sib.itemId, variantId: v!.id, defaultVariantId: sib.variantId };
  }

  it('a live offer for a RETIRED variant is refused; a withdrawn row is not (a retired variant may be withdrawn)', async () => {
    const f = await menuFixture('r1');
    const s = await siblingVariant(f);
    await sql`update menu_item_variants set status = 'retired' where id = ${s.variantId}`;
    const err = await refusal(() => insOffer(f, s.variantId, '10.00'));
    expect(err, 'a live offer for a retired variant was accepted').toBeDefined();
    expect(err!.message).toMatch(/retired/i);
    expect(await refusal(() => insWithdrawn(f, s.variantId))).toBeUndefined();
  });

  it('a live offer for a variant of a RETIRED item is refused', async () => {
    const f = await menuFixture('r2');
    await insRule(f, f.variantId);
    await sql`update menu_items set status = 'retired' where id = ${f.itemId}`;
    const err = await refusal(() => insOffer(f, f.variantId, '10.00'));
    expect(err, 'a live offer for a variant of a retired item was accepted').toBeDefined();
    expect(err!.message).toMatch(/retired/i);
  });

  it('an ACTIVE variant of an active item still takes an offer (control)', async () => {
    const f = await menuFixture('r3');
    const s = await siblingVariant(f);
    expect(await refusal(() => insOffer(f, s.variantId, '10.00'))).toBeUndefined();
  });
});

// =================================================================================================
describe('P -- parents stay put once referenced', () => {
  async function sibling(f: Awaited<ReturnType<typeof menuFixture>>, itemId: string, label: string) {
    const [v] = await sql<{ id: string }[]>`
      insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by)
      values (${f.orgId}, ${itemId}, ${label}, false, 1, 'active', ${f.personId}) returning id`;
    return v!.id;
  }
  const move = (variantId: string, itemId: string) => sql`update menu_item_variants set menu_item_id = ${itemId} where id = ${variantId}`;
  const itemOf = async (variantId: string) => (await sql<{ i: string }[]>`select menu_item_id i from menu_item_variants where id = ${variantId}`)[0]!.i;

  it('control: a variant with no offer and no refills row may move to another item', async () => {
    const f = await menuFixture('p0');
    const v = await sibling(f, f.itemId, 'Large');
    const other = await newItem(f, 'a_la_carte');
    expect(await refusal(() => move(v, other.itemId))).toBeUndefined();
  });

  it('menu_item_id of a variant with an ordinary offer cannot change; the row stays put', async () => {
    const f = await menuFixture('p1');
    const v = await sibling(f, f.itemId, 'Large');
    await insRule(f, v);
    await insOffer(f, v, '10.00');
    const other = await newItem(f, 'a_la_carte');
    const err = await refusal(() => move(v, other.itemId));
    expect(err, 'a variant with an offer was re-parented').toBeDefined();
    expect(err!.message).toMatch(/offer|menu_item_id|parent/i);
    expect(await itemOf(v)).toBe(f.itemId);
  });

  it('... nor with a BUNDLE offer', async () => {
    const f = await menuFixture('p2');
    const pkg = await newItem(f, 'package');
    const v = await sibling(f, pkg.itemId, 'Group');
    await insRule(f, v);
    await sql`insert into menu_offers (org_id, store_id, variant_id, channel, amount, bundle_heads, extra_head_amount, withdrawn, created_by)
              values (${f.orgId}, ${f.storeId}, ${v}, 'store', 999, 4, 199, false, ${f.personId})`;
    const other = await newItem(f, 'package');
    const err = await refusal(() => move(v, other.itemId));
    expect(err, 'a variant with a bundle offer was re-parented').toBeDefined();
    expect(await itemOf(v)).toBe(pkg.itemId);
  });

  it('... nor once a menu_package_refills row names it as the package variant', async () => {
    const f = await menuFixture('p3');
    const pkg = await newItem(f, 'package');
    const v = await sibling(f, pkg.itemId, 'Group');
    const refill = await newItem(f, 'refill');
    await sql`insert into menu_package_refills (org_id, package_variant_id, refill_item_id, created_by)
              values (${f.orgId}, ${v}, ${refill.itemId}, ${f.personId})`;
    const other = await newItem(f, 'package');
    const err = await refusal(() => move(v, other.itemId));
    expect(err, 'a variant named by package_refills was re-parented').toBeDefined();
    expect(await itemOf(v)).toBe(pkg.itemId);
  });

  it('a refill item\'s item_type cannot change while menu_package_refills references it; unreferenced it can', async () => {
    const f = await menuFixture('p4');
    const pkg = await newItem(f, 'package');
    const refill = await newItem(f, 'refill');
    const free = await newItem(f, 'refill');
    await sql`insert into menu_package_refills (org_id, package_variant_id, refill_item_id, created_by)
              values (${f.orgId}, ${pkg.variantId}, ${refill.itemId}, ${f.personId})`;
    const err = await refusal(() => sql`update menu_items set item_type = 'a_la_carte' where id = ${refill.itemId}`);
    expect(err, 'a referenced refill changed type').toBeDefined();
    expect(err!.message).toMatch(/refill|type/i);
    const [row] = await sql<{ t: string }[]>`select item_type t from menu_items where id = ${refill.itemId}`;
    expect(row!.t).toBe('refill');
    expect(await refusal(() => sql`update menu_items set item_type = 'a_la_carte' where id = ${free.itemId}`)).toBeUndefined();
  });
});

// =================================================================================================
describe('M -- monotonic history: a new row may not be EARLIER than the latest existing row for its key', () => {
  const EARLIER = /earlier|monoton|latest|before|out of order|order/i;

  it('menu_offers key (store, variant, channel): +1h after a row at +2h is refused; later accepted; other channel and other store accepted', async () => {
    const f = await menuFixture('m1');
    await insRule(f, f.variantId);
    await insOffer(f, f.variantId, '10.00', '2 hours');
    const err = await refusal(() => insOffer(f, f.variantId, '11.00', '1 hour'));
    expect(err, 'an offer earlier than the latest row for its key was accepted').toBeDefined();
    expect(err!.code, 'not the UNIQUE violation').not.toBe('23505');
    expect(err!.message).toMatch(EARLIER);
    expect(await refusal(() => insOffer(f, f.variantId, '12.00', '3 hours'))).toBeUndefined();
    expect(await refusal(() => insOffer(f, f.variantId, '11.00', '1 hour', 'online'))).toBeUndefined();
    expect(await refusal(() => insOffer({ ...f, storeId: f.store2Id }, f.variantId, '11.00', '1 hour'))).toBeUndefined();
  });

  it('a WITHDRAWN row also sets the latest: a live row earlier than it is refused', async () => {
    const f = await menuFixture('m2');
    await insRule(f, f.variantId);
    await insWithdrawn(f, f.variantId, '2 hours');
    const err = await refusal(() => insOffer(f, f.variantId, '11.00', '1 hour'));
    expect(err, 'a live offer earlier than a scheduled withdrawal was accepted').toBeDefined();
    expect(err!.message).toMatch(EARLIER);
  });

  it('menu_option_offers key (store, option_value, channel): earlier refused; later, other channel accepted', async () => {
    const f = await menuFixture('m3');
    const { valueId } = await newOption(f);
    await insOptionOffer(f, valueId, '5.00', '2 hours');
    const err = await refusal(() => insOptionOffer(f, valueId, '6.00', '1 hour'));
    expect(err, 'an option offer earlier than the latest row was accepted').toBeDefined();
    expect(err!.code).not.toBe('23505');
    expect(err!.message).toMatch(EARLIER);
    expect(await refusal(() => insOptionOffer(f, valueId, '6.00', '3 hours'))).toBeUndefined();
    expect(await refusal(() => insOptionOffer(f, valueId, '6.00', '1 hour', 'online'))).toBeUndefined();
  });

  it('menu_depletion_rules key (variant): earlier than the latest rule is refused; later accepted', async () => {
    const f = await menuFixture('m4');
    await insRule(f, f.variantId, '2 hours');
    const err = await refusal(() => insRule(f, f.variantId, '1 hour'));
    expect(err, 'a rule earlier than the latest rule was accepted').toBeDefined();
    expect(err!.code).not.toBe('23505');
    expect(err!.message).toMatch(EARLIER);
    expect(await refusal(() => insRule(f, f.variantId, '3 hours'))).toBeUndefined();
  });
});
