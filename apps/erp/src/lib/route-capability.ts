/**
 * T-288 — which capability a route requires, declared ONCE and read by both consumers.
 *
 * **Ian, 2026-09-12:** *"do both hide the menu and gate the reads."* That overturns the posture
 * recorded against DEF-051 (*"hiding a link is presentation; the gate is the write"*) — see
 * `docs/tasks/288-*.md` for the amendment. ⛔ It does **not** repeal DEF-051's reasoning: hiding
 * alone is still worthless. What changes is that hiding now sits **on top of** a real read gate,
 * instead of being rejected as a substitute for one.
 *
 * ## ⛔ Why one map and not two lists
 *
 * The nav filter and the page gate must never be able to disagree. If they read different lists
 * they drift in the SILENT, dangerous direction: a link disappears, an operator concludes the
 * screen is protected, and the URL still renders everything. That is DEF-310's exact shape — two
 * guards described as twins, one widened, the other not, passing happily while blind.
 *
 * So this file is the only declaration. `AppShell` filters the sidebar from it;
 * `requirePageAccess` refuses from it; `tests/unit/route-capability-coverage.test.ts` proves every
 * route it names is actually guarded and every guarded route is named.
 *
 * ## ⚠️ What this is NOT
 *
 * It is not the authorization system. `authorize()` in `packages/auth` remains the control, is
 * unchanged, and still runs inside every domain service on every write. This adds a **second
 * layer for reads** (bible §15.11 — no layer may be the only one for a given risk).
 *
 * ⛔ **Deny-by-default (bible §7 rule 11, T-603 S5).** A route absent from this map is refused at runtime by `requirePageAccess` (T-616) unless it is on the approved-open or awaiting list in `route-open-lists.ts`,
 * and `tests/unit/route-capability-coverage.test.ts` fails for every page, and every server-action folder, that has no entry here and is not on
 * its approved-open or awaiting-a-decision list. A new screen therefore cannot ship unmapped: map it (a capability, a list, or an explicit `null`).
 */
import type { Capability } from '@shareat/auth';

/**
 * Route → the capability required to READ it. Longest prefix wins, so `/admin/users/[id]` inherits
 * `/admin/users` without needing its own row.
 *
 * ⭐ **Each key is the screen's own write words, not a capability that merely sounds related.** The test that matters is
 * *"would it be wrong for the person at the counter to read this"*; a screen a cashier legitimately works gets the words that cashier holds.
 */
/** T-435: a single capability, a LIST meaning ANY-OF, or `null` meaning OPEN (a longer `null` key re-opens a sub-route). */
export type RouteRequirement = Capability | readonly Capability[] | null;

export const ROUTE_CAPABILITY: Readonly<Record<string, RouteRequirement>> = {
  // T-526 R1: the full-screen POS. Receipts and Till inherit '/pos' (record_sale) by prefix; Kitchen and Refills each need their own word,
  // so holding another POS word never opens them. The shell's tabs read this same map (`navHrefAllowed`), so a tab and its page cannot disagree.
  '/pos': 'record_sale',
  '/pos/kitchen': 'serve_pos_ticket',
  '/pos/refills': 'request_pos_refill',

  // T-587 S2: the two clock pages had no key, so every signed-in person (a cashier) saw them in the sidebar. Both loaders already authorize
  // `manage_attendance` at the store (`listTerminals`, `laneHealth`, `listQuarantine`), so that is the word; the writes keep their own words
  // (`provision_clock_terminal` to provision or revoke, discarding a failed punch). Managers keep access, cashiers lose link, hub row and page.
  '/attendance/terminals': 'manage_attendance',
  '/attendance/lane': 'manage_attendance',

  // --- Who may act, and where. The keys to the building. -------------------------------------
  '/admin/users': 'manage_users',
  '/admin/stores': 'manage_stores',
  // T-505: register / revoke a POS tablet's link, clear its approval lock. The capability the writes already check at the store.
  '/admin/pos-tablets': 'provision_clock_terminal',
  // T-508 S2b (spec R10): kitchen setup is the store manager's job, store-scoped; the page picks only stores where this is held.
  '/kitchen': 'manage_store_settings',
  // T-510 S3: lunch and dinner hours are a store manager's job too; the longer prefix wins over '/menu' (view_menu). The page lists only stores where this is held.
  '/menu/hours': 'manage_store_settings',
  // T-651: arranging the order is editing categories and items, so it is the same word the writes check (manage_menu).
  '/menu/arrange': 'manage_menu',
  // T-653: the one flavour list. Read and written by whoever manages the menu.
  '/menu/flavours': 'manage_menu',
  // T-497 S1 (Ian, 2026-10-28, bible row 403): the prerequisite-walls report is admins only, same word as Stores.
  '/admin/prerequisite-refusals': 'manage_stores',
  // T-290 — position access defaults. `grant_capability` is org-scoped and is the capability the
  // screen's every write already checks inside the domain; the page gate reads the same word.
  '/admin/access-defaults': 'grant_capability',

  // --- Configuration that changes how money is classified for everyone ------------------------
  '/settings': 'manage_store_settings',
  // T-375 S1: which POS store a branch sells under decides where its sales are booked, so it is admin-only
  // (the longer prefix wins over `/settings`). `linkStoreToPos` checks the same word on the write.
  '/settings/pos-link': 'manage_chart_of_accounts',
  // T-401 S6: the usage tolerance band is org policy, admin-only like the menu depletion rules (`set_menu_depletion`); the setters check the same word.
  '/settings/usage-tolerance': 'set_menu_depletion',
  '/settings/business-rules': 'manage_business_rules',
  // T-640 (Ian, 25 Nov 2026): the AI hub holds provider keys and the AI spending cap: super admin only. Every hub function checks the same word (and an admin-or-above role) on the write.
  '/settings/ai-hub': 'manage_ai_hub',
  // T-584 (Ian, 15 Nov 2026): HR documents. The register, a document and its print need view_documents; issuing needs issue_documents; the templates are the admin's. The longer prefix wins over /documents. Every domain function checks the same word at the document's store.
  '/documents': 'view_documents',
  '/documents/new': 'issue_documents',
  '/documents/templates': 'manage_document_templates',
  // T-464: pairing a store's POS tablet is the store manager's (or an admin's) act; `pairPosTablet` / `unpairPosTablet` check the same word at the store. Longer prefix wins over `/settings`.
  '/settings/pos-tablet': 'pair_pos_tablet',

  // --- The books. A cashier's own day is theirs; the organisation's ledger is not. -------------
  '/reports/trial-balance': 'view_trial_balance',
  '/reports/income-statement': 'view_financial_reports',
  // DEF-867: equals the page's data gate (`reportScope(..., 'view_trial_balance')`); a manager could never see its data.
  '/reports/balance-sheet': 'view_trial_balance',
  '/reports/cash-flow': 'view_financial_reports',
  '/reports/ap-aging': 'view_financial_reports',
  '/reports/ar-aging': 'view_financial_reports',
  '/reports/store-comparison': 'view_financial_reports',
  '/reports/expense-items': 'view_financial_reports',
  '/reports/sales-rollup': 'view_financial_reports',
  '/reports/pos-data': 'view_financial_reports',
  '/reports/pos-reconciliation': 'view_financial_reports',
  // T-589 B3a: these routes had no key, so a refused person hit the error boundary (`reportScope`'s data gate throws). Each key is the word the page's own
  // `reportScope(...)` gate uses, so the route gate and the data gate cannot disagree. Children inherit (dual-run/pack, dual-run/[store]/[week]).
  '/reports/journal-lines': 'view_trial_balance',
  '/reports/dual-run': 'view_financial_reports',

  // T-589 B3a: the day list shows every day's totals and cash (DEF-809: managers and up, never staff). Any-of the two words `sales-days/[id]` and `/edit` already
  // read by (`canReadAtStore`), so nobody who reads a day is locked out of its list. `/` is deliberately NOT keyed: everyone lands there (the page shows a plain welcome).
  '/sales-days': ['submit_sales_day', 'verify_sales_day'],

  // --- What the business owes and owns, and what people are paid ------------------------------
  // ⚠️ `/payroll` is the one people react to most strongly when it is visible on a counter
  //    tablet: it names colleagues' pay. It was reachable by any signed-in person until T-288.
  '/payroll': 'run_payroll',
  // T-190: the statutory tables decide every payslip's deductions, so they are admin-only (the longer prefix wins over `/payroll`).
  '/payroll/rates': 'manage_payroll_rates',
  // T-193 S5: what is owed to SSS / PhilHealth / Pag-IBIG / BIR and what was paid. Government numbers, so `remit_statutory` (the longer prefix wins over `/payroll`, so /new and /<id> inherit it).
  '/payroll/statutory-payments': 'remit_statutory',
  // T-369 S1: names colleagues' money owed, like `/payroll`. The longer prefix wins over `/expenses`.
  '/expenses/reimbursements': 'record_ap_payment',
  '/owners': 'view_financial_reports',
  '/loans': 'view_financial_reports',
  '/liabilities': 'view_financial_reports',
  '/service-charge': 'view_financial_reports',
  '/fixed-assets': 'manage_fixed_assets',
  '/money-accounts': 'view_financial_reports',
  '/money-transfers': 'view_financial_reports',
  '/prepaid': 'view_financial_reports',
  // T-577 (DEF-834, Ian 13 Nov, bible row 461): these three screens read the whole org's money and were open to any signed-in person. Each lists the
  // capabilities its own actions already check (any ONE opens it), so nobody who works the screen is locked out and nobody else reads it. Children inherit.
  // /ap: log, verify or pay a supplier invoice, or approve a supplier (the screen's writes). /cash-requests: the ask (`create_expense`) and the decision (`approve_expense`).
  '/ap': ['record_supplier_invoice', 'verify_supplier_invoice', 'record_ap_payment', 'approve_supplier'],
  // /budgets only sets and removes caps (`manage_expense_budgets`). A spender still sees what is left on /expenses/new, which stays open.
  '/budgets': 'manage_expense_budgets',
  '/cash-requests': ['create_expense', 'approve_expense'],
  // T-511 S4: uploading a Grab / Foodpanda statement. `ingestSettlementFile` checks the same word at the store the file belongs to. The longer prefix wins over /channel-settlements (record_ar_collection, T-617).
  '/channel-settlements/upload': 'upload_settlement_files',
  // T-511 S5b: reading, rejecting and reopening the staged days. The list and detail are scoped per store inside the domain by the same word `rejectDay` checks (recording a channel settlement); the longer prefix wins over /channel-settlements (T-617).
  '/channel-settlements/review': 'record_ar_collection',
  // T-390 S5: the opening count (costs), the opening figures (party names, balances) and the count sheet. The domain's writes check
  // the same word; this is the read layer. The prefix covers /opening-balances/stock-count/sheet.
  '/opening-balances/balance-sheet': 'run_cutover',
  '/opening-balances/stock-count': 'run_cutover',

  // --- T-401 S4: the menu and catalog master. The prefix covers /menu/items/[id] and /menu/prices; the longer /menu/requests wins
  //     and needs the (store-scoped) request word instead, which a manager holds. The writes check their own words in the domain.
  '/menu': 'view_menu',
  '/menu/requests': 'request_menu_item',

  // --- T-435 / bible row 353: personal data is read only by people whose job needs it, for their own stores. The page also
  //     filters the store list and every loader authorizes (two layers). ----------------------------------------------------
  // Customers are org master data; AR is per store. Everyone with a reason to see a B2B customer collects from them.
  '/customers': 'record_ar_collection',
  // Ian Q3 (16 Oct): price lists stay open. The longer `null` key wins over the `/customers` prefix.
  '/customers/price-lists': null,
  // Ian Q2: holding only manage_attendance at a store is enough to see that store's roster.
  '/staff': ['enrol_staff', 'manage_attendance'],
  '/staff/hire': 'enrol_staff',
  // T-603 S2 (DEF-906, 907, 910, 916): the store-picker screens. Each key is the screen's own write words (any ONE opens it); the page then lists only the stores where
  // one is held (`storePageScope`) and a record page asks the same list at the record's store (`recordInScope`). Longer keys below still win.
  // Every word a screen under /inventory exists for: stock moves and receiving, rooms, thresholds, counts, usage and wastage (record and post), transfers, supplier returns, production, and their voids.
  '/inventory': [
    'record_stock_movement', 'record_wastage', 'receive_delivery', 'transfer_stock', 'void_transfer', 'record_supplier_return', 'void_supplier_return',
    'set_item_threshold', 'manage_locations', 'open_count_session', 'commit_count', 'post_usage', 'void_usage_record', 'finalize_pos_usage_pull',
    'post_production', 'edit_posted_production', 'void_production',
  ],
  '/till': ['record_till_count', 'resolve_till_variance'],
  '/remittance': 'accept_remittance',
  '/trade/returns': ['record_customer_return', 'void_customer_return', 'apply_customer_credit'],
  '/wastage': ['record_order_wastage', 'resolve_order_wastage'],
  // T-603 S3 (DEF-911): the expense list and form are for people who record or approve expenses, at their stores (the same words `expenses/[id]` already reads by). `/expenses/reimbursements` and `/expenses/recurring` keep their longer keys.
  '/expenses': ['create_expense', 'edit_own_expense', 'approve_expense'],
  '/expenses/recurring': 'manage_recurring_expenses',
  // T-603 S3 (DEF-912): the findings feed and the store scorecard. A store-limited viewer sees their stores' findings; org-level ones (trial balance, fiscal runway) and close-readiness are for an org-wide viewer. Children inherit.
  '/findings': 'view_financial_reports',
  // T-398 S5d: goods another company sent us are received by whoever may receive a delivery. The longer key wins over the open /inventory.
  '/inventory/deliveries/inbound': 'receive_delivery',
  // T-583 S2 (Ian, 2026-11-15, revised 16 Nov: "cooks can read recipes"): the cookbook is READ by whoever may record a cook run
  // (`record_stock_movement`: managers and admins by role, cooks by position); staff with no cook role are refused. /[id] inherits.
  // The longer /new key wins over the prefix and needs `manage_recipes`. Recipe writes keep their own `manage_recipes` check.
  // T-635: the slicer pay view shows what people are owed, so it is read by whoever runs payroll. Rates are set under `set_pay_rate` inside the domain.
  '/inventory/production/slicer-pay': 'run_payroll',
  '/inventory/production/recipes': 'record_stock_movement',
  '/inventory/production/recipes/new': 'manage_recipes',
  // T-398 S6d: the franchisor looks at a franchisee's sales and stock (each press is logged by the database); the franchisee's owner reads who looked.
  '/franchise/sales': 'view_franchise_sales',
  '/franchise/stock': 'view_franchise_sales',
  '/franchise/access-log': 'view_franchise_access_log',

  // --- T-617 (Ian, 22 Nov 2026, "approve the defaults"): the 13 routes that awaited a decision. Existing words only; each is the screen's own acts, any ONE opens it.
  // Longer keys elsewhere in this map still win (/attendance/terminals, /channel-settlements/upload, /opening-balances/stock-count ...).
  '/attendance': 'manage_attendance',
  // A signed-in person's OWN leave (balance, request, their requests) stays open to everyone; the store-wide half is drawn only for `manage_attendance` and every read is store-checked in the domain.
  '/attendance/leave': null,
  // Recording, voiding and reviewing a settlement all need record_ar_collection at the store (domain). Admin-only payout account (set_channel_payout) sits on top inside the page.
  '/channel-settlements': 'record_ar_collection',
  // Commissary floor staff hold fulfil_branch_order at the commissary (a read of what is offered and what is short); the writes keep their own manage/resolve words in the domain.
  '/commissary/catalogue': ['manage_commissary_offerings', 'manage_commissary_map', 'fulfil_branch_order'],
  '/commissary/discrepancies': ['resolve_trade_discrepancy', 'fulfil_branch_order'],
  // Both sides of an internal order: the branch (place), the commissary (fulfil, dispatch), signing for goods (confirm_receipt) and the thread (post_order_message).
  '/commissary/orders': ['place_branch_order', 'fulfil_branch_order', 'dispatch_branch_order', 'confirm_receipt', 'post_order_message'],
  // The item master: manage (manager+), approve (super admin) or decide a request (admin).
  '/items': ['manage_items', 'approve_item', 'approve_item_request'],
  // The CSV import is the admin's; `importItems` checks approve_item_request.
  '/items/import': 'approve_item_request',
  // Attesting a store's opening step is a manager's (run_cutover, store-checked); posting the opening entry stays admin-only in the domain behind an administrator PIN.
  '/opening-balances': 'run_cutover',
  // The SC/PWD register: `listStatutoryDiscounts` reads by record_statutory_discount at the store, so a cashier (who transcribes the paper logbook) keeps the screen; managers and admins hold it by role.
  '/statutory-discounts': 'record_statutory_discount',
  // T-628: the office's read-only list of POS reservations and held deposits; a manager reads it (the domain asks approve_pos_correction at the store).
  '/pos-reservations': 'approve_pos_correction',
  // The same three words `orderDetail` already opens an order by.
  '/trade/orders': ['create_wholesale_order', 'approve_buyer', 'record_ar_collection'],
  // The franchisor's actions; the domain asks view_franchise_sales on every press. /franchise/access-log keeps its own longer key.
  '/franchise': 'view_franchise_sales',
};

/**
 * The requirement to read `pathname`: a capability, a list (ANY-OF), or `null` when the route is open to any signed-in
 * person.
 *
 * ⚠️ **Longest prefix wins, and the boundary check is not decoration.** A bare `startsWith` would
 * make `/ownership-transfer` inherit `/owners`'s capability — a route that does not exist today,
 * which is exactly how this kind of helper acquires a wrong answer nobody notices. A prefix
 * matches only at a `/` boundary or on an exact match.
 */
export function capabilityForRoute(pathname: string): RouteRequirement {
  let best: { route: string; requirement: RouteRequirement } | null = null;
  for (const [route, requirement] of Object.entries(ROUTE_CAPABILITY)) {
    const matches = pathname === route || pathname.startsWith(`${route}/`);
    if (!matches) continue;
    if (!best || route.length > best.route.length) best = { route, requirement };
  }
  return best?.requirement ?? null;
}

/** The capabilities a route accepts (any one of them is enough), `[]` when it is open. */
export function capabilitiesForRoute(pathname: string): readonly Capability[] {
  const r = capabilityForRoute(pathname);
  if (r === null) return [];
  return typeof r === 'string' ? [r] : r;
}

/**
 * Presentation only — which nav hrefs this actor may be shown.
 *
 * ⛔ **`held` is a set of capabilities, and this function is NOT a control.** It decides what a
 * menu renders. `requirePageAccess` is what actually refuses, and `authorize()` is what actually
 * refuses a write. A caller that used this to decide whether an action may proceed has
 * re-created DEF-051.
 */
export function navHrefAllowed(href: string, held: ReadonlySet<string>): boolean {
  const accepted = capabilitiesForRoute(href);
  return accepted.length === 0 || accepted.some((c) => held.has(c));
}

/**
 * DEF-803 - the three commissary nav items show only when the org actually uses them (T-398 smoketest: a franchisee's owner saw all three, each an empty
 * state; ADR-008 s6 / O5: PG sees no commissary screen). `commissaryUsage` (packages/db) supplies the two facts. ⛔ Presentation only, like `navHrefAllowed`:
 * the routes are untouched and still render their empty states on a direct visit.
 *  - "Commissary catalogue" and "Transit discrepancies": only if the org has a commissary store.
 *  - "Branch orders": only if the org has a store linked as a branch, or has a commissary.
 */
export const COMMISSARY_NAV_HREFS: readonly string[] = ['/commissary/orders', '/commissary/catalogue', '/commissary/discrepancies'];

export function commissaryNavAllowed(href: string, usage: { readonly hasCommissary: boolean; readonly hasBranchLink: boolean }): boolean {
  if (!COMMISSARY_NAV_HREFS.includes(href)) return true;
  if (href === '/commissary/orders') return usage.hasCommissary || usage.hasBranchLink;
  return usage.hasCommissary;
}
