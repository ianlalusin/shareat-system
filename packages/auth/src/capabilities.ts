/**
 * The capability matrix — transcribed from `docs/decisions/CAPABILITY-MATRIX.md`, which IS
 * the decision (docs/tasks/121-roles-and-access.md Contract §3). This file is the
 * enforcement: a typed, exhaustive table, with the build itself as the guard.
 *
 * ## Why this compiles into a guard, not merely a lookup
 *
 * `CAPABILITY_MATRIX` and `CAPABILITY_SCOPE` are both typed as `Record<Capability, ...>`
 * over the closed `Capability` union below. TypeScript's mapped-type checking REQUIRES
 * every union member to appear as a key — add a capability to the union without adding a
 * row to both records and this file fails to compile, not merely a test. That is the
 * literal mechanism behind "adding a capability without a decision for every role must not
 * compile" (Contract §3, CAPABILITY-MATRIX.md rule 2). `tests/unit/capability-matrix.test.ts`
 * additionally PARSES the markdown table and compares it against these objects cell by
 * cell (invariant 3: "matches CAPABILITY-MATRIX.md exactly — parsed, not hand-compared"),
 * because the compiler can prove completeness but not correctness — a typo'd `false` where
 * the document says ✅ still compiles.
 *
 * ## `close_period` — the one cell that is not a plain boolean in practice
 *
 * CAPABILITY-MATRIX.md marks the manager cell "**conditional**", resolving the row-101 /
 * row-114 conflict (§Open 2): a manager MAY close a period, but only if their store scope
 * covers the whole org — a period is org-wide, and a manager whose scope is a single store
 * has no business closing every other store's books too. That condition is not a per-role
 * fact the matrix can express (it depends on DATA — which stores a specific manager holds
 * — not on the role alone), so it is stored here as `manager: true` (the baseline
 * decision) and enforced as an EXTRA check in `authorize()` for this one capability, never
 * inferred from the matrix shape. See `authorize.ts`'s own comment at the `close_period`
 * branch.
 *
 * ## Every cell is now decided (2026-08-25)
 *
 * The last two open cells closed together: `set_credit_limit` goes to manager as well as
 * admin (bible row 121), and `close_period` is grantable to a manager but subject to
 * store scope, so it needs org-wide scope (bible row 123). Their rows below now read
 * `DECIDED` rather than `OPEN`.
 *
 * ⚠️ **`set_credit_limit` sat at `manager: false` in this file for a day after the document
 * said ✅**, and the matrix test that exists to catch exactly that drift did not fire —
 * because an unrelated parse error in the same test file aborted the whole suite before any
 * assertion ran. **A guard that throws while parsing stops guarding.** That is why the
 * document's role cells must stay a closed enum (`✅` / `✗` / `conditional`) and carry their
 * prose in the notes column: an explanatory cell like "✅ only with org-wide scope" reads
 * fine to a human and is a parser crash — and the crash hides every other check.
 */

// -----------------------------------------------------------------------------------------
// Roles — CAPABILITY-MATRIX.md "How to read this": each strictly contains the one below it
// in AUTHORITY, never in SCOPE. super_admin > admin > manager > staff.
// -----------------------------------------------------------------------------------------

export const ROLES = ['super_admin', 'admin', 'manager', 'staff'] as const;
export type Role = (typeof ROLES)[number];

// -----------------------------------------------------------------------------------------
// The 65 capabilities, exactly as CAPABILITY-MATRIX.md lists them (grep-counted against
// the document, not hand-counted — see the task report: the document's own prose says
// "36 rows" in two places, but the table itself had 38 entries including the two
// ⚠️-flagged open cells and the two platform-only rows, and transfer_funds (row 150) is
// the 39th; T-125's manage_prepaid_items and run_amortisation make 41. T-130 adds
// record_supplier_invoice, verify_supplier_invoice and void_supplier_invoice, making 44.
// T-159 adds provision_clock_terminal (Phase 4), making 49. T-137's record_statutory_discount
// and void_statutory_discount make 50 (2026-08-30's own additions took it on to 58 via
// record_till_count/resolve_till_variance, and T-189 to 60 via set_pay_rate/run_payroll —
// see tests/unit/capability-matrix.test.ts's own running history, which stayed in sync
// where this comment did not). T-167 adds transfer_stock and void_transfer, making 62. T-170
// adds record_supplier_return, void_supplier_return and apply_supplier_credit, making 65. T-179
// adds record_customer_return, void_customer_return, apply_customer_credit and refund_customer,
// making 69.
// Do NOT hand-count this number: the matrix test parses the document and compares.
// Invariant 3's parser is the proof: it fails loudly if this list and the document ever
// disagree, in EITHER direction.
// -----------------------------------------------------------------------------------------

export type Capability =
  // Sales and cash
  | 'record_sale'
  | 'submit_sales_day'
  | 'verify_sales_day'
  | 'void_sales_day'
  | 'record_statutory_discount'
  | 'void_statutory_discount'
  | 'accept_remittance'
  /** T-186. Staff-OPEN: the person holding the drawer is the cashier. */
  | 'record_till_count'
  /** T-186. Staff-DENIED, and the asymmetry with the line above IS the control. */
  | 'resolve_till_variance'
  | 'transfer_funds'
  // Expenses
  | 'create_expense'
  | 'edit_own_expense'
  | 'edit_any_expense'
  | 'void_expense'
  | 'approve_expense'
  // Inventory
  | 'record_stock_movement'
  | 'adjust_inventory'
  | 'record_wastage'
  | 'charge_staff_for_discrepancy'
  /** T-167. Room-to-room within one store. */
  | 'transfer_stock'
  /** T-167. ⛔ Manager+, same asymmetry as `void_expense` — voiding is supervisory. */
  | 'void_transfer'
  /** T-170. Staff-open, same bar as record_stock_movement — a return is recorded when the goods
   *  physically leave, one act by one person, no draft state to review later. */
  | 'record_supplier_return'
  /** T-170. ⛔ Manager+, same asymmetry as void_transfer/void_expense. */
  | 'void_supplier_return'
  /** T-170. Spending the `1240` credit inside `recordPayment` — a distinct decision from
   *  recording the payment itself, even though `record_ap_payment` (manager+) already gates the
   *  call it lives inside. */
  | 'apply_supplier_credit'
  /** T-179. Staff-open, same bar as record_supplier_return — a customer return is recorded when
   *  the goods physically arrive, one act by one person. */
  | 'record_customer_return'
  /** T-179. ⛔ Manager+, same asymmetry as void_supplier_return. */
  | 'void_customer_return'
  /** T-179. Spending the `2140` credit inside `recordCollection` — the AR mirror of
   *  apply_supplier_credit. */
  | 'apply_customer_credit'
  /** T-179. Paying OUT cash against a return — a financial decision distinct from recording the
   *  goods coming back. */
  | 'refund_customer'
  // Inventory — T-173/T-174/T-175, the commissary pipeline
  | 'confirm_receipt'
  | 'resolve_trade_discrepancy'
  | 'set_item_threshold'
  | 'post_order_message'
  // Inventory — T-172, the branch order itself (2026-09-03, DEF-136)
  /** T-172. The BRANCH side: draft, add/remove lines, submit, answer a proposed substitution,
   *  withdraw before dispatch. Staff-open — the person who notices the shelf is empty is the one
   *  who orders, same bar as set_item_threshold; v1 gated none of the order flow by role.
   *  Store-scoped to the BRANCH (`requested_by_store_id`), which is invariant 10's half. */
  | 'place_branch_order'
  /** T-172. The COMMISSARY side: accept, reject, adjust fulfilment, propose a substitution, mark
   *  ready. Staff-open — packing crates is floor work. Store-scoped to the COMMISSARY. Posts nothing. */
  | 'fulfil_branch_order'
  /** T-172. ⛔ Manager+. The posting event — stock leaves into `1340`. Same asymmetry as
   *  dispatch_wholesale_order. ⚠️ Separate from T-173's confirm_receipt (phase plan §5.4). */
  | 'dispatch_branch_order'
  // Inventory — DEF-135 (2026-09-03): the four Phase 3 documents get their screens
  /** T-160. A store's rooms: create, rename, re-role, set default, deactivate. Manager+, as v1's
   *  location CRUD is. `allocate_stock` is deliberately NOT declared — no caller. */
  | 'manage_locations'
  /** T-166. Draft a delivery/purchase and receive it. Staff-open, same reasoning as
   *  `confirm_receipt`: the person signing at the dock is a cook or cashier. */
  | 'receive_delivery'
  /** T-166 invariant 3. ⛔ Manager+: over-receipt needs the flag AND a manager. */
  | 'allow_over_receipt'
  /** T-168. ⛔ Manager+: posting is the only step that moves stock. A floor worker drafts under
   *  `record_stock_movement` / `record_wastage`; a manager posts. */
  | 'post_usage'
  /** T-168. ⛔ Manager+, same asymmetry as `void_transfer`. */
  | 'void_usage_record'
  /** T-169. ⛔ Manager+: opening a session FREEZES the room for every writer. Counting a line
   *  stays under `record_stock_movement`. */
  | 'open_count_session'
  /** T-169. ⛔ Manager+: the variance posts to `5400`, a write-off in disguise — the same class
   *  as `adjust_inventory`. Cancelling rides on this too. */
  | 'commit_count'
  // Suppliers, buyers and credit
  | 'approve_supplier'
  | 'approve_buyer'
  | 'set_credit_limit'
  | 'manage_expense_budgets'
  | 'manage_recurring_expenses'
  | 'override_credit_limit'
  | 'record_ap_payment'
  | 'record_ar_collection'
  | 'write_off_receivable'
  | 'run_cutover'
  // Supplier invoices — T-130
  | 'manage_items'
  | 'approve_item'
  | 'record_supplier_invoice'
  | 'verify_supplier_invoice'
  | 'void_supplier_invoice'
  // Wholesale
  | 'create_wholesale_order'
  | 'dispatch_wholesale_order'
  // Books and reporting
  | 'view_financial_reports'
  | 'view_trial_balance'
  | 'reverse_entry'
  | 'close_period'
  | 'post_journal_entry'
  // People
  | 'enrol_staff'
  | 'manage_users'
  /**
   * ⭐ T-222. **Opening or closing a BRANCH — org-structural, not a room inside one.**
   * `manage_locations` is store-scoped and governs rooms *within* a store, which is a different
   * question from whether the store exists at all. ⛔ Manager is denied deliberately: creating a
   * store fans access rows and establishes a cash-custody policy, so it sits at the same bar as
   * `manage_users`.
   */
  | 'manage_stores'
  | 'grant_capability'
  | 'manage_attendance'
  /** T-189. ⛔ Manager DENIED — rostering a team must not include repricing it. */
  | 'set_pay_rate'
  /** T-189. ⛔ Admin-only, as v1's postPayrollRunAction is. */
  | 'run_payroll'
  | 'provision_clock_terminal'
  // Configuration
  | 'manage_store_settings'
  /** ⭐ Separate from `manage_store_settings` ON PURPOSE — see the role grid below. */
  | 'set_cash_policy'
  | 'manage_price_lists'
  /** T-171 (DEF-129, 2026-09-03). What THIS commissary offers and at what manual cost, plus the
   *  link that says which branch may order here. Store-scoped to the COMMISSARY. Manager+. */
  | 'manage_commissary_offerings'
  /** T-171. Which of the branch's OWN items a commissary line becomes, the ledger-only decision
   *  and the receiving expense category. Store-scoped to the BRANCH — the correspondence is the
   *  branch's to own (T-171 invariant 9). Manager+. */
  | 'manage_commissary_map'
  | 'manage_fixed_assets'
  | 'run_depreciation'
  | 'manage_prepaid_items'
  | 'run_amortisation'
  | 'manage_chart_of_accounts'
  // T-176 — production: slab -> slice, recipe -> batch, and the payroll lock. Manager+ on all
  // three, same asymmetry as post_usage/void_usage_record — a floor worker DRAFTS under
  // record_stock_movement; posting, editing a posted record, and voiding are all supervisory.
  | 'post_production'
  | 'edit_posted_production'
  | 'void_production'
  // T-178 — order/channel wastage disposition. Recording is staff-open, same bar as
  // record_wastage/record_statutory_discount — frictionless, or it goes unrecorded. Resolving and
  // charging are supervisory, same asymmetry as resolve_trade_discrepancy/
  // charge_staff_for_discrepancy — a disposition is a judgement with a posting behind it, and
  // taking money off a named person is never staff-level.
  /** T-178. Staff-open: the person at the counter logs a refunded or remade order. */
  | 'record_order_wastage'
  /** T-178. ⛔ Manager+: deciding platform_paid / absorbed / charged is a judgement call. */
  | 'resolve_order_wastage'
  /** T-178. ⛔ Manager+, same asymmetry as charge_staff_for_discrepancy — a SECOND, stricter gate
   *  on top of resolve_order_wastage, checked only when the chosen disposition is `charged`. */
  | 'charge_staff_for_wastage'
  /** T-178. ⛔ Manager+: undoing a backstop's own auto-charge within its 30-day window. */
  | 'reverse_auto_charge'
  // T-177 — POS item mapping and the daily usage pull.
  /** T-177. Manager+, same bar as `manage_locations`/`manage_items`: a standing "this POS item
   *  means this stock item" decision is configuration, curated by whoever runs the store. */
  | 'manage_pos_map'
  /** T-177 invariant 7. Staff-open, same bar as `record_stock_movement` — "the person who hits an
   *  unmappable item mid-pull is the person who knows," and the request itself moves no stock. */
  | 'request_pos_map'
  /** T-177. ⛔ Manager+: approving silences the item as a recorded `no_stock` decision; rejecting
   *  returns it to unmapped — both are judgement calls the requester's own capability may not make. */
  | 'decide_pos_map_request'
  /** T-177 invariant 5. ⛔ Manager+, same asymmetry as `post_usage`/`post_production` — finalizing
   *  is the step that writes real usage records and posts through the ledger. */
  | 'finalize_pos_usage_pull'
  // Platform — super-admin only
  | 'cross_org_access'
  | 'view_franchise_sales';

export const CAPABILITIES: readonly Capability[] = [
  'record_sale',
  'submit_sales_day',
  'verify_sales_day',
  'void_sales_day',
  'record_statutory_discount',
  'void_statutory_discount',
  'accept_remittance',
  'record_till_count',
  'resolve_till_variance',
  'transfer_funds',
  'create_expense',
  'edit_own_expense',
  'edit_any_expense',
  'void_expense',
  'approve_expense',
  'record_stock_movement',
  'adjust_inventory',
  'record_wastage',
  'charge_staff_for_discrepancy',
  'transfer_stock',
  'void_transfer',
  'record_supplier_return',
  'void_supplier_return',
  'apply_supplier_credit',
  'record_customer_return',
  'void_customer_return',
  'apply_customer_credit',
  'refund_customer',
  'confirm_receipt',
  'resolve_trade_discrepancy',
  'set_item_threshold',
  'post_order_message',
  'place_branch_order',
  'fulfil_branch_order',
  'dispatch_branch_order',
  'manage_locations',
  'receive_delivery',
  'allow_over_receipt',
  'post_usage',
  'void_usage_record',
  'open_count_session',
  'commit_count',
  'approve_supplier',
  'approve_buyer',
  'set_credit_limit',
  'manage_expense_budgets',
  'manage_recurring_expenses',
  'override_credit_limit',
  'record_ap_payment',
  'record_ar_collection',
  'write_off_receivable',
  'run_cutover',
  'manage_items',
  'approve_item',
  'record_supplier_invoice',
  'verify_supplier_invoice',
  'void_supplier_invoice',
  'create_wholesale_order',
  'dispatch_wholesale_order',
  'view_financial_reports',
  'view_trial_balance',
  'reverse_entry',
  'close_period',
  'post_journal_entry',
  'enrol_staff',
  'manage_users',
  'manage_stores',
  'grant_capability',
  'manage_attendance',
  'set_pay_rate',
  'run_payroll',
  'provision_clock_terminal',
  'manage_store_settings',
  'set_cash_policy',
  'manage_price_lists',
  'manage_commissary_offerings',
  'manage_commissary_map',
  'manage_fixed_assets',
  'run_depreciation',
  'manage_prepaid_items',
  'run_amortisation',
  'manage_chart_of_accounts',
  'post_production',
  'edit_posted_production',
  'void_production',
  'record_order_wastage',
  'resolve_order_wastage',
  'charge_staff_for_wastage',
  'reverse_auto_charge',
  'manage_pos_map',
  'request_pos_map',
  'decide_pos_map_request',
  'finalize_pos_usage_pull',
  'cross_org_access',
  'view_franchise_sales',
];

// -----------------------------------------------------------------------------------------
// Scope — CAPABILITY-MATRIX.md's Scope column. 'store' means authorize() also checks the
// actor's store list; 'org' means it applies org-wide (no storeId needed); 'platform' means
// it crosses orgs entirely (super_admin break-glass — cross_org_access, view_franchise_sales).
// -----------------------------------------------------------------------------------------

export type CapabilityScope = 'store' | 'org' | 'platform';

export const CAPABILITY_SCOPE: Readonly<Record<Capability, CapabilityScope>> = {
  record_sale: 'store',
  submit_sales_day: 'store',
  verify_sales_day: 'store',
  void_sales_day: 'store',
  // The SC/PWD register is kept per store, like the sales day it sits beside (T-137).
  record_statutory_discount: 'store',
  void_statutory_discount: 'store',
  accept_remittance: 'store',
  record_till_count: 'store',
  resolve_till_variance: 'store',
  // A transfer names two money accounts, and a money account belongs to a store.
  transfer_funds: 'store',

  create_expense: 'store',
  edit_own_expense: 'store',
  edit_any_expense: 'store',
  void_expense: 'store',
  approve_expense: 'store',

  record_stock_movement: 'store',
  adjust_inventory: 'store',
  record_wastage: 'store',
  charge_staff_for_discrepancy: 'store',
  // A transfer's two locations are both in one store — T-167 §8 out-of-scope excludes cross-store.
  transfer_stock: 'store',
  void_transfer: 'store',
  record_supplier_return: 'store',
  void_supplier_return: 'store',
  // Checked inside recordPayment, which is itself store-scoped (record_ap_payment).
  apply_supplier_credit: 'store',
  record_customer_return: 'store',
  void_customer_return: 'store',
  // Checked inside recordCollection, which is itself store-scoped (record_ar_collection).
  apply_customer_credit: 'store',
  refund_customer: 'store',

  /**
   * ⭐ **Store-scoped, and BOTH stores are legitimate callers** — T-173 invariant 8. A
   * commissary-side actor and a branch-side actor both confirm receipts, from opposite grants; a
   * one-sided check would break the highest-volume commissary flow. The domain checks that the
   * actor's store is one of the two on the order, which is the half `authorize` cannot know.
   */
  confirm_receipt: 'store',
  /**
   * ⚠️ The goods are the COMMISSARY's asset, so only its side decides what the difference was
   * (T-174 invariant 11). `resolveDiscrepancy` enforces WHICH store; this decides which ROLE.
   */
  resolve_trade_discrepancy: 'store',
  set_item_threshold: 'store',
  post_order_message: 'store',
  /**
   * ⭐ T-172. Store-scoped, and each side of ONE document is a different store: the branch's
   * capability is checked against `requested_by_store_id`, the commissary's two against
   * `store_id`. That is how invariant 10 ("each field has exactly one owner") is enforced — not
   * by a column-level rule, but by which store the capability is resolved at.
   */
  place_branch_order: 'store',
  fulfil_branch_order: 'store',
  dispatch_branch_order: 'store',

  // DEF-135 — every one of these is an act on ONE store's stock: its rooms, its dock, its kitchen,
  // its count. A location, a delivery, a usage record and a count session all carry a store_id.
  manage_locations: 'store',
  receive_delivery: 'store',
  allow_over_receipt: 'store',
  post_usage: 'store',
  void_usage_record: 'store',
  open_count_session: 'store',
  commit_count: 'store',

  // T-130 correction: `suppliers` has no store_id — it is org-wide master data, same shape
  // as `customers` (ADR-008), which uses the org-scoped `manage_chart_of_accounts` for its
  // own creation. Declared 'store' before this table existed; nothing depended on that yet
  // (grep-verified: no caller anywhere). `approve_buyer` is untouched — that is T-131's own
  // schema decision to make, not assumed here.
  approve_supplier: 'org',
  approve_buyer: 'store',
  // T-215. STORE-scoped, matching `approve_buyer` rather than `set_credit_limit`: a budget IS a
  // store's envelope, and a cap set org-wide would mean the same peso figure for a branch doing
  // 40 covers a day and one doing 400.
  manage_expense_budgets: 'store',
  // T-216. STORE-scoped for the same reason as the budget cap: a fixed bill belongs to a branch.
  // ⛔ It governs the TEMPLATE only. Posting the expense a template produces still needs
  // `approve_expense`, unchanged — automation must never become a way to pre-authorise spending.
  manage_recurring_expenses: 'store',
  set_credit_limit: 'org', // OPEN — Ian to confirm (CAPABILITY-MATRIX.md §Open 1)
  override_credit_limit: 'store',
  record_ap_payment: 'store',
  record_ar_collection: 'store',
  // ⭐ T-131. Admin-only, as v1 has it — stricter than voiding, because a write-off makes a
  // debt disappear rather than correcting a mistake.
  write_off_receivable: 'store',
  // ORG, not store: the conversion is one org-level event, and most of its steps belong to no
  // store at all. ⚠️ The per-store discipline is NOT lost — a per-store step demands a storeId
  // and writes one row per store, so a single tick still cannot hide a store nobody visited.
  run_cutover: 'org',
  // Logging a pending invoice moves no money — same bar as create_expense.
  // Org-wide master data — an item is one thing for the whole org, which is the entire
  // point of T-145 (v1's per-store items are why 187 names exist as separate records).
  manage_items: 'org',
  // ⭐ T-148. Org-scoped like the item master it governs.
  approve_item: 'org',
  record_supplier_invoice: 'store',
  verify_supplier_invoice: 'store',
  void_supplier_invoice: 'store',

  create_wholesale_order: 'store',
  dispatch_wholesale_order: 'store',

  view_financial_reports: 'store',
  view_trial_balance: 'org',
  reverse_entry: 'store',
  close_period: 'org', // OPEN — Ian to confirm (§Open 2); manager also needs org-wide STORE scope, see authorize.ts
  post_journal_entry: 'org',

  enrol_staff: 'store',
  manage_users: 'org',
  // ⛔ ORG-scoped, and it must be: a store-scoped capability needs a `storeId` that exists, and
  // the store this authorizes the creation of does not exist yet.
  manage_stores: 'org',
  grant_capability: 'org',
  manage_attendance: 'store',
  set_pay_rate: 'store',
  run_payroll: 'store',
  provision_clock_terminal: 'store',

  manage_store_settings: 'store',
  set_cash_policy: 'store',
  manage_price_lists: 'org',
  // T-171. STORE-scoped, unlike price lists: an offering belongs to one commissary, a map to one
  // branch, and invariant 9 says a caller may only edit the side they hold.
  manage_commissary_offerings: 'store',
  manage_commissary_map: 'store',
  manage_fixed_assets: 'org',
  run_depreciation: 'org',
  // Org-scoped like their fixed-asset twins: a policy or a licence is bought by the business,
  // not by a till.
  manage_prepaid_items: 'org',
  run_amortisation: 'org',
  manage_chart_of_accounts: 'org',

  // T-176. STORE-scoped, same bar as post_usage/void_usage_record: a production run belongs to
  // one store's stock and its own fiscal period.
  post_production: 'store',
  edit_posted_production: 'store',
  void_production: 'store',

  // T-178. Every order wastage carries a store_id and posts a store-scoped 1220/5300/1230 leg.
  record_order_wastage: 'store',
  resolve_order_wastage: 'store',
  charge_staff_for_wastage: 'store',
  reverse_auto_charge: 'store',

  // T-177. A map, a request and a pull all carry a store_id — a POS item means something
  // different at each branch, same bar as record_order_wastage.
  manage_pos_map: 'store',
  request_pos_map: 'store',
  decide_pos_map_request: 'store',
  finalize_pos_usage_pull: 'store',

  cross_org_access: 'platform',
  view_franchise_sales: 'platform',
};

// -----------------------------------------------------------------------------------------
// The matrix itself — every capability × every role, an explicit true/false. No default;
// see this file's top comment for what "no default" means at the type level.
// -----------------------------------------------------------------------------------------

export const CAPABILITY_MATRIX: Readonly<Record<Capability, Readonly<Record<Role, boolean>>>> = {
  record_sale: { super_admin: true, admin: true, manager: true, staff: true },
  submit_sales_day: { super_admin: true, admin: true, manager: true, staff: true },
  verify_sales_day: { super_admin: true, admin: true, manager: true, staff: false },
  void_sales_day: { super_admin: true, admin: true, manager: true, staff: false },
  // ⭐ Recording is STAFF-open on purpose, and it is the only way this table gets filled. There is
  // no paper logbook and the till captures no identity (bible row 164), so a record can only be
  // created while the customer is still at the counter — and the person standing there is a
  // cashier, not a manager. ⛔ Gating this to managers would not make the register stricter; it
  // would make it EMPTY, because nothing downstream can reconstruct a name or an ID number later.
  record_statutory_discount: { super_admin: true, admin: true, manager: true, staff: true },
  // ⛔ Voiding is NOT, and the asymmetry is the control. The burden of proof in a BIR audit is on
  // the seller, so withdrawing a statutory record is a supervisory act - same shape as
  // void_sales_day directly above.
  void_statutory_discount: { super_admin: true, admin: true, manager: true, staff: false },
  accept_remittance: { super_admin: true, admin: true, manager: true, staff: false },
  record_till_count: { super_admin: true, admin: true, manager: true, staff: true },
  resolve_till_variance: { super_admin: true, admin: true, manager: true, staff: false },
  // DECIDED — Ian 2026-08-26 (bible row 150): manager, deliberately NOT admin-only.
  // ⭐ Row 149 made OPENING an account admin-only, and the distinction between the two is
  // the point: adding an account changes what the books can record against, while moving
  // money between accounts that already exist is RECORDING something that happened. A
  // manager who may accept a remittance — the single largest transfer the business makes,
  // cashier to office — cannot coherently be barred from moving ₱500 between two drawers.
  transfer_funds: { super_admin: true, admin: true, manager: true, staff: false },

  create_expense: { super_admin: true, admin: true, manager: true, staff: true },
  edit_own_expense: { super_admin: true, admin: true, manager: true, staff: true },
  edit_any_expense: { super_admin: true, admin: true, manager: true, staff: false },
  void_expense: { super_admin: true, admin: true, manager: true, staff: false },
  approve_expense: { super_admin: true, admin: true, manager: true, staff: false },

  record_stock_movement: { super_admin: true, admin: true, manager: true, staff: true },
  adjust_inventory: { super_admin: true, admin: true, manager: true, staff: false },
  record_wastage: { super_admin: true, admin: true, manager: true, staff: true },
  charge_staff_for_discrepancy: { super_admin: true, admin: true, manager: true, staff: false },
  // T-167. Staff-open, same bar as record_stock_movement: a floor worker moves crates between
  // rooms without finding a manager first.
  transfer_stock: { super_admin: true, admin: true, manager: true, staff: true },
  // ⛔ Voiding is supervisory, same asymmetry as void_expense / void_statutory_discount.
  void_transfer: { super_admin: true, admin: true, manager: true, staff: false },
  // T-170. Staff-open — a return is one act by one person when the goods physically leave, same
  // bar as record_stock_movement.
  record_supplier_return: { super_admin: true, admin: true, manager: true, staff: true },
  void_supplier_return: { super_admin: true, admin: true, manager: true, staff: false },
  // Same level as record_ap_payment, the capability the call it lives inside already requires —
  // spending a credit is at least as consequential as recording the payment itself.
  apply_supplier_credit: { super_admin: true, admin: true, manager: true, staff: false },

  // T-179. Staff-open — the AR mirror of record_supplier_return, same reasoning.
  record_customer_return: { super_admin: true, admin: true, manager: true, staff: true },
  void_customer_return: { super_admin: true, admin: true, manager: true, staff: false },
  // Same level as apply_supplier_credit — spending or paying out is a financial decision.
  apply_customer_credit: { super_admin: true, admin: true, manager: true, staff: false },
  refund_customer: { super_admin: true, admin: true, manager: true, staff: false },

  // ⭐ Staff too: a branch cook signs for the crates that arrive, and requiring a manager on site
  // to accept a delivery is the rule people work around by sharing a login. The two-sided store
  // check is the real control here, not the role.
  confirm_receipt: { super_admin: true, admin: true, manager: true, staff: true },
  // ⛔ Manager and up. Deciding that goods were lost, or charging a named person for them, is a
  // judgement with a posting behind it — the same class as `adjust_inventory`.
  resolve_trade_discrepancy: { super_admin: true, admin: true, manager: true, staff: false },
  // ⭐ Staff too, per v1: the person who notices the shelf is empty is the person on the floor,
  // and making them find a manager is how thresholds stay unset (DEF-100's neighbour — an unset
  // threshold is invisible, so friction here has no counter-pressure).
  set_item_threshold: { super_admin: true, admin: true, manager: true, staff: true },
  post_order_message: { super_admin: true, admin: true, manager: true, staff: true },
  // ⭐ T-172. Both SIDES of the order are staff-open, and the posting event is not. v1 gates none
  // of the order flow by role (only discrepancy resolution checks isManager); v2 keeps that for
  // the conversation — draft, submit, accept, pack, propose, answer — and holds the one act that
  // moves stock and posts to `1340` to the same bar as dispatch_wholesale_order.
  place_branch_order: { super_admin: true, admin: true, manager: true, staff: true },
  fulfil_branch_order: { super_admin: true, admin: true, manager: true, staff: true },
  dispatch_branch_order: { super_admin: true, admin: true, manager: true, staff: false },

  // DEF-135 (2026-09-03). The pattern across all four documents is the one this matrix already
  // uses everywhere else: RECORDING is floor work and staff-open; the act that moves stock, posts
  // to the ledger, or locks a room out is supervisory.
  // T-160: manager+, exactly v1's `isAdmin || isManager` gate on location CRUD.
  manage_locations: { super_admin: true, admin: true, manager: true, staff: false },
  // T-166: staff too — the person signing for the crates is a cook or a cashier (confirm_receipt's
  // reasoning). The photo CHECK and the shortage trigger are the controls, not the role.
  receive_delivery: { super_admin: true, admin: true, manager: true, staff: true },
  // ⛔ Over-receipt is a gated exception, never a silent cashier bypass (T-166 invariant 3).
  allow_over_receipt: { super_admin: true, admin: true, manager: true, staff: false },
  // T-168: a floor worker DRAFTS (record_stock_movement / record_wastage); a manager POSTS.
  post_usage: { super_admin: true, admin: true, manager: true, staff: false },
  void_usage_record: { super_admin: true, admin: true, manager: true, staff: false },
  // T-169: opening freezes the room for every writer; committing posts to 5400. Both supervisory.
  // Counting a line is record_stock_movement, staff-open.
  open_count_session: { super_admin: true, admin: true, manager: true, staff: false },
  commit_count: { super_admin: true, admin: true, manager: true, staff: false },

  approve_supplier: { super_admin: true, admin: true, manager: true, staff: false },
  approve_buyer: { super_admin: true, admin: true, manager: true, staff: false },
  // DECIDED — Ian 2026-08-25 (bible row 121): manager too. A manager already approves the
  // buyer, and a FRANCHISE manager setting their own buyers' limits is risking their own
  // money. Still split from approve_buyer deliberately: approving someone and deciding how
  // much of your money they may owe are two decisions, not one.
  set_credit_limit: { super_admin: true, admin: true, manager: true, staff: false },
  // T-215. Same shape and same reasoning as `set_credit_limit`: a manager who runs a branch's
  // money sets that branch's caps. Staff false — a cap is a control ON spending, and the person
  // it constrains is not the person who sets it.
  manage_expense_budgets: { super_admin: true, admin: true, manager: true, staff: false },
  // T-216. Same shape as `manage_expense_budgets`: a manager who runs a branch's money decides
  // which of its bills recur. Staff false — setting up a standing payment is not a till act.
  manage_recurring_expenses: { super_admin: true, admin: true, manager: true, staff: false },
  override_credit_limit: { super_admin: true, admin: true, manager: true, staff: false },
  record_ap_payment: { super_admin: true, admin: true, manager: true, staff: false },
  record_ar_collection: { super_admin: true, admin: true, manager: true, staff: false },
  // ⭐ Manager too — Ian, 2026-08-28, overriding v1's admin-only gate. v1 restricts write-off to
  // admins while voiding is manager-level; that asymmetry made sense when NOTHING else guarded the
  // action. Here the real control is identity, not rank: `writeOffCharge` refuses whoever recorded
  // the charge, so a write-off always takes two people whatever their role. Rank was the weaker of
  // the two controls and it is the one that made a receivable uncollectable-but-unclearable in a
  // store with no admin.
  write_off_receivable: { super_admin: true, admin: true, manager: true, staff: false },
  // T-134. Attestations are a manager's, for their own store. The purge and the opening entry
  // are admin-only in the domain layer on top of this - C2 and C5 are irreversible in practice.
  run_cutover: { super_admin: true, admin: true, manager: true, staff: false },
  // T-130. Logging a pending invoice is document capture, not money movement — same bar as
  // create_expense (staff too). Recording the actual EXPENSE against a verified invoice still
  // requires approve_expense (manager+) via createExpense+approveExpense together — no separate
  // capability needed there, since posting has always been the gate that matters.
  // T-145. Master data, same bar as approve_supplier: managers curate what the org buys.
  manage_items: { super_admin: true, admin: true, manager: true, staff: false },
  // ⭐ T-148, Ian 2026-08-28: "superadmin only can add" an item; everyone else requests it.
  // ⛔ The ONLY capability in this matrix granted to super_admin alone, and deliberately: an item
  // is the identity every price, every supplier link and every future OCR match keys on, and a
  // duplicate identity is not a row to delete afterwards — it is a price history split in two.
  approve_item: { super_admin: true, admin: false, manager: false, staff: false },
  record_supplier_invoice: { super_admin: true, admin: true, manager: true, staff: true },
  // DECIDED — Ian 2026-08-27: "yes manager verifies receipts."
  verify_supplier_invoice: { super_admin: true, admin: true, manager: true, staff: false },
  void_supplier_invoice: { super_admin: true, admin: true, manager: true, staff: false },

  create_wholesale_order: { super_admin: true, admin: true, manager: true, staff: true },
  dispatch_wholesale_order: { super_admin: true, admin: true, manager: true, staff: false },

  view_financial_reports: { super_admin: true, admin: true, manager: true, staff: false },
  view_trial_balance: { super_admin: true, admin: true, manager: false, staff: false },
  reverse_entry: { super_admin: true, admin: true, manager: true, staff: false },
  // DECIDED — Ian 2026-08-25 (bible row 123): grantable, but subject to store scope. `true`
  // here is the BASELINE decision (bible row 101: "admin and manager may close");
  // authorize.ts adds the org-wide-store-scope condition that resolves the conflict with
  // row 114's store scoping. See this file's top comment.
  close_period: { super_admin: true, admin: true, manager: true, staff: false },
  // "Nobody posts by hand" — reserved for break-glass repair, logged. Admin does NOT hold
  // it: entries come from source documents, never a form, not even an admin's.
  post_journal_entry: { super_admin: true, admin: false, manager: false, staff: false },

  enrol_staff: { super_admin: true, admin: true, manager: true, staff: false },
  manage_users: { super_admin: true, admin: true, manager: false, staff: false },
  manage_stores: { super_admin: true, admin: true, manager: false, staff: false },
  grant_capability: { super_admin: true, admin: true, manager: false, staff: false },
  manage_attendance: { super_admin: true, admin: true, manager: true, staff: false },
  set_pay_rate: { super_admin: true, admin: true, manager: false, staff: false },
  run_payroll: { super_admin: true, admin: true, manager: false, staff: false },
  // ⭐ ADMIN-ONLY (Ian, 2026-08-29, bible row 165). A provisioned terminal is the ONLY principal
  // allowed to read the credential mirror, so whoever may create one may read every enrolled
  // fingerprint template and card id at that store. Manager was v1's level; this is tighter.
  provision_clock_terminal: { super_admin: true, admin: true, manager: false, staff: false },

  manage_store_settings: { super_admin: true, admin: true, manager: true, staff: false },
  /**
   * ⛔ **Manager is FALSE, and that is the whole reason this is not `manage_store_settings`.**
   *
   * Ian, 2026-08-29: *"configure the peso ceiling for unremitted by store configurable by admin."*
   * The ceiling is the number a store's cash custody is MEASURED against, so whoever is measured
   * must not be able to move it. A manager who is late remitting could otherwise raise the ceiling
   * and the finding would vanish — the control silently deleting its own evidence.
   *
   * ⚠️ Ordinary store settings stay manager-editable (*"store settings tied to operation"* — Ian,
   * CAPABILITY-MATRIX row). This one is not an operating setting; it is a risk limit.
   */
  set_cash_policy: { super_admin: true, admin: true, manager: false, staff: false },
  manage_price_lists: { super_admin: true, admin: true, manager: false, staff: false },
  // T-171. Manager+, same bar as manage_items: a store manager curates what their commissary
  // offers and what their branch receives it as. ⚠️ NOT admin-only like price lists — a map row
  // is operational setup ("which of my items is this"), not a commercial price decision.
  manage_commissary_offerings: { super_admin: true, admin: true, manager: true, staff: false },
  manage_commissary_map: { super_admin: true, admin: true, manager: true, staff: false },
  manage_fixed_assets: { super_admin: true, admin: true, manager: false, staff: false },
  run_depreciation: { super_admin: true, admin: true, manager: false, staff: false },
  // ⭐ Mirrors manage_fixed_assets / run_depreciation exactly, and is SEPARATE from them on
  // purpose: someone trusted with the asset register is not automatically trusted with the
  // insurance policies and licences, and a reviewer asking "who may write off a prepaid?"
  // should find a row rather than infer one.
  //
  // ⚠️ Both are admin-yes/manager-no, so they enrol themselves into
  // ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER — that set is DERIVED, so nobody has to remember.
  manage_prepaid_items: { super_admin: true, admin: true, manager: false, staff: false },
  run_amortisation: { super_admin: true, admin: true, manager: false, staff: false },
  manage_chart_of_accounts: { super_admin: true, admin: true, manager: false, staff: false },

  // T-176. Manager+, all three — posting, editing a posted record, and voiding all move stock
  // and the books; same asymmetry as post_usage/void_usage_record (staff drafts, manager posts).
  post_production: { super_admin: true, admin: true, manager: true, staff: false },
  edit_posted_production: { super_admin: true, admin: true, manager: true, staff: false },
  void_production: { super_admin: true, admin: true, manager: true, staff: false },

  // T-178. Recording is staff-open — frictionless, or it goes unrecorded, same bar as
  // record_wastage/record_statutory_discount. Resolving and charging are supervisory: a
  // disposition is a judgement with a posting behind it, and charge_staff_for_wastage is a
  // SECOND, stricter gate on top of resolve_order_wastage — same asymmetry as
  // resolve_trade_discrepancy/charge_staff_for_discrepancy. Reversing an auto-charge is
  // supervisory too, same bar as reverse_entry.
  record_order_wastage: { super_admin: true, admin: true, manager: true, staff: true },
  resolve_order_wastage: { super_admin: true, admin: true, manager: true, staff: false },
  charge_staff_for_wastage: { super_admin: true, admin: true, manager: true, staff: false },
  reverse_auto_charge: { super_admin: true, admin: true, manager: true, staff: false },

  // T-177. Mapping is manager+ curation, same bar as manage_locations/manage_items. Requesting an
  // unmappable item is staff-open, same bar as record_stock_movement — the person who hits it is
  // the person who knows. Deciding a request and finalizing a pull are both supervisory: the
  // former is a judgement call, the latter is the step that writes real usage records and posts.
  manage_pos_map: { super_admin: true, admin: true, manager: true, staff: false },
  request_pos_map: { super_admin: true, admin: true, manager: true, staff: true },
  decide_pos_map_request: { super_admin: true, admin: true, manager: true, staff: false },
  finalize_pos_usage_pull: { super_admin: true, admin: true, manager: true, staff: false },

  cross_org_access: { super_admin: true, admin: false, manager: false, staff: false },
  view_franchise_sales: { super_admin: true, admin: false, manager: false, staff: false },
};

/** `close_period` is the one capability with an extra, data-dependent condition beyond the
 * matrix (see this file's top comment). Exported as a named set, rather than a magic
 * string literal inside `authorize()`, so a second conditional capability (should one ever
 * exist) has one obvious place to be added and one obvious place tests look for it. */
export const CONDITIONAL_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>(['close_period']);

/**
 * The elevated-grant set for the grant-time fallback (bible rows 115-116,
 * CAPABILITY-MATRIX.md §B/§B.1): "creating a manager in an org with no admin applies the
 * elevated grants then, as real rows." Derived, not hand-listed — it is exactly the
 * capabilities `admin` holds that `manager` does not, computed from the matrix above so
 * the two can never silently drift apart. (`post_journal_entry`, `cross_org_access` and
 * `view_franchise_sales` are excluded automatically: admin itself lacks all three, so the
 * delta is empty for them — a manager standing in for a MISSING admin still cannot post by
 * hand or reach another org.)
 */
export const ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER: readonly Capability[] = CAPABILITIES.filter(
  (c) => CAPABILITY_MATRIX[c].admin && !CAPABILITY_MATRIX[c].manager,
);

/**
 * ⭐ **Exactly the capabilities `super_admin` holds that `admin` does not — DERIVED, never
 * listed.** Today it is four: `approve_item`, `post_journal_entry`, `cross_org_access`,
 * `view_franchise_sales`.
 *
 * Same discipline and same reason as `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER` above: computed from
 * the matrix so the two can never silently drift apart. Its sibling — that one is the delta
 * `admin` has over `manager`; this one is the delta `super_admin` has over `admin`.
 *
 * ## What depends on it
 *
 * T-232 §2.2. The first person of an organization cannot hold two role rows —
 * `person_roles_active_person_org_unique` allows at most one active role per (person, org) — so
 * `createFirstAdmin` gives them the `admin` role **plus these capabilities as explicit
 * `person_grants` rows**. Because no capability is `admin: true, super_admin: false`, that is an
 * exact equivalence rather than a downgrade, and `assignRoleAsActor` accepts it in place of the
 * `super_admin` role literal.
 *
 * ⛔ **One definition, imported everywhere — `packages/domain` must never re-derive it.** If the
 * set `createFirstAdmin` GRANTS ever stopped matching the set `assignRoleAsActor` DEMANDS, the
 * organisation's first admin would quietly lose the ability to appoint a second one, with no error
 * raised anywhere.
 *
 * ⚠️ **The grants are MATERIALISED once, at creation.** The set is always current; the rows are
 * not. Adding a fifth member leaves every existing owner silently without it, and removing one
 * leaves a stale grant — a live authority nobody decided to give. So a change here is a data
 * migration, not an edit: write the backfill (and the revocation) for existing `person_grants`
 * first. `packages/auth/tests/super-admin-capability-set.test.ts` pins the set so that day arrives
 * as a failing test with those instructions attached.
 *
 * ⭐ It lives HERE rather than in `roles.ts` for a measured reason: `roles.ts` imports
 * `@shareat/db`, so a test that only wanted this constant paid ~2 s of schema import to read it.
 * This file imports nothing at all.
 */
export const SUPER_ADMIN_ONLY_CAPABILITIES: readonly Capability[] = CAPABILITIES.filter(
  (c) => CAPABILITY_MATRIX[c].super_admin && !CAPABILITY_MATRIX[c].admin,
);
