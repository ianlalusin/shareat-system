/**
 * The commissary ↔ branch catalogue — T-171.
 *
 * ⭐ **Most of this task was already built.** T-145 gave one org-level `items` table, T-149 gave
 * per-store sellability, and T-151 gave `item_pricing` with a basis **derived from invoice
 * history rather than stored** — which is the fix for the bug that froze a chopstick branch price
 * at ₱1,458 instead of ₱1.46 and could not self-heal.
 *
 * ⛔ **So there is no `commissary_item_config` table here, deliberately.** v1 has one per store,
 * holding pricing mode and a rolling `lastReceivedCost`. Recreating it would be a per-store item
 * master by another name — exactly what T-145's header warns about: *"the moment this table grows
 * a name or a unit, it has become that."* v1 has **842 item records for 385 real products**
 * because of precisely this.
 *
 * What was genuinely missing is the **cross-store correspondence**, and it is one table.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid, foreignKey } from 'drizzle-orm/pg-core';
import { expenseCategories } from './expenses';
import { items } from './items';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

export const LINK_STATUSES = ['active', 'inactive'] as const;

/** Which branch may order from which commissary. */
export const commissaryLinks = pgTable(
  'commissary_links',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
    commissaryStoreId: uuid('commissary_store_id').notNull().references(() => stores.id, { onDelete: 'restrict' }),
    branchStoreId: uuid('branch_store_id').notNull().references(() => stores.id, { onDelete: 'restrict' }),
    status: text('status', { enum: LINK_STATUSES }).notNull().default('active'),
    createdBy: uuid('created_by').notNull().references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('commissary_links_pair_key').on(t.commissaryStoreId, t.branchStoreId),
    check('commissary_links_not_self_check', sql`${t.commissaryStoreId} <> ${t.branchStoreId}`),
    index('commissary_links_branch_idx').on(t.branchStoreId, t.status),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.branchStoreId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'commissary_links_branch_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.commissaryStoreId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'commissary_links_commissary_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'commissary_links_created_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);

/** What a commissary will dispatch, and the manager-set cost of last resort. */
export const commissaryItemOfferings = pgTable(
  'commissary_item_offerings',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
    commissaryStoreId: uuid('commissary_store_id').notNull().references(() => stores.id, { onDelete: 'restrict' }),
    itemId: uuid('item_id').notNull().references(() => items.id, { onDelete: 'restrict' }),
    status: text('status', { enum: LINK_STATUSES }).notNull().default('active'),
    /**
     * ⭐ Tier 3 of the basis fallback: a slab link first, then the item's own landed history
     * (T-151), then this. ⛔ **Nothing prices at a silent zero** — with all three empty the
     * catalogue line comes back `priced: false` and the order form refuses to add it. A ₱0 line
     * becomes a ₱0 order becomes a ₱0 receivable, and nobody notices until the month closes.
     */
    manualCost: numeric('manual_cost', { precision: 14, scale: 4 }),
    createdBy: uuid('created_by').notNull().references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('commissary_item_offerings_key').on(t.commissaryStoreId, t.itemId),
    check('commissary_item_offerings_manual_cost_check', sql`${t.manualCost} is null or ${t.manualCost} >= 0`),
    index('commissary_item_offerings_org_idx').on(t.orgId),
    check('commissary_item_offerings_manual_cost_finite_check', sql`${t.manualCost} > '-Infinity'::numeric and ${t.manualCost} < 'Infinity'::numeric`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.commissaryStoreId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'commissary_item_offerings_commissary_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'commissary_item_offerings_created_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * ⭐ The cross-store correspondence — and it is NOT a unit-of-measure concept, despite sitting in
 * the same neighbourhood. `docs/discovery/20` §5 warns that a shallow read deletes this table as
 * duplication; it is not. It answers *"which of MY products is this commissary's line"*, which is
 * a different question from *"what unit does this item come in"*.
 */
export const commissaryItemMap = pgTable(
  'commissary_item_map',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'restrict' }),
    commissaryStoreId: uuid('commissary_store_id').notNull().references(() => stores.id, { onDelete: 'restrict' }),
    branchStoreId: uuid('branch_store_id').notNull().references(() => stores.id, { onDelete: 'restrict' }),
    commissaryItemId: uuid('commissary_item_id').notNull().references(() => items.id, { onDelete: 'restrict' }),
    /**
     * ⛔ **NOT NULL, unlike v1.** v1 allows null with TWO different meanings — *"not mapped yet"*
     * and *"deliberately ledger-only"* — which `01-data-model.md:245` already flags as a hazard.
     * ⭐ A deliberate decision gets its own column below; an overloaded null is not a decision, it
     * is two decisions nobody can tell apart.
     */
    branchItemId: uuid('branch_item_id').notNull().references(() => items.id, { onDelete: 'restrict' }),
    /** The explicit "this line moves no branch stock" decision that v1 encodes as a null. */
    isLedgerOnly: boolean('is_ledger_only').notNull().default(false),
    /**
     * ⭐ The branch's own COGS classification for receiving this line.
     *
     * ⚠️ **The SAME resolved category gates order submit and the receipt posting** — one
     * definition, never two. v1 carries `hasFullCategory` for exactly this, shared by the submit
     * block and the auto-book test; had they drifted, an order could pass submit while its lines
     * were invisible to booking. That is the ₱12,184.71 failure by a second route.
     */
    expenseCategoryId: uuid('expense_category_id').references(() => expenseCategories.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by').notNull().references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('commissary_item_map_key').on(t.commissaryStoreId, t.branchStoreId, t.commissaryItemId),
    check('commissary_item_map_not_self_check', sql`${t.commissaryStoreId} <> ${t.branchStoreId}`),
    index('commissary_item_map_branch_idx').on(t.branchStoreId),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.branchStoreId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'commissary_item_map_branch_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.commissaryStoreId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'commissary_item_map_commissary_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'commissary_item_map_created_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);
