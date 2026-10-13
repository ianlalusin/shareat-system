/**
 * T-401 S1 (migration 0196) - the ERP menu and catalog master. docs/tasks/401-erp-menu-catalog-master.md sections 2-4.
 *
 * Thirteen org-scoped tables (ten at first; Ian's answers added requests, v1 links and usage-source switches). The variant is the sellable unit (R1). "Offer" means a STORE'S PRICE ROW for a variant on a
 * channel (R5): append-only, effective-dated, never UPDATEd, never back-dated; the offer in force at time t is the row
 * with the greatest `effective_from <= t`, `withdrawn` means "not sold from then", and no row means not offered. The
 * same shape carries depletion rules (R6) and option-value price deltas.
 *
 * What Drizzle cannot express is hand-added in migration 0196 (NOTE comments below): the case-insensitive unique
 * expression indexes, the partial unique indexes, the composite same-org FKs' parent UNIQUEs on items and
 * production_recipes, the SQL functions `menu_offer_in_force` / `menu_option_offer_in_force` /
 * `menu_variant_has_live_offer`, every trigger, RLS and the grants. No table or column here uses `session`, `receipt`,
 * `product` or `dine_in` (GLOSSARY, R11).
 *
 * Money is `numeric(14,2)` and always a string in code (bible section 6); depletion quantities are `numeric(14,6)`.
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { items } from './items';
import { organizations } from './organizations';
import { persons } from './persons';
import { productionRecipes } from './production';
import { stockLocations } from './stock-locations';
import { stores } from './stores';

export const MENU_STATUSES = ['active', 'retired'] as const;
export type MenuStatus = (typeof MENU_STATUSES)[number];

export const MENU_ITEM_TYPES = ['a_la_carte', 'package', 'refill'] as const;
export type MenuItemType = (typeof MENU_ITEM_TYPES)[number];

export const MENU_SELECTION_MODES = ['single', 'multi'] as const;
export type MenuSelectionMode = (typeof MENU_SELECTION_MODES)[number];

export const MENU_CHANNELS = ['store', 'online'] as const;
export type MenuChannel = (typeof MENU_CHANNELS)[number];

export const MENU_PRICING_MODES = ['fixed', 'fixed_markup', 'percent_markup'] as const;
export type MenuPricingMode = (typeof MENU_PRICING_MODES)[number];

export const MENU_REQUEST_STATUSES = ['open', 'approved', 'duplicate', 'rejected', 'withdrawn'] as const;
export type MenuRequestStatus = (typeof MENU_REQUEST_STATUSES)[number];

export const MENU_LINK_STATUSES = ['active', 'inactive'] as const;
export type MenuLinkStatus = (typeof MENU_LINK_STATUSES)[number];

export const MENU_USAGE_SOURCES = ['v1_pos_map', 'menu_rules'] as const;
export type MenuUsageSource = (typeof MENU_USAGE_SOURCES)[number];

export const MENU_DEPLETION_MODES = ['direct', 'recipe', 'no_stock'] as const;
export type MenuDepletionMode = (typeof MENU_DEPLETION_MODES)[number];

// NOTE: items_org_id_id_unique, production_recipes_org_id_id_unique and stock_locations_org_id_id_unique UNIQUE (org_id, id) are hand-added in
// migration 0196 (no Drizzle mirror on items.ts / production.ts): trivially true, they give the composite FKs below a
// real unique target (R10, the 0194 pattern).

/** R9: org-level, one optional level of parent. */
export const menuCategories = pgTable(
  'menu_categories',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => menuCategories.id, { onDelete: 'restrict' }),
    sortOrder: integer('sort_order').notNull().default(0),
    status: text('status', { enum: MENU_STATUSES }).notNull().default('active'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('menu_categories_org_id_id_unique').on(t.orgId, t.id),
    // NOTE: UNIQUE (org_id, lower(name)) - menu_categories_org_name_key, hand-added in migration 0196.
    index('menu_categories_parent_idx').on(t.parentId),
    check('menu_categories_name_not_blank_check', sql`length(trim(${t.name})) > 0`),
    check('menu_categories_status_check', sql`${t.status} in ('active','retired')`),
    check('menu_categories_not_own_parent_check', sql`${t.parentId} IS NULL OR ${t.parentId} <> ${t.id}`),
    foreignKey({
      columns: [t.orgId, t.parentId],
      foreignColumns: [t.orgId, t.id],
      name: 'menu_categories_parent_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'menu_categories_created_by_same_org_fk',
    }).onDelete('restrict'),
    // NOTE: triggers menu_categories_parent_guard (a parent has no parent) and menu_categories_retire_guard (a category
    // holding an active item cannot be retired), hand-added in migration 0196.
  ],
);

/** R2: `a_la_carte | package | refill`; add-on is the flag `sold_in_package_session`, not a type. */
export const menuItems = pgTable(
  'menu_items',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => menuCategories.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description'),
    itemType: text('item_type', { enum: MENU_ITEM_TYPES }).notNull(),
    soldALaCarte: boolean('sold_a_la_carte').notNull().default(false),
    soldInPackageSession: boolean('sold_in_package_session').notNull().default(false),
    /** v1 `customerEnabled`: whether a diner may order it. Not an offer column (R5). */
    dinerOrderable: boolean('diner_orderable').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    status: text('status', { enum: MENU_STATUSES }).notNull().default('active'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('menu_items_org_id_id_unique').on(t.orgId, t.id),
    // NOTE: UNIQUE (org_id, item_type, lower(name)) - menu_items_org_type_name_key, hand-added in migration 0196
    // (a "Pork" refill and a "Pork" a la carte item are both real).
    index('menu_items_category_idx').on(t.categoryId),
    check('menu_items_name_not_blank_check', sql`length(trim(${t.name})) > 0`),
    check('menu_items_item_type_check', sql`${t.itemType} in ('a_la_carte','package','refill')`),
    check('menu_items_status_check', sql`${t.status} in ('active','retired')`),
    check(
      'menu_items_refill_not_sold_check',
      sql`${t.itemType} <> 'refill' OR (NOT ${t.soldALaCarte} AND NOT ${t.soldInPackageSession})`,
    ),
    foreignKey({
      columns: [t.orgId, t.categoryId],
      foreignColumns: [menuCategories.orgId, menuCategories.id],
      name: 'menu_items_category_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'menu_items_created_by_same_org_fk',
    }).onDelete('restrict'),
    // NOTE: triggers menu_items_category_guard, menu_items_type_guard (item_type fixed once any variant has an offer)
    // and menu_items_retire_guard (refused while a live offer is in force or scheduled), hand-added in migration 0196.
  ],
);

/** R1: the variant is the sellable unit. Every item has exactly one default (label NULL only for the default). */
export const menuItemVariants = pgTable(
  'menu_item_variants',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    menuItemId: uuid('menu_item_id')
      .notNull()
      .references(() => menuItems.id, { onDelete: 'restrict' }),
    label: text('label'),
    isDefault: boolean('is_default').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    status: text('status', { enum: MENU_STATUSES }).notNull().default('active'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('menu_item_variants_org_id_id_unique').on(t.orgId, t.id),
    // NOTE: menu_item_variants_one_default_key UNIQUE (menu_item_id) WHERE is_default and
    // menu_item_variants_item_label_key UNIQUE (menu_item_id, lower(label)), hand-added in migration 0196.
    check('menu_item_variants_status_check', sql`${t.status} in ('active','retired')`),
    check(
      'menu_item_variants_label_check',
      sql`(${t.label} IS NULL AND ${t.isDefault}) OR (${t.label} IS NOT NULL AND length(trim(${t.label})) > 0)`,
    ),
    foreignKey({
      columns: [t.orgId, t.menuItemId],
      foreignColumns: [menuItems.orgId, menuItems.id],
      name: 'menu_item_variants_menu_item_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'menu_item_variants_created_by_same_org_fk',
    }).onDelete('restrict'),
    // NOTE: trigger menu_item_variants_retire_guard and the DEFERRED constraint trigger menu_item_variants_default_guard
    // (an active item keeps exactly one active default), hand-added in migration 0196.
  ],
);

/** R4: required = `min_selections > 0`, never a separate boolean. R3: flavours are option values in a group. */
export const menuOptionGroups = pgTable(
  'menu_option_groups',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    selectionMode: text('selection_mode', { enum: MENU_SELECTION_MODES }).notNull(),
    minSelections: integer('min_selections').notNull().default(0),
    maxSelections: integer('max_selections').notNull().default(1),
    status: text('status', { enum: MENU_STATUSES }).notNull().default('active'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('menu_option_groups_org_id_id_unique').on(t.orgId, t.id),
    check('menu_option_groups_name_not_blank_check', sql`length(trim(${t.name})) > 0`),
    check('menu_option_groups_selection_mode_check', sql`${t.selectionMode} in ('single','multi')`),
    check('menu_option_groups_status_check', sql`${t.status} in ('active','retired')`),
    check('menu_option_groups_min_check', sql`${t.minSelections} >= 0`),
    check('menu_option_groups_max_check', sql`${t.maxSelections} >= 1 AND ${t.maxSelections} >= ${t.minSelections}`),
    check('menu_option_groups_single_max_check', sql`${t.selectionMode} <> 'single' OR ${t.maxSelections} = 1`),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'menu_option_groups_created_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);

export const menuOptionValues = pgTable(
  'menu_option_values',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    optionGroupId: uuid('option_group_id')
      .notNull()
      .references(() => menuOptionGroups.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    status: text('status', { enum: MENU_STATUSES }).notNull().default('active'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('menu_option_values_org_id_id_unique').on(t.orgId, t.id),
    // NOTE: UNIQUE (option_group_id, lower(name)) - menu_option_values_group_name_key, hand-added in migration 0196.
    check('menu_option_values_name_not_blank_check', sql`length(trim(${t.name})) > 0`),
    check('menu_option_values_status_check', sql`${t.status} in ('active','retired')`),
    foreignKey({
      columns: [t.orgId, t.optionGroupId],
      foreignColumns: [menuOptionGroups.orgId, menuOptionGroups.id],
      name: 'menu_option_values_option_group_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'menu_option_values_created_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);

/** R4: a group is linked to an item OR a variant; a variant's links, if any, replace its item's. Unlink = DELETE. */
export const menuOptionGroupLinks = pgTable(
  'menu_option_group_links',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    optionGroupId: uuid('option_group_id')
      .notNull()
      .references(() => menuOptionGroups.id, { onDelete: 'restrict' }),
    menuItemId: uuid('menu_item_id').references(() => menuItems.id, { onDelete: 'restrict' }),
    variantId: uuid('variant_id').references(() => menuItemVariants.id, { onDelete: 'restrict' }),
    sortOrder: integer('sort_order').notNull().default(0),
    status: text('status', { enum: MENU_STATUSES }).notNull().default('active'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // NOTE: partial UNIQUEs (option_group_id, menu_item_id) WHERE menu_item_id IS NOT NULL and
    // (option_group_id, variant_id) WHERE variant_id IS NOT NULL, hand-added in migration 0196.
    index('menu_option_group_links_item_idx').on(t.menuItemId),
    index('menu_option_group_links_variant_idx').on(t.variantId),
    check('menu_option_group_links_one_target_check', sql`num_nonnulls(${t.menuItemId}, ${t.variantId}) = 1`),
    check('menu_option_group_links_status_check', sql`${t.status} in ('active','retired')`),
    foreignKey({
      columns: [t.orgId, t.optionGroupId],
      foreignColumns: [menuOptionGroups.orgId, menuOptionGroups.id],
      name: 'menu_option_group_links_option_group_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.menuItemId],
      foreignColumns: [menuItems.orgId, menuItems.id],
      name: 'menu_option_group_links_menu_item_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.variantId],
      foreignColumns: [menuItemVariants.orgId, menuItemVariants.id],
      name: 'menu_option_group_links_variant_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'menu_option_group_links_created_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);

/** R8: a package names its refills. No "empty means all" sentinel. Unlink = DELETE. */
export const menuPackageRefills = pgTable(
  'menu_package_refills',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    packageVariantId: uuid('package_variant_id')
      .notNull()
      .references(() => menuItemVariants.id, { onDelete: 'restrict' }),
    refillItemId: uuid('refill_item_id')
      .notNull()
      .references(() => menuItems.id, { onDelete: 'restrict' }),
    status: text('status', { enum: MENU_STATUSES }).notNull().default('active'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('menu_package_refills_pair_unique').on(t.packageVariantId, t.refillItemId),
    index('menu_package_refills_refill_idx').on(t.refillItemId),
    check('menu_package_refills_status_check', sql`${t.status} in ('active','retired')`),
    foreignKey({
      columns: [t.orgId, t.packageVariantId],
      foreignColumns: [menuItemVariants.orgId, menuItemVariants.id],
      name: 'menu_package_refills_package_variant_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.refillItemId],
      foreignColumns: [menuItems.orgId, menuItems.id],
      name: 'menu_package_refills_refill_item_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'menu_package_refills_created_by_same_org_fk',
    }).onDelete('restrict'),
    // NOTE: trigger menu_package_refills_pair_guard (package variant -> refill item only), hand-added in migration 0196.
  ],
);

/**
 * R6: depletion is mandatory and effective-dated: the `pos_item_maps` shape, append-only. Stricter than pos_item_maps
 * (I6): `recipe` and `direct` carry only their own reference. History table: triggers refuse back-dating, any UPDATE,
 * and a DELETE of a row in effect; a scheduled rule may go only if no live offer is left without a rule in force.
 */
export const menuDepletionRules = pgTable(
  'menu_depletion_rules',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => menuItemVariants.id, { onDelete: 'restrict' }),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    mode: text('mode', { enum: MENU_DEPLETION_MODES }).notNull(),
    itemId: uuid('item_id').references(() => items.id, { onDelete: 'restrict' }),
    recipeId: uuid('recipe_id').references(() => productionRecipes.id, { onDelete: 'restrict' }),
    /** In the stock item's base unit, as pos_item_maps. */
    quantityPerSale: numeric('quantity_per_sale', { precision: 14, scale: 6 }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('menu_depletion_rules_variant_effective_unique').on(t.variantId, t.effectiveFrom),
    index('menu_depletion_rules_org_idx').on(t.orgId),
    check('menu_depletion_rules_quantity_per_sale_finite_check', sql`${t.quantityPerSale} > '-Infinity'::numeric AND ${t.quantityPerSale} < 'Infinity'::numeric`),
    check('menu_depletion_rules_mode_check', sql`${t.mode} in ('direct','recipe','no_stock')`),
    check(
      'menu_depletion_rules_mode_shape_check',
      sql`(${t.mode} = 'direct' AND ${t.itemId} IS NOT NULL AND ${t.recipeId} IS NULL AND ${t.quantityPerSale} IS NOT NULL)
        OR (${t.mode} = 'recipe' AND ${t.recipeId} IS NOT NULL AND ${t.itemId} IS NULL)
        OR (${t.mode} = 'no_stock' AND ${t.itemId} IS NULL AND ${t.recipeId} IS NULL)`,
    ),
    check(
      'menu_depletion_rules_quantity_check',
      sql`${t.quantityPerSale} IS NULL OR (${t.quantityPerSale} > 0 AND ${t.quantityPerSale} < 'Infinity'::numeric)`,
    ),
    foreignKey({
      columns: [t.orgId, t.variantId],
      foreignColumns: [menuItemVariants.orgId, menuItemVariants.id],
      name: 'menu_depletion_rules_variant_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.itemId],
      foreignColumns: [items.orgId, items.id],
      name: 'menu_depletion_rules_item_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.recipeId],
      foreignColumns: [productionRecipes.orgId, productionRecipes.id],
      name: 'menu_depletion_rules_recipe_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'menu_depletion_rules_created_by_same_org_fk',
    }).onDelete('restrict'),
    // NOTE: triggers menu_depletion_rules_insert_guard / _update_guard / _delete_guard, hand-added in migration 0196.
  ],
);

/**
 * R5: the price is an OFFER. `amount` is the per-guest price on a per-head package offer, the bundle price on a bundle
 * offer (`bundle_heads` set, `extra_head_amount` charged per guest beyond), the unit price otherwise, and NULL on a
 * refill (a zero-price serving) or a withdrawn row. Triggers (0196): no back-dating, no UPDATE, future-only DELETE,
 * refill/amount/bundle shape by item type, and a LIVE offer needs a depletion rule in force at its `effective_from`.
 */
export const menuOffers = pgTable(
  'menu_offers',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => menuItemVariants.id, { onDelete: 'restrict' }),
    channel: text('channel', { enum: MENU_CHANNELS }).notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    amount: numeric('amount', { precision: 14, scale: 2 }),
    bundleHeads: integer('bundle_heads'),
    extraHeadAmount: numeric('extra_head_amount', { precision: 14, scale: 2 }),
    withdrawn: boolean('withdrawn').notNull().default(false),
    /** R15: `fixed` = `amount` as typed; `online` rows may instead follow the store price by a rule, resolved at read. */
    pricingMode: text('pricing_mode', { enum: MENU_PRICING_MODES }).notNull().default('fixed'),
    /** Signed percent over the store price (`percent_markup`), > -100. */
    markupPercent: numeric('markup_percent', { precision: 8, scale: 4 }),
    /** Signed peso amount over the store price (`fixed_markup`). */
    fixedMarkupAmount: numeric('fixed_markup_amount', { precision: 14, scale: 2 }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('menu_offers_slot_unique').on(t.storeId, t.variantId, t.channel, t.effectiveFrom),
    index('menu_offers_org_store_idx').on(t.orgId, t.storeId, t.effectiveFrom),
    index('menu_offers_variant_idx').on(t.variantId),
    check('menu_offers_amount_finite_check', sql`${t.amount} > '-Infinity'::numeric AND ${t.amount} < 'Infinity'::numeric`),
    check('menu_offers_extra_head_amount_finite_check', sql`${t.extraHeadAmount} > '-Infinity'::numeric AND ${t.extraHeadAmount} < 'Infinity'::numeric`),
    check('menu_offers_markup_percent_finite_check', sql`${t.markupPercent} > '-Infinity'::numeric AND ${t.markupPercent} < 'Infinity'::numeric`),
    check('menu_offers_fixed_markup_amount_finite_check', sql`${t.fixedMarkupAmount} > '-Infinity'::numeric AND ${t.fixedMarkupAmount} < 'Infinity'::numeric`),
    check('menu_offers_channel_check', sql`${t.channel} in ('store','online')`),
    check(
      'menu_offers_withdrawn_no_amounts_check',
      sql`NOT ${t.withdrawn} OR (${t.pricingMode} = 'fixed' AND ${t.amount} IS NULL AND ${t.bundleHeads} IS NULL AND ${t.extraHeadAmount} IS NULL AND ${t.markupPercent} IS NULL AND ${t.fixedMarkupAmount} IS NULL)`,
    ),
    check('menu_offers_pricing_mode_check', sql`${t.pricingMode} in ('fixed','fixed_markup','percent_markup')`),
    check('menu_offers_store_channel_fixed_check', sql`${t.channel} = 'online' OR ${t.pricingMode} = 'fixed'`),
    check(
      'menu_offers_rule_shape_check',
      sql`(${t.pricingMode} = 'fixed' AND ${t.markupPercent} IS NULL AND ${t.fixedMarkupAmount} IS NULL)
        OR (${t.pricingMode} = 'percent_markup' AND ${t.markupPercent} IS NOT NULL AND ${t.markupPercent} > -100 AND ${t.markupPercent} < 'Infinity'::numeric
          AND ${t.amount} IS NULL AND ${t.bundleHeads} IS NULL AND ${t.extraHeadAmount} IS NULL AND ${t.fixedMarkupAmount} IS NULL)
        OR (${t.pricingMode} = 'fixed_markup' AND ${t.fixedMarkupAmount} IS NOT NULL AND ${t.fixedMarkupAmount} > '-Infinity'::numeric AND ${t.fixedMarkupAmount} < 'Infinity'::numeric
          AND ${t.amount} IS NULL AND ${t.bundleHeads} IS NULL AND ${t.extraHeadAmount} IS NULL AND ${t.markupPercent} IS NULL)`,
    ),
    check('menu_offers_amount_check', sql`${t.amount} IS NULL OR (${t.amount} >= 0 AND ${t.amount} < 'Infinity'::numeric)`),
    check('menu_offers_bundle_pair_check', sql`(${t.bundleHeads} IS NULL) = (${t.extraHeadAmount} IS NULL)`),
    check('menu_offers_bundle_heads_check', sql`${t.bundleHeads} IS NULL OR ${t.bundleHeads} >= 1`),
    check(
      'menu_offers_extra_head_amount_check',
      sql`${t.extraHeadAmount} IS NULL OR (${t.extraHeadAmount} >= 0 AND ${t.extraHeadAmount} < 'Infinity'::numeric)`,
    ),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'menu_offers_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.variantId],
      foreignColumns: [menuItemVariants.orgId, menuItemVariants.id],
      name: 'menu_offers_variant_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'menu_offers_created_by_same_org_fk',
    }).onDelete('restrict'),
    // NOTE: triggers menu_offers_insert_guard / _update_guard / _delete_guard, hand-added in migration 0196.
  ],
);

/** R5: an option value's signed price delta per store and channel, same offer shape. No row in force = not offered there. */
export const menuOptionOffers = pgTable(
  'menu_option_offers',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    optionValueId: uuid('option_value_id')
      .notNull()
      .references(() => menuOptionValues.id, { onDelete: 'restrict' }),
    channel: text('channel', { enum: MENU_CHANNELS }).notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    /** Signed ("no rice, -10" is real, R4). NULL only on a withdrawn row. */
    priceDelta: numeric('price_delta', { precision: 14, scale: 2 }),
    withdrawn: boolean('withdrawn').notNull().default(false),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('menu_option_offers_slot_unique').on(t.storeId, t.optionValueId, t.channel, t.effectiveFrom),
    index('menu_option_offers_value_idx').on(t.optionValueId),
    check('menu_option_offers_price_delta_finite_check', sql`${t.priceDelta} > '-Infinity'::numeric AND ${t.priceDelta} < 'Infinity'::numeric`),
    check('menu_option_offers_channel_check', sql`${t.channel} in ('store','online')`),
    check(
      'menu_option_offers_delta_shape_check',
      sql`(${t.withdrawn} AND ${t.priceDelta} IS NULL) OR (NOT ${t.withdrawn} AND ${t.priceDelta} IS NOT NULL AND ${t.priceDelta} > '-Infinity'::numeric AND ${t.priceDelta} < 'Infinity'::numeric)`,
    ),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'menu_option_offers_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.optionValueId],
      foreignColumns: [menuOptionValues.orgId, menuOptionValues.id],
      name: 'menu_option_offers_option_value_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'menu_option_offers_created_by_same_org_fk',
    }).onDelete('restrict'),
    // NOTE: triggers menu_option_offers_insert_guard / _update_guard / _delete_guard, hand-added in migration 0196.
  ],
);

/**
 * R14: a manager asks for an item; only a super admin resolves it (approve creates the item, duplicate points at an
 * existing one, reject needs a note). A request resolves once and its identity columns are frozen (trigger, 0196).
 */
export const menuItemRequests = pgTable(
  'menu_item_requests',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    itemType: text('item_type', { enum: MENU_ITEM_TYPES }).notNull(),
    /** A hint only. */
    categoryId: uuid('category_id').references(() => menuCategories.id, { onDelete: 'restrict' }),
    note: text('note'),
    status: text('status', { enum: MENU_REQUEST_STATUSES }).notNull().default('open'),
    resolvedItemId: uuid('resolved_item_id').references(() => menuItems.id, { onDelete: 'restrict' }),
    resolvedBy: uuid('resolved_by').references(() => persons.id, { onDelete: 'restrict' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolutionNote: text('resolution_note'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    index('menu_item_requests_org_status_idx').on(t.orgId, t.status),
    check('menu_item_requests_name_not_blank_check', sql`length(trim(${t.name})) > 0`),
    check('menu_item_requests_item_type_check', sql`${t.itemType} in ('a_la_carte','package','refill')`),
    check('menu_item_requests_status_check', sql`${t.status} in ('open','approved','duplicate','rejected','withdrawn')`),
    check(
      'menu_item_requests_resolved_shape_check',
      sql`(${t.status} = 'open' AND ${t.resolvedItemId} IS NULL AND ${t.resolvedBy} IS NULL AND ${t.resolvedAt} IS NULL AND ${t.resolutionNote} IS NULL)
        OR (${t.status} <> 'open' AND ${t.resolvedBy} IS NOT NULL AND ${t.resolvedAt} IS NOT NULL)`,
    ),
    check('menu_item_requests_item_only_when_resolved_check', sql`${t.resolvedItemId} IS NULL OR ${t.status} IN ('approved','duplicate')`),
    check('menu_item_requests_item_needed_check', sql`${t.status} NOT IN ('approved','duplicate') OR ${t.resolvedItemId} IS NOT NULL`),
    check('menu_item_requests_reject_note_check', sql`${t.status} <> 'rejected' OR length(trim(coalesce(${t.resolutionNote}, ''))) > 0`),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'menu_item_requests_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.requestedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'menu_item_requests_requested_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.categoryId],
      foreignColumns: [menuCategories.orgId, menuCategories.id],
      name: 'menu_item_requests_category_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.resolvedItemId],
      foreignColumns: [menuItems.orgId, menuItems.id],
      name: 'menu_item_requests_resolved_item_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.resolvedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'menu_item_requests_resolved_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'menu_item_requests_created_by_same_org_fk',
    }).onDelete('restrict'),
    // NOTE: trigger menu_item_requests_guard (resolves once; name, store_id, requested_by, item_type frozen), hand-added in migration 0196.
  ],
);

/**
 * R7: store x v1 POS item key -> variant. A store fact, so it carries the store's own stock-location override. A link
 * may only be made (or re-activated) to an active variant with a depletion rule in force now; variant, store and key
 * are immutable (relink = deactivate + insert). Triggers hand-added in migration 0196.
 */
export const menuPosV1Links = pgTable(
  'menu_pos_v1_links',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    posItemKey: text('pos_item_key').notNull(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => menuItemVariants.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').references(() => stockLocations.id, { onDelete: 'restrict' }),
    status: text('status', { enum: MENU_LINK_STATUSES }).notNull().default('active'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    // NOTE: menu_pos_v1_links_active_key UNIQUE (store_id, pos_item_key) WHERE status = 'active', hand-added in migration 0196.
    index('menu_pos_v1_links_variant_idx').on(t.variantId),
    check('menu_pos_v1_links_key_not_blank_check', sql`length(trim(${t.posItemKey})) > 0`),
    check('menu_pos_v1_links_status_check', sql`${t.status} in ('active','inactive')`),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'menu_pos_v1_links_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.variantId],
      foreignColumns: [menuItemVariants.orgId, menuItemVariants.id],
      name: 'menu_pos_v1_links_variant_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.locationId],
      foreignColumns: [stockLocations.orgId, stockLocations.id],
      name: 'menu_pos_v1_links_location_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'menu_pos_v1_links_created_by_same_org_fk',
    }).onDelete('restrict'),
    // NOTE: trigger menu_pos_v1_links_guard (rule in force, active variant, location in the store, identity immutable), hand-added in migration 0196.
  ],
);

/**
 * R7: which stock-usage source a store reads. Append-only history; the latest row by created_at is the source, no row
 * means pos_item_maps. A switch is immediate: the insert trigger sets created_at = now(); the UPDATE guard is ENABLE ALWAYS.
 */
export const menuUsageSourceSwitches = pgTable(
  'menu_usage_source_switches',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    source: text('source', { enum: MENU_USAGE_SOURCES }).notNull(),
    reason: text('reason'),
    differenceCount: integer('difference_count'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('menu_usage_source_switches_store_idx').on(t.storeId, t.createdAt),
    check('menu_usage_source_switches_source_check', sql`${t.source} in ('v1_pos_map','menu_rules')`),
    check('menu_usage_source_switches_difference_count_check', sql`${t.differenceCount} IS NULL OR ${t.differenceCount} >= 0`),
    check(
      'menu_usage_source_switches_reason_check',
      sql`NOT (${t.source} = 'menu_rules' AND (${t.differenceCount} IS NULL OR ${t.differenceCount} > 0)) OR length(trim(coalesce(${t.reason}, ''))) > 0`,
    ),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'menu_usage_source_switches_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'menu_usage_source_switches_created_by_same_org_fk',
    }).onDelete('restrict'),
    // NOTE: triggers menu_usage_source_switches_insert_guard and _update_guard (ENABLE ALWAYS), hand-added in migration 0196.
  ],
);
