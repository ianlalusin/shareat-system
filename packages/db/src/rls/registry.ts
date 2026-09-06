/**
 * RLS coverage registry — docs/tasks/120-row-level-security.md, ADR-008 §9–§10, bible row 112.
 *
 * Org isolation is enforced by PostgreSQL, not by remembering to write `WHERE org_id = …`.
 * That filter works until the ONE query that forgets, and that query will exist — written
 * months from now, by someone who did not know the rule, in a report or a script or a fix at
 * 11pm. Application discipline is not a control.
 *
 * A franchise with a separate owner is already live (Padre Garcia, ADR-008 §7), so the failure
 * mode is not a broken page: it is showing one business owner another business owner's books.
 *
 * **Every table declares its scoping here, and an unlisted table fails the build**
 * (`tests/unit/rls-registry.test.ts`). Same rule as the cutover classification: no default,
 * because a default is a decision made by whoever wrote it for data they have never seen.
 */

export type RlsScope =
  /** `org_id` on the table itself. */
  | 'org_column'
  /** No `org_id`; reachable only through a parent that has one. */
  | 'derived'
  /** The organizations table itself — scoped by its own `id`. */
  | 'self'
  /** RLS enabled with NO staff or customer policy. Only the system principal can read it. */
  | 'system_only';

export interface RlsEntry {
  readonly scope: RlsScope;
  /** Prose. A scoping decision without a reason cannot be reviewed by anyone but its author. */
  readonly reason: string;
  /** `derived` only — the SQL predicate linking this table to an org-bearing parent. */
  readonly via?: string;
  /**
   * ⛔ **An ACCESS table keyed on a person — its policy MUST also prove the person belongs to
   * the org** (DEF-183), in BOTH `USING` and `WITH CHECK`, whether or not the table also
   * carries its own `org_id`:
   *
   * ```sql
   * EXISTS (SELECT 1 FROM persons p WHERE p.id = <table>.person_id AND p.org_id = app_current_org())
   * ```
   *
   * `org_id = app_current_org()` alone answers *"is this row LABELLED with my org?"* — a row
   * carrying MY org_id and ANOTHER org's person_id satisfies it perfectly, and its FK is
   * satisfied too because that person genuinely exists. `person_roles` shipped that way for
   * two weeks and a cross-org role write was allowed.
   *
   * Enforced by `packages/db/tests/integration/rls.test.ts` — *"every person-keyed access table
   * uses the via_person form"* — which reads the LIVE policy out of `pg_policies` rather than
   * trusting this flag. Tables in `schema/access.ts` are picked up automatically; this marker
   * is what extends the guard to a person-keyed access table defined elsewhere.
   */
  readonly personKeyedAccess?: true;
}

export const RLS_REGISTRY: Readonly<Record<string, RlsEntry>> = {
  organizations: {
    scope: 'self',
    reason: 'The tenancy boundary itself. A principal sees its own organization row and no other.',
  },
  stores: { scope: 'org_column', reason: 'Branches belong to one org. A franchise never sees another org’s stores.' },

  // ---- T-160: the room model ------------------------------------------------------------
  location_types: {
    scope: 'org_column',
    reason:
      'How an org names its kinds of space. A franchise defines its own and must never see ' +
      'another org’s.',
  },
  stock_usage_records: {
    scope: 'org_column',
    reason: 'A usage record belongs to a store, and a store to one org.',
  },
  stock_usage_lines: {
    scope: 'derived',
    reason: 'No org_id of its own — reached only through its record, like delivery_lines.',
    via: 'exists (select 1 from stock_usage_records r where r.id = record_id and r.org_id = app_current_org())',
  },

  // ---- T-175: thresholds and the order thread ---------------------------------------------
  store_item_thresholds: {
    scope: 'org_column',
    reason: 'A threshold belongs to a store, and a store to one org.',
  },
  trade_order_messages: {
    scope: 'org_column',
    reason:
      'A conversation between two stores of one org. ⚠️ It carries its own `org_id` rather than ' +
      'reaching through the order, because it is read on its own far more often than with one.',
  },

  // ---- T-174: the transit shortfall ------------------------------------------------------
  trade_discrepancies: {
    scope: 'org_column',
    reason: 'A dispute between two stores of ONE org. It never spans one.',
  },

  // ---- T-171: the commissary catalogue --------------------------------------------------
  commissary_links: {
    scope: 'org_column',
    reason:
      'Both stores in a link belong to one org — that is what makes the transfer internal. A ' +
      'franchise’s supply arrangements are its own.',
  },
  commissary_item_offerings: {
    scope: 'org_column',
    reason: 'A commissary’s catalogue belongs to its store, and a store to one org.',
  },
  commissary_item_map: {
    scope: 'org_column',
    reason: 'A correspondence between two stores of the SAME org. It never spans one.',
  },

  count_sessions: {
    scope: 'org_column',
    reason: 'A count belongs to a store, and a store to one org.',
  },
  count_session_locations: {
    scope: 'derived',
    reason: 'Reached only through its session.',
    via: 'exists (select 1 from count_sessions s where s.id = session_id and s.org_id = app_current_org())',
  },
  count_lines: {
    scope: 'derived',
    reason: 'Reached only through its session.',
    via: 'exists (select 1 from count_sessions s where s.id = session_id and s.org_id = app_current_org())',
  },

  deliveries: {
    scope: 'org_column',
    reason: 'A delivery belongs to a store, and a store to one org.',
  },
  delivery_lines: {
    scope: 'derived',
    reason:
      'No org_id of its own — a line is only ever reached through its delivery, and duplicating ' +
      'the org onto it would be a second copy of the same fact to keep in step.',
    via: 'exists (select 1 from deliveries d where d.id = delivery_id and d.org_id = app_current_org())',
  },

  stock_layers: {
    scope: 'org_column',
    reason: 'A layer belongs to a store, and a store to one org. Cost is as tenant-private as money.',
  },
  stock_layer_consumptions: {
    scope: 'org_column',
    reason:
      'The subledger carries its own org rather than deriving it through the layer: it is joined ' +
      'from movements as often as from layers, so the policy belongs on the row being read.',
  },

  stock_movements: {
    scope: 'org_column',
    reason:
      'Every movement carries its org directly. ⚠️ org_column rather than derived through the ' +
      'location: this is the highest-volume table in the domain and every on-hand query filters ' +
      'it, so the policy belongs on the row being read, not behind a join.',
  },

  // ---- T-167: stock transfers ------------------------------------------------------------
  stock_transfers: {
    scope: 'org_column',
    reason: 'A transfer belongs to a store, and a store to one org.',
  },
  stock_transfer_lines: {
    scope: 'derived',
    reason: 'No org_id of its own — reached only through its transfer, like delivery_lines.',
    via: 'exists (select 1 from stock_transfers t where t.id = transfer_id and t.org_id = app_current_org())',
  },
  stock_reservations: {
    scope: 'org_column',
    reason:
      'Every reservation carries its org directly, same reasoning as stock_movements: it is ' +
      'looked up by (item, location) as often as by transfer, so the policy belongs on the row ' +
      'being read rather than behind a join.',
  },

  // ---- T-170: supplier returns ------------------------------------------------------------
  supplier_returns: {
    scope: 'org_column',
    reason: 'A return belongs to a store, and a store to one org.',
  },
  supplier_return_lines: {
    scope: 'derived',
    reason: 'No org_id of its own — reached only through its return, like delivery_lines.',
    via: 'exists (select 1 from supplier_returns r where r.id = return_id and r.org_id = app_current_org())',
  },

  // ---- T-179: customer returns -------------------------------------------------------------
  customer_returns: {
    scope: 'org_column',
    reason: 'A return belongs to a store, and a store to one org.',
  },
  customer_return_lines: {
    scope: 'derived',
    reason: 'No org_id of its own — reached only through its return, like supplier_return_lines.',
    via: 'exists (select 1 from customer_returns r where r.id = return_id and r.org_id = app_current_org())',
  },

  stock_locations: {
    scope: 'org_column',
    reason:
      'A room belongs to a store, and a store to one org. ⚠️ org_column rather than derived ' +
      'THROUGH the store: every stock query filters by location, so carrying org_id here means ' +
      'the policy is checked on the table actually being read rather than through a join the ' +
      'planner might reorder.',
  },
  departments: {
    scope: 'org_column',
    reason: 'An org’s own attribution vocabulary. Never shared across a tenancy boundary.',
  },
  persons: { scope: 'org_column', reason: 'The staff roster is per-org. A franchise owner must not see Ian’s staff.' },
  accounts: {
    scope: 'org_column',
    reason:
      'The chart of accounts is seeded per org. Shared-versus-per-org is ADR-008 open 1; until that ' +
      'is decided, per-org scoping is the safe default — it can be widened later without a leak, ' +
      'whereas starting shared and narrowing means having already exposed it.',
  },
  fiscal_periods: { scope: 'org_column', reason: 'Each org closes its own books on its own calendar.' },
  journal_entries: { scope: 'org_column', reason: 'The books. The single most consequential table to scope correctly.' },

  journal_lines: {
    scope: 'derived',
    via: 'exists (select 1 from journal_entries e where e.id = journal_lines.entry_id and e.org_id = app_current_org())',
    reason:
      'Has NO org_id of its own — it is reachable only through its entry. Scoping it via the parent ' +
      'rather than denormalising an org_id keeps ONE source of truth for which org an entry belongs ' +
      'to; a copied column could drift from its parent, and a line whose org disagreed with its ' +
      'entry would be invisible or visible to the wrong tenant.',
  },
  person_identities: {
    scope: 'derived',
    personKeyedAccess: true,
    via: 'exists (select 1 from persons p where p.id = person_identities.person_id and p.org_id = app_current_org())',
    reason: 'Login identities hang off persons, which carries the org.',
  },

  // T-121 — the three access axes (docs/tasks/121-roles-and-access.md, bible row 114).
  person_roles: {
    scope: 'org_column',
    personKeyedAccess: true,
    reason:
      'Who holds what role is per-org data — a franchise owner must not see, let alone infer, ' +
      'Ian\'s own org role assignments. Carries org_id directly, so it is org_column — but it is ' +
      'ALSO person-keyed, and org_column alone was not enough: see personKeyedAccess above and ' +
      'migration 0129. ⚠️ This entry previously justified the org_id column with "a person can ' +
      'hold different roles in different orgs, e.g. Ian holding several franchises\' admin". ' +
      'That is NOT reachable in the running system and was corrected by T-221 (DEF-187): ' +
      'sessions carry no org of their own, findLiveByTokenHash selects orgId FROM persons, and ' +
      'there is no org switcher — so authorize() can only ever resolve a role under the ' +
      'person\'s OWN org. A row whose org_id differs from its person\'s org has no reader ' +
      'anywhere. If bible row 114\'s franchise-admin story is later built as one person holding ' +
      'roles across orgs, migration 0129 must be revisited with it.',
  },
  person_store_scope: {
    scope: 'derived',
    personKeyedAccess: true,
    via: 'exists (select 1 from persons p where p.id = person_store_scope.person_id and p.org_id = app_current_org())',
    reason:
      'No org_id of its own — "which stores can this person see" is reached only through the ' +
      'person it names, same reasoning as person_identities. A store list is exactly the kind ' +
      'of data a franchise owner must not read for another org\'s staff.',
  },
  person_grants: {
    scope: 'derived',
    personKeyedAccess: true,
    via: 'exists (select 1 from persons p where p.id = person_grants.person_id and p.org_id = app_current_org())',
    reason:
      'No org_id of its own — grants hang off the person they were given to. DEF-052\'s lesson ' +
      'generalised: a grant with no locatable enforcement is a checkbox, and a grant no other ' +
      'org can even query is one less place that checkbox could leak.',
  },

  audit_log: {
    scope: 'system_only',
    reason:
      'Has no org column today, so it CANNOT be org-scoped yet — stated plainly rather than given a ' +
      'policy that looks like scoping and is not. RLS is enabled with no staff policy, so it is ' +
      'invisible to every tenant until Phase 2 adds the column. **Failing closed is the correct ' +
      'direction**: a missing policy breaks a feature loudly instead of leaking quietly.',
  },

  // T-122 — expenses: non-inventory spend (docs/tasks/122-expenses.md, bible rows 118-120).
  expense_categories: {
    scope: 'org_column',
    reason: 'The seeded category -> account crosswalk is per-org configuration, same reasoning as accounts.',
  },
  expenses: {
    scope: 'org_column',
    reason: 'A source document that posts into the ledger — org-scoped exactly like journal_entries, for the same reason: a franchise owner must never see another org’s spend.',
  },
  expense_payments: {
    scope: 'derived',
    via: 'exists (select 1 from expenses e where e.id = expense_payments.expense_id and e.org_id = app_current_org())',
    reason:
      'No org_id of its own — reachable only through the expense it belongs to, same pattern as ' +
      'journal_lines through journal_entries: one source of truth for which org a payment belongs ' +
      'to, so a copied column can never drift from its parent.',
  },

  // T-123 — sales day: the ERP's record of a day's selling (docs/tasks/123-sales-day.md).
  sales_channels: {
    scope: 'org_column',
    reason:
      'Per-store channel configuration. Org-scoped for the same reason as accounts: a franchise ' +
      'owner configures their own channels and must never see, let alone edit, those of another org.',
  },
  statutory_discount_records: {
    scope: 'org_column',
    reason:
      'The statutory SC/PWD register names CUSTOMERS — holder name and government ID number — ' +
      'which makes it the most personally identifying table in the schema, not merely a ' +
      'commercially sensitive one. A franchise owner reading another orgâs register would be ' +
      'reading named individualsâ disability and age status, so org_column scoping is a privacy ' +
      'boundary here, not only a tenancy one.',
  },
  sales_days: {
    scope: 'org_column',
    reason:
      'A source document that posts into the ledger — org-scoped exactly like journal_entries ' +
      'and expenses. Daily takings are among the most sensitive figures a franchise has, and ' +
      'ADR-008 §5 limits the franchisor to sales-only visibility through a separate, explicit ' +
      'grant — never through this table being readable.',
  },
  sales_day_tenders: {
    scope: 'derived',
    via: 'exists (select 1 from sales_days sd where sd.id = sales_day_tenders.sales_day_id and sd.org_id = app_current_org())',
    reason:
      'No org_id of its own — reachable only through the sales day it belongs to, the same ' +
      'pattern as sales_day_channels beside it. One source of truth for which org a tender row ' +
      'belongs to, so a copied column cannot drift from its parent.',
  },
  sales_day_channels: {
    scope: 'derived',
    via: 'exists (select 1 from sales_days sd where sd.id = sales_day_channels.sales_day_id and sd.org_id = app_current_org())',
    reason:
      'No org_id of its own — reachable only through the sales day it belongs to, the same ' +
      'pattern as expense_payments through expenses and journal_lines through journal_entries. ' +
      'One source of truth for which org a channel row belongs to, so a copied column cannot ' +
      'drift from its parent.',
  },

  // T-138 — identity and sessions (docs/tasks/138-identity-and-sessions.md, bible §7.1).
  person_credentials: {
    scope: 'derived',
    via: 'exists (select 1 from persons p where p.id = person_credentials.person_id and p.org_id = app_current_org())',
    reason:
      'No org_id of its own — reachable only through the person it belongs to, the same pattern ' +
      'as expense_payments through expenses. ⚠️ And the org boundary matters more here than ' +
      'almost anywhere: a credential row readable across orgs would expose which staff exist in ' +
      'another franchise, before any question of the secrets themselves.',
  },
  sessions: {
    scope: 'derived',
    via: 'exists (select 1 from persons p where p.id = sessions.person_id and p.org_id = app_current_org())',
    reason:
      'Reachable through its person, same as person_credentials. ⭐ A session row is a live ' +
      'authentication fact — who is signed in, where, and until when — so cross-org visibility ' +
      'would leak the shape of another franchise’s operation even with the token hashed.',
  },

  // T-124 — fixed assets (docs/tasks/124-fixed-assets-and-depreciation.md).
  prepaid_items: {
    scope: 'org_column',
    reason:
      'What an org has paid for in advance — its insurers, its landlords, its licence renewals. ' +
      'A franchise must never see another org’s contracts.',
  },
  cash_requests: {
    scope: 'org_column',
    reason:
      'Who is holding the business\u2019s cash, for what, and who approved it. Names staff and ' +
      'amounts \u2014 another org has no business reading either.',
  },
  owner_drawing_closes: {
    scope: 'org_column',
    reason:
      'What each owner withdrew in a month, and who signed it off. ⛔ Reveals both an owner’s ' +
      'personal cash flow and the store’s internal controls — neither is another org’s business.',
  },
  customers: {
    scope: 'org_column',
    reason:
      'Who an org sells to, on what terms, and at what price. ⛔ A franchise reading another’s ' +
      'customer list would learn its buyers — the most directly commercial data the system holds.',
  },
  price_lists: {
    scope: 'org_column',
    reason: 'What an org charges. ⛔ Reading a competitor’s price list is reading its margin.',
  },
  price_list_items: {
    scope: 'org_column',
    reason: 'The rates themselves. Same sensitivity as the list that holds them.',
  },
  liabilities: {
    scope: 'org_column',
    reason:
      'What an org owes, to whom, and when it falls due. ⛔ A franchise reading another’s ' +
      'obligations learns its commitments and its cash-flow pressure — the same commercial ' +
      'sensitivity as its borrowing.',
  },
  owners: {
    scope: 'org_column',
    reason:
      'Who owns a store, what percentage they hold, and what they are permitted to draw. ' +
      '⛔ One franchise reading another’s ownership split learns its cap table — among the most ' +
      'commercially sensitive facts the system holds, and the reason T-120 exists.',
  },
  loans: {
    scope: 'org_column',
    reason:
      "What an org owes and to whom. A franchise seeing another org\u2019s borrowing would learn " +
      'its leverage and its lenders \u2014 commercially sensitive well beyond ordinary privacy.',
  },
  stored_files: {
    scope: 'org_column',
    reason:
      "Which documents an org holds, and where they sit. ⭐ THE POINT OF T-141: the bucket "
      + "itself has no org isolation (DEF-070), so this row is where it comes from \u2014 a read "
      + 'is brokered only after `authorize()` has matched this org.',
  },
  remittances: {
    scope: 'org_column',
    reason: "What an org handed over, when, and who accepted it \u2014 its cash custody trail.",
  },
  remittance_lines: {
    scope: 'derived',
    via: 'exists (select 1 from remittances r where r.id = remittance_lines.remittance_id and r.org_id = app_current_org())',
    reason:
      'No org_id of its own — a line is reachable only through its handover. Scoped via the ' +
      'parent so the two can never disagree about which org they belong to.',
  },
  remittance_allocations: {
    scope: 'derived',
    via: 'exists (select 1 from remittances r where r.id = remittance_allocations.remittance_id and r.org_id = app_current_org())',
    reason: 'As remittance_lines — reachable only through its handover.',
  },
  remittance_variances: {
    scope: 'org_column',
    reason:
      "Money that did not arrive, and who is being asked for it. A franchise seeing another " +
      "org\u2019s open variances would learn who it suspects of a shortage.",
  },
  pay_rates: {
    scope: 'org_column',
    reason: 'What a job pays. A franchise reading another org’s rates would learn its labour cost.',
  },
  pay_runs: {
    scope: 'org_column',
    reason: 'Which periods an org has paid, and from which account.',
  },
  payslips: {
    scope: 'org_column',
    reason:
      'What a named person earned, and what was recovered from them. ⚠️ The most personal row ' +
      'in the schema — org isolation here is not tidiness, it is the whole point.',
  },
  thirteenth_month_runs: {
    scope: 'org_column',
    reason: 'Which years an org has paid 13th-month for, and from which account.',
  },
  thirteenth_month_payouts: {
    scope: 'org_column',
    reason:
      'What a named person earned as their 13th-month pay. Same sensitivity as payslips — org ' +
      'isolation here is the whole point, not tidiness.',
  },
  separations: {
    scope: 'org_column',
    reason:
      'Why a named person left and what they were paid on the way out — arguably the single most ' +
      'sensitive HR row in the schema. Org isolation is the whole point, not tidiness.',
  },
  till_custody_shifts: {
    scope: 'org_column',
    reason:
      'Who held a store’s till, when, and what they counted. A franchise seeing another ' +
      'org’s shifts would learn which of its neighbours is short and who is being asked for it.',
  },
  till_count_lines: {
    scope: 'derived',
    via: 'exists (select 1 from till_custody_shifts s where s.id = till_count_lines.shift_id and s.org_id = app_current_org())',
    reason:
      'No org_id of its own — a count is reachable only through its shift. Scoped via the ' +
      'parent so the two can never disagree about which org they belong to, exactly as ' +
      'remittance_lines is.',
  },
  scheduler_runs: {
    scope: 'org_column',
    reason:
      "Whether an org’s books are being kept up to date, and what broke when they were not. " +
      'A franchise seeing another org’s failed runs would learn which of its neighbours is ' +
      'behind on its accounting.',
  },
  money_transfers: {
    scope: 'org_column',
    reason:
      'Every movement of an org’s money between its own accounts, with amounts and bank ' +
      'references. A franchise seeing another org’s transfers would learn its cash position, ' +
      'its float, and which of its wallets it actually uses.',
  },
  money_accounts: {
    scope: 'org_column',
    reason:
      'Where an org keeps its money, and who holds it. A franchise must never see another ' +
      "org's wallets — the account names alone would disclose which providers and banks it uses.",
  },
  asset_policy: {
    scope: 'org_column',
    reason:
      'Per-org policy — the capitalisation threshold is a decision one org makes, and a franchise ' +
      'setting its own must never see or alter another one.',
  },
  asset_category_lives: {
    scope: 'org_column',
    reason: 'As asset_policy — agreed useful lives are per-org configuration.',
  },
  fixed_assets: {
    scope: 'org_column',
    reason:
      'The asset register. Org-scoped like every other document table. ⚠️ Worth naming the reason ' +
      'beyond habit: a register lists what a business OWNS, so cross-org visibility would hand a ' +
      'franchisee an inventory of another franchisee’s equipment and what it cost them.',
  },

  // T-130 — suppliers, supplier invoices, AP payments (docs/tasks/130-accounts-payable.md).
  suppliers: {
    scope: 'org_column',
    reason:
      'Who an org buys from, on what terms. A franchise reading another org’s supplier list ' +
      'would learn its vendors and, from the AP balances behind each one, its purchasing volume.',
  },
  supplier_invoices: {
    scope: 'org_column',
    reason: 'A source document that posts into the ledger — org-scoped exactly like expenses and journal_entries.',
  },
  ap_payments: {
    scope: 'org_column',
    reason: 'What an org paid a supplier, when, and from which account — org-scoped like every other posting document.',
  },
  ap_payment_allocations: {
    scope: 'derived',
    via: 'exists (select 1 from ap_payments p where p.id = ap_payment_allocations.ap_payment_id and p.org_id = app_current_org())',
    reason:
      'No org_id of its own — reachable only through the payment it belongs to, same pattern as ' +
      'expense_payments through expenses.',
  },

  // T-145 — the item master and invoice lines.
  items: {
    scope: 'org_column',
    reason:
      'What an org buys, by name and unit. A franchise reading another org’s item list would ' +
      'learn its product range, and joined to invoice lines, what it pays for each.',
  },
  supplier_invoice_lines: {
    scope: 'derived',
    via: 'exists (select 1 from supplier_invoices si where si.id = supplier_invoice_lines.supplier_invoice_id and si.org_id = app_current_org())',
    reason:
      'No org_id of its own — reachable only through the invoice it belongs to, same pattern as ' +
      'expense_payments through expenses. ⛔ These rows ARE the price history, so a leak here is ' +
      'a leak of another org’s purchasing economics.',
  },

  store_item_sellability: {
    scope: 'org_column',
    reason:
      'Which of an org’s stores makes a thing versus buys it. Reveals where production happens, ' +
      'so it is org-scoped like the item master it qualifies.',
  },
  item_pricing: {
    scope: 'org_column',
    reason:
      'How an org marks up what it charges its own branches. Its markup IS its internal margin ' +
      'policy, so it is org-scoped like the item master it prices.',
  },
  item_requests: {
    scope: 'org_column',
    reason:
      'Pending and decided item requests, including the near-duplicate warnings shown to the ' +
      'approver. Org-scoped like the item master it governs.',
  },
  supplier_items: {
    scope: 'org_column',
    reason:
      'Which suppliers an org buys which items from. Joined to invoice lines it reveals ' +
      'purchasing volume and unit economics, so it is org-scoped like items and suppliers.',
  },

  trade_orders: {
    scope: 'org_column',
    reason:
      'What an org sells wholesale, to whom, at what price. A franchise reading another’s would ' +
      'learn its entire wholesale book — buyers, volumes and the rates it negotiated.',
  },
  trade_order_lines: {
    scope: 'org_column',
    reason:
      'The captured rate per item per order. ⛔ This IS the negotiated price history, so a leak ' +
      'here hands a competitor the margin structure, not merely a total.',
  },

  cutover_steps: {
    scope: 'org_column',
    reason:
      'Who attested what during the conversion, and when. The accountability record for the one ' +
      'irreversible event in this system.',
  },
  opening_counts: {
    scope: 'org_column',
    reason:
      'Every item an org holds and what it is worth, per store. A complete inventory valuation ' +
      'is about as commercially sensitive as a single table gets.',
  },
  finding_acknowledgements: {
    scope: 'org_column',
    reason:
      'Which integrity problems an org has seen and accepted, and who accepted them. A record of ' +
      'known-bad books, which is exactly what a competitor or a franchisee should not read.',
  },
  finding_occurrences: {
    scope: 'org_column',
    reason:
      'T-214. When each integrity problem appeared and how long it went unfixed, per store. A ' +
      'longer, more damaging record than the acknowledgements beside it: acceptances show what ' +
      'was noticed, this shows what was ignored and for how many days.',
  },
  finding_views: {
    scope: 'org_column',
    reason:
      'T-214. Which named person opened the findings screen on which day. Individually ' +
      'attributable staff behaviour, and the raw material for "nobody has looked at this since".',
  },
  channel_settlements: {
    scope: 'org_column',
    reason:
      'What Foodpanda and Grab actually paid an org, and every fee they deducted. Its commission ' +
      'rate is commercially sensitive and its variance column is an internal control signal.',
  },

  // ---- T-178: order/channel wastage disposition ------------------------------------------
  order_wastages: {
    scope: 'org_column',
    reason:
      'Which orders were refunded or remade, and who was charged for them. Staff accountability ' +
      'data a competing franchise must never read.',
  },
  order_wastage_allocations: {
    scope: 'derived',
    reason: 'No org_id of its own — reached only through its wastage, same shape as trade_order_lines.',
    via: 'exists (select 1 from order_wastages w where w.id = wastage_id and w.org_id = app_current_org())',
  },
  expense_budgets: {
    scope: 'org_column',
    reason:
      'What a store is allowed to spend, per category. A franchise reading another’s caps would ' +
      'learn its cost structure category by category — closer to a P&L than most P&L lines are.',
  },
  ar_charges: {
    scope: 'org_column',
    reason: 'What a customer owes this org. A franchise reading another’s would learn its wholesale book.',
  },
  ar_collections: {
    scope: 'org_column',
    reason: 'What was collected, when, into which account — org-scoped like every posting document.',
  },
  ar_write_offs: {
    scope: 'org_column',
    reason: 'Which debts an org gave up on. Commercially sensitive, and a fraud signal if readable across orgs.',
  },
  ar_collection_allocations: {
    scope: 'derived',
    via: 'exists (select 1 from ar_collections c where c.id = ar_collection_allocations.ar_collection_id and c.org_id = app_current_org())',
    reason: 'No org_id of its own — reachable through the collection it belongs to, same pattern as ap_payment_allocations.',
  },

  // ---- T-154: the staff master record (Phase 4, lane B) --------------------------------
  positions: {
    scope: 'org_column',
    reason:
      'The position taxonomy is per-org: the canonical six are seeded per org, and a store’s own ' +
      'extras belong to that org’s vocabulary. A franchise inventing a position must not widen ' +
      'anyone else’s.',
  },
  employments: {
    scope: 'org_column',
    reason:
      'Who works where, on what terms. Same stakes as persons and higher — an employment carries ' +
      'employment status and, from Phase 5, hangs the pay rate. A franchise owner seeing another ' +
      'org’s roster is the exact leak this registry exists to prevent.',
  },
  employment_positions: {
    scope: 'derived',
    via: 'exists (select 1 from employments e where e.id = employment_positions.employment_id and e.org_id = app_current_org())',
    reason:
      'Has no org_id of its own — reachable only through its employment, the same pattern as ' +
      'journal_lines through journal_entries. Denormalising an org_id here could drift from the ' +
      'parent, and a row whose org disagreed with its employment would be invisible or visible to ' +
      'the wrong tenant.',
  },

  // ---- T-155: attendance policy (Phase 4, lane B) ---------------------------------------
  store_attendance_config: {
    scope: 'org_column',
    reason:
      'A store’s attendance and late policy, and from Phase 5 an input to what it pays. Per-org ' +
      'like the store it governs — a franchise setting its own grace minutes must not be visible ' +
      'to, or settable by, anyone else’s org.',
  },

  // ---- T-156: the punch (Phase 4, lane B) -----------------------------------------------
  attendance_punches: {
    scope: 'org_column',
    reason:
      'Who was physically at which terminal, when. Per-org like the employment it points at — and ' +
      'sensitive beyond the org boundary in its own right: a punch stream is a record of a named ' +
      'person’s movements, which is exactly the field-level concern bible §7 rule 10 raises about ' +
      'store membership implying too much.',
  },

  // ---- T-157: the adjudicated day (Phase 4, lane B) -------------------------------------
  attendance_days: {
    scope: 'org_column',
    reason:
      'What a person’s day paid, before a rate is applied. Per-org, and the row Phase 5 multiplies ' +
      'by a pay rate — so it is the closest thing in this phase to compensation data and is scoped ' +
      'accordingly.',
  },

  // ---- T-158: manager adjustments (Phase 4, lane B) -------------------------------------
  attendance_adjustments: {
    scope: 'org_column',
    reason:
      'Who decided what about whose day. Per-org, and it is the audit trail every self-dealing ' +
      'control in this phase rests on — a decision readable or writable across an org boundary ' +
      'would make attribution meaningless.',
  },

  // ---- T-159: device identity (Phase 4, lane B) -----------------------------------------
  clock_terminals: {
    scope: 'org_column',
    reason:
      'A provisioned terminal is the ONLY principal allowed to read that store’s biometric mirror ' +
      '(bible §5.3). Leaking the roster of terminals across an org boundary would tell another ' +
      'tenant exactly which device identities to target.',
  },

  // ---- T-181: the Lane A outbox (Phase 4, lane B) ---------------------------------------
  mirror_outbox: {
    scope: 'org_column',
    reason:
      'Publish intents for one org’s roster, config and day feed. It names which entities changed ' +
      'and when, which is a shape of activity data in its own right — and the relay runs as the ' +
      'system principal, so org scoping costs it nothing.',
  },

  // ---- T-185: attendance credentials (Phase 4, lane B) ----------------------------------
  attendance_credentials: {
    scope: 'org_column',
    reason:
      'A card id or a fingerprint template against one employment. Per-org and emphatically so: ' +
      'this is the most sensitive table in the phase — a row here is what lets somebody be ' +
      'clocked in and paid, and a template is biometric data about a named person.',
  },

  // ---- T-182: the Lane B quarantine (Phase 4, lane B) -----------------------------------
  inbox_quarantine: {
    scope: 'org_column',
    reason:
      'Events that failed to become punches, held with their raw bodies. Per-org: the raw event ' +
      'names a person, a device and a time, and a stuck punch is still attendance data.',
  },

  etl_runs: { scope: 'system_only', reason: 'ETL machinery. Never reachable by a tenant or a customer — only the migrator, crons and the audit.' },
  etl_source_documents: {
    scope: 'system_only',
    reason:
      'Holds captured v1 production documents including real PII. No tenant has any business reading ' +
      'it; the system principal alone can, which is what the audit and the ETL run as.',
  },
  etl_quarantine: { scope: 'system_only', reason: 'As etl_source_documents — ETL machinery.' },
  etl_reconciliation: { scope: 'system_only', reason: 'As etl_source_documents — ETL machinery.' },

  // ---- T-176: production — slab -> slice, recipe -> batch --------------------------------
  production_recipes: {
    scope: 'org_column',
    reason: 'A recipe belongs to an org, org-wide master data, same class as items itself.',
  },
  production_recipe_lines: {
    scope: 'derived',
    reason: 'No org_id of its own — reached only through its recipe, like supplier_return_lines.',
    via: 'exists (select 1 from production_recipes r where r.id = recipe_id and r.org_id = app_current_org())',
  },
  production_records: {
    scope: 'org_column',
    reason: 'A production record belongs to a store, and a store to one org.',
  },
  production_record_lines: {
    scope: 'derived',
    reason: 'No org_id of its own — reached only through its record, like production_recipe_lines.',
    via: 'exists (select 1 from production_records r where r.id = record_id and r.org_id = app_current_org())',
  },

  // ---- T-177: POS item mapping and the daily usage pull -----------------------------------
  pos_item_maps: {
    scope: 'org_column',
    reason: 'A mapping decision belongs to a store, and a store to one org.',
  },
  pos_map_requests: {
    scope: 'org_column',
    reason: 'As pos_item_maps — a store-scoped decision, org-wide isolation.',
  },
  pos_usage_pulls: {
    scope: 'org_column',
    reason: 'A pull belongs to a store, and a store to one org.',
  },
  pos_usage_pull_lines: {
    scope: 'derived',
    reason: 'No org_id of its own — reached only through its pull, like production_record_lines.',
    via: 'exists (select 1 from pos_usage_pulls p where p.id = pull_id and p.org_id = app_current_org())',
  },
};

export function rlsScopeOf(table: string): RlsEntry | undefined {
  return RLS_REGISTRY[table];
}

export function tablesWithScope(scope: RlsScope): string[] {
  return Object.entries(RLS_REGISTRY)
    .filter(([, e]) => e.scope === scope)
    .map(([t]) => t)
    .sort();
}

/** The database role the application connects as. NOT a superuser — superusers bypass RLS. */
export const APP_ROLE = 'shareat_app';
