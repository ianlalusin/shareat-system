/**
 * statutory_discount_records — the per-transaction SC/PWD record required by RR 5-2017 §5.9
 * (PWD) and RR 7-2010 (senior). docs/tasks/137-statutory-discount-logbook.md.
 *
 * ## ⛔ This table posts NOTHING, and that is bible row 75, not an omission
 *
 * > *"Shareat System must never be labelled or exported as BIR-ready output. A statutory basis,
 * > if ever needed, is **a separate reporting layer over the same ledger — not a retrofit of
 * > these accounts**."*
 *
 * So this is a **parallel record**, exactly as T-137 wanted. The daily `sales_days.senior_discount`
 * / `pwd_discount` totals continue to 4900 as contra-revenue (bible row 132) and are **not**
 * derived from these rows, nor these from them. They have different provenance and different
 * completeness, and coupling them would put a statutory side-record inside revenue recognition —
 * which is the retrofit row 75 forbids.
 *
 * ⚠️ **No VAT is computed here.** `gross_amount` and `discount_amount` are recorded as the till
 * computed them. This system does not calculate a VAT exemption and must never present one.
 *
 * ## ⚠️ The two columns nothing can derive
 *
 * `holder_name` and `id_number` are read off a physical card by a person. **Nothing captures them
 * today** — not POS, not v1's ERP, not CUSTOMER, not the Website (DEF-101; T-137 §1 corrects the
 * spec that said otherwise). POS *does* already write four of the six statutory fields per
 * transaction — `DiscountEvent` carries receipt number, amount, date and the acting staffer — so
 * the gap is two fields, not five. Closing it needs POS v2, after January.
 *
 * ## ⛔ And there is no paper logbook either — the obligation is unmet today
 *
 * Ian, 2026-08-29: *"they are not kept to avail the discount they just present id and the pos
 * picks the discount from the list of configured discount."* So nothing records the holder's
 * name, ID number or invoice — **not in software and not on paper** (bible row 164).
 *
 * ⚠️ **This table therefore cannot be back-filled.** A row must be created while the customer is
 * still at the counter, because nothing downstream holds the two fields that matter. That is the
 * whole reason `record_statutory_discount` is staff-open.
 *
 * ## ⭐ `source` is the honesty column
 *
 * Every row is `manual` until POS v2 exists. Same lesson as `sales_days.pos_sourced` (T-123):
 * *a day pulled from POS and a day typed in by hand are not equally trustworthy, and a reader
 * that cannot tell them apart will treat them as if they were.* When POS v2 lands it writes `pos`
 * rows into this same table — no migration, and the report can then show which period is
 * machine-captured and which was typed at the till.
 *
 * ## One discount only, by construction
 *
 * A PWD who is also a senior claims one 20%, not both. `kind` is a column and the unique index
 * allows one live row per invoice, so the rule cannot be broken by a second insert rather than
 * being re-checked in TypeScript (bible §6.3 — the database enforces the rules).
 */
import { sql } from 'drizzle-orm';
import { check, date, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid, foreignKey } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

export const statutoryDiscountRecords = pgTable(
  'statutory_discount_records',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),

    // ── The six fields the regulations name. All six, or the record does not satisfy them ──
    /** Reg field 5, *"date of transactions"*. The date of the SALE, never of the data entry —
     *  a January entry of a December sale is a December record. */
    businessDate: date('business_date').notNull(),
    /** ⭐ Reg field 6, *"invoice number"* — **omitted by the original T-137 spec**, and present in
     *  the text of both RR 5-2017 §5.9 and RR 7-2010. It is also the join back to POS's receipt
     *  when POS v2 begins writing these rows itself. */
    invoiceNumber: text('invoice_number').notNull(),
    /** Which statute this row is kept under. ⚠️ They are different regulations with different ID
     *  documents — an OSCA ID is not a PWD ID — so this is not cosmetic labelling. */
    kind: text('kind', { enum: ['senior', 'pwd'] }).notNull(),
    /** Reg field 2. OSCA ID for `senior`, PWD ID for `pwd`. ⛔ No format is enforced: these are
     *  LGU-issued and their formats vary by city, so a regex here would reject valid cards. */
    idNumber: text('id_number').notNull(),
    /** Reg field 1, *"name of the person with disability"* / of the senior citizen. */
    holderName: text('holder_name').notNull(),
    /** Reg field 3, *"gross sales/receipts"* — the amount BEFORE the discount. */
    grossAmount: numeric('gross_amount', { precision: 14, scale: 2 }).notNull(),
    /** Reg field 4, *"sales discount granted"*. The net is derived, never stored — a stored net
     *  is a third number that can disagree with the two that define it (DEF-075's habit). */
    discountAmount: numeric('discount_amount', { precision: 14, scale: 2 }).notNull(),

    /** ⚠️ **Nullable deliberately: this is NOT in the regulation text.** "Establishment signatory"
     *  comes from practitioner guidance, and the original T-137 spec listed it as required. The
     *  reg-level signature is the CUSTOMER's (RR 10-2015) — and RR 8-2023 waives even that for
     *  online and mobile-app orders. Cautious establishments keep a signatory column; the law does
     *  not compel one, so it cannot be `notNull` without inventing an obligation. */
    signatory: text('signatory'),

    /** ⭐ Provenance. `manual` = a person typed it; `pos` = POS v2 wrote it at the till. Defaults
     *  to `manual` because that is the only thing that can produce a row today.
     *  ⚠️ **It is NOT called `transcribed`** (migration 0066). That word asserts a source document
     *  was copied, and there is none — Ian confirmed 2026-08-29 that no paper logbook is kept
     *  (bible row 164). A row entered at the till is original capture by a human, not a copy. */
    source: text('source', { enum: ['manual', 'pos'] })
      .notNull()
      .default('manual'),

    notes: text('notes'),

    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),

    /** ⛔ **Void, never DELETE.** A statutory record that can be silently removed is worthless as
     *  evidence — the burden of proof in a BIR audit is on the seller, so the register must show
     *  that a row existed and was withdrawn, and by whom. */
    voidedBy: uuid('voided_by').references(() => persons.id, { onDelete: 'restrict' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    /** ⭐ **One LIVE record per invoice — this is the "one discount only" rule** (a PWD who is also
     *  a senior claims one 20%, not both). Partial on `voided_at is null` so a mistyped row can be
     *  voided and re-entered against the same invoice, which a total unique index would block
     *  forever. Same pattern as `trade_orders_ar_charge_key`. */
    uniqueIndex('statutory_discount_records_live_invoice_key')
      .on(t.orgId, t.storeId, t.businessDate, t.invoiceNumber)
      .where(sql`${t.voidedAt} is null`),
    /** The logbook report's own query: one store, a date range, in date order. */
    index('statutory_discount_records_org_id_store_id_business_date_idx').on(t.orgId, t.storeId, t.businessDate),
    index('statutory_discount_records_org_id_business_date_idx').on(t.orgId, t.businessDate),

    check('statutory_discount_records_kind_check', sql`${t.kind} in ('senior', 'pwd')`),
    check('statutory_discount_records_source_check', sql`${t.source} in ('manual', 'pos')`),
    /** ⚠️ Both amounts must be POSITIVE, not merely non-negative. A zero-peso discount is not a
     *  discount, and a zero gross is not a sale — either one means the row was entered wrong, and
     *  a statutory register full of zero rows is worse than a short one. */
    check('statutory_discount_records_amounts_positive_check', sql`
      ${t.grossAmount} > 0 and ${t.discountAmount} > 0
    `),
    /** The discount cannot exceed what it discounts. */
    check('statutory_discount_records_discount_within_gross_check', sql`
      ${t.discountAmount} <= ${t.grossAmount}
    `),
    /** A void is all three columns or none — the same both-or-neither shape `sales_days` uses for
     *  its provenance pair. Half a void is a row nobody can interpret. */
    check('statutory_discount_records_void_triple_check', sql`
      (${t.voidedAt} is null and ${t.voidedBy} is null and ${t.voidReason} is null)
      or (${t.voidedAt} is not null and ${t.voidedBy} is not null and ${t.voidReason} is not null)
    `),
    /** Identity is the whole point of the record — a blank name or ID satisfies nothing. `notNull`
     *  stops a NULL; this stops the empty string that gets typed instead. */
    check('statutory_discount_records_identity_present_check', sql`
      length(btrim(${t.holderName})) > 0
      and length(btrim(${t.idNumber})) > 0
      and length(btrim(${t.invoiceNumber})) > 0
    `),
    check('statutory_discount_records_gross_amount_finite_check', sql`${t.grossAmount} > '-Infinity'::numeric and ${t.grossAmount} < 'Infinity'::numeric`),
    check('statutory_discount_records_discount_amount_finite_check', sql`${t.discountAmount} > '-Infinity'::numeric and ${t.discountAmount} < 'Infinity'::numeric`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.recordedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'statutory_discount_records_recorded_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'statutory_discount_records_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.voidedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'statutory_discount_records_voided_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);
