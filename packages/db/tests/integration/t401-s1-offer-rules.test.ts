/**
 * T-401 S1 (migration 0196) - I3, I4, I5, I5b, I6, I7, I8, I13 (DB half). docs/tasks/401-erp-menu-catalog-master.md
 * sections 2 (R2, R5, R6) and 3-4. TESTER, not BUILDER. Real Postgres, raw SQL as the migration role.
 *
 * Red today: the menu_* tables do not exist, so each fixture fails on `relation ... does not exist`. That is the
 * missing migration, not the assertion that counts. Once 0196 lands each case asserts a specific refusal AND a
 * positive control, so a trigger that refuses everything is caught as well as one that refuses nothing.
 * Refusal TEXT is matched loosely on the spec's words; SQLSTATE is pinned only for CHECK (23514) and UNIQUE (23505).
 */
import { afterAll, describe, expect, it } from 'vitest';

import { insOffer, insOptionOffer, insRule, insWithdrawn, menuFixture, newItem, newOption, refusal, sql, uid } from './_fixtures/t401-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const count = async (table: string, orgId: string) =>
  ((await sql.unsafe(`select count(*)::int as n from ${table} where org_id = '${orgId}'`)) as unknown as [{ n: number }])[0].n;

// =================================================================================================
describe('I3 -- a refill offer carries no amount; a non-refill live offer must', () => {
  it('refill + amount refused; refill + NULL amount accepted (with a rule in force)', async () => {
    const f = await menuFixture('i3a');
    const refill = await newItem(f, 'refill');
    await insRule(f, refill.variantId);
    const err = await refusal(() => insOffer(f, refill.variantId, '10.00'));
    expect(err, 'a refill offer carrying an amount was accepted').toBeDefined();
    expect(err!.message).toMatch(/refill/i);
    expect(await count('menu_offers', f.orgId)).toBe(0);
    expect(await refusal(() => insOffer(f, refill.variantId, null))).toBeUndefined();
  });

  it('non-refill live offer with NULL amount refused; with an amount accepted (mutant: trigger checks only one direction)', async () => {
    const f = await menuFixture('i3b');
    await insRule(f, f.variantId);
    const err = await refusal(() => insOffer(f, f.variantId, null));
    expect(err, 'a live a_la_carte offer with no amount was accepted').toBeDefined();
    expect(err!.message).toMatch(/amount/i);
    expect(await refusal(() => insOffer(f, f.variantId, '10.00'))).toBeUndefined();
  });

  it('a WITHDRAWN offer with an amount is refused (CHECK withdrawn => amounts NULL); withdrawn with none accepted', async () => {
    const f = await menuFixture('i3c');
    const err = await refusal(
      () => sql`insert into menu_offers (org_id, store_id, variant_id, channel, amount, withdrawn, created_by)
                values (${f.orgId}, ${f.storeId}, ${f.variantId}, 'store', 10, true, ${f.personId})`,
    );
    expect(err?.code).toBe('23514');
    // a withdrawn row needs no depletion rule (it is not live)
    expect(await refusal(() => insWithdrawn(f, f.variantId))).toBeUndefined();
  });
});

// =================================================================================================
describe('I4 -- bundle pricing only on a package; bundle_heads and extra_head_amount both or neither', () => {
  it('bundle columns on an a_la_carte variant refused; on a package accepted (mutant: no package check)', async () => {
    const f = await menuFixture('i4a');
    await insRule(f, f.variantId);
    const err = await refusal(
      () => sql`insert into menu_offers (org_id, store_id, variant_id, channel, amount, bundle_heads, extra_head_amount, withdrawn, created_by)
                values (${f.orgId}, ${f.storeId}, ${f.variantId}, 'store', 999, 4, 199, false, ${f.personId})`,
    );
    expect(err, 'a bundle offer on an a_la_carte variant was accepted').toBeDefined();
    expect(err!.message).toMatch(/bundle|package/i);

    const pkg = await newItem(f, 'package');
    await insRule(f, pkg.variantId);
    const ok = await refusal(
      () => sql`insert into menu_offers (org_id, store_id, variant_id, channel, amount, bundle_heads, extra_head_amount, withdrawn, created_by)
                values (${f.orgId}, ${f.storeId}, ${pkg.variantId}, 'store', 999, 4, 199, false, ${f.personId})`,
    );
    expect(ok, `bundle on a package must pass: ${ok?.message}`).toBeUndefined();
  });

  it.each([
    ['bundle_heads set, extra_head_amount NULL', 'bundle_heads, extra_head_amount', '4, null'],
    ['extra_head_amount set, bundle_heads NULL', 'bundle_heads, extra_head_amount', 'null, 199'],
    ['bundle_heads = 0', 'bundle_heads, extra_head_amount', '0, 199'],
  ])('%s -> 23514 (mutant: CHECK on the pair dropped)', async (_label, cols, vals) => {
    const f = await menuFixture('i4b');
    const pkg = await newItem(f, 'package');
    await insRule(f, pkg.variantId);
    const err = await refusal(
      () => sql.unsafe(`insert into menu_offers (org_id, store_id, variant_id, channel, amount, ${cols}, withdrawn, created_by)
                        values ('${f.orgId}', '${f.storeId}', '${pkg.variantId}', 'store', 999, ${vals}, false, '${f.personId}')`),
    );
    expect(err?.code).toBe('23514');
  });
});

// =================================================================================================
describe('I5 -- a live offer needs a depletion rule in force at its effective_from', () => {
  it('offer with no rule refused; rule first then offer accepted (mutant: no rule check at all)', async () => {
    const f = await menuFixture('i5a');
    const err = await refusal(() => insOffer(f, f.variantId, '10.00'));
    expect(err, 'a live offer with no rule in force was accepted').toBeDefined();
    expect(err!.message).toMatch(/depletion|rule/i);
    expect(await count('menu_offers', f.orgId)).toBe(0);
    await insRule(f, f.variantId);
    expect(await refusal(() => insOffer(f, f.variantId, '10.00'))).toBeUndefined();
  });

  it('a rule dated AFTER the offer does not cover it (mutant: trigger asks "any rule exists" not "in force at")', async () => {
    const f = await menuFixture('i5b');
    await insRule(f, f.variantId, '2 hours');
    const err = await refusal(() => insOffer(f, f.variantId, '10.00', '1 hour'));
    expect(err, 'an offer was accepted although its only rule starts later').toBeDefined();
    expect(err!.message).toMatch(/depletion|rule/i);
    // equal instants are covered (<=)
    expect(await refusal(() => insOffer(f, f.variantId, '10.00', '2 hours'))).toBeUndefined();
  });

  it('a withdrawn offer needs no rule (only LIVE offers do)', async () => {
    const f = await menuFixture('i5c');
    expect(await refusal(() => insWithdrawn(f, f.variantId))).toBeUndefined();
  });

  it('the rule must be for the same variant (a rule on another variant does not cover this one)', async () => {
    const f = await menuFixture('i5d');
    const other = await newItem(f, 'a_la_carte');
    await insRule(f, other.variantId);
    const err = await refusal(() => insOffer(f, f.variantId, '10.00'));
    expect(err).toBeDefined();
  });
});

// =================================================================================================
describe('I5b -- deleting a scheduled rule cannot orphan an offer; retiring a variant or item with a live offer is refused', () => {
  it('rule R2 from T, offer from T+1h relying on R2 alone -> DELETE R2 refused (mutant: rule delete skips the dependent-offer check)', async () => {
    const f = await menuFixture('i5b1');
    const [r2] = await insRule(f, f.variantId, '1 hour');
    await insOffer(f, f.variantId, '10.00', '2 hours');
    const err = await refusal(() => sql`delete from menu_depletion_rules where id = ${r2!.id}`);
    expect(err, 'a rule an offer relies on was deleted').toBeDefined();
    expect(err!.message).toMatch(/offer|depletion|rule/i);
    expect(await count('menu_depletion_rules', f.orgId)).toBe(1);
  });

  it('with an earlier rule R1 still covering the offer, DELETE R2 is allowed', async () => {
    const f = await menuFixture('i5b2');
    await insRule(f, f.variantId); // R1, in force now
    const [r2] = await insRule(f, f.variantId, '1 hour');
    await insOffer(f, f.variantId, '10.00', '2 hours');
    const err = await refusal(() => sql`delete from menu_depletion_rules where id = ${r2!.id}`);
    expect(err, `R1 covers the offer, so R2 may go: ${err?.message}`).toBeUndefined();
  });

  it('retire a variant with an offer IN FORCE: refused; after a withdrawal in force: allowed', async () => {
    const f = await menuFixture('i5b3');
    const sib = await newItem(f, 'a_la_carte'); // a second item; the variant under test is a non-default sibling
    await insRule(f, sib.variantId);
    const [v2] = await sql<{ id: string }[]>`
      insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by)
      values (${f.orgId}, ${sib.itemId}, 'Large', false, 1, 'active', ${f.personId}) returning id`;
    await insRule(f, v2!.id);
    await insOffer(f, v2!.id, '10.00');
    const err = await refusal(() => sql`update menu_item_variants set status = 'retired' where id = ${v2!.id}`);
    expect(err, 'a variant with a live offer in force was retired').toBeDefined();
    expect(err!.message).toMatch(/offer|withdraw/i);
    await insWithdrawn(f, v2!.id);
    const ok = await refusal(() => sql`update menu_item_variants set status = 'retired' where id = ${v2!.id}`);
    expect(ok, `after withdrawal the retire must pass: ${ok?.message}`).toBeUndefined();
  });

  it('retire a variant with a SCHEDULED live offer: refused; after the future offer is cancelled (deleted): allowed', async () => {
    const f = await menuFixture('i5b4');
    const sib = await newItem(f, 'a_la_carte');
    const [v2] = await sql<{ id: string }[]>`
      insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by)
      values (${f.orgId}, ${sib.itemId}, 'Large', false, 1, 'active', ${f.personId}) returning id`;
    await insRule(f, v2!.id);
    const [offer] = await insOffer(f, v2!.id, '10.00', '1 day');
    expect(await refusal(() => sql`update menu_item_variants set status = 'retired' where id = ${v2!.id}`)).toBeDefined();
    await sql`delete from menu_offers where id = ${offer!.id}`;
    expect(await refusal(() => sql`update menu_item_variants set status = 'retired' where id = ${v2!.id}`)).toBeUndefined();
  });

  it('retire an ITEM while any of its variants has a live offer in force: refused; after withdrawal: allowed', async () => {
    const f = await menuFixture('i5b5');
    await insRule(f, f.variantId);
    await insOffer(f, f.variantId, '10.00');
    const err = await refusal(() => sql`update menu_items set status = 'retired' where id = ${f.itemId}`);
    expect(err, 'an item with a live offer in force was retired').toBeDefined();
    expect(err!.message).toMatch(/offer|withdraw/i);
    await insWithdrawn(f, f.variantId);
    const ok = await refusal(() => sql`update menu_items set status = 'retired' where id = ${f.itemId}`);
    expect(ok, `after withdrawal the retire must pass: ${ok?.message}`).toBeUndefined();
  });

  it('retire an ITEM with a SCHEDULED live offer: refused', async () => {
    const f = await menuFixture('i5b6');
    await insRule(f, f.variantId);
    await insOffer(f, f.variantId, '10.00', '1 day');
    expect(await refusal(() => sql`update menu_items set status = 'retired' where id = ${f.itemId}`)).toBeDefined();
  });
});

// =================================================================================================
describe('I6 -- depletion rule shape = pos_item_maps shape; quantity > 0 and finite', () => {
  const ins = (f: Awaited<ReturnType<typeof menuFixture>>, mode: string, item: string | null, recipe: string | null, qty: string | null) =>
    sql`insert into menu_depletion_rules (org_id, variant_id, mode, item_id, recipe_id, quantity_per_sale, created_by)
        values (${f.orgId}, ${f.variantId}, ${mode}, ${item}, ${recipe}, ${qty}, ${f.personId})`;

  it('one good row per mode is accepted (direct / recipe / no_stock)', async () => {
    const f = await menuFixture('i6ok');
    const v2 = await newItem(f, 'a_la_carte');
    const v3 = await newItem(f, 'a_la_carte');
    expect(await refusal(() => ins(f, 'direct', f.stockItemId, null, '0.5'))).toBeUndefined();
    expect(
      await refusal(() => sql`insert into menu_depletion_rules (org_id, variant_id, mode, recipe_id, quantity_per_sale, created_by)
                              values (${f.orgId}, ${v2.variantId}, 'recipe', ${f.recipeId}, 1, ${f.personId})`),
    ).toBeUndefined();
    expect(
      await refusal(() => sql`insert into menu_depletion_rules (org_id, variant_id, mode, created_by)
                              values (${f.orgId}, ${v3.variantId}, 'no_stock', ${f.personId})`),
    ).toBeUndefined();
  });

  it.each([
    ['direct without item_id', 'direct', 'none', '0.5'],
    ['direct without quantity', 'direct', 'item', null],
    ['recipe without recipe_id', 'recipe', 'none', '1'],
    ['no_stock carrying an item_id', 'no_stock', 'item', null],
    ['no_stock carrying a recipe_id', 'no_stock', 'recipe', null],
    ['unknown mode', 'mystery', 'none', '1'],
  ])('%s -> 23514', async (_l, mode, carry, qty) => {
    const f = await menuFixture('i6bad');
    const err = await refusal(() => ins(f, mode, carry === 'item' ? f.stockItemId : null, carry === 'recipe' ? f.recipeId : null, qty));
    expect(err?.code).toBe('23514');
  });

  it('recipe mode carrying an item_id is refused (mutant: recipe branch accepts item_id)', async () => {
    // NOTE: the pos_item_maps_mode_shape_check it copies does NOT forbid this; section 4 I6 says it must. See QUESTION in report.
    const f = await menuFixture('i6rec');
    const err = await refusal(() => ins(f, 'recipe', f.stockItemId, f.recipeId, '1'));
    expect(err?.code).toBe('23514');
  });

  it.each([['0'], ['-1'], ['NaN']])('quantity_per_sale = %s -> 23514', async (qty) => {
    const f = await menuFixture('i6qty');
    const err = await refusal(() => ins(f, 'direct', f.stockItemId, null, qty));
    expect(err?.code).toBe('23514');
  });

  it('UNIQUE (variant, effective_from): two rules with the same instant -> 23505', async () => {
    const f = await menuFixture('i6uq');
    await insRule(f, f.variantId, '1 day');
    const err = await refusal(
      () => sql`insert into menu_depletion_rules (org_id, variant_id, effective_from, mode, item_id, quantity_per_sale, created_by)
                select org_id, variant_id, effective_from, mode, item_id, quantity_per_sale, created_by from menu_depletion_rules where org_id = ${f.orgId}`,
    );
    expect(err?.code).toBe('23505');
  });
});

// =================================================================================================
describe('I7 -- an active item has exactly one default variant', () => {
  it('a second default on the same item is refused (23505) (mutant: partial unique index dropped)', async () => {
    const f = await menuFixture('i7a');
    const err = await refusal(
      () => sql`insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by)
                values (${f.orgId}, ${f.itemId}, 'Large', true, 1, 'active', ${f.personId})`,
    );
    expect(err?.code).toBe('23505');
  });

  it('a non-default sibling variant is accepted; its label is unique per item (case-insensitive) (23505)', async () => {
    const f = await menuFixture('i7b');
    const ins = (label: string) => sql`insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by)
                                       values (${f.orgId}, ${f.itemId}, ${label}, false, 1, 'active', ${f.personId})`;
    expect(await refusal(() => ins('Large'))).toBeUndefined();
    expect((await refusal(() => ins('LARGE')))?.code).toBe('23505');
  });

  it('retiring the only default variant of an ACTIVE item is refused; the row stays active', async () => {
    const f = await menuFixture('i7c');
    const err = await refusal(() => sql`update menu_item_variants set status = 'retired' where id = ${f.variantId}`);
    expect(err, 'the default variant of an active item was retired').toBeDefined();
    expect(err!.message).toMatch(/default/i);
    const [row] = await sql<{ status: string }[]>`select status from menu_item_variants where id = ${f.variantId}`;
    expect(row!.status).toBe('active');
  });

  it('a retired item may have its default retired with it (control: the rule binds ACTIVE items only)', async () => {
    const f = await menuFixture('i7d');
    await sql`update menu_items set status = 'retired' where id = ${f.itemId}`;
    expect(await refusal(() => sql`update menu_item_variants set status = 'retired' where id = ${f.variantId}`)).toBeUndefined();
  });
});

// =================================================================================================
describe('I8 -- item_type is fixed once a variant has an offer; names are unique per org AND type', () => {
  it('type change refused once a variant has an offer; row unchanged (mutant: trigger checks variants instead of offers)', async () => {
    const f = await menuFixture('i8a');
    await insRule(f, f.variantId);
    await insOffer(f, f.variantId, '10.00');
    const err = await refusal(() => sql`update menu_items set item_type = 'package' where id = ${f.itemId}`);
    expect(err, 'item_type changed after an offer existed').toBeDefined();
    expect(err!.message).toMatch(/item_type|type/i);
    const [row] = await sql<{ item_type: string }[]>`select item_type from menu_items where id = ${f.itemId}`;
    expect(row!.item_type).toBe('a_la_carte');
  });

  it('type change with a variant but NO offer is allowed (the guard is about offers, not variants)', async () => {
    const f = await menuFixture('i8b');
    const err = await refusal(() => sql`update menu_items set item_type = 'package' where id = ${f.itemId}`);
    expect(err, `no offer yet, change must pass: ${err?.message}`).toBeUndefined();
  });

  it('a withdrawn-only history still counts as "has an offer" (a row exists): type change refused', async () => {
    const f = await menuFixture('i8c');
    await insWithdrawn(f, f.variantId);
    expect(await refusal(() => sql`update menu_items set item_type = 'package' where id = ${f.itemId}`)).toBeDefined();
  });

  it('a refill and an a_la_carte item both named "Pork" are accepted', async () => {
    const f = await menuFixture('i8d');
    expect(await refusal(() => newItem(f, 'a_la_carte', 'Pork'))).toBeUndefined();
    expect(await refusal(() => newItem(f, 'refill', 'Pork'))).toBeUndefined();
  });

  it('two refill items named "pork" and "Pork" are refused (23505): unique per org, type, lower(name)', async () => {
    const f = await menuFixture('i8e');
    await newItem(f, 'refill', 'pork');
    const err = await refusal(() => newItem(f, 'refill', 'Pork'));
    expect(err?.code).toBe('23505');
  });

  it('CHECK: a refill sold a la carte or in a package session -> 23514', async () => {
    const f = await menuFixture('i8f');
    for (const col of ['sold_a_la_carte', 'sold_in_package_session']) {
      const err = await refusal(
        () => sql.unsafe(`insert into menu_items (org_id, category_id, name, item_type, sold_a_la_carte, sold_in_package_session, diner_orderable, sort_order, status, created_by)
                          values ('${f.orgId}', '${f.categoryId}', '${uid('R')}', 'refill', ${col === 'sold_a_la_carte'}, ${col === 'sold_in_package_session'}, true, 0, 'active', '${f.personId}')`),
      );
      expect(err?.code, col).toBe('23514');
    }
  });
});

// =================================================================================================
describe('I13 (DB half) -- offer amounts >= 0, deltas signed, everything finite', () => {
  it('menu_offers.amount: negative and NaN -> 23514; zero accepted', async () => {
    const f = await menuFixture('i13a');
    await insRule(f, f.variantId);
    expect((await refusal(() => insOffer(f, f.variantId, '-0.01')))?.code).toBe('23514');
    expect((await refusal(() => insOffer(f, f.variantId, 'NaN')))?.code).toBe('23514');
    expect(await refusal(() => insOffer(f, f.variantId, '0.00'))).toBeUndefined();
  });

  it('menu_offers.extra_head_amount: negative -> 23514', async () => {
    const f = await menuFixture('i13b');
    const pkg = await newItem(f, 'package');
    await insRule(f, pkg.variantId);
    const err = await refusal(
      () => sql`insert into menu_offers (org_id, store_id, variant_id, channel, amount, bundle_heads, extra_head_amount, withdrawn, created_by)
                values (${f.orgId}, ${f.storeId}, ${pkg.variantId}, 'store', 999, 4, -1, false, ${f.personId})`,
    );
    expect(err?.code).toBe('23514');
  });

  it('menu_option_offers.price_delta: NEGATIVE accepted (signed, "no rice -10" is real); NaN refused; live NULL refused; withdrawn with a delta refused', async () => {
    const f = await menuFixture('i13c');
    const { valueId } = await newOption(f);
    expect(await refusal(() => insOptionOffer(f, valueId, '-10.00'))).toBeUndefined();
    const v2 = (await newOption(f)).valueId;
    expect((await refusal(() => insOptionOffer(f, v2, 'NaN')))?.code).toBe('23514');
    expect((await refusal(() => insOptionOffer(f, v2, null)))?.code).toBe('23514');
    const err = await refusal(
      () => sql`insert into menu_option_offers (org_id, store_id, option_value_id, channel, price_delta, withdrawn, created_by)
                values (${f.orgId}, ${f.storeId}, ${v2}, 'store', 5, true, ${f.personId})`,
    );
    expect(err?.code).toBe('23514');
  });

  it('channel is store|online only (offers and option offers) -> 23514', async () => {
    const f = await menuFixture('i13d');
    await insRule(f, f.variantId);
    const { valueId } = await newOption(f);
    expect((await refusal(() => insOffer(f, f.variantId, '10', null, 'grab')))?.code).toBe('23514');
    expect((await refusal(() => insOptionOffer(f, valueId, '1', null, 'grab')))?.code).toBe('23514');
    expect(await refusal(() => insOffer(f, f.variantId, '10', null, 'online'))).toBeUndefined();
  });

  it('same (store, variant, channel, effective_from) twice -> 23505; same instant on another channel accepted', async () => {
    const f = await menuFixture('i13e');
    await insRule(f, f.variantId);
    await insOffer(f, f.variantId, '10', '1 day');
    const dup = await refusal(
      () => sql`insert into menu_offers (org_id, store_id, variant_id, channel, effective_from, amount, withdrawn, created_by)
                select org_id, store_id, variant_id, channel, effective_from, 11, false, created_by from menu_offers where org_id = ${f.orgId}`,
    );
    expect(dup?.code).toBe('23505');
    expect(await refusal(() => insOffer(f, f.variantId, '10', '1 day', 'online'))).toBeUndefined();
  });
});
