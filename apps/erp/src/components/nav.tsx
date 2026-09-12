import type { GroupIconKey } from './shell/icons';

/**
 * The app's navigation link data — read by `AppShell`/`SidebarNav` (T-234) to render the sidebar,
 * and by `tests/unit/nav-route-reachability.test.ts` (T-227), which text-scans this file for
 * `href: '...'` literals. **Keep every href in that exact single-quoted shape** — the guard does
 * not parse TypeScript, it greps this file's source.
 *
 * ⚠️ **Twenty-seven routes existed and not one was linked from anywhere.** `app/page.tsx` was
 * still the Phase 0 scaffold, so every screen shipped since T-122 has been reachable only by
 * typing its URL. That is invisible in a test suite and invisible in a build: both go green on a
 * page nobody can navigate to, which is the same failure shape as ERP-rebuild's Tailwind content
 * globs (a real file in an unlisted directory is indistinguishable from a passing one).
 *
 * ⭐ **T-288 — these links are now FILTERED before render.** `AppShell` computes which hrefs the
 * signed-in actor may be shown from `apps/erp/src/lib/route-capability.ts` and passes them to
 * `SidebarNav`. ⛔ This file stays pure data: it does not know about capabilities, and the filter
 * is applied by the caller. A link hidden here is ALSO refused at its own route, so the hiding is
 * never the control (DEF-051).
 *
 * ⭐ T-234 slice 1: this file used to also render the top bar (`export async function Nav()`,
 * reading the session itself). That render is gone — `AppShell.tsx` reads the session now and
 * decides whether to render a shell at all, and `SidebarNav.tsx` renders these links. This file is
 * data only, on purpose: a data module has no reason to be a Server Component, an async function,
 * or anything a test needs a running session to import.
 */
export const GROUPS: { label: string; icon: GroupIconKey; links: { href: string; label: string }[] }[] = [
  {
    label: 'Daily',
    icon: 'daily',
    links: [
      // T-211 — `/` used to be the Phase 0 scaffold; it's the dashboard now, so it earns a nav
      // entry of its own rather than relying solely on the "Shareat" logo link.
      { href: '/', label: 'Dashboard' },
      { href: '/sales-days', label: 'Sales days' },
      // ⭐ DEF-137 — `recordChannelSettlement` shipped 2026-08-28 with no screen and no nav entry,
      // so the `1220` receivable every verified Foodpanda/Grab day raises had nothing that ever
      // cleared it. Beside Sales days on purpose: that screen creates the receivable, this one
      // ends it.
      { href: '/channel-settlements', label: 'Channel settlements' },
      // T-178. Beside Channel settlements on purpose: that screen clears 1220 for a channel-day
      // as a whole; this one disposes of one refunded or remade order within it.
      { href: '/wastage', label: 'Order wastage' },
      { href: '/remittance', label: 'Remittance' },
      { href: '/till', label: 'Till custody' },
      // ⭐ DEF-131 — the FK every Phase 4/5 table depends on had no live path that created one
      // until 2026-09-04. Beside Attendance on purpose: that screen needs an employmentId this
      // one is the only way to create.
      { href: '/staff', label: 'Staff' },
      { href: '/attendance', label: 'Attendance' },
      // ⭐ DEF-133 — provisioning a clock terminal or enrolling a card/fingerprint had no admin UI
      // until 2026-09-04; only hand-run SQL could. `provision_clock_terminal` is admin-only.
      { href: '/attendance/terminals', label: 'Clock terminals' },
      // ⭐ DEF-197 — the screen that exists so a dead letter is VISIBLE was itself invisible. This
      // is landmine #14's whole structural fix (bible §12 row 14: v1's recovery path is a banner
      // saying "tell a manager", and there is nothing for the manager to open), and it was in no
      // nav group and linked from no page — reachable only by typing the URL, for five days.
      // Found by T-227's own guard on its first run, which is what a guard is for.
      { href: '/attendance/lane', label: 'Clock lane' },
      { href: '/payroll', label: 'Payroll' },
      { href: '/expenses', label: 'Expenses' },
      // ⭐ T-215 — beside Expenses on purpose: a cap only ever changes a decision at the moment of
      // spending, and `/expenses/new` is where that moment is. This screen is where it gets set.
      { href: '/budgets', label: 'Budgets' },
      // ⚠️ T-216 — the TEMPLATE register. Nothing acts on these yet and the screen says so in a
      // banner: the daily job is blocked on Ian deciding whether a due template drafts an expense
      // or pays itself. Linked anyway, because a screen reachable only by URL is DEF-181.
      { href: '/expenses/recurring', label: 'Recurring bills' },
      { href: '/cash-requests', label: 'Cash requests' },
    ],
  },
  {
    label: 'Inventory',
    icon: 'inventory',
    links: [
      { href: '/inventory', label: 'Stock on hand' },
      // ⭐ DEF-135 — the whole physical stock lifecycle (rooms, receiving, usage, counting) had a
      // tested engine and NO screen until 2026-09-03. Four routes, four lanes, one day.
      { href: '/inventory/locations', label: 'Rooms' },
      { href: '/inventory/deliveries', label: 'Deliveries' },
      { href: '/inventory/usage', label: 'Usage & wastage' },
      { href: '/inventory/counts', label: 'Counts' },
      // T-176, 2026-09-04 — a slicing run or prep batch posts as one stock transaction.
      { href: '/inventory/production', label: 'Production' },
      // T-177 — a day's POS sales turned into inventory consumption, so on-hand stays honest.
      { href: '/inventory/pos-usage', label: 'POS usage pull' },
      { href: '/inventory/pos-map', label: 'POS item mapping' },
      { href: '/inventory/low-stock', label: 'Low stock' },
      { href: '/commissary/orders', label: 'Branch orders' },
      // ⭐ DEF-129 — `commissary_item_map` had no writer anywhere until 2026-09-03, so every real
      // internal receipt threw. Links, offerings and the map live here.
      { href: '/commissary/catalogue', label: 'Commissary catalogue' },
      { href: '/commissary/discrepancies', label: 'Transit shortfalls' },
      { href: '/items', label: 'Items' },
    ],
  },
  {
    label: 'Money',
    icon: 'money',
    links: [
      { href: '/money-accounts', label: 'Accounts' },
      { href: '/money-transfers', label: 'Transfers' },
      { href: '/loans', label: 'Loans' },
      { href: '/prepaid', label: 'Prepaid' },
      { href: '/fixed-assets', label: 'Fixed assets' },
      { href: '/liabilities', label: 'Liabilities' },
      { href: '/owners', label: 'Owners' },
    ],
  },
  {
    label: 'Trade',
    icon: 'trade',
    links: [
      // ⚠️ `/ap/invoices` has no page — only `[id]`. It pointed here as a 404 until 2026-08-30
      // (DEF-107). `/ap` lists pending invoices already; a dedicated register is T-188 §7's
      // stated omission, not an oversight.
      { href: '/ap', label: 'Supplier invoices' },
      { href: '/ap/suppliers', label: 'Suppliers' },
      { href: '/customers', label: 'Customers' },
      { href: '/customers/price-lists', label: 'Price lists' },
      // ⭐ DEF-138 — the entry point to the whole wholesale / inter-entity feature had no screen
      // until 2026-09-03; returns (T-179) shipped a day before the orders they return against.
      { href: '/trade/orders', label: 'Trade orders' },
      { href: '/trade/returns', label: 'Customer returns' },
    ],
  },
  {
    label: 'Reports',
    icon: 'reports',
    links: [
      // ⭐ First in Reports on purpose: it answers "can this period close at all" before the
      // statements that assume it can. DEF-084 — this feed had no screen until 2026-08-30.
      { href: '/findings', label: 'Findings' },
      // ⭐ T-245. Beside Findings on purpose, not under Setup, despite the /admin/ path: it is a
      // count you READ, the same shape as Findings, not a thing you administer. Answers "which
      // order-of-operations walls do people actually hit" — the number Ian's "count first" ruling
      // (roadmap, 8 Sep) requires before any tutorial is written.
      { href: '/admin/prerequisite-refusals', label: 'Prerequisite walls' },
      { href: '/reports/trial-balance', label: 'Trial balance' },
      { href: '/reports/income-statement', label: 'Income statement' },
      { href: '/reports/balance-sheet', label: 'Balance sheet' },
      { href: '/reports/ap-aging', label: 'AP aging' },
      { href: '/reports/ar-aging', label: 'AR aging' },
      { href: '/reports/cash-flow', label: 'Cash flow' },
      { href: '/reports/store-comparison', label: 'Store comparison' },
      { href: '/reports/sales-rollup', label: 'Sales rollup' },
      { href: '/reports/pos-reconciliation', label: 'POS reconciliation' },
      // ⭐ DEF-139 — the screen worked and was tested but had no nav entry, so it was reachable
      // only by typing the URL. Same failure shape as this file's own header comment.
      { href: '/statutory-discounts', label: 'SC/PWD register' },
      { href: '/cutover/count', label: 'Cutover count' },
      { href: '/cutover/opening', label: 'Opening balances' },
    ],
  },
  {
    label: 'Setup',
    icon: 'setup',
    links: [
      // ⭐ T-219 / DEF-167 — role assignment, store scope and capability grants were fully built
      // and tested with no screen at all, so a hired person could sign in (T-217) and then be
      // authorized for nothing.
      //
      // ⚠️ **This entry used to carry the line "Hiding a link is presentation; the gate is the
      // write" as a reason NOT to filter the nav. T-288 changed that** — Ian, 2026-09-12: *"do
      // both hide the menu and gate the reads."* A cashier on a shared counter tablet was shown
      // this link, and `/admin/users` rendered the roster to them. ⛔ The old line is still TRUE
      // and is not repealed: hiding alone is worthless. It is now paired with a real read gate
      // (`requirePageAccess`), and BOTH read the one `ROUTE_CAPABILITY` map so they cannot drift.
      { href: '/admin/users', label: 'Users and roles' },
      // T-290 — what a Cashier can do here, per store. Gated on `grant_capability` through
      // `ROUTE_CAPABILITY`, the same map the filter above reads (bible row 198, decision 3).
      { href: '/admin/access-defaults', label: 'Position access defaults' },
      // ⭐ T-222 — until this shipped nothing in the codebase created a store; the four dev stores
      // were inserted by hand. ⚠️ Linked here on purpose: DEF-181 was precisely a screen that
      // shipped linked from nowhere, and this is the task that cites it.
      { href: '/admin/stores', label: 'Stores' },
      // ⭐ DEF-181 — this shipped with T-201 linked from nowhere, reachable only by typing the URL.
      // Exactly the failure this file's own header comment describes, re-created three routes later.
      //
      // DEF-192 / T-227: `/settings` was dropped when attendance was its only child — a hub listing
      // exactly one child is a screen that exists to satisfy a link. T-229 landed the second surface
      // (`/settings/expense-categories`) and a real `app/settings/page.tsx`, so the hub now earns its
      // place and links to both children; `nav-route-reachability` resolves `/settings/attendance`
      // transitively through it, which is why the direct entry is no longer needed here.
      { href: '/settings', label: 'Settings' },
    ],
  },
];
