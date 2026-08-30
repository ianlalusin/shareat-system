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
      { href: '/remittance', label: 'Remittance' },
      { href: '/till', label: 'Till custody' },
      { href: '/payroll', label: 'Payroll' },
      { href: '/expenses', label: 'Expenses' },
      { href: '/cash-requests', label: 'Cash requests' },
    ],
  },
  {
    label: 'Inventory',
    links: [
      { href: '/inventory', label: 'Stock on hand' },
      { href: '/inventory/low-stock', label: 'Low stock' },
      { href: '/commissary/orders', label: 'Branch orders' },
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
          {GROUPS.map((group) => (
            <div key={group.label} className="flex items-baseline gap-2">
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
