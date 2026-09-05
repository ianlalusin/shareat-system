import Link from 'next/link';
import { currentSession } from '../lib/session';

/**
 * The app's navigation — and until now there wasn't one.
 *
 * ⚠️ **Twenty-seven routes existed and not one was linked from anywhere.** `app/page.tsx` was
 * still the Phase 0 scaffold, so every screen shipped since T-122 has been reachable only by
 * typing its URL. That is invisible in a test suite and invisible in a build: both go green on a
 * page nobody can navigate to, which is the same failure shape as ERP-rebuild's Tailwind content
 * globs (a real file in an unlisted directory is indistinguishable from a passing one).
 *
 * ⭐ Rendered from the SESSION, so signing out hides it — and the sign-in page never shows it.
 */
const GROUPS: { label: string; links: { href: string; label: string }[] }[] = [
  {
    label: 'Daily',
    links: [
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
      { href: '/payroll', label: 'Payroll' },
      { href: '/expenses', label: 'Expenses' },
      { href: '/cash-requests', label: 'Cash requests' },
    ],
  },
  {
    label: 'Inventory',
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
    links: [
      // ⭐ First in Reports on purpose: it answers "can this period close at all" before the
      // statements that assume it can. DEF-084 — this feed had no screen until 2026-08-30.
      { href: '/findings', label: 'Findings' },
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
];

export async function Nav() {
  const session = await currentSession();
  if (!session) return null;

  return (
    <nav className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
      <div className="mx-auto max-w-6xl px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <Link href="/" className="text-sm font-semibold tracking-tight">
            Shareat
          </Link>
          {/* ⚠️ DEF-149 — each group carries `flex-wrap` too, not only the row above. A group was
              an unwrappable row, so at 390px the Inventory group alone ran 237px past the viewport
              and EVERY route in the app scrolled sideways. Phone portrait is the canvas; measured
              on four routes before and after. */}
          {GROUPS.map((group) => (
            <div key={group.label} className="flex flex-wrap items-baseline gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                {group.label}
              </span>
              {group.links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="text-sm text-neutral-600 underline-offset-4 hover:text-neutral-900 hover:underline dark:text-neutral-400 dark:hover:text-neutral-100"
                >
                  {link.label}
                </Link>
              ))}
            </div>
          ))}
          <span className="ml-auto text-xs text-neutral-500">Signed in</span>
        </div>
      </div>
    </nav>
  );
}
