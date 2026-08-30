/**
 * The stock ledger — T-161. Movements are the truth; on-hand is a query.
 *
 * ## ⭐ There is no balance column here, and that is the whole design
 *
 * v1 keeps `itemBalances` as a written, incremented document **beside** `itemStockLedger`, and
 * then ships `reconcileLegacy()` — a comparator that sums the ledger and flags any item whose
 * stored balance disagrees. **A tool that detects drift between two copies of one number is
 * evidence there should be one copy.**
 *
 * ⚠️ This is DEF-075's pattern — a stored balance beside the ledger — for the **eighth** time:
 * loans, owner equity, cash requests, liabilities, customers, suppliers, AP-open, and now stock.
 * At that point the finding is not the column, it is the habit.
 *
 * ⭐ **`onHand(item, location)` is `sum(quantity)` over these rows.** A materialised view may
 * exist later as a *cache* — derived, rebuildable, never authoritative (§16.1 invariant 3) — and
 * it is deliberately not built here, because a cache added before a measured need is a second
 * source of truth with extra steps.
 *
 * ## The two named bugs that dictate the write shape
 *
 * A meat balance drifting negative, and a **−20 kg** slab drift. Both trace to the same cause:
 * two concurrent posts read the same "available" snapshot *outside* the transaction, both passed,
 * and both committed. `FieldValue.increment` is not idempotent and Firestore forced that
 * pre-check.
 *
 * ⭐ **Postgres removes the whole class for free** — `SELECT … FOR UPDATE` on the (item, location)
 * inside the same transaction that writes the movement. The rule is stated anyway, because
 * re-deriving v1's pre-check shape out of habit is the easy mistake once the constraint that
 * forced it is gone.
 *
 * ## Append-only, and enforced as such
 *
 * ⛔ No `UPDATE`, no `DELETE` — a trigger, not a convention. Bible row 104: *name the statement
 * the database rejects, not the call our code declines to make.* DEF-041 is what happened when an
 * invariant was phrased the other way round and satisfied by grepping our own repo.
 *
 * A correction is a **new, opposite row** carrying `reversalOfId` (§16.1 invariant 5).
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { items } from './items';
import { journalEntries } from './journal';
import { organizations } from './organizations';
import { persons } from './persons';
import { stockLocations } from './stock-locations';
import { stores } from './stores';

/**
 * ⭐ A CLOSED list, deliberately. Every kind here has one defined posting pattern
 * (§16.11), and a movement whose reason is not on this list is a reason nobody has decided how to
 * account for yet — which is exactly when it must not be writable.
 */
export const STOCK_MOVEMENT_KINDS = [
  'receipt',
  'usage',
  'wastage',
  'transfer_out',
  'transfer_in',
  'count_adjustment',
  'manual_adjustment',
  'production_in',
  'production_out',
  'return_out',
  'opening',
] as const;
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number];

/**
 * ⭐ Which kinds move VALUE as well as quantity. A room-to-room transfer moves neither cost nor
 * layer (layers are per store — T-162 invariant 6), so it posts nothing; everything else does.
 *
 * ⚠️ Held here rather than in the domain because **T-165 turns it into a CHECK constraint**:
 * a value-moving movement without a `journal_entry_id` becomes unrepresentable. Until the
 * valuation core lands the column stays nullable, and this list is the specification of what that
 * constraint will say.
 */
export const VALUE_MOVING_KINDS: readonly StockMovementKind[] = [
  'receipt',
  'usage',
  'wastage',
  'count_adjustment',
  'manual_adjustment',
  'production_in',
  'production_out',
  'return_out',
  'opening',
];

export const stockMovements = pgTable(
  'stock_movements',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => stockLocations.id, { onDelete: 'restrict' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    /** ⚠️ BUSINESS time, not row time. The period lock and `onHand(asOf)` both key off this, and
     *  a stock count needs to ask what the ledger said at a moment, not what it says now. */
    movedAt: timestamp('moved_at', { withTimezone: true }).notNull(),
    /** ⭐ SIGNED: positive in, negative out. Never zero — a movement of nothing is not an event. */
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    kind: text('kind', { enum: STOCK_MOVEMENT_KINDS }).notNull(),
    /** Invariant 4 for stock: every movement names the document that caused it. */
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    /** Null until T-163/T-164 post value; tightened to a CHECK by T-165. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    /** A correction is a new opposite row pointing at what it reverses — never an edit. */
    reversalOfId: uuid('reversal_of_id'),
    note: text('note'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('stock_movements_quantity_not_zero_check', sql`${t.quantity} <> 0`),
    check('stock_movements_source_type_not_blank_check', sql`length(trim(${t.sourceType})) > 0`),
    /**
     * ⭐ Idempotency. One source document may touch several (item, location) pairs, but never the
     * same pair twice — so a retried post writes nothing new instead of doubling the stock.
     *
     * ⚠️ A REVERSAL is a second row for the same pair, so it must be excluded rather than
     * collide: the partial index covers original movements only, and a reversal is unique by
     * `reversal_of_id` below.
     */
    uniqueIndex('stock_movements_source_pair_key')
      .on(t.sourceType, t.sourceId, t.itemId, t.locationId)
      .where(sql`${t.reversalOfId} is null`),
    /** ⭐ A movement may be reversed AT MOST ONCE — invariant 4's second half, as a constraint. */
    uniqueIndex('stock_movements_one_reversal_key')
      .on(t.reversalOfId)
      .where(sql`${t.reversalOfId} is not null`),
    index('stock_movements_item_location_idx').on(t.itemId, t.locationId, t.movedAt),
    index('stock_movements_store_moved_idx').on(t.orgId, t.storeId, t.movedAt),
  ],
);
