/**
 * Loans — a standard model. T-126, bible row 158.
 *
 * > **Ian, 2026-08-27:** *"that loan model in v1 is really flawed. I suggest build a standard one
 * > for loan and we will build on top of it later to cater our case."*
 *
 * ## ⛔ THREE places recorded the same money in v1
 *
 * `LoanPlain` carried **four running totals** (`totalPaid`, `principalPaid`, `interestPaid`,
 * `outstandingBalance` — the last commented *"principalAmount - principalPaid"*, a stored copy of a
 * subtraction). Beside it sat a **`loanPayments`** collection, and beside *that* a
 * **`LoanLedgerEntry`** carrying its own `balanceBefore`. Three registers of one debt.
 *
 * ⚠️ **They drifted, and it was measured, not guessed.** The ERPNext migration read both live Grab
 * loans and concluded *"NEITHER figure is usable"*: one stale by fourteen days of unrecorded
 * settlements, the other reading zero payments because every settlement routed through a single
 * `channelCfg.loanId` — *"a wiring artifact, not a fact."*
 *
 * ## ⭐ So there is ONE register here, and it is the ledger
 *
 * This table holds the **terms**. Every peso — disbursed, repaid, interest — is a journal entry
 * keyed `source_type = 'loan_disbursement' | 'loan_payment'` and `source_id = the loan id`, and the
 * split is readable off the legs: `2400` is principal, `7200` is interest.
 *
 * ⛔ **There is no `loan_payments` table**, deliberately. A payment is not a thing that happens
 * alongside the ledger; it *is* a ledger entry, and giving it a second home is how v1 got three.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';
import { suppliers } from './suppliers';

/**
 * ⚠️ **NOT NULL, with no default, and v1 explains exactly why.**
 *
 * > *"ABSENT on loans written before this field existed — those were all entered as an annual
 * > percentage, so absent MUST read as `'year'`. New loans default to `'month'`, which is how Grab
 * > quotes. **A month is 30 days and a year is 365; the two are not interchangeable.**"*
 *
 * ⛔ An absent rate period therefore means *different things on different rows*, with nothing on
 * the row to tell them apart. A loan whose rate period nobody stated cannot exist here.
 */
export const RATE_PERIODS = ['day', 'month', 'year'] as const;
export type RatePeriod = (typeof RATE_PERIODS)[number];

/**
 * ⭐ The methods differ in **what the rate is charged ON**, which is the whole distinction:
 * `straight` charges the ORIGINAL principal (so repaying early changes nothing and the total cost
 * is fixed the day it is signed — how Grab lends), while the other two charge the OUTSTANDING
 * balance. It is also why payment frequency changes total interest for those two and never for
 * `straight`.
 */
export const INTEREST_METHODS = ['straight', 'amortizing', 'equal_principal'] as const;
export type InterestMethod = (typeof INTEREST_METHODS)[number];

export const PAYMENT_FREQUENCIES = [
  'daily',
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'annual',
] as const;
export type PaymentFrequency = (typeof PAYMENT_FREQUENCIES)[number];

/**
 * ⚠️ `paid_off` is **not** stamped by whoever posts last — it is set when the derived outstanding
 * reaches zero, and re-opened if a payment is reversed. The column records the state; the ledger
 * decides it.
 */
export const LOAN_STATUSES = ['active', 'paid_off', 'defaulted', 'written_off'] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

export const loans = pgTable(
  'loans',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),

    /**
     * ⭐ `2400` is party-requiring, and **the party is THE LOAN, not the lender** — `party_type
     * = 'loan'`, `party_id = this row's id`.
     *
     * ⚠️ That looks like the wrong noun until you ask what the party is FOR: it makes each
     * balance on a shared control account attributable. **A lender can hold two loans** — v1's own
     * data has exactly that, two Grab loans on Lipa — so keying on the lender would merge two
     * debts that must be tracked apart. Same reasoning as ADR-010's wallets (row 142).
     *
     * ⚠️ `lenderName` stays TEXT — not every lender is a supplier-shaped counterparty (a bank, a
     * personal loan). `lenderId` below is the FK T-130 promised, nullable, informational/lookup
     * only. The party on the LINE does not change.
     */
    lenderName: text('lender_name').notNull(),
    /** ⭐ T-130. Nullable — set when the lender IS a real `suppliers` row; still just a lookup,
     *  never posted (the party stays `party_type='loan'`, row 158). */
    lenderId: uuid('lender_id').references(() => suppliers.id, { onDelete: 'restrict' }),

    name: text('name').notNull(),
    principalAmount: numeric('principal_amount', { precision: 14, scale: 2 }).notNull(),

    interestRate: numeric('interest_rate', { precision: 8, scale: 4 }).notNull(),
    ratePeriod: text('rate_period', { enum: RATE_PERIODS }).notNull(),
    interestMethod: text('interest_method', { enum: INTEREST_METHODS }).notNull(),
    paymentFrequency: text('payment_frequency', { enum: PAYMENT_FREQUENCIES }).notNull(),
    /** How many instalments the term runs to. */
    termPeriods: integer('term_periods').notNull(),

    startDate: date('start_date').notNull(),

    status: text('status', { enum: LOAN_STATUSES }).notNull().default('active'),
    closedOn: date('closed_on'),
    closeReason: text('close_reason'),

    notes: text('notes'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    index('loans_org_store_idx').on(t.orgId, t.storeId),
    index('loans_org_status_idx').on(t.orgId, t.status),

    check('loans_principal_positive_check', sql`${t.principalAmount} > 0`),
    check('loans_lender_not_blank_check', sql`length(trim(${t.lenderName})) > 0`),
    /** A negative rate is a gift, not a loan; nothing here models one. */
    check('loans_rate_not_negative_check', sql`${t.interestRate} >= 0`),
    check('loans_term_positive_check', sql`${t.termPeriods} >= 1`),
    check('loans_rate_period_check', sql`${t.ratePeriod} in ('day', 'month', 'year')`),
    check(
      'loans_method_check',
      sql`${t.interestMethod} in ('straight', 'amortizing', 'equal_principal')`,
    ),
    check(
      'loans_status_check',
      sql`${t.status} in ('active', 'paid_off', 'defaulted', 'written_off')`,
    ),
    /** All-or-nothing, the shape every other termination in this schema uses. ⚠️ `paid_off` is
     *  exempt: it is reached by arithmetic, not by somebody closing it with a reason. */
    check(
      'loans_close_shape_check',
      sql`${t.status} in ('active', 'paid_off')
          or (${t.closedOn} is not null and ${t.closeReason} is not null)`,
    ),
  ],
);
