/**
 * T-401 S1 (migration 0196) - I10 (package -> refill pairing, DB half) and I11 (org isolation; same-org composite FKs).
 * docs/tasks/401-erp-menu-catalog-master.md sections 2 (R8, R10) and 3-4. TESTER, not BUILDER.
 *
 * Red today: the menu_* tables do not exist (`relation ... does not exist` from the fixture). Once they do,
 * I11 proves the isolation as shareat_app (RLS) AND that the composite FK refuses a cross-org reference even for
 * the OWNER (which bypasses RLS), so the two layers are each shown to be a real backstop (bible 15.11).
 */
import { afterAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';

import { asApp, insOffer, insOptionOffer, insRule, menuFixture, newItem, newOption, refusal, sql, type MenuFx } from './_fixtures/t401-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

// =================================================================================================
describe('I10 -- package refills: package -> refill only; unique pair; unlink allowed', () => {
  const link = (f: MenuFx, packageVariant: string, refillItem: string) =>
    sql`insert into menu_package_refills (org_id, package_variant_id, refill_item_id, created_by)
        values (${f.orgId}, ${packageVariant}, ${refillItem}, ${f.personId}) returning id`;

  it('package variant + refill item accepted; duplicate pair -> 23505', async () => {
    const f = await menuFixture('i10a');
    const pkg = await newItem(f, 'package');
    const refill = await newItem(f, 'refill');
    expect(await refusal(() => link(f, pkg.variantId, refill.itemId))).toBeUndefined();
    expect((await refusal(() => link(f, pkg.variantId, refill.itemId)))?.code).toBe('23505');
  });

  it('wrong types refused: a_la_carte variant as the package side; a package item as the refill side', async () => {
    const f = await menuFixture('i10b');
    const pkg = await newItem(f, 'package');
    const refill = await newItem(f, 'refill');
    const e1 = await refusal(() => link(f, f.variantId, refill.itemId)); // a_la_carte variant
    expect(e1, 'a non-package variant was accepted as the package side').toBeDefined();
    expect(e1!.message).toMatch(/package|refill/i);
    const e2 = await refusal(() => link(f, pkg.variantId, f.itemId)); // a_la_carte item as refill
    expect(e2, 'a non-refill item was accepted as the refill side').toBeDefined();
    expect(e2!.message).toMatch(/package|refill/i);
    const e3 = await refusal(() => link(f, refill.variantId, refill.itemId)); // refill variant as package side
    expect(e3).toBeDefined();
    const n = (await sql<{ n: number }[]>`select count(*)::int n from menu_package_refills where org_id = ${f.orgId}`)[0]!.n;
    expect(n).toBe(0);
  });

  it('unlink (DELETE) is allowed; UPDATE is not granted/allowed (no UPDATE on the table)', async () => {
    const f = await menuFixture('i10c');
    const pkg = await newItem(f, 'package');
    const r1 = await newItem(f, 'refill');
    const r2 = await newItem(f, 'refill');
    const [row] = await link(f, pkg.variantId, r1.itemId);
    const r = await asApp(f.orgId, async (tx) => {
      const up = await refusal(() => tx.unsafe(`update menu_package_refills set refill_item_id = '${r2.itemId}' where id = '${row!.id}'`));
      return up?.code;
    });
    expect(r.value, 'shareat_app must hold no UPDATE on menu_package_refills (42501)').toBe('42501');
    const del = await asApp(f.orgId, (tx) => tx.unsafe(`delete from menu_package_refills where id = '${row!.id}' returning id`));
    expect(del.err).toBeUndefined();
    expect(del.value).toHaveLength(1);
  });

  it('option-group links: exactly one of item / variant (num_nonnulls = 1) -> 23514; unique per target+group -> 23505; unlink allowed', async () => {
    const f = await menuFixture('i10d');
    const { groupId } = await newOption(f);
    const both = await refusal(
      () => sql`insert into menu_option_group_links (org_id, option_group_id, menu_item_id, variant_id, sort_order, created_by)
                values (${f.orgId}, ${groupId}, ${f.itemId}, ${f.variantId}, 0, ${f.personId})`,
    );
    expect(both?.code).toBe('23514');
    const none = await refusal(
      () => sql`insert into menu_option_group_links (org_id, option_group_id, sort_order, created_by)
                values (${f.orgId}, ${groupId}, 0, ${f.personId})`,
    );
    expect(none?.code).toBe('23514');
    const ins = () => sql`insert into menu_option_group_links (org_id, option_group_id, menu_item_id, sort_order, created_by)
                          values (${f.orgId}, ${groupId}, ${f.itemId}, 0, ${f.personId}) returning id`;
    const [row] = await ins();
    expect((await refusal(ins))?.code).toBe('23505');
    expect(await refusal(() => sql`delete from menu_option_group_links where id = ${row!.id}`)).toBeUndefined();
  });

  it('option group CHECKs: max >= max(min,1); single => max = 1', async () => {
    const f = await menuFixture('i10e');
    const ins = (mode: string, min: number, max: number) =>
      sql`insert into menu_option_groups (org_id, name, selection_mode, min_selections, max_selections, status, created_by)
          values (${f.orgId}, ${`G${mode}${min}${max}`}, ${mode}, ${min}, ${max}, 'active', ${f.personId})`;
    expect((await refusal(() => ins('multi', 3, 2)))?.code).toBe('23514'); // max < min
    expect((await refusal(() => ins('multi', 0, 0)))?.code).toBe('23514'); // max < 1
    expect((await refusal(() => ins('single', 1, 2)))?.code).toBe('23514'); // single => max 1
    expect(await refusal(() => ins('multi', 0, 3))).toBeUndefined();
    expect(await refusal(() => ins('single', 1, 1))).toBeUndefined();
  });

  it('categories: a parent has no parent; a retired category holds no active item; names unique per org (case-insensitive)', async () => {
    const f = await menuFixture('i10f');
    const mk = (name: string, parent: string | null) =>
      sql<{ id: string }[]>`insert into menu_categories (org_id, name, parent_id, sort_order, status, created_by)
                            values (${f.orgId}, ${name}, ${parent}, 0, 'active', ${f.personId}) returning id`;
    const [top] = await mk('Drinks', null);
    const [sub] = await mk('Soda', top!.id);
    const grand = await refusal(() => mk('Cola', sub!.id));
    expect(grand, 'a third level was accepted').toBeDefined();
    expect((await refusal(() => mk('DRINKS', null)))?.code).toBe('23505');
    // fixture category holds an active item
    const err = await refusal(() => sql`update menu_categories set status = 'retired' where id = ${f.categoryId}`);
    expect(err, 'a category with an active item was retired').toBeDefined();
    expect(err!.message).toMatch(/item|category/i);
  });
});

// =================================================================================================
const MENU_TABLES = [
  'menu_categories',
  'menu_items',
  'menu_item_variants',
  'menu_option_groups',
  'menu_option_values',
  'menu_option_group_links',
  'menu_package_refills',
  'menu_depletion_rules',
  'menu_offers',
  'menu_option_offers',
  'menu_item_requests',
  'menu_pos_v1_links',
  'menu_usage_source_switches',
] as const;

/** Org A populated in all thirteen tables (as the owner). */
async function populate(f: MenuFx) {
  const pkg = await newItem(f, 'package');
  const refill = await newItem(f, 'refill');
  const { groupId, valueId } = await newOption(f);
  await sql`insert into menu_option_group_links (org_id, option_group_id, menu_item_id, sort_order, created_by)
            values (${f.orgId}, ${groupId}, ${f.itemId}, 0, ${f.personId})`;
  await sql`insert into menu_package_refills (org_id, package_variant_id, refill_item_id, created_by)
            values (${f.orgId}, ${pkg.variantId}, ${refill.itemId}, ${f.personId})`;
  await insRule(f, f.variantId);
  await insOffer(f, f.variantId, '10.00');
  await insOptionOffer(f, valueId, '1.00');
  await sql`insert into menu_item_requests (org_id, store_id, requested_by, name, item_type, note, status, created_by)
            values (${f.orgId}, ${f.storeId}, ${f.personId}, 'Req', 'a_la_carte', 'x', 'open', ${f.personId})`;
  await sql`insert into menu_pos_v1_links (org_id, store_id, pos_item_key, variant_id, status, created_by)
            values (${f.orgId}, ${f.storeId}, 'KEY-POP', ${f.variantId}, 'active', ${f.personId})`;
  await sql`insert into menu_usage_source_switches (org_id, store_id, source, created_by)
            values (${f.orgId}, ${f.storeId}, 'pos_item_maps', ${f.personId})`;
}

describe('I11 -- org isolation', () => {
  it('as shareat_app, org B reads 0 rows of org A in each of the thirteen tables; org A reads its own (mutant: one table missing its policy)', async () => {
    const a = await menuFixture('i11a');
    const b = await menuFixture('i11b');
    await populate(a);
    for (const t of MENU_TABLES) {
      const own = await asApp(a.orgId, async (tx) => (await tx.unsafe(`select count(*)::int as n from ${t} where org_id = '${a.orgId}'`))[0]!.n as number);
      expect(own.err, `${t}: org A could not read its own rows: ${own.err?.message}`).toBeUndefined();
      expect(own.value, `${t}: org A sees none of its own rows (positive control)`).toBeGreaterThan(0);
      const other = await asApp(b.orgId, async (tx) => (await tx.unsafe(`select count(*)::int as n from ${t} where org_id = '${a.orgId}'`))[0]!.n as number);
      expect(other.err).toBeUndefined();
      expect(other.value, `${t}: org B can read org A's rows`).toBe(0);
    }
  });

  it('as shareat_app (org B), an INSERT stamped org A is refused by RLS (42501) on ALL THIRTEEN tables, with every other column valid', async () => {
    const a = await menuFixture('i11c');
    const b = await menuFixture('i11d');
    await populate(b); // B's rules, variants etc. exist, so the only thing wrong with each row is the org stamp
    const bp = await newItem(b, 'package');
    const br = await newItem(b, 'refill');
    const bo = await newOption(b);
    const bo2 = await newOption(b);
    const A = a.orgId;
    const by = b.personId; // valid in the inserting org
    const stmts: Record<(typeof MENU_TABLES)[number], (tx: postgres.TransactionSql) => Promise<unknown>> = {
      menu_categories: (tx) => tx`insert into menu_categories (org_id, name, sort_order, status, created_by) values (${A}, 'Sneaky', 0, 'active', ${by})`,
      menu_items: (tx) => tx`insert into menu_items (org_id, category_id, name, item_type, sold_a_la_carte, sold_in_package_session, diner_orderable, sort_order, status, created_by)
                             values (${A}, ${b.categoryId}, 'Sneaky', 'a_la_carte', true, false, true, 0, 'active', ${by})`,
      menu_item_variants: (tx) => tx`insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by)
                                     values (${A}, ${b.itemId}, 'Sneaky', false, 1, 'active', ${by})`,
      menu_option_groups: (tx) => tx`insert into menu_option_groups (org_id, name, selection_mode, min_selections, max_selections, status, created_by)
                                     values (${A}, 'Sneaky', 'single', 1, 1, 'active', ${by})`,
      menu_option_values: (tx) => tx`insert into menu_option_values (org_id, option_group_id, name, sort_order, status, created_by)
                                     values (${A}, ${bo.groupId}, 'Sneaky', 0, 'active', ${by})`,
      menu_option_group_links: (tx) => tx`insert into menu_option_group_links (org_id, option_group_id, menu_item_id, sort_order, created_by)
                                          values (${A}, ${bo2.groupId}, ${b.itemId}, 0, ${by})`,
      menu_package_refills: (tx) => tx`insert into menu_package_refills (org_id, package_variant_id, refill_item_id, created_by)
                                       values (${A}, ${bp.variantId}, ${br.itemId}, ${by})`,
      menu_depletion_rules: (tx) => tx`insert into menu_depletion_rules (org_id, variant_id, mode, item_id, quantity_per_sale, created_by)
                                       values (${A}, ${b.variantId}, 'direct', ${b.stockItemId}, 1, ${by})`,
      menu_offers: (tx) => tx`insert into menu_offers (org_id, store_id, variant_id, channel, effective_from, amount, withdrawn, created_by)
                              values (${A}, ${b.storeId}, ${b.variantId}, 'online', now(), 10, false, ${by})`,
      menu_option_offers: (tx) => tx`insert into menu_option_offers (org_id, store_id, option_value_id, channel, effective_from, price_delta, withdrawn, created_by)
                                     values (${A}, ${b.storeId}, ${bo.valueId}, 'online', now(), 1, false, ${by})`,
      menu_item_requests: (tx) => tx`insert into menu_item_requests (org_id, store_id, requested_by, name, item_type, note, status, created_by)
                                     values (${A}, ${b.storeId}, ${by}, 'Sneaky', 'a_la_carte', 'x', 'open', ${by})`,
      menu_pos_v1_links: (tx) => tx`insert into menu_pos_v1_links (org_id, store_id, pos_item_key, variant_id, status, created_by)
                                    values (${A}, ${b.storeId}, 'SNEAKY-KEY', ${b.variantId}, 'active', ${by})`,
      menu_usage_source_switches: (tx) => tx`insert into menu_usage_source_switches (org_id, store_id, source, created_by)
                                             values (${A}, ${b.storeId}, 'pos_item_maps', ${by})`,
    };
    for (const t of MENU_TABLES) {
      const r = await asApp(b.orgId, (tx) => stmts[t](tx));
      expect(r.err, `${t}: cross-org INSERT accepted`).toBeDefined();
      expect(r.err!.code, `${t}: ${r.err!.message}`).toBe('42501');
      expect(r.err!.message, `${t}: must be the RLS policy, not a grant`).toMatch(/row-level security/i);
    }
  });

  it('FORCE ROW LEVEL SECURITY is on for all thirteen menu tables (the owner does not bypass the policy)', async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relname, relrowsecurity, relforcerowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'r' and relname = any(${[...MENU_TABLES]})`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...MENU_TABLES].sort());
    const notForced = rows.filter((r) => !r.relrowsecurity || !r.relforcerowsecurity).map((r) => r.relname);
    expect(notForced, `RLS not enabled+forced on: ${notForced.join(', ')}`).toEqual([]);
  });

  it('composite FK: an offer for org A pointing at ORG B\'s store is refused, even for the OWNER (23503)', async () => {
    const a = await menuFixture('i11e');
    const b = await menuFixture('i11f');
    await insRule(a, a.variantId);
    const err = await refusal(
      () => sql`insert into menu_offers (org_id, store_id, variant_id, channel, amount, withdrawn, created_by)
                values (${a.orgId}, ${b.storeId}, ${a.variantId}, 'store', 10, false, ${a.personId})`,
    );
    expect(err?.code).toBe('23503');
    expect(err!.message).toMatch(/same_org|store/i);
  });

  it('composite FK: a variant (org A) pointing at ORG B\'s item is refused (23503)', async () => {
    const a = await menuFixture('i11g');
    const b = await menuFixture('i11h');
    const err = await refusal(
      () => sql`insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by)
                values (${a.orgId}, ${b.itemId}, 'X', false, 1, 'active', ${a.personId})`,
    );
    expect(err?.code).toBe('23503');
  });

  it('composite FKs on the other edges: item -> category, rule -> stock item, option value -> group, offer -> variant (23503 each)', async () => {
    const a = await menuFixture('i11i');
    const b = await menuFixture('i11j');
    const { groupId: bGroup } = await newOption(b);
    const cases: [string, () => PromiseLike<unknown>][] = [
      [
        'menu_items.category_id',
        () => sql`insert into menu_items (org_id, category_id, name, item_type, sold_a_la_carte, sold_in_package_session, diner_orderable, sort_order, status, created_by)
                  values (${a.orgId}, ${b.categoryId}, 'Zed', 'a_la_carte', true, false, true, 0, 'active', ${a.personId})`,
      ],
      [
        'menu_depletion_rules.item_id',
        () => sql`insert into menu_depletion_rules (org_id, variant_id, mode, item_id, quantity_per_sale, created_by)
                  values (${a.orgId}, ${a.variantId}, 'direct', ${b.stockItemId}, 1, ${a.personId})`,
      ],
      [
        'menu_option_values.option_group_id',
        () => sql`insert into menu_option_values (org_id, option_group_id, name, sort_order, status, created_by)
                  values (${a.orgId}, ${bGroup}, 'V', 0, 'active', ${a.personId})`,
      ],
      [
        'menu_offers.variant_id',
        () => sql`insert into menu_offers (org_id, store_id, variant_id, channel, withdrawn, created_by)
                  values (${a.orgId}, ${a.storeId}, ${b.variantId}, 'store', true, ${a.personId})`,
      ],
    ];
    for (const [name, run] of cases) {
      const err = await refusal(run);
      expect(err?.code, `${name}: cross-org reference accepted or refused for the wrong reason (${err?.message})`).toBe('23503');
    }
  });
});
