/**
 * Cutover data classification — docs/tasks/119-data-classification-and-purge.md,
 * ADR-007, bible row 108.
 *
 * v2 runs for real Oct–Dec 2026, then every operational table is emptied on 1 January 2027
 * and the books open with one balance-sheet entry of counted, present-day facts (row 106).
 *
 * **THE TABLE IS THE MARK.** There is deliberately no per-row `is_pilot_data` flag. Such a
 * flag would have to be set correctly by every insert path that will ever exist, and one
 * miss — a cron, a backfill, a Phase 5 module written in November — leaves a row that
 * SILENTLY survives the purge and contaminates the opening books. That is DEF-036's lesson
 * exactly: a guard written against the code that exists today stops guarding when new code
 * appears. Whether data is configuration or operational is a property of the TABLE.
 *
 * **There is no default class.** An unlisted table is a build failure, never an assumption —
 * a default would be a decision made by whoever wrote the default, for data they have never
 * seen. `tests/unit/cutover-classification.test.ts` enforces it, and the measure of this
 * module's success is that build failure, not its own green tests.
 */

export type CutoverClass = 'keep' | 'purge' | 'keep_shell' | 'date_scoped';

interface BaseEntry {
  /** Prose, always. A classification without a reason is unreviewable in December, when the
   *  person reading it is not the person who wrote it. */
  readonly reason: string;
}

export interface KeepEntry extends BaseEntry {
  readonly class: 'keep';
}

export interface PurgeEntry extends BaseEntry {
  readonly class: 'purge';
  /** ADR-007 §6 — the ETL tables are evidence behind the opening balance and must survive the
   *  1 January purge, then go once it is signed off. The purge REFUSES them before this date. */
  readonly notBefore?: string;
}

export interface KeepShellEntry extends BaseEntry {
  readonly class: 'keep_shell';
  /** The row survives; these columns are set NULL and re-entered at cutover. */
  readonly clearColumns: readonly string[];
}

export interface DateScopedEntry extends BaseEntry {
  readonly class: 'date_scoped';
  readonly dateColumn: string;
  /** Rows on or after this date survive; earlier rows are purged. */
  readonly keepFrom: string;
}

export type CutoverEntry = KeepEntry | PurgeEntry | KeepShellEntry | DateScopedEntry;

/**
 * Every table in the schema, in exactly one class. Adding a table to the schema without
 * adding it here FAILS THE BUILD — which is the point, and the cheapest possible moment to
 * ask "does this survive the cutover?": while the person who designed it still has the
 * context to answer.
 */
export const CUTOVER_CLASSIFICATION: Readonly<Record<string, CutoverEntry>> = {
  // ---- Configuration and base data ----------------------------------------------------
  organizations: {
    class: 'keep',
    reason:
      'Configuration. With ADR-008 this is a real tenancy boundary, not a placeholder — a ' +
      'franchise is an organization.',
  },
  stores: { class: 'keep', reason: 'Configuration — the branch list.' },
  persons: {
    class: 'keep',
    reason:
      'The staff roster, named explicitly by Ian as data that stays. Pilot users keep their ' +
      'logins (ADR-007 open 2, answered): only what they DID is purged.',
  },
  person_identities: {
    class: 'keep',
    reason: 'Login identities for the roster above. Purging them would lock every user out.',
  },
  person_roles: {
    class: 'keep',
    reason:
      'Access configuration for the staff roster above, not a transactional fact. Purging it ' +
      'at cutover would leave every pilot user with no role at all on 1 January — the opposite ' +
      'of the "pilot users keep their logins" decision this mirrors (ADR-007 open 2).',
  },
  person_store_scope: {
    class: 'keep',
    reason: 'Which stores a person may see — configuration, like the role it accompanies. Same reasoning as person_roles.',
  },
  person_grants: {
    class: 'keep',
    reason:
      'Per-person capability overrides, including the grant-time-fallback rows for managers in ' +
      'admin-less orgs (bible row 115). These are access configuration, not pilot activity — ' +
      'purging them would silently strip capability from staff who need it on day one.',
  },
  accounts: {
    class: 'keep',
    reason:
      'The chart of accounts is configuration. Re-seeding it would risk changing the ids the ' +
      'opening entry references — a catastrophic and silent failure, so it is never rebuilt.',
  },

  // ---- Date-scoped --------------------------------------------------------------------
  fiscal_periods: {
    class: 'date_scoped',
    reason:
      'Splits by date rather than by kind: 2026 pilot periods go, 2027 stays. The only table ' +
      'in the schema that needs this class.',
    dateColumn: 'starts_on',
    keepFrom: '2027-01-01',
  },

  // ---- The books ----------------------------------------------------------------------
  journal_entries: {
    class: 'purge',
    reason: 'The books. Replaced wholesale by the 2027-01-01 opening entry (row 106).',
  },
  journal_lines: {
    class: 'purge',
    reason: 'As journal_entries. Purged first — children before parents.',
  },
  audit_log: {
    class: 'purge',
    reason:
      'It records pilot actions against rows that will not exist. An audit trail pointing at ' +
      'deleted ids is worse than no audit trail: it looks authoritative and resolves to nothing.',
  },

  // ---- T-122: expenses ------------------------------------------------------------------
  expense_categories: {
    class: 'keep',
    reason:
      'The seeded category -> account crosswalk (docs/tasks/122-expenses.md), configuration ' +
      'exactly like accounts itself — re-seeding it at cutover risks changing the ids real ' +
      'pilot expenses reference. Same reasoning as the accounts entry above.',
  },
  expenses: {
    class: 'purge',
    reason:
      'Operational financial activity — a non-inventory spend document, same class as ' +
      'journal_entries. Replaced wholesale by the 2027-01-01 opening entry (row 106); no ' +
      'pilot expense survives the cutover.',
  },
  expense_payments: {
    class: 'purge',
    reason: 'As expenses — its child rows. Purged first — children before parents (see PURGE_ORDER_HINT).',
  },

  // ---- T-123: sales day -----------------------------------------------------------------
  sales_channels: {
    class: 'keep',
    reason:
      'Per-store configuration — the channel list and, critically, the per-channel ' +
      '`is_remitted_daily` flag (v1 Store.salesChannels[]). Same class as expense_categories: ' +
      're-seeding at cutover would change ids that pilot sales days reference, and the ' +
      'remittable flag is a business decision about each channel, not pilot data.',
  },
  sales_days: {
    class: 'purge',
    reason:
      'Operational revenue recognition — the same class as journal_entries and expenses. ' +
      'Replaced wholesale by the 2027-01-01 opening entry (row 106); no pilot sales day ' +
      'survives, and one that did would double-count January revenue.',
  },
  sales_day_tenders: {
    class: 'purge',
    reason:
      'As sales_days — its child rows, recording which money account the online tender of a day ' +
      'landed in. Purged first: children before parents (PURGE_ORDER_HINT).',
  },
  sales_day_channels: {
    class: 'purge',
    reason: 'As sales_days — its child rows. Purged first: children before parents (PURGE_ORDER_HINT).',
  },

  // ---- T-138: identity and sessions ----------------------------------------------------
  person_credentials: {
    class: 'keep',
    reason:
      'How a real person signs in. Same class as persons and person_roles, and for the same ' +
      'reason: the pilot is run by the actual staff, and purging their credentials on 1 January ' +
      'would lock the business out of its own books on the morning the books open.',
  },
  sessions: {
    class: 'purge',
    reason:
      'Live sign-in state, not configuration. Every session is short-lived by design and none ' +
      'should outlive the cutover — a token minted in December has no business being valid in ' +
      'January. Purging them forces a clean re-authentication, which is the correct posture for ' +
      'the first day of a new ledger.',
  },

  // ---- T-154: the staff master record (Phase 4, lane B) --------------------------------
  positions: {
    class: 'keep',
    reason:
      'Configuration — the vocabulary of jobs a store has. The canonical six are seeded and a ' +
      'store’s own extras are deliberate setup, not pilot transactions. Purging them would strand ' +
      'every surviving employment’s position reference.',
  },
  employments: {
    class: 'keep',
    reason:
      'Who works here. Same class as persons and person_credentials, and for the same reason: the ' +
      'pilot is run by the actual staff, and emptying the roster on 1 January would mean nobody ' +
      'can clock in on the morning the books open. An employment is a fact about a job, not a ' +
      'transaction the ledger produced — nothing here posts.',
  },
  employment_positions: {
    class: 'keep',
    reason: 'As employments — its child rows, and meaningless without them.',
  },

  // ---- T-155: attendance policy (Phase 4, lane B) ---------------------------------------
  store_attendance_config: {
    class: 'keep',
    reason:
      'Configuration, and the SUPERSEDED rows are configuration history rather than pilot ' +
      'transactions. ⭐ Purging them would be worse than losing settings: an attendance_days row ' +
      'names the config row it was computed under, so dropping the history would leave every ' +
      'surviving day unable to explain the hours it credited. Nothing here posts to the ledger.',
  },

  // ---- T-156: the punch (Phase 4, lane B) -----------------------------------------------
  attendance_punches: {
    class: 'purge',
    reason:
      'Operational, and the clearest case of it in this phase — a punch is an event the pilot ' +
      'produced, not configuration. ⭐ It is safe to purge precisely BECAUSE attendance posts ' +
      'nothing to the ledger (bible §10: attendance touches money only through payroll): the ' +
      'opening books carry no balance derived from a 2026 punch. Pilot attendance is settled and ' +
      'paid within the pilot; January opens on counted present-day facts, and a punch is neither.',
  },

  // ---- T-157: the adjudicated day (Phase 4, lane B) -------------------------------------
  attendance_days: {
    class: 'purge',
    reason:
      'Derived from attendance_punches, which is purged, and derived data cannot outlive its ' +
      'source. Same argument as the punch: attendance posts nothing to the ledger, so no opening ' +
      'balance depends on a 2026 day. ⚠️ Purged BEFORE its config rows, which are kept — a day ' +
      'references the config it was computed under, and children go before parents.',
  },

  // ---- T-158: manager adjustments (Phase 4, lane B) -------------------------------------
  attendance_adjustments: {
    class: 'purge',
    reason:
      'Decisions about pilot days, which are themselves purged. A decision about a day that no ' +
      'longer exists is not history worth keeping — it is a dangling judgement. Purged with its ' +
      'days, and before them (children first).',
  },

  // ---- T-159: device identity (Phase 4, lane B) -----------------------------------------
  clock_terminals: {
    class: 'keep',
    reason:
      'The physical tablets on the counters survive 1 January — purging them would un-pair every ' +
      'clock terminal in the group on the morning the books open, and re-pairing needs a manager ' +
      'at each store with the device in hand. Configuration, not pilot activity.',
  },

  // ---- T-160: the Lane A outbox (Phase 4, lane B) ---------------------------------------
  mirror_outbox: {
    class: 'purge',
    reason:
      'A queue, not a record. Every row is an intent to publish something that has already been ' +
      'published, and the source rows it points at are the truth. ⚠️ Purging it on 1 January is ' +
      'safe ONLY because the mirror is rebuilt by re-enqueuing from source, never by replaying this ' +
      'table — which is also why it carries no payload column.',
  },

  // ---- T-124: fixed assets ---------------------------------------------------------------
  prepaid_items: {
    class: 'keep_shell',
    reason:
      'A prepaid contract survives the cutover — an insurance policy does not lapse on 1 January ' +
      'because the books restarted. But its COST is re-entered from the December position, the ' +
      'same treatment fixed_assets gets, so the item stays and its money is cleared.',
    clearColumns: ['total_cost', 'coverage_start_date', 'coverage_months', 'source_expense_id'],
  },
  cash_requests: {
    class: 'purge',
    reason:
      'A float handed out, spent and reconciled \u2014 activity, and the ledger behind it is ' +
      'purged too. ⚠️ An OPEN one at cutover is a real unliquidated float somebody is holding, so ' +
      'it must be closed BEFORE the cutover rather than inherited: v2 opens on a zero starting ' +
      'point, and a float with no ledger behind it is money nobody can account for.',
  },
  owner_drawing_closes: {
    class: 'purge',
    reason:
      'An attestation ABOUT a month of drawings — and those drawings are purged with the rest of ' +
      'the ledger. ⛔ Keeping the close without the postings it agreed to would leave a signed ' +
      'statement pointing at nothing, which is worse than no statement: it reads as evidence. ' +
      '⚠️ v2 opens on a zero starting point, so the first month closes against a fresh ledger.',
  },
  customers: {
    // ⭐ keep_shell, not keep: the ROW survives and named columns clear — which is exactly what the
    // reconciliation anchor needs, and what `keep` cannot express.
    class: 'keep_shell',
    reason:
      'WHO the business sells to on terms, and which of them are its own stores or franchises. ' +
      'Identity and relationship, not activity. ⭐ There is no balance on the row to clear — it is ' +
      'summed from 1210, and that ledger purges, so a kept customer correctly opens at zero. ' +
      '⚠️ The reconciliation anchor is CLEARED on cutover: it attests a verification against a ' +
      'ledger that no longer exists, and a stale anchor would tell an aging report that everything ' +
      'before an old date was settled.',
    clearColumns: ['reconciled_as_of', 'reconciled_at', 'reconciled_by'],
  },
  price_lists: {
    class: 'keep',
    reason: 'What the business charges. A price does not stop being the price because the books restarted.',
  },
  price_list_items: {
    class: 'keep',
    reason: 'The rates that make up a price list — kept with it, and carrying no money movement.',
  },
  liabilities: {
    class: 'keep',
    reason:
      'A debt does not stop existing because the books restarted — the landlord still expects the ' +
      'accrued rent. ⭐ The obligation is KEPT; the ledger behind it purges, so it opens at zero and ' +
      'its real balance is re-entered as an opening figure. Same treatment as loans. ⚠️ An ' +
      'obligation already settled before cutover should be RETIRED rather than carried — a kept row ' +
      'reading zero is indistinguishable from one nobody has charged yet.',
  },
  owners: {
    class: 'keep',
    reason:
      'WHO the owners are, what share they claim, and what they may withdraw — identity and ' +
      'policy, not activity. The partnership does not dissolve because the books restarted. ' +
      '⭐ There are no balances on this table to clear: the position is summed from 3100 and 3200, ' +
      'and the ledger behind it purges with everything else, so a kept owner correctly reads ZERO ' +
      'contributed on day one. ⚠️ That is not a loss — v2 assumes a zero starting point, and prior ' +
      'capital arrives as an opening balance if it arrives at all.',
  },
  loans: {
    class: 'keep',
    reason:
      'A debt does not stop existing because the books restarted \u2014 the lender still expects ' +
      'the money. ⚠️ KEEP, but the outstanding balance is NOT inherited: it is derived from the ' +
      'ledger, which is purged, so T-134 must re-enter the position as an opening balance. ' +
      '⛔ And v1\u2019s stored figures must not be used for it \u2014 the ERPNext migration ' +
      'measured both live Grab loans and found "NEITHER figure is usable".',
  },
  stored_files: {
    class: 'keep_shell',
    reason:
      'The pointer to a document that proves something. ⚠️ KEEP_SHELL rather than purge: the ' +
      'BYTES live in a bucket this purge cannot reach, so deleting the rows would orphan every ' +
      'object with no way left to find it — the row IS the index. What is cleared is the LINK, ' +
      'because whatever it pointed at is gone; the file then ages out through the orphan sweep ' +
      'like any other unclaimed upload.',
    clearColumns: ['linked_to'],
  },
  remittances: {
    class: 'purge',
    reason:
      'A handover of money that happened on a date, against days that are themselves purged. ' +
      'v2 opens on a zero starting point, so a remittance settling 2026 sales days has nothing ' +
      'left to settle once those days are gone.',
  },
  remittance_lines: {
    class: 'purge',
    reason: 'As remittances — the per-account split of a handover that no longer exists.',
  },
  remittance_allocations: {
    class: 'purge',
    reason:
      'As remittances. ⚠️ These MUST go with them: an allocation surviving its sales day would ' +
      'make a purged day look settled, which is the one thing this table exists to say.',
  },
  remittance_variances: {
    class: 'purge',
    reason:
      'As remittances. ⚠️ An OPEN variance is a real unresolved claim, so purging it discards a ' +
      'debt someone may still owe — but it is a claim against pre-cutover books, and T-134 owns ' +
      'what carries across as an opening balance. It must be settled or written off before ' +
      'cutover, not silently inherited.',
  },
  scheduler_runs: {
    class: 'purge',
    reason:
      'The operational record of what the month-end run did, not a business record. v2 opens on ' +
      'a zero starting point, and a run against the old books says nothing about the new ones. ' +
      '⚠️ Purged, NOT kept: an inherited "last run: November" would make the first cutover ' +
      'month look healthy when nothing had run against it at all — the precise illusion DEF-044 was.',
  },
  money_transfers: {
    class: 'purge',
    reason:
      'A transfer is ACTIVITY, not configuration — one recorded movement of money on one date. ' +
      'The accounts it moved between survive (money_accounts is `keep`); the movements do not, ' +
      'the same treatment every other posted document gets. v2 always assumes a zero starting ' +
      'point, and a transfer that predates the books has nothing left to reconcile against.',
  },
  money_accounts: {
    class: 'keep',
    reason:
      'The places money sits — the cashier drawer, the office safe, each wallet — plus who ' +
      'holds each one (ADR-010). Configuration, not activity: a drawer does not stop being a ' +
      'drawer on 1 January. Purging it would orphan every journal line that names a wallet as ' +
      'its party and leave the internal custodian view unanswerable for all of 2027.',
  },
  asset_policy: {
    class: 'keep',
    reason:
      'The capitalisation threshold and salvage default — a documented policy decision (bible ' +
      'row 139), not pilot data. Purging it would leave the org with no policy at all, and the ' +
      'service refuses to capitalise anything when it cannot read one, so the first CAPEX ' +
      'expense of January would be blocked rather than mis-posted.',
  },
  asset_category_lives: {
    class: 'keep',
    reason: 'As asset_policy — agreed useful lives per category are configuration, not activity.',
  },
  fixed_assets: {
    class: 'keep_shell',
    clearColumns: ['cost', 'salvage_value', 'acquired_on', 'source_expense_id'],
    reason:
      'ADR-007 §3 names this case exactly: "fixed assets keep name, category and remaining ' +
      'useful life; cost and accumulated depreciation are re-entered." The physical asset still ' +
      'exists on 1 January — a fridge does not stop being a fridge — so the ROW survives and its ' +
      'financial columns are cleared and re-entered from the December walk-round (T-134 B2). ' +
      '⭐ Accumulated depreciation needs no clearing here BECAUSE IT IS NOT STORED: it is derived ' +
      'from journal_entries, which purge, so it returns to zero on its own. ⚠️ Classifying this ' +
      'table is what revealed the shell could not physically EXIST: cost was NOT NULL, so the ' +
      'purge could not have cleared it. fixed_assets.status gained an explicit ' +
      '`pending_valuation` state, and the cutover leaves every surviving row in it — which also ' +
      'makes T-134s "what is still missing" list a plain query rather than a reconciliation.',
  },

  // ---- T-130: suppliers, supplier invoices, AP payments --------------------------------
  suppliers: {
    // ⭐ keep_shell, not keep — same reasoning as `customers`: the ROW survives (who we buy
    // from does not stop existing because the books restarted) but the reconciliation anchor
    // is cleared, because it attests a verification against a ledger that no longer exists.
    class: 'keep_shell',
    reason:
      'WHO the business buys from. Identity, not activity. No balance to clear — it is summed ' +
      'from 2110, and that ledger purges, so a kept supplier correctly opens at zero. The ' +
      'reconciliation anchor is CLEARED: a stale one would tell an aging report that a live ' +
      'obligation was settled.',
    clearColumns: ['reconciled_as_of', 'reconciled_at', 'reconciled_by'],
  },
  supplier_invoices: {
    class: 'purge',
    reason:
      'Operational financial activity — a source document behind a credit expense posting, ' +
      'same class as expenses and journal_entries. Replaced wholesale by the 2027-01-01 opening ' +
      'entry (row 106); no pilot invoice survives the cutover.',
  },
  ap_payments: {
    class: 'purge',
    reason: 'As supplier_invoices — activity, not configuration. The supplier who was paid survives; the payment does not.',
  },
  ap_payment_allocations: {
    class: 'purge',
    reason: 'As ap_payments — its child rows, naming which expense a payment settled. Purged first: children before parents (PURGE_ORDER_HINT).',
  },

  // ---- T-145: item master and invoice lines ------------------------------------------
  items: {
    // ⭐ keep, not keep_shell: an item carries no balance and no reconciliation anchor, so
    // nothing about it becomes false when the books restart. WHAT the business buys does not
    // change on 1 January.
    class: 'keep',
    reason:
      'WHAT the business buys. Identity and unit of measure, with no balance and no anchor — ' +
      'nothing on this row is invalidated by the ledger purge, and re-keying 385 items by hand ' +
      'at cutover would be pointless work with a fresh chance to introduce duplicates.',
  },
  supplier_invoice_lines: {
    class: 'purge',
    reason:
      'The detail of a purchase document — same class as supplier_invoices, which it hangs off ' +
      'by CASCADE. ⚠️ Purging these purges the PRICE HISTORY with them, which is correct but ' +
      'worth stating: price history is derived from lines, so a cutover resets it to empty and ' +
      'it rebuilds from the first post-cutover invoice.',
  },

  store_item_sellability: {
    // ⭐ keep, like the items it qualifies: which store makes the bulgogi sauce and which buys it
    // is configuration about how the business operates, not activity. Nothing about it becomes
    // false when the ledger restarts.
    class: 'keep',
    reason:
      'Per-store exceptions to what an item may be bought and sold as. Configuration, no balance, ' +
      'nothing the cutover invalidates — and re-deciding it per store by hand would be pointless work.',
  },
  item_pricing: {
    // Keep, like the items it prices: a markup rule is configuration about how the business
    // operates, not activity. Nothing about it becomes false when the ledger restarts, and
    // re-entering a pricing rule per item by hand would be pointless work.
    class: 'keep',
    reason:
      'The branch-price rule per item. Configuration, no balance, nothing the cutover ' +
      'invalidates. The COST it is applied to is derived from invoice history, which purges ' +
      'with the invoices - so the rule survives and simply re-derives against post-cutover ' +
      'purchases.',
  },
  item_requests: {
    // ⭐ keep, NOT purge — and this is the one place an approval record survives the cutover.
    // `cash_requests` purges because the money it moved is replaced by the opening balance; an
    // ITEM is not replaced, it carries forward. Purging the request would leave a kept item with
    // no record of who authorised that identity, which is the whole point of making a super-admin
    // approve it.
    class: 'keep',
    reason:
      'The provenance of a kept item: who asked for it, who approved it, and what near-duplicate ' +
      'warning they were shown at the time. The item survives the cutover, so its authorisation ' +
      'must too — otherwise the control leaves no trace.',
  },
  supplier_items: {
    // ⭐ keep, like `items`: a declaration that a supplier CAN sell us something carries no
    // balance and is not invalidated by the ledger restarting. ⚠️ The observed half of the
    // catalogue is not here to classify — it is a query over supplier_invoice_lines, which
    // purge, so observed links correctly reset to empty and rebuild from the first new invoice.
    class: 'keep',
    reason:
      'A human-declared "this supplier can sell us this". No balance, no anchor, nothing the ' +
      'cutover falsifies. Re-declaring them by hand would be pointless work.',
  },

  // ---- T-131: accounts receivable -----------------------------------------------------
  trade_orders: {
    // Purge, like every other posting document. An order is ACTIVITY — it raised a receivable
    // that the opening balance replaces. Keeping it would leave an order pointing at an
    // ar_charge that no longer exists.
    class: 'purge',
    reason:
      'A posting document. The receivable it raised is replaced by the cutover opening balance, ' +
      'so the order that raised it must go with it.',
  },
  trade_order_lines: {
    // ⚠️ Purged BY CASCADE from trade_orders, not independently — same shape as
    // supplier_invoice_lines. Listed so the classification test sees every table.
    class: 'purge',
    reason:
      'Lines of a purged order, removed by CASCADE. ⚠️ Purging these purges the captured ' +
      'wholesale rates with them, which is correct: the price list survives and is the standing ' +
      'quote a new order re-captures from.',
  },
  cutover_steps: {
    // Keep. These rows ARE the record of the conversion - who attested the count, who ran the
    // purge, who posted the opening entry. Purging them would erase the audit trail of the very
    // event the purge is part of.
    class: 'keep',
    reason:
      'The accountability record of the conversion itself. Purging it would erase the audit trail ' +
      'of the event doing the purging.',
  },
  opening_counts: {
    // Keep. The counted stock is what the opening balance is BUILT from - it is the evidence
    // behind a figure the cutover posts, not activity the cutover replaces.
    class: 'keep',
    reason:
      'The evidence behind the opening inventory figure. It is an input to the cutover, not ' +
      'activity the cutover supersedes.',
  },
  finding_acknowledgements: {
    // Purge. Every acknowledgement is about a condition in the PRE-cutover ledger, and that ledger
    // is replaced wholesale by the opening entry. Keeping them would suppress findings about books
    // that no longer exist - the precise failure this feature was designed to prevent.
    class: 'purge',
    reason:
      'Acceptances of conditions in a ledger the cutover replaces. Keeping them would suppress ' +
      'findings about books that no longer exist.',
  },
  channel_settlements: {
    // Purge, like every other posting document. A settlement clears a receivable the opening
    // balance replaces, so keeping it would leave it pointing at a sales day that no longer
    // exists and a receivable already superseded.
    class: 'purge',
    reason:
      'A posting document. The receivable it cleared is replaced by the cutover opening balance.',
  },
  ar_charges: {
    class: 'purge',
    reason:
      'A source document that posts into the ledger — same class as expenses and ' +
      'supplier_invoices. Replaced wholesale by the 2027-01-01 opening entry (row 106), which ' +
      'carries AR as ONE balance per customer rather than a replay of individual charges.',
  },
  ar_collections: {
    class: 'purge',
    reason: 'Activity, not configuration. The customer survives the cutover; the payment does not.',
  },
  ar_collection_allocations: {
    class: 'purge',
    reason: 'Child rows of ar_collections, naming which charge a collection settled. Children before parents (PURGE_ORDER_HINT).',
  },
  ar_write_offs: {
    class: 'purge',
    reason:
      'A posting document like any other. ⚠️ The bad-debt EXPENSE it recognised is history that ' +
      'belongs to the closed year; nothing about it should survive into the opening balance.',
  },

  // ---- ETL: purged, but LATER ---------------------------------------------------------
  etl_source_documents: {
    class: 'purge',
    notBefore: '2027-01-31',
    reason:
      'Holds 19,358 captured v1 documents including real PII, AND is the evidence behind every ' +
      'opening figure. Purging on 1 January destroys the ability to answer "where did this ' +
      'number come from?" in the exact month it is asked. Goes once the opening balance is ' +
      'signed off — PII with no remaining purpose is a liability (ADR-007 §6).',
  },
  etl_runs: { class: 'purge', notBefore: '2027-01-31', reason: 'As etl_source_documents — the run history that dates the evidence.' },
  etl_quarantine: { class: 'purge', notBefore: '2027-01-31', reason: 'As etl_source_documents — what could not be converted, and why.' },
  etl_reconciliation: { class: 'purge', notBefore: '2027-01-31', reason: 'As etl_source_documents — the proof nothing landed went missing.' },
};

/** Tables the purge must never touch even if classified — belt and braces around views. */
export const NON_TABLE_RELATIONS: readonly string[] = [
  'v_account_balance',
  'v_trial_balance',
  'v_income_statement',
  // T-154 — 'is this person on the roster' is DERIVED, never a stored boolean (bible §4.2 rule 7).
  'v_active_employments',
];

export function classify(table: string): CutoverEntry | undefined {
  return CUTOVER_CLASSIFICATION[table];
}

export function tablesInClass(cls: CutoverClass): string[] {
  return Object.entries(CUTOVER_CLASSIFICATION)
    .filter(([, e]) => e.class === cls)
    .map(([t]) => t)
    .sort();
}

/**
 * Purge order: children before parents, so a DELETE never trips a foreign key. Derived from
 * the real FK graph at runtime by the purge script; this is the fallback ordering used only
 * when the graph is unavailable, and it is deliberately explicit rather than clever.
 */
export const PURGE_ORDER_HINT: readonly string[] = [
  'sessions',
  'finding_acknowledgements',
  'channel_settlements',
  'sales_day_channels',
  'sales_days',
  'ar_collection_allocations',
  'ar_write_offs',
  'ar_collections',
  'trade_order_lines',
  'trade_orders',
  'ar_charges',
  'ap_payment_allocations',
  'supplier_invoice_lines',
  'expense_payments',
  'expenses',
  'ap_payments',
  'supplier_invoices',
  'journal_lines',
  'journal_entries',
  'audit_log',
  'etl_reconciliation',
  'etl_quarantine',
  'etl_source_documents',
  'etl_runs',
];
