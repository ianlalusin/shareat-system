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
}

export const RLS_REGISTRY: Readonly<Record<string, RlsEntry>> = {
  organizations: {
    scope: 'self',
    reason: 'The tenancy boundary itself. A principal sees its own organization row and no other.',
  },
  stores: { scope: 'org_column', reason: 'Branches belong to one org. A franchise never sees another org’s stores.' },
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
    via: 'exists (select 1 from persons p where p.id = person_identities.person_id and p.org_id = app_current_org())',
    reason: 'Login identities hang off persons, which carries the org.',
  },

  // T-121 — the three access axes (docs/tasks/121-roles-and-access.md, bible row 114).
  person_roles: {
    scope: 'org_column',
    reason:
      'Who holds what role is per-org data — a franchise owner must not see, let alone infer, ' +
      'Ian\'s own org role assignments. Carries org_id directly (a person can hold different ' +
      'roles in different orgs, e.g. Ian holding several franchises\' admin — bible row 114 A.4).',
  },
  person_store_scope: {
    scope: 'derived',
    via: 'exists (select 1 from persons p where p.id = person_store_scope.person_id and p.org_id = app_current_org())',
    reason:
      'No org_id of its own — "which stores can this person see" is reached only through the ' +
      'person it names, same reasoning as person_identities. A store list is exactly the kind ' +
      'of data a franchise owner must not read for another org\'s staff.',
  },
  person_grants: {
    scope: 'derived',
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

  etl_runs: { scope: 'system_only', reason: 'ETL machinery. Never reachable by a tenant or a customer — only the migrator, crons and the audit.' },
  etl_source_documents: {
    scope: 'system_only',
    reason:
      'Holds captured v1 production documents including real PII. No tenant has any business reading ' +
      'it; the system principal alone can, which is what the audit and the ETL run as.',
  },
  etl_quarantine: { scope: 'system_only', reason: 'As etl_source_documents — ETL machinery.' },
  etl_reconciliation: { scope: 'system_only', reason: 'As etl_source_documents — ETL machinery.' },
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
