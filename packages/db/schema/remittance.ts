/**
 * Pooled remittance — one handover settling many days. T-143, bible rows 128–129, 144–147.
 *
 * > **Ian:** *"Lipa has 5 sitting sales reports for January 1 to 5, all verified, money in cashier
 * > not remitted yet — it can be remitted all at once… If the remittance is short, cover the
 * > oldest sales report first, and record shortage/overage on the last date."*
 *
 * ## ⭐ A remittance IS a transfer, with allocations attached
 *
 * The money movement already exists: cashier-custodian account → office-custodian account, same
 * store, T-139. **Nothing here posts to the ledger.** `remittance_lines.money_transfer_id` is the
 * seam that keeps one money-movement path — ⛔ do not grow a second one, which is exactly how v1
 * ended up with two amortisation runners that drifted apart.
 *
 * ## ⛔ What is deliberately ABSENT
 *
 * No `expected` column, no `total` column, and **no `partially_remitted` status on `sales_days`**.
 * `sales_days`' own header forbids the last one by name: *"do not add `actualRemittanceCash`,
 * `remittanceRefNo` or a `partially_remitted` status here; that is precisely the shape that blocks
 * pooling."* The state keeps v1's word and is DERIVED from what has been allocated.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { journalEntries } from './journal';
import { moneyAccounts } from './money-accounts';
import { moneyTransfers } from './money-transfers';
import { organizations } from './organizations';
import { persons } from './persons';
import { salesDays } from './sales-days';
import { stores } from './stores';

export const REMITTANCE_ALLOCATION_SOURCES = ['cash', 'charge'] as const;
export type RemittanceAllocationSource = (typeof REMITTANCE_ALLOCATION_SOURCES)[number];

export const REMITTANCE_STATUSES = ['posted', 'reversed'] as const;
export type RemittanceStatus = (typeof REMITTANCE_STATUSES)[number];

/**
 * ⚠️ `open` is a state a variance must LEAVE, not one it may sit in forever — but nothing here
 * forces it out, deliberately: an open variance does not block the next remittance (Ian). Blocking
 * would push people to fudge a count to keep trading, which is worse than a visible open item.
 */
// T-366 S2 (migration 0172): 'income' is S3's recognised overage (Dr cashier / Cr 7350).
// 'written_off' stays so existing rows read; the domain refuses NEW write-offs (Amendment A1).
export const VARIANCE_STATUSES = ['open', 'charged', 'written_off', 'income'] as const;
export type VarianceStatus = (typeof VARIANCE_STATUSES)[number];

// -------------------------------------------------------------------------------------

export const remittances = pgTable(
  'remittances',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),

    remittedOn: date('remitted_on').notNull(),
    reference: text('reference'),
    notes: text('notes'),

    /** Who received it at the office. ⚠️ Not who handed it over — the accountability that matters
     *  is the acceptance, which is the moment the money changes custody. */
    acceptedBy: uuid('accepted_by').references(() => persons.id, { onDelete: 'restrict' }),

    status: text('status', { enum: REMITTANCE_STATUSES }).notNull().default('posted'),
    reversedOn: date('reversed_on'),
    reverseReason: text('reverse_reason'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('remittances_org_store_date_idx').on(t.orgId, t.storeId, t.remittedOn),
    check('remittances_status_check', sql`${t.status} in ('posted', 'reversed')`),
    check(
      'remittances_reverse_shape_check',
      sql`(${t.status} = 'reversed') = (${t.reversedOn} is not null and ${t.reverseReason} is not null)`,
    ),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.acceptedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'remittances_accepted_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.createdBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'remittances_created_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'remittances_store_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * One line per money account handed over — the till and the wallet remit separately, because they
 * are different places and reconcile against different things.
 */
export const remittanceLines = pgTable(
  'remittance_lines',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    remittanceId: uuid('remittance_id')
      .notNull()
      .references(() => remittances.id, { onDelete: 'restrict' }),
    fromMoneyAccountId: uuid('from_money_account_id')
      .notNull()
      .references(() => moneyAccounts.id, { onDelete: 'restrict' }),
    toMoneyAccountId: uuid('to_money_account_id')
      .notNull()
      .references(() => moneyAccounts.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),

    /**
     * ⭐ T-324 §3.5 — the release valve for cash a verified-day cap cannot yet attribute.
     *
     * NULL means never asked (every row before migration 0154); `0.00` means "I declare no
     * overage" — a zero amount is a legitimate value, not "unset"
     * (`packages/core/src/money.ts:15-16`). Nothing bounds its size on purpose: it converts a
     * silent sweep into a deliberate act, and the resulting positive variance lands in
     * `remittance_variances` for the office to see.
     */
    declaredOverage: numeric('declared_overage', { precision: 14, scale: 2 }),

    /** ⭐ THE SEAM. The money moved through `createMoneyTransfer` like any other transfer; this
     *  records which one, so there is exactly one posting path and one place the legs live. */
    moneyTransferId: uuid('money_transfer_id')
      .notNull()
      .references(() => moneyTransfers.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('remittance_lines_remittance_idx').on(t.remittanceId),
    uniqueIndex('remittance_lines_transfer_unique').on(t.moneyTransferId),
    check('remittance_lines_amount_positive_check', sql`${t.amount} > 0`),
    check(
      'remittance_lines_declared_overage_check',
      sql`${t.declaredOverage} is null or ${t.declaredOverage} >= 0`,
    ),
    check('remittance_lines_amount_finite_check', sql`${t.amount} > '-Infinity'::numeric and ${t.amount} < 'Infinity'::numeric`),
    check('remittance_lines_declared_overage_finite_check', sql`${t.declaredOverage} > '-Infinity'::numeric and ${t.declaredOverage} < 'Infinity'::numeric`),
  ],
);

/**
 * FIFO's output: how much of this handover settled which day.
 *
 * ⭐ **This is what makes a day's remittance state derivable.** Sum the allocations against what
 * the day is owed, and `unremitted` / `partially_remitted` / `remitted` falls out — no column to
 * stamp, and none to go stale when a second batch arrives.
 */
export const remittanceAllocations = pgTable(
  'remittance_allocations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    remittanceId: uuid('remittance_id')
      .notNull()
      .references(() => remittances.id, { onDelete: 'restrict' }),
    /** ⭐ The END-DAY REPORT this settles, keyed by DATE (bible row 157). Not a sales-day id: a
     *  collection banked on a day the store did not trade is still money the cashier holds. */
    businessDate: date('business_date').notNull(),
    /** The day's sales component, when there is one. ⚠️ A link, never the identity. */
    salesDayId: uuid('sales_day_id').references(() => salesDays.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    /** T-366 S2 (0172): 'cash' = FIFO over a handover; 'charge' = a shortage charged to a person,
     *  which completes the day without any cash arriving. Both count as settled. */
    source: text('source', { enum: REMITTANCE_ALLOCATION_SOURCES }).notNull().default('cash'),
  },
  (t) => [
    index('remittance_allocations_sales_day_idx').on(t.salesDayId),
    index('remittance_allocations_date_idx').on(t.businessDate),
    /** ⚠️ One batch settles a given DATE once. Two rows for the same pair would double-count the
     *  day's settlement and quietly mark it fully remitted. */
    uniqueIndex('remittance_allocations_unique').on(t.remittanceId, t.businessDate, t.source),
    check('remittance_allocations_source_check', sql`${t.source} in ('cash', 'charge')`),
    check('remittance_allocations_amount_positive_check', sql`${t.amount} > 0`),
    check('remittance_allocations_amount_finite_check', sql`${t.amount} > '-Infinity'::numeric and ${t.amount} < 'Infinity'::numeric`),
  ],
);

/**
 * ⭐ The variance gets its own table so it cannot hide.
 *
 * > **Ian, 2026-08-26:** *"no, it won't block — but it must be flagged and dedicate a separated
 * > table so it won't hide from sight like v1 does."*
 *
 * ## ⚠️ This is a CUSTODY variance, not a COUNT variance
 *
 * Once the till is counted daily and signed, a batch shortage **cannot** be a counting error — the
 * counts already reconciled. It is a loss *in custody*, after the fact, and that is a different
 * question asked of a possibly different person.
 *
 * ⛔ **So `sales_day_id` records where FIFO put the residual; it does NOT name who owes it.**
 * Charging one requires an explicit person. v1's remittance builder already throws rather than
 * infer a `chargeToStaffId`, and that refusal is ported: inferring the person from the date is
 * exactly the wrong inference (bible row 128).
 */
export const remittanceVariances = pgTable(
  'remittance_variances',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    remittanceId: uuid('remittance_id')
      .notNull()
      .references(() => remittances.id, { onDelete: 'restrict' }),
    /** Where FIFO left the residual — the last DATE the batch touched. */
    businessDate: date('business_date').notNull(),
    salesDayId: uuid('sales_day_id').references(() => salesDays.id, { onDelete: 'restrict' }),

    /** ⚠️ SIGNED: negative is short, positive is over. One column, because they are one event seen
     *  from two directions, and splitting them invites a report that shows only the shorts. */
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),

    status: text('status', { enum: VARIANCE_STATUSES }).notNull().default('open'),
    /** ⛔ Required to leave `open` via `charged`. Never inferred from the date. */
    chargedToPersonId: uuid('charged_to_person_id').references(() => persons.id, {
      onDelete: 'restrict',
    }),
    reason: text('reason'),
    resolvedBy: uuid('resolved_by').references(() => persons.id, { onDelete: 'restrict' }),
    resolvedOn: date('resolved_on'),
    /** T-366 S2 (0172): the entry this resolution posted (charge, or S3's income). Null while open. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('remittance_variances_org_status_idx').on(t.orgId, t.status),
    uniqueIndex('remittance_variances_remittance_unique').on(t.remittanceId),
    /** A zero variance is not a variance — it is a remittance that balanced, and a row saying so
     *  would make the open-items list meaningless. */
    check('remittance_variances_amount_nonzero_check', sql`${t.amount} <> 0`),
    check(
      'remittance_variances_status_check',
      sql`${t.status} in ('open', 'charged', 'written_off', 'income')`,
    ),
    index('remittance_variances_journal_entry_idx').on(t.journalEntryId),
    /** ⛔ THE REFUSAL, in the schema so no code path can skip it: charged needs a person,
     *  written_off needs a reason, and both need a resolver. */
    check(
      'remittance_variances_resolution_shape_check',
      sql`(${t.status} = 'open' and ${t.chargedToPersonId} is null and ${t.resolvedBy} is null)
          or (${t.status} = 'charged' and ${t.chargedToPersonId} is not null and ${t.resolvedBy} is not null)
          or (${t.status} = 'written_off' and ${t.reason} is not null and ${t.resolvedBy} is not null)
          or (${t.status} = 'income' and ${t.chargedToPersonId} is null and ${t.resolvedBy} is not null)`,
    ),
    // NOTE: the two checks below are NOT VALID, hand-added in migration 0172 — a legacy database may
    // hold `charged` rows with no entry. Drizzle cannot say NOT VALID; do not "fix" it to match.
    check(
      'remittance_variances_sign_check',
      sql`(${t.status} <> 'income' or ${t.amount} > 0) and (${t.status} <> 'charged' or ${t.amount} < 0)`,
    ),
    check(
      'remittance_variances_posting_check',
      sql`(${t.status} = 'open' and ${t.journalEntryId} is null)
          or (${t.status} in ('charged', 'income') and ${t.journalEntryId} is not null)
          or ${t.status} = 'written_off'`,
    ),
    check('remittance_variances_amount_finite_check', sql`${t.amount} > '-Infinity'::numeric and ${t.amount} < 'Infinity'::numeric`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.chargedToPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'remittance_variances_charged_to_person_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.resolvedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'remittance_variances_resolved_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);
