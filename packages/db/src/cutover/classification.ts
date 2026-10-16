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
  /** Only a `purge` entry carries `notBefore`; declared here so a reader of the union can ask any entry for it. */
  readonly notBefore?: undefined;
}

export interface PurgeEntry extends BaseEntry {
  readonly class: 'purge';
  /** ADR-007 §6 — the ETL tables are evidence behind the opening balance and must survive the
   *  1 January purge, then go once it is signed off. The purge REFUSES them before this date. */
  readonly notBefore?: string;
}

export interface KeepShellEntry extends BaseEntry {
  readonly class: 'keep_shell';
  /** Only a `purge` entry carries `notBefore`; declared here so a reader of the union can ask any entry for it. */
  readonly notBefore?: undefined;
  /** The row survives; these columns are set NULL and re-entered at cutover. */
  readonly clearColumns: readonly string[];
  /** T-347 (DEF-437) §3.2 — literal values the shell step writes instead of NULL, in the SAME
   *  UPDATE as `clearColumns` (never a column also listed there — `cutover-classification.test.ts`
   *  U1 enforces it). `fixed_assets` uses this to reclassify every surviving row to
   *  `pending_valuation` and clear its stale `needs_review` flag in one statement. */
  readonly set?: Readonly<Record<string, string | boolean>>;
  /** T-347 (DEF-437) §3.2 — rows describing something that no longer exists on 1 January are
   *  DELETEd outright (before the `set`/`clearColumns` UPDATE), never shelled. `fixed_assets` uses
   *  this to drop every `disposed` row — Ian's Q2 ruling. */
  readonly dropWhere?: { readonly column: string; readonly in: readonly string[] };
}

export interface DateScopedEntry extends BaseEntry {
  readonly class: 'date_scoped';
  /** Only a `purge` entry carries `notBefore`; declared here so a reader of the union can ask any entry for it. */
  readonly notBefore?: undefined;
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
  stores: {
    // ⭐ **PLAIN KEEP. Every column survives, `wastage_monitor_person_id` included** — Ian,
    // 2026-09-07, stating the rule the cutover follows: *"the cutover wipes transactional data, not
    // stores and store settings"* (bible §13 row 182).
    //
    // ⛔ **This REVERSES T-178's carve-out**, which made the table `keep_shell` and nulled
    // `wastage_monitor_person_id` on the reasoning that who held that pilot-era job is an
    // assignment to re-decide for production — grouping it with the reconciliation anchor on
    // `customers`. **The analogy does not hold.** That anchor is cleared because it ATTESTS a
    // verification the purge invalidates; the Monitor attests nothing, it is a forward-looking
    // assignment, and a store setting of exactly the same kind as `remittance_cadence` and
    // `unremitted_ceiling`, both of which survive.
    //
    // ⚠️ **What the carve-out actually did, which is why it went:** it put every branch into the
    // no-Monitor state on cutover morning. With none set, `recordOrderWastage`'s invariant-2 seed
    // silently does nothing, every tracked wastage is created ownerless, and the 15-day backstop
    // falls to *store absorbs, net zero* — nothing recovered, nothing errored. That is DEF-206
    // re-created fleet-wide at the one moment nobody is watching for it.
    //
    // ⭐ Changing who holds the job for production is now an ORDINARY EDIT on
    // `/settings/wastage-monitor` (T-229 slice 3 — `setWastageMonitor`, gated
    // `manage_store_settings`), which is the honest way to re-decide an assignment: deliberately,
    // by a named person, not by a purge blanking a field and hoping somebody notices.
    class: 'keep',
    reason:
      'Configuration — the branch list and every setting on it, wastage_monitor_person_id ' +
      'included. Ian 2026-09-07: the cutover wipes transactional data, not store settings. ' +
      'Re-deciding the Monitor for production is an edit on /settings/wastage-monitor.',
  },
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
  // T-264 slice 3 — DEF-284, docs/plans/264-slice3-plan.md.
  period_overrides: {
    class: 'purge',
    reason:
      'CASCADEs off journal_entries (ON DELETE CASCADE, entry_id), which is itself purge — same ' +
      'lineage as journal_lines, children before parents. An override record about a pilot-era ' +
      'entry that no longer exists after cutover is exactly audit_log’s own reasoning: pointing at ' +
      'a deleted id is worse than no record at all.',
  },
  audit_log_event_keys: {
    class: 'purge',
    reason:
      'T-402 R10 idempotency keys of offline events: each key lives exactly as long as its audit_log row, ' +
      'so it is purged with audit_log (R15 dumps audit_log first). Truncated in the same statement as its ' +
      'parent: the composite FK to audit_log is satisfied within one multi-table TRUNCATE.',
  },
  authz_denial_counts: {
    class: 'purge',
    reason:
      'T-402 R9 hourly counters of un-rolled authorisation denials: rehearsal and pilot noise, not production ' +
      'history. Dropped at cutover with the log they summarise.',
  },
  audit_log: {
    class: 'purge',
    // T-350 S3 amendment M3 (planner ruling) — org-scoped since migration 0167, but classification
    // is unchanged: what it records before cutover is rehearsal and pilot activity, not production
    // history, regardless of which org wrote it.
    reason:
      'Rows written before cutover record rehearsal and pilot actions, not production history; ' +
      'they are dropped at cutover. T-402 (migration 0197): audit_log is now PARTITIONED; TRUNCATE of the ' +
      'parent truncates every partition, and a partition is its parent for this classification (R6). ' +
      'R15 (S3) dumps the table before the purge.',
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
  /** ⚠️ **This one is not obviously `purge`, and the reasoning is worth reading before changing
   *  it.** Every other operational table is purged because the 2027-01-01 opening entry replaces
   *  it. **This table is not replaced by anything** — the opening entry is a balance-sheet
   *  position, and a statutory register is a list of transactions that already happened. Purging
   *  it destroys evidence for sales the business really made, in periods BIR can still assess.
   *  ⛔ But it is still `purge`, for the same reason as `etl_*`: the Oct–Dec rows are **pilot**
   *  data, and a pilot register is not the store's statutory record — the paper logbook is
   *  (T-137 §6). Keeping half-real rows past cutover would produce a register that looks
   *  authoritative and is not. **If the pilot is ever declared the real record, this becomes
   *  `date_scoped` on `business_date` — a decision for Ian, not a default.** */
  statutory_discount_records: {
    class: 'purge',
    reason:
      'Pilot-period statutory records, not the storeâs register of record — the paper logbook is ' +
      '(T-137 §6). Purged like every other operational table so no half-real row survives to look ' +
      'authoritative in a BIR audit. Revisit as date_scoped only if Ian declares the pilot register ' +
      'the real one.',
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
  pin_attempt_throttle: {
    class: 'purge',
    reason:
      'A rate-limit counter, not configuration — same class as sessions and for the same ' +
      'reason. A cooldown mid-window in December has no business surviving into January. ' +
      'A bucket is a store, the organisation, or (T-416) the administrator-PIN approvals of one person.',
  },
  sign_in_attempts: {
    class: 'purge',
    reason:
      'Attempt history, same class as pin_attempt_throttle and for the same reason: attempt ' +
      'history from December has no business in the January ledger. Rows belong to a store, ' +
      'the organisation, or (T-416) the person who typed an administrator-approval PIN.',
  },

  v1_master_links: {
    class: 'keep',
    reason:
      'The v1 to v2 key the master-data load writes: T-390 price list and the T-392 AP tie read it, and after 1 January ' +
      'it is provenance. Purging it would let a re-run duplicate every record it had already created.',
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

  // ---- T-289: position access defaults (the spine) --------------------------------------
  position_capability_defaults: {
    class: 'keep',
    reason:
      'Access configuration, not pilot activity — the same reasoning as person_grants above, ' +
      'whose row it is: purging it would silently strip capability from staff who need it on ' +
      'day one, AND strand every person_grants row whose source_ref points at it (the FK is ' +
      'RESTRICT, so a purge would fail loudly anyway, which is the argument here, not the accident).',
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

  // ---- T-181: the Lane A outbox (Phase 4, lane B) ---------------------------------------
  mirror_outbox: {
    class: 'purge',
    reason:
      'A queue, not a record. Every row is an intent to publish something that has already been ' +
      'published, and the source rows it points at are the truth. ⚠️ Purging it on 1 January is ' +
      'safe ONLY because the mirror is rebuilt by re-enqueuing from source, never by replaying this ' +
      'table — which is also why it carries no payload column.',
  },

  // ---- T-185: attendance credentials (Phase 4, lane B) ----------------------------------
  attendance_credentials: {
    class: 'keep',
    reason:
      'A badge does not stop being somebody’s badge because the books restarted, and re-enrolling ' +
      'every staffer’s fingerprint on 1 January is a day of work that buys nothing. ⚠️ The rows are ' +
      'kept, but every credential belonging to an employment that did NOT carry over must be ' +
      'revoked in the same pass — a live badge for somebody who no longer works here is exactly ' +
      'the credential that punches unnoticed.',
  },

  // ---- T-182: the Lane B quarantine (Phase 4, lane B) -----------------------------------
  inbox_quarantine: {
    class: 'purge',
    reason:
      'Failed pilot punches. Purged with attendance_punches, which it is the failed half of. ' +
      '⚠️ An UNRESOLVED row at cutover is a punch nobody ever settled — the purge rehearsal ' +
      '(ADR-007) should report the count rather than discard it silently, because a store with a ' +
      'backlog here is a store whose attendance was never really working.',
  },

  // ---- T-124: fixed assets ---------------------------------------------------------------
  // T-347 (DEF-437), §3.2 — Ian's Q1 ruling: RECLASSIFIED keep_shell → purge. A keep_shell here
  // would need total_cost, coverage_start_date and coverage_months ALL nullable (`0026`'s table
  // body has them NOT NULL — DEF-437's own shape D), a second nullable-money ripple through
  // repo/prepaid.ts, domain/prepaid, the amortisation run and /prepaid, for a shell that keeps only
  // a name and category anyway — a re-entry in every practical sense. T-134 creates the opening
  // item fresh. Nothing references prepaid_items (verified against pg_constraint /
  // schema/missed-month-adjustments.ts — only missed_month_adjustments does, and that is purge
  // class too, truncated in the same batch), so there is no FK to drop and re-add for it either.
  prepaid_items: {
    class: 'purge',
    reason:
      'Ian Q1 (2026-09-25): purged and re-entered in T-134, not kept as a shell. A prepaid ' +
      'contract does not stop existing on 1 January, but its cost, start and term are re-entered ' +
      'from the December position exactly like fixed_assets — the difference is that here nothing ' +
      'worth keeping would survive a shell (name and category alone), so the row is dropped and ' +
      'recreated rather than carrying a second nullable-cost code path through the amortisation run.',
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
  pay_rates: {
    class: 'keep',
    reason:
      'What a job pays is CONFIGURATION, like the roster it belongs to — purging it would leave ' +
      'every employment unpayable on 2 January. ⚠️ Effective-dated rows from 2026 stay: a rate ' +
      'that took effect in November is still the rate in force in January until somebody changes it.',
  },
  pay_runs: {
    class: 'purge',
    reason:
      'A period paid against 2026 books, whose journal entries are themselves purged. v2 opens on a ' +
      'zero starting point.',
  },
  payslips: {
    class: 'purge',
    reason:
      'As pay_runs — what somebody earned in a purged period. ⚠️ These MUST go with the runs: a ' +
      'payslip surviving its run would claim a person was paid out of books that no longer exist.',
  },
  thirteenth_month_runs: {
    class: 'purge',
    reason:
      'A year paid against 2026 pilot books, whose journal entries are themselves purged — same ' +
      'shape as pay_runs. ⚠️ T-191 itself never runs against 2026 for real: v2 has at most Oct–Dec ' +
      '2026 posted, and that is pilot data due to be purged, not a full year. The real 2026 payout ' +
      'happens outside v2. Kept here only so the class matches every other 2026-dated run.',
  },
  thirteenth_month_payouts: {
    class: 'purge',
    reason:
      'As thirteenth_month_runs — what somebody earned in a purged run. Must go with the run it ' +
      'belongs to, same reasoning as payslips.',
  },
  separations: {
    class: 'purge',
    reason:
      'A 2026 pilot separation, whose journal entry is itself purged — same shape as every other ' +
      '2026-dated payroll table. v2 opens on a zero starting point; a real separation processed ' +
      'in 2027 is real data from day one.',
  },
  till_custody_shifts: {
    class: 'purge',
    reason:
      'A custody period over 2026 cash, against sales days that are themselves purged. v2 opens ' +
      'on a zero starting point, so who held a till in November settles nothing in the new books.',
  },
  till_count_lines: {
    class: 'purge',
    reason:
      'As till_custody_shifts — a count of a till that no longer has a shift. ⚠️ Same caveat ' +
      'as remittance_variances: an UNRESOLVED counted shortage is a real claim against a real ' +
      'person, so it must be settled or written off BEFORE cutover, never silently inherited.',
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
    clearColumns: [
      'cost',
      'salvage_value',
      'acquired_on',
      'source_expense_id',
      'in_service_on',
      'in_service_source',
    ],
    // T-347 (DEF-437), §3.2 — Ian's Q2 ruling: a disposed asset does not exist on 1 January, so it
    // is DELETEd, never shelled (dropWhere runs first). The survivor becomes the explicit shell
    // state and its stale needs_review flag is cleared with it, both in the SAME statement as
    // clearColumns — the whole reason this task exists: a half-cleared row satisfies no CHECK.
    dropWhere: { column: 'status', in: ['disposed'] },
    set: { status: 'pending_valuation', needs_review: false },
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
      'makes T-134s "what is still missing" list a plain query rather than a reconciliation. ' +
      'T-346 S2 (DEF-427): in_service_on/in_service_source clear alongside acquired_on — a shell ' +
      'with no cost or acquisition date has no in-service date either (0163\'s own shape check ' +
      'agrees: pending_valuation requires both NULL). T-347 (DEF-437): a DISPOSED row can be ' +
      'neither valued (cost NULL) nor a shell (disposal_pair_check forbids it), so it no longer ' +
      'exists on 1 January and is dropped outright; the survivor\'s status/needs_review land in the ' +
      'one UPDATE alongside every cleared column, or the fill/guard triggers this table carries ' +
      'since T-346 refuse the half-cleared intermediate state (0163, R2.5/R2.6).',
  },
  // T-345 — the missed-month catch-up link.
  missed_month_adjustments: {
    class: 'purge',
    reason:
      'CASCADEs off journal_entries (ON DELETE CASCADE, journal_entry_id), which is itself purge — ' +
      'same lineage as journal_lines and period_overrides, children before parents. A link naming a ' +
      'pilot-era catch-up entry that no longer exists after cutover is exactly period_overrides’ own ' +
      'reasoning: pointing at a deleted id is worse than no record at all.',
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

  // ---- T-160: the room model ------------------------------------------------------------
  location_types: {
    // ⭐ keep: WHAT KINDS of space a store has is configuration, and it describes the building
    // rather than anything the books did. Nothing about "we have a stockroom and a kitchen"
    // becomes false when the ledger restarts.
    class: 'keep',
    reason:
      'The catalogue of physical space kinds — Stockroom, Display, Kitchen, Receiving. ' +
      'Configuration describing the premises, carrying no balance and no anchor. Re-keying it ' +
      'at cutover would be pointless work with a fresh chance to mistype a room.',
  },
  stock_usage_records: {
    class: 'purge',
    reason:
      'Operational stock movement documents — the same class as deliveries and stock_movements. ' +
      'On 2027-01-01 every location opens at the counted figure (T-134), so the history of how it ' +
      'got there belongs to the old books.',
  },
  stock_usage_lines: {
    class: 'purge',
    reason: 'The detail of a usage record, by CASCADE. Same class as its parent.',
  },

  // ---- T-175: thresholds and the order thread ---------------------------------------------
  store_item_thresholds: {
    // ⭐ keep: WHEN to reorder is a standing judgement about how this branch runs — the same class
    // as `item_pricing`. It took a manager real thought per item, it carries no balance and no
    // anchor, and nothing about "we reorder pork at 20 kg" becomes false when the ledger restarts.
    class: 'keep',
    reason:
      'The reorder threshold per store per item — configuration, and the single most tedious ' +
      'thing in this wave to re-key. ⚠️ A threshold missed at cutover is invisible: the item ' +
      'simply never appears on the low-stock list again, and nothing says why.',
  },
  trade_order_messages: {
    class: 'purge',
    reason:
      'The conversation about one order, by CASCADE. ⚠️ It is an audit trail, and an audit trail ' +
      'of documents that no longer exist is not evidence of anything — keeping it while purging ' +
      'the orders would leave messages discussing quantities nobody can look up.',
  },

  // ---- T-174: the transit shortfall ------------------------------------------------------
  trade_discrepancies: {
    // ⛔ purge: a dispute about a shipment that moved in the OLD books belongs to the old books.
    // ⚠️ An unresolved one at cutover is not a data problem to migrate — it is a decision
    // somebody still owes, and it must be made before the year closes, not carried across it.
    class: 'purge',
    reason:
      'An operational dispute about one dispatch, and the `1340` balance it disposes of purges ' +
      'with the rest of the ledger. On 2027-01-01 every location opens at the counted figure ' +
      '(T-134), which is the answer to every transit question the old books had left open.',
  },

  // ---- T-171: the commissary catalogue --------------------------------------------------
  commissary_links: {
    // ⭐ keep: WHICH branch may order from WHICH commissary is a standing arrangement about the
    // shape of the business, not a transaction. Nothing about "Malvar orders from Lipa" becomes
    // false when the ledger restarts.
    class: 'keep',
    reason:
      'The supply arrangement between two stores — configuration, carrying no balance and no ' +
      'anchor. Re-keying it at cutover would be pointless work, and a missed pair silently stops ' +
      'a branch ordering on 2 January.',
  },
  commissary_item_offerings: {
    class: 'keep',
    reason:
      'What a commissary will dispatch, plus a manager-set cost of last resort. A catalogue, in ' +
      'the same class as items and price lists. ⚠️ `manual_cost` is a CONFIGURED number, not a ' +
      'derived one — it survives because nothing recomputes it.',
  },
  commissary_item_map: {
    // ⭐ The single most expensive row here to re-key, and the most dangerous to get wrong: a
    // missing map line is what makes a receipt land with nothing to credit.
    class: 'keep',
    reason:
      'The cross-store item correspondence and the branch’s expense category for receiving it. ' +
      'Configuration that took real effort to build and answers "which of MY products is this ' +
      'commissary’s line" — a question the ledger restarting does not change.',
  },

  count_sessions: {
    class: 'purge',
    reason:
      'A physical count is an operational event about a period that is ending. ⚠️ The 31 December ' +
      'opening count is NOT this table — T-134 owns `opening_counts`, which is KEEP-classified ' +
      'because it is the evidence behind the opening balance.',
  },
  count_session_locations: {
    class: 'purge',
    reason: 'Which rooms a count covered, by CASCADE. Same class as its session.',
  },
  count_lines: {
    class: 'purge',
    reason: 'The counted quantities and their variances. Same class as the session they belong to.',
  },

  deliveries: {
    class: 'purge',
    reason:
      'The receiving document — operational, and the source of the stock_movements, stock_layers ' +
      'and journal entries it created, all of which purge. ⚠️ Keeping deliveries while purging ' +
      'what they caused would leave documents claiming stock that no longer exists.',
  },
  delivery_lines: {
    class: 'purge',
    reason: 'The detail of a delivery, hanging off it by CASCADE. Same class as its parent.',
  },

  stock_layers: {
    // ⭐ purge, with stock_movements. A layer IS a valued receipt, so keeping layers while purging
    // the movements that created them would leave cost with no quantity behind it — the two halves
    // of one fact, separated.
    class: 'purge',
    reason:
      'FIFO cost layers — the valued half of a stock receipt, and operational for exactly the ' +
      'reason stock_movements is. ⚠️ The 2027-01-01 opening layer is written FRESH by the cutover ' +
      'at counted value (T-134), so purging is what makes room for it rather than losing anything.',
  },
  stock_layer_consumptions: {
    class: 'purge',
    reason:
      'The inventory subledger — which layer paid for which movement. Purged with both parents; ' +
      'it is the detail behind journal entries that are themselves purged.',
  },

  stock_movements: {
    // ⭐ PURGE, and it is the counterweight to `stock_locations` being KEEP. The rooms are
    // configuration and survive; what was IN them is operational history and does not. On
    // 2027-01-01 every store opens at zero on-hand and the opening count (T-134) is what puts
    // stock back — which is row 106's "zero starting point" applied to quantity rather than money.
    class: 'purge',
    reason:
      'The stock ledger — operational movements, the same class as journal_entries and expenses. ' +
      'On-hand is derived from these rows, so purging them opens every location at zero, which is ' +
      'exactly what the 31 December counted opening balance then replaces. ⚠️ Keeping them would ' +
      'carry pilot stock into the real books while the ledger behind it was deleted.',
  },

  stock_transfers: {
    class: 'purge',
    reason:
      'A room-to-room movement document — operational, same class as stock_movements. ⚠️ It posts ' +
      'no journal entry and consumes no layer (T-162 invariant 6), so purging it loses no value ' +
      'the ledger needs; every store opens 2027-01-01 already knowing nothing crossed a doorway.',
  },
  stock_transfer_lines: {
    class: 'purge',
    reason: 'The detail of a transfer, hanging off it by CASCADE. Same class as its parent.',
  },
  stock_reservations: {
    class: 'purge',
    reason:
      'A "goods in the truck" marker for an in-transit transfer. Operational, and every ' +
      'reservation is either released or belongs to a transfer that purges with it — there is no ' +
      'live truck to carry across a cutover.',
  },

  supplier_returns: {
    class: 'purge',
    reason:
      'A goods-back document — operational, same class as deliveries. ⚠️ The CREDIT it left ' +
      'behind (1240) is a live balance sheet fact and survives independently through the ' +
      'opening balance, the same way an AP invoice\'s liability survives its own purged document.',
  },
  supplier_return_lines: {
    class: 'purge',
    reason: 'The detail of a return, hanging off it by CASCADE. Same class as its parent.',
  },

  customer_returns: {
    class: 'purge',
    reason:
      'A goods-back document — operational, same class as trade_orders. ⚠️ The CREDIT it left ' +
      "behind (2140) is a live balance sheet fact and survives independently through the " +
      "opening balance, the same way an AR charge's receivable survives its own purged document.",
  },
  customer_return_lines: {
    class: 'purge',
    reason: 'The detail of a return, hanging off it by CASCADE. Same class as its parent.',
  },

  stock_locations: {
    // ⭐ keep, and this is the one worth reading twice. The ROOMS survive; the STOCK IN THEM does
    // not — stock lives in stock_movements (T-161), which purges. A room with no movements behind
    // it is just a labelled shelf, and the shelf is still there on 2 January.
    class: 'keep',
    reason:
      'The rooms themselves, not their contents. Stock is held in stock_movements, which purges ' +
      'independently, so a kept room opens at zero on-hand exactly like a kept item opens with ' +
      'no history. ⚠️ Purging these instead would delete the default-room and Receiving ' +
      'configuration every store needs before it can receive anything at all.',
  },
  departments: {
    class: 'keep',
    reason:
      'The attribution taxonomy usage is reported by — kitchen, bar. Org-level configuration, ' +
      'the same class as expense_categories: a fixed vocabulary the reports group on, which ' +
      'means nothing if it is re-invented per period.',
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
  finding_occurrences: {
    // Purge, for the same reason as the acknowledgements above and one more. Every occurrence
    // records how long a condition in the PRE-cutover ledger went unfixed, and that ledger is
    // replaced wholesale. Keeping them would age findings against books that no longer exist, and
    // would credit or blame a store for clearing something the cutover erased.
    class: 'purge',
    reason:
      'The lifespan of conditions in a ledger the cutover replaces. Keeping them would age ' +
      'findings against books that no longer exist.',
  },
  finding_views: {
    // Purge. Who read a screen about the pre-cutover ledger says nothing about the new one, and
    // the accountability record it feeds ("nobody has looked since...") would start out lying.
    class: 'purge',
    reason:
      'Views of a screen about a ledger the cutover replaces. Carrying them forward would make ' +
      '"last looked at" refer to books that no longer exist.',
  },
  prerequisite_refusals: {
    // T-245. Purge, same reasoning as finding_occurrences: this is pilot-period telemetry about
    // how often anyone hit an order-of-operations wall in the PRE-cutover system. The January
    // cutover replaces the workflow state these refusals were measuring against, so keeping them
    // would count walls against data that no longer exists and mis-prioritise whatever tutorial
    // work the counter is meant to rank.
    class: 'purge',
    reason:
      'Pilot-period telemetry about walls hit in the pre-cutover system. Keeping it would count ' +
      'refusals against workflow state the cutover replaces.',
  },
  channel_settlements: {
    // Purge, like every other posting document. A settlement clears a receivable the opening
    // balance replaces, so keeping it would leave it pointing at a sales day that no longer
    // exists and a receivable already superseded.
    class: 'purge',
    reason:
      'A posting document. The receivable it cleared is replaced by the cutover opening balance.',
  },
  // ---- T-178: order/channel wastage disposition ------------------------------------------
  order_wastages: {
    // Purge, same reasoning as channel_settlements directly above: a posting document that
    // clears (or explains not clearing) a channel receivable the opening balance replaces. It
    // also points at a sales_day and journal_entry, both themselves purged.
    class: 'purge',
    reason:
      'A posting/decision document over a channel receivable superseded by the cutover opening ' +
      'balance, exactly like channel_settlements and ar_charges. Not carried forward.',
  },
  order_wastage_allocations: {
    class: 'purge',
    reason: 'Child of order_wastages (ON DELETE CASCADE); purges with its parent for the same reason.',
  },
  recurring_expense_drafts: {
    class: 'purge',
    reason:
      'PROVENANCE ABOUT EXPENSES, not configuration — one row per (template, due date) saying ' +
      'which invoice and which expense that date produced. Every document it points at is class ' +
      'PURGE, so after 1 January it would describe nothing: a table of pointers to rows that no ' +
      'longer exist. ⚠️ Its parent `recurring_expenses` is KEEP and that is not a contradiction — ' +
      'the template is the standing fact ("Lipa pays rent on the 5th"), this is the log of what it ' +
      'did in 2026. ⛔ Both document FKs are ON DELETE SET NULL for the reason 0132 records: a row reached ' +
      'from a KEEP table must never be able to BLOCK the purge of a PURGE one.',
  },
  recurring_expenses: {
    // T-347 (DEF-437) — RECLASSIFIED keep → keep_shell (one column). `ON DELETE SET NULL` answers
    // an ordinary row-by-row DELETE of an expense, but NEVER a TRUNCATE: Postgres refuses to
    // TRUNCATE a table referenced by ANY foreign key from a table not in the same TRUNCATE
    // statement, regardless of that FK's ON DELETE action (SET NULL/CASCADE/RESTRICT all block it
    // identically). This is a genuinely NEW same-root shape T-347's own dynamic FK derivation
    // (`purge.ts`'s `planPurge`, reading `pg_constraint` rather than a hand-list) caught that
    // §2's evidence sweep did not enumerate — reported and fixed together, per the task's own
    // "orchestrator registers" note for shapes the sweep finds.
    class: 'keep_shell',
    clearColumns: ['last_drafted_expense_id'],
    reason:
      'CONFIGURATION, and the clearest case in the table. A template says "Lipa pays rent on the ' +
      '5th" — a standing fact about how the business operates, not an event that happened in ' +
      '2026. Purging it would mean re-typing every fixed bill on 1 January, which is exactly the ' +
      'forgetting this module exists to prevent. `last_drafted_expense_id` points at `expenses`, ' +
      'which PURGES, so the ROW survives as keep_shell with exactly one column cleared — the same ' +
      'shape as fixed_assets.source_expense_id, and provenance of a deleted draft is worth nothing ' +
      'anyway. ⛔ **The trap this classification USED TO expose, restated correctly:** `ON DELETE ' +
      'SET NULL` prevents a blocking RESTRICT on an ordinary DELETE, but TRUNCATE checks for any ' +
      'referencing FK regardless of its ON DELETE action — so this column still needed the same ' +
      'drop/clear/re-add procedure T-347 built for fixed_assets, not exemption from it.',
  },
  expense_budgets: {
    class: 'purge',
    reason:
      'A cap for a PERIOD, and every period it names is a 2026 period — the key is `YYYYMM`. ' +
      '⚠️ The judgement worth stating: this is the closest call in the whole table, because a ' +
      'budget LOOKS like configuration and a store will want its January caps on 1 January. But ' +
      'ADR-007 §1 is about what a row MEANS, not how convenient it is: a 202612 envelope is a ' +
      'statement about December trading, and carrying it forward would open the year with caps ' +
      'nobody re-agreed. The auto-reissue job re-creates a live cap on its own schedule, so the ' +
      'ones that should survive do — by being recreated deliberately, not by escaping a purge.',
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

  // ---- T-176: production — slab -> slice, recipe -> batch --------------------------------
  production_recipes: {
    class: 'keep',
    reason:
      'A repeatable prep conversion is a standing instruction ("this is how we cut a slab"), ' +
      'configuration exactly like expense_categories or sales_channels — not a transaction the ' +
      'pilot produced.',
  },
  production_recipe_lines: {
    class: 'keep',
    reason: 'The detail of a recipe, hanging off it by CASCADE. Same class as its parent.',
  },
  production_records: {
    class: 'purge',
    reason:
      'Operational — one real conversion event, the same class as stock_movements and ' +
      'journal_entries. Replaced wholesale by the 2027-01-01 opening entry (row 106); no pilot ' +
      'production run survives the cutover.',
  },
  production_record_lines: {
    class: 'purge',
    reason: 'The detail of a record, hanging off it by CASCADE. Same class as its parent.',
  },
  pos_item_maps: {
    class: 'keep',
    reason:
      'A standing "this POS item means this stock item" decision — configuration, the same class ' +
      'as production_recipes. Nobody wants to re-map a menu on 1 January.',
  },
  pos_map_requests: {
    class: 'keep',
    reason: 'The provenance of a mapping decision, same class as item_requests — kept with the map it produced.',
  },
  pos_usage_pulls: {
    class: 'purge',
    reason:
      'Operational — one real reconciliation event per (store, sales day), the same class as ' +
      'stock_usage_records. No pilot pull survives the cutover.',
  },
  pos_usage_pull_lines: {
    class: 'purge',
    reason: 'The detail of a pull, hanging off it by CASCADE. Same class as its parent.',
  },

  // ---- T-386: item codes (migration 0189) -----------------------------------------------------
  item_code_counters: {
    class: 'keep',
    reason:
      "Items are kept, so the numbers already issued to them must stay issued; purging the marks would let a kept item's " +
      'number be issued again.',
  },

  // ---- T-375: the POS v1 day feed (migration 0183) --------------------------------------------
  pos_v1_store_links: {
    class: 'keep',
    reason:
      'Configuration: which v2 store is which POS store, and the channel and tax type its sales land under. The ' +
      'same class as pos_item_maps - nobody re-links a store on 1 January, and a purged link would silently flip a ' +
      'linked store back to the typed path (the link row IS the per-store switch, I10).',
  },
  tenders: {
    class: 'keep',
    reason:
      'The tender master a till sells against (ADR-015 section 7): configuration, the same class as ' +
      'pos_item_maps. The names and wallet accounts are standing decisions, not pilot activity.',
  },
  pos_v1_day_feeds: {
    class: 'purge',
    reason:
      'Operational - the stored copy of what POS reported for a pilot-era day. Every sales day and usage pull that ' +
      'cites a feed is itself purged, so no kept row points at one. Append-only by trigger; the purge TRUNCATEs, ' +
      'which fires no row trigger. Purged AFTER sales_days and pos_usage_pulls (PURGE_ORDER_HINT).',
  },
  sales_day_pos_corrections: {
    class: 'purge',
    reason:
      'A posting document: it names a journal entry (purge) and a sales day (purge). Append-only by trigger. Purged ' +
      'BEFORE sales_days (PURGE_ORDER_HINT).',
  },

  // ---- T-392 S3: the dual-run comparator (migration 0195) -------------------------------------
  dual_run_reports: {
    class: 'purge',
    notBefore: '2027-01-31',
    reason:
      'Pilot data per ADR-007, but it is the 15 Nov go/no-go evidence, so it is kept past cutover as etl_* is: not purged ' +
      'before 2027-01-31. Append-only (the app role has no UPDATE or DELETE). Purged AFTER its lines (PURGE_ORDER_HINT).',
  },
  dual_run_lines: {
    class: 'purge',
    notBefore: '2027-01-31',
    reason: 'As dual_run_reports: the lines of a kept comparison report. Purged BEFORE dual_run_reports (PURGE_ORDER_HINT).',
  },
  dual_run_dispositions: {
    class: 'purge',
    notBefore: '2027-01-31',
    reason: 'As dual_run_reports: the defect refs a person recorded against a delta; part of the same evidence.',
  },

  // ---- T-401 S1: the ERP menu and catalog master (migration 0196) -----------------------------
  menu_categories: {
    class: 'keep',
    reason: 'The menu’s categories: standing configuration, same class as pos_item_maps. Nobody re-keys a menu on 1 January.',
  },
  menu_items: {
    class: 'keep',
    reason: 'A menu item is standing configuration (T-401), the same class as pos_item_maps and tenders.',
  },
  menu_item_variants: {
    class: 'keep',
    reason: 'The sellable unit of a menu item: standing configuration, kept with its item.',
  },
  menu_option_groups: {
    class: 'keep',
    reason: 'Option groups (flavours, sizes, add-ons) are standing configuration, kept with the menu.',
  },
  menu_option_values: {
    class: 'keep',
    reason: 'The values of an option group: standing configuration, kept with their group.',
  },
  menu_option_group_links: {
    class: 'keep',
    reason: 'Which option groups an item or variant offers: standing configuration, kept with the menu.',
  },
  menu_package_refills: {
    class: 'keep',
    reason: 'Which refills a package entitles: standing configuration, kept with the menu.',
  },
  menu_depletion_rules: {
    class: 'keep',
    reason: 'What a sale consumes (the pos_item_maps shape, effective-dated): standing configuration, the depletion history is the record.',
  },
  menu_offers: {
    class: 'keep',
    reason: 'A store’s price history: an offer history is the price record, not pilot activity, so it is kept (T-401 spec section 3).',
  },
  menu_option_offers: {
    class: 'keep',
    reason: 'A store’s option-price history: the price record, kept like menu_offers.',
  },
  menu_item_requests: {
    class: 'keep',
    reason: 'The intake of the item master: kept with the menu it feeds.',
  },
  menu_pos_v1_links: {
    class: 'keep',
    reason: 'Standing configuration (which v1 POS item is which variant), the same class as pos_item_maps.',
  },
  menu_usage_source_switches: {
    class: 'keep',
    reason: 'Configuration history: which source each store reads, kept so the cut-over is traceable.',
  },
};

/** Tables the purge must never touch even if classified — belt and braces around views. */
export const NON_TABLE_RELATIONS: readonly string[] = [
  'v_account_balance',
  'v_trial_balance',
  'v_income_statement',
  // T-209a — the fourth reporting view; docs/tasks/209-reporting-read-model-and-statements.md.
  'v_balance_sheet',
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
  'finding_views',
  'finding_occurrences',
  'finding_acknowledgements',
  // T-215. ⚠️ Self-referencing (`reissued_from_id`), so a reissued row points at its parent and
  // the whole table has to go in one DELETE rather than in FK order — listed early for that
  // reason, and because nothing else references it at all.
  'expense_budgets',
  'channel_settlements',
  'sales_day_channels',
  // T-375: corrections cite a sales day, two feeds and a journal entry; usage pulls cite a sales day and a feed.
  'sales_day_pos_corrections',
  // T-392 S3: lines cite their report; dispositions cite nothing purged.
  'dual_run_lines',
  'dual_run_reports',
  'dual_run_dispositions',
  'pos_usage_pulls',
  'sales_days',
  'pos_v1_day_feeds',
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
  'audit_log_event_keys',
  'audit_log',
  'authz_denial_counts',
  'etl_reconciliation',
  'etl_quarantine',
  'etl_source_documents',
  'etl_runs',
];
