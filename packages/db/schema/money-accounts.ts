/**
 * `money_accounts` — every place money physically sits. ADR-010, bible rows 142–147.
 *
 * ## ⭐ Why this table exists at all
 *
 * Ian: *"we do 2 levels of accounting here — the general one, business-wide, where all cash
 * whoever the owner is is business cash … and the other level curated to our needs, the one with
 * these owners … for internal only. How can we model it cleanly?"*
 *
 * **One ledger, two views.** A journal line records WHERE money is; who holds it is an attribute
 * of that place. The general view groups lines by GL account (all cash is business cash — the
 * trial balance an accountant recognises); the internal view groups the SAME lines by these rows'
 * `custodian`. Two views over one set of lines cannot disagree.
 *
 * ⛔ **Two ledgers always eventually do**, and v1 is proving it in the live books: its AP control
 * says ₱669,829.84 while its own subledger sums to ₱1,567,980.87, and 34 of 115 account/store
 * combinations disagree with a reconstruction from raw legs. That is what maintaining one fact
 * twice costs, measured.
 *
 * ## The rule that put things here rather than in the chart
 *
 * **Does it get reconciled against something outside the books?** A drawer is counted, a safe is
 * counted, a GCash wallet and a BDO account each have a statement — so each is a real place and
 * earns a row. Nobody reconciles *"the cashier"* against an external document, so ownership is an
 * ATTRIBUTE of the place, never a tick on a transaction (DEF-058: *"the owner belongs to the
 * ACCOUNT — it should be derived, never ticked"*).
 *
 * ⚠️ **A new wallet is a new ROW, never a chart change.** The chart is governed reference data
 * (bible §4.4) and must not move every time the business opens a GCash account. This is also why
 * v1's `online__{id}` per-entity GL accounts are NOT copied — they made the chart grow with the
 * business, and every one of them rolled up into a single line in the audit anyway.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';

/**
 * Who holds the money. **The internal view** (bible row 142).
 *
 * ⭐ `staff` is Ian's addition and it fills a hole v1 left: v1's owner enum is `cashier|office`
 * only, so its staff float sat outside the ownership model entirely, treated as "not cashier
 * owned" without anything saying whose it was.
 *
 * ⚠️ **`staff` is PLURAL where the other two are singular** — one drawer, one safe, but many
 * people each holding their own float. So a `staff` location is made specific by the journal
 * line's party (`party_type = 'employee'`), exactly as `1230` already names which employee owes
 * money. The custodian says what KIND of place; the party says WHICH one.
 */
export const CUSTODIANS = ['cashier', 'office', 'staff'] as const;
export type Custodian = (typeof CUSTODIANS)[number];

/** What kind of place it is. Not the same question as which GL account it rolls into — two
 *  wallets with different providers are both `ewallet` and both roll into 1140. */
export const MONEY_INSTRUMENTS = ['cash', 'ewallet', 'bank'] as const;
export type MoneyInstrument = (typeof MONEY_INSTRUMENTS)[number];

/**
 * ⭐ THE FIVE EVERY STORE HAS, FROM THE MOMENT IT EXISTS (bible row 156).
 *
 * > **Ian, 2026-08-26:** *"all stores must have these accounts, seeded and configurable but can
 * > never be terminated as long as store is active … these 5 accounts must always be present and
 * > available since they are the foundation of money movement."*
 *
 * ⚠️ The names here are DEFAULTS, not identities. Ian: *"cashier cash may be renamed to counter
 * till, office cash may be office vault"*, and the two online ones *"may be edited to bear actual
 * name like cashier gcash, office bpi"*. What is fixed is the SHAPE — who holds it and what kind
 * of money it is — because that is what the ledger reasons about. The name is what people read.
 *
 * ⛔ There is no `staff online`, and the omission is deliberate: a staff float is cash in a
 * person's pocket, handed over and accounted for. A wallet belongs to the business, not the errand.
 */
export const FOUNDATION_ACCOUNTS = [
  { name: 'Cashier cash', instrument: 'cash', custodian: 'cashier' },
  { name: 'Cashier online', instrument: 'ewallet', custodian: 'cashier' },
  { name: 'Office cash', instrument: 'cash', custodian: 'office' },
  { name: 'Office online', instrument: 'ewallet', custodian: 'office' },
  { name: 'Staff float', instrument: 'cash', custodian: 'staff' },
] as const satisfies readonly {
  name: string;
  instrument: MoneyInstrument;
  custodian: Custodian;
}[];

export const moneyAccounts = pgTable(
  'money_accounts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** ⚠️ NOT nullable. Money always sits somewhere, and "somewhere" is always at a store — a
     *  drawer belongs to a branch, and so does the wallet its cashier collects into. */
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),

    /** What staff call it: "Cashier drawer", "GCash — Lipa cashier", "BDO — office". */
    name: text('name').notNull(),
    instrument: text('instrument', { enum: MONEY_INSTRUMENTS }).notNull(),

    /**
     * Which GL account this rolls up into. ⭐ **This is the general view.**
     *
     * ⚠️ A CODE, not an FK to `accounts.id`. Accounts are seeded per org, so an id here would
     * bind a money account to one org's copy of the chart; the code is the stable identity the
     * whole codebase already routes on (`routeExpense`, `postEntry`).
     */
    glAccountCode: text('gl_account_code').notNull(),

    /** ⭐ The internal view. See {@link CUSTODIANS}. */
    custodian: text('custodian', { enum: CUSTODIANS }).notNull(),

    /** Retire a wallet without deleting its history. ⛔ Never delete a money account — its
     *  journal lines outlive it, and an orphaned line is the DEF-065 class of problem. */
    isActive: boolean('is_active').notNull().default(true),

    /**
     * ⭐ One of the FIVE every store must always have (bible row 156).
     *
     * > **Ian, 2026-08-26:** *"these 5 accounts must always be present and available since they
     * > are the foundation of money movement."*
     *
     * ⚠️ **A flag, not an inference from `instrument` + `custodian`** — and that is the whole
     * reason it exists. A store may open a SECOND cashier wallet (a second GCash, a BDO account),
     * and that one is ordinary: retirable like anything else. Only the first, seeded one is
     * foundational, and nothing about its shape distinguishes it from the second.
     */
    isFoundation: boolean('is_foundation').notNull().default(false),

    /**
     * ⭐ **How far below zero this account may go before a draw is REFUSED.** Stored positive; a
     * limit of `20000.00` means the balance may reach −₱20,000 and no further.
     *
     * > **Ian, 2026-08-27:** *"how deep can a cashier account be negative — it can't be unlimited,
     * > so admin can set it. If the set is 20,000 that is the only allowable negative balance a
     * > cashier is allowed to."*
     *
     * ⚠️ **Only a CASHIER account ever uses it.** An office or staff balance is complete — nothing
     * is waiting to be posted into it — so any shortfall there is real and blocks at zero regardless
     * (bible row 154). This exists because a cashier drawer's balance legitimately runs behind the
     * till while the day is unverified, and *"legitimately behind"* is not the same as *"unlimited"*.
     *
     * ⚠️ Per ACCOUNT, not per org: a busier store carries a bigger float, and one number for
     * everywhere would be set to the largest store's need and be meaningless everywhere else.
     */
    overdraftLimit: numeric('overdraft_limit', { precision: 14, scale: 2 })
      .notNull()
      .default('20000.00'),

    /**
     * ⭐ **T-153 — the till float's configured amount, and the flag that this account IS one.**
     *
     * > **Ian, 2026-08-29:** *"extra cash float that is not remitted to the manager or admin — it
     * > sits on till forever… the staff just makes sure if the configured budget is 20k, every day
     * > opening and closing it is 20k… it's on a side pocket of the cashier."*
     *
     * Non-null marks a **float pot**; every other money account leaves it null, so the column is
     * its own flag and there is nothing separate to keep in step with it.
     *
     * ⛔ **A target is not a duplicate.** Bible rows 143/145/147 forbid storing a COPY of a figure
     * the ledger computes — a cached balance drifts, and then two places disagree about the same
     * pesos. This is the *other operand*: `balance <> float_target` is not drift to prevent, it is
     * the finding. T-152's un-remitted ceiling is the same shape.
     */
    floatTarget: numeric('float_target', { precision: 14, scale: 2 }),

    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    /** One name per store. Two "GCash" rows at one branch is the ambiguity this table exists to
     *  remove — per ACCOUNT not per provider (bible row 142), so they must be named apart. */
    uniqueIndex('money_accounts_org_store_name_unique').on(t.orgId, t.storeId, t.name),
    /** ⛔ One foundation account per shape per store. Without this, a re-run of the seeder or a
     *  concurrent store insert could mint a second "Cashier cash" and the register would show two
     *  tills that are the same till. */
    uniqueIndex('money_accounts_foundation_unique')
      .on(t.storeId, t.instrument, t.custodian)
      .where(sql`${t.isFoundation}`),
    index('money_accounts_org_custodian_idx').on(t.orgId, t.custodian),
    index('money_accounts_org_store_idx').on(t.orgId, t.storeId),
    check('money_accounts_custodian_check', sql`${t.custodian} in ('cashier', 'office', 'staff')`),
    check('money_accounts_instrument_check', sql`${t.instrument} in ('cash', 'ewallet', 'bank')`),
    /** ⚠️ A money account must roll into a money-holding account. Restricting to the 11xx range
     *  in the database stops a wallet being pointed at, say, 4100 revenue — which would make the
     *  internal view silently include figures that are not money at all. */
    check('money_accounts_gl_code_is_money_check', sql`${t.glAccountCode} ~ '^11[0-9]{2}$'`),
    check('money_accounts_name_not_blank_check', sql`length(trim(${t.name})) > 0`),
    // ⛔ Stored POSITIVE, and zero is meaningful: it means this drawer may never go below zero at
    // all. A negative value here would invert the comparison silently.
    check('money_accounts_overdraft_limit_not_negative_check', sql`${t.overdraftLimit} >= 0`),
    // A float pot of zero says what NULL already says, and is far likelier to be an unfilled form.
    check('money_accounts_float_target_positive_check', sql`${t.floatTarget} is null or ${t.floatTarget} > 0`),
    /** ⭐ T-316 (migration 0184): the float is a TARGET on the cashier's own cash drawer — CASH, held
     *  by the CASHIER, rolling into `1110` — not a side pocket. Any other shape would put a target on
     *  a wallet or an office safe and make the off-target detector nonsense. */
    /** ⭐ ONE float pot per store — and this is what makes its BALANCE knowable, not tidiness.
     *  `balanceOf` scopes a non-`1140` account by (gl code, store) because these are not
     *  `requires_party`; two pots in one store would share one figure and the off-target detector
     *  would compare it against two targets. Ian, 2026-08-29: *"1 store 1 till."* */
    uniqueIndex('money_accounts_one_float_per_store')
      .on(t.storeId)
      .where(sql`${t.floatTarget} is not null`),
    check(
      'money_accounts_float_target_shape_check',
      sql`${t.floatTarget} is null or (${t.instrument} = 'cash' and ${t.custodian} = 'cashier' and ${t.glAccountCode} = '1110')`,
    ),
    check('money_accounts_overdraft_limit_finite_check', sql`${t.overdraftLimit} > '-Infinity'::numeric and ${t.overdraftLimit} < 'Infinity'::numeric`),
    check('money_accounts_float_target_finite_check', sql`${t.floatTarget} > '-Infinity'::numeric and ${t.floatTarget} < 'Infinity'::numeric`),
    // NOTE: money_accounts_org_id_id_unique UNIQUE (org_id, id) — hand-added in migration 0171
    // (T-357 / DEF-490), no Drizzle mirror here. It is trivially true (id alone is already
    // unique) and exists only so the 11 composite `(org_id, "<col>") REFERENCES money_accounts
    // (org_id, id)` same-org FKs elsewhere in this schema (each declared beside its own table)
    // have a real unique target — Postgres requires one for a composite FK's referenced columns.,
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'money_accounts_store_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
