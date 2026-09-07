/**
 * organizations — the root of every scoped table in Shareat System.
 *
 * docs/tasks/101-core-schema.md Contract §2. One row today. SEBN is the reserved second
 * entity (bible §4.1 / task spec "Why this spec differs") — nothing here or downstream may
 * assume there is exactly one organization.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const organizations = pgTable(
  'organizations',
  {
    // PostgreSQL 18 native uuidv7() — no extension needed (bible §13 row 70).
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    /** The everyday TRADING name. ⚠️ Not the registered one — see `legalName`. */
    name: text('name').notNull(),
    code: text('code').notNull().unique(),
    isActive: boolean('is_active').notNull().default(true),
    /**
     * ⭐ T-229 slice 4 / DEF-208 — the registered name the books are kept under, which differs from
     * the trading name above. A form that conflates the two is how the wrong one reaches a document.
     */
    legalName: text('legal_name'),
    /**
     * ⭐ **One TIN per corporation** — the PH model, and the reason it lives here rather than on
     * every store the way v1 had it. A branch carries `stores.tin_branch_code` against this number.
     *
     * ⚠️ **NULLABLE ON PURPOSE, and it is a decision, not an omission.** Bible §13 row 75: this is
     * a management ledger, never a statutory filing basis. A NOT NULL here would assert that the
     * system cannot represent a business without a TIN — a compliance claim the bible disclaims —
     * and would make an organization un-creatable before somebody looks the number up, inverting
     * `bootstrap-org.ts`'s first step. The `/settings/organization` screen insists instead.
     */
    tin: text('tin'),
    /**
     * ⛔ **DESCRIPTIVE ONLY — nothing computes VAT from this and nothing may start to.** There is
     * no VAT engine in v2 (bible §13 row 75); the column exists so a document can print the right
     * registration. Same posture as `sales_channels.tax_treatment` (T-230).
     */
    taxType: text('tax_type', { enum: ['vat', 'non_vat'] as const }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    check('organizations_tax_type_check', sql`${t.taxType} is null or ${t.taxType} in ('vat', 'non_vat')`),
    /**
     * ⭐ T-229 slice 4 R1. A wrong number that LOOKS set is worse than an empty field, and a TIN
     * with a typo is exactly that case. Digits only — the domain strips dashes and spaces first, so
     * "123-456-789" is accepted and stored as "123456789".
     * ⛔ Deliberately NO checksum and no cross-field rule against the branch code: a format check
     * catches a typo, a checksum starts to look like validating a registration, which is the
     * compliance posture this slice refuses.
     */
    check('organizations_tin_format_check', sql`${t.tin} is null or ${t.tin} ~ '^[0-9]{9,12}$'`),
  ],
);
