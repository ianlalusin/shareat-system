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
// The 38 capabilities, exactly as CAPABILITY-MATRIX.md lists them (grep-counted against
// the document, not hand-counted — see the task report: the document's own prose says
// "36 rows" in two places, but the table itself has 38 entries including the two
// ⚠️-flagged open cells and the two platform-only rows. Invariant 3's parser is the proof:
// it fails loudly if this list and the document ever disagree, in EITHER direction).
// -----------------------------------------------------------------------------------------

export type Capability =
  // Sales and cash
  | 'record_sale'
  | 'submit_sales_day'
  | 'verify_sales_day'
  | 'void_sales_day'
  | 'accept_remittance'
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
  // Suppliers, buyers and credit
  | 'approve_supplier'
  | 'approve_buyer'
  | 'set_credit_limit'
  | 'override_credit_limit'
  | 'record_ap_payment'
  | 'record_ar_collection'
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
  | 'grant_capability'
  | 'manage_attendance'
  // Configuration
  | 'manage_store_settings'
  | 'manage_price_lists'
  | 'manage_fixed_assets'
  | 'run_depreciation'
  | 'manage_chart_of_accounts'
  // Platform — super-admin only
  | 'cross_org_access'
  | 'view_franchise_sales';

export const CAPABILITIES: readonly Capability[] = [
  'record_sale',
  'submit_sales_day',
  'verify_sales_day',
  'void_sales_day',
  'accept_remittance',
  'create_expense',
  'edit_own_expense',
  'edit_any_expense',
  'void_expense',
  'approve_expense',
  'record_stock_movement',
  'adjust_inventory',
  'record_wastage',
  'charge_staff_for_discrepancy',
  'approve_supplier',
  'approve_buyer',
  'set_credit_limit',
  'override_credit_limit',
  'record_ap_payment',
  'record_ar_collection',
  'create_wholesale_order',
  'dispatch_wholesale_order',
  'view_financial_reports',
  'view_trial_balance',
  'reverse_entry',
  'close_period',
  'post_journal_entry',
  'enrol_staff',
  'manage_users',
  'grant_capability',
  'manage_attendance',
  'manage_store_settings',
  'manage_price_lists',
  'manage_fixed_assets',
  'run_depreciation',
  'manage_chart_of_accounts',
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
  accept_remittance: 'store',

  create_expense: 'store',
  edit_own_expense: 'store',
  edit_any_expense: 'store',
  void_expense: 'store',
  approve_expense: 'store',

  record_stock_movement: 'store',
  adjust_inventory: 'store',
  record_wastage: 'store',
  charge_staff_for_discrepancy: 'store',

  approve_supplier: 'store',
  approve_buyer: 'store',
  set_credit_limit: 'org', // OPEN — Ian to confirm (CAPABILITY-MATRIX.md §Open 1)
  override_credit_limit: 'store',
  record_ap_payment: 'store',
  record_ar_collection: 'store',

  create_wholesale_order: 'store',
  dispatch_wholesale_order: 'store',

  view_financial_reports: 'store',
  view_trial_balance: 'org',
  reverse_entry: 'store',
  close_period: 'org', // OPEN — Ian to confirm (§Open 2); manager also needs org-wide STORE scope, see authorize.ts
  post_journal_entry: 'org',

  enrol_staff: 'store',
  manage_users: 'org',
  grant_capability: 'org',
  manage_attendance: 'store',

  manage_store_settings: 'store',
  manage_price_lists: 'org',
  manage_fixed_assets: 'org',
  run_depreciation: 'org',
  manage_chart_of_accounts: 'org',

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
  accept_remittance: { super_admin: true, admin: true, manager: true, staff: false },

  create_expense: { super_admin: true, admin: true, manager: true, staff: true },
  edit_own_expense: { super_admin: true, admin: true, manager: true, staff: true },
  edit_any_expense: { super_admin: true, admin: true, manager: true, staff: false },
  void_expense: { super_admin: true, admin: true, manager: true, staff: false },
  approve_expense: { super_admin: true, admin: true, manager: true, staff: false },

  record_stock_movement: { super_admin: true, admin: true, manager: true, staff: true },
  adjust_inventory: { super_admin: true, admin: true, manager: true, staff: false },
  record_wastage: { super_admin: true, admin: true, manager: true, staff: true },
  charge_staff_for_discrepancy: { super_admin: true, admin: true, manager: true, staff: false },

  approve_supplier: { super_admin: true, admin: true, manager: true, staff: false },
  approve_buyer: { super_admin: true, admin: true, manager: true, staff: false },
  // DECIDED — Ian 2026-08-25 (bible row 121): manager too. A manager already approves the
  // buyer, and a FRANCHISE manager setting their own buyers' limits is risking their own
  // money. Still split from approve_buyer deliberately: approving someone and deciding how
  // much of your money they may owe are two decisions, not one.
  set_credit_limit: { super_admin: true, admin: true, manager: true, staff: false },
  override_credit_limit: { super_admin: true, admin: true, manager: true, staff: false },
  record_ap_payment: { super_admin: true, admin: true, manager: true, staff: false },
  record_ar_collection: { super_admin: true, admin: true, manager: true, staff: false },

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
  grant_capability: { super_admin: true, admin: true, manager: false, staff: false },
  manage_attendance: { super_admin: true, admin: true, manager: true, staff: false },

  manage_store_settings: { super_admin: true, admin: true, manager: true, staff: false },
  manage_price_lists: { super_admin: true, admin: true, manager: false, staff: false },
  manage_fixed_assets: { super_admin: true, admin: true, manager: false, staff: false },
  run_depreciation: { super_admin: true, admin: true, manager: false, staff: false },
  manage_chart_of_accounts: { super_admin: true, admin: true, manager: false, staff: false },

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
