import { GROUPS } from './nav';

/**
 * T-630 — the breadcrumb on every ERP page, built from the URL path (`docs/tasks/630-breadcrumbs.md`).
 *
 * Ian, 2026-11-23: "some sub pages has this link some has no ... add to all pages, step browsing path
 * so its easier to go to previous pages from nested ones". Before this, 8 of 157 pages passed a
 * hand-written `crumb` to `PageHeader`; the rest had none, or a one-step "← Parent" link.
 *
 * This file is pure data and one pure function, `crumbSteps`. `shell/Breadcrumbs.tsx` renders it once,
 * in `AppShell`, so no page can forget it. `tests/unit/t630-breadcrumbs.test.ts` holds both guards: the
 * function's rules, and the census that `CRUMB_PAGES` is exactly the set of `page.tsx` files in scope.
 *
 * Labels, in order (rule 2):
 *   1. a title the page itself showed (its `<h1>`; the renderer passes it in through `titleOf`);
 *   2. the sidebar label from `nav.tsx` `GROUPS` for that exact path (reused, never copied);
 *   3. `SEGMENT_LABELS` below, the small explicit map for what nav does not name;
 *   4. a dynamic segment (`[id]`) not in the map is never shown raw: the census refuses a missing one;
 *   5. otherwise the segment itself, dashes to spaces ("price-lists" -> "Price lists").
 */

/** One step of the trail. `href` is null for the current page and for a path with no page of its own (rule 4). */
export interface CrumbStep {
  readonly label: string;
  readonly href: string | null;
  readonly current: boolean;
}

/**
 * ⛔ Kept equal to the real `page.tsx` set by the census in `t630-breadcrumbs.test.ts`; a new page that
 * is not added here fails that test rather than silently getting no breadcrumb. Needed at run time
 * because the browser cannot see the file system, and rule 4 (no dead links) needs to know which
 * paths have a page.
 *
 * Not listed, on purpose (rule 5 and 7): `/` (the Dashboard), `/pos` and everything under it (the
 * tablet), `/clock` (the wall kiosk), `/sign-in` and `/setup` (before a session; `AppShell` renders no
 * shell there at all).
 */
export const CRUMB_PAGES: readonly string[] = [
  '/admin/access-defaults',
  '/admin/pos-tablets',
  '/admin/prerequisite-refusals',
  '/admin/stores',
  '/admin/stores/[id]',
  '/admin/stores/[id]/pos-preflight',
  '/admin/users',
  '/admin/users/[personId]',
  '/ap',
  '/ap/invoices/[id]',
  '/ap/suppliers',
  '/ap/suppliers/[id]',
  '/ap/vat',
  '/attendance',
  '/attendance/[dayId]',
  '/attendance/lane',
  '/attendance/leave',
  '/attendance/terminals',
  '/budgets',
  '/cash-requests',
  '/cash-requests/[id]',
  '/channel-settlements',
  '/channel-settlements/record',
  '/channel-settlements/review',
  '/channel-settlements/upload',
  '/commissary/catalogue',
  '/commissary/discrepancies',
  '/commissary/orders',
  '/commissary/orders/[id]',
  '/customers',
  '/customers/[customerId]',
  '/customers/price-lists',
  '/customers/price-lists/[id]',
  '/documents',
  '/documents/[id]',
  '/documents/[id]/print',
  '/documents/new',
  '/documents/templates',
  '/expenses',
  '/expenses/[id]',
  '/expenses/new',
  '/expenses/recurring',
  '/expenses/reimbursements',
  '/findings',
  '/findings/scorecard',
  '/fixed-assets',
  '/fixed-assets/[id]',
  '/fixed-assets/new',
  '/franchise/access-log',
  '/franchise/sales',
  '/franchise/stock',
  '/inventory',
  '/inventory/counts',
  '/inventory/counts/[id]',
  '/inventory/deliveries',
  '/inventory/deliveries/[id]',
  '/inventory/deliveries/inbound',
  '/inventory/deliveries/inbound/[shipmentId]',
  '/inventory/locations',
  '/inventory/low-stock',
  '/inventory/production',
  '/inventory/production/[id]',
  '/inventory/production/recipes',
  '/inventory/production/recipes/[id]',
  '/inventory/production/recipes/new',
  '/inventory/production/slicer-pay',
  '/inventory/returns',
  '/inventory/transfers',
  '/inventory/usage',
  '/inventory/usage/[id]',
  '/items',
  '/items/[id]',
  '/items/import',
  '/kitchen',
  '/liabilities',
  '/liabilities/[id]',
  '/liabilities/unpaid',
  '/loans',
  '/loans/[id]',
  '/menu',
  '/menu/hours',
  '/menu/items/[id]',
  '/menu/prices',
  '/menu/requests',
  '/menu/stores/[storeId]',
  '/menu/usage-source',
  '/money-accounts',
  '/money-transfers',
  '/opening-balances',
  '/opening-balances/balance-sheet',
  '/opening-balances/stock-count',
  '/opening-balances/stock-count/sheet',
  '/owners',
  '/owners/[id]',
  '/payroll',
  '/payroll/rates',
  '/payroll/separations',
  '/payroll/statutory-payments',
  '/payroll/statutory-payments/[id]',
  '/payroll/statutory-payments/month',
  '/payroll/statutory-payments/new',
  '/payroll/thirteenth-month',
  '/pos-reservations',
  '/prepaid',
  '/prepaid/[id]',
  '/remittance',
  '/reports/ap-aging',
  '/reports/ar-aging',
  '/reports/balance-sheet',
  '/reports/cash-flow',
  '/reports/dual-run',
  '/reports/dual-run/[store]/[week]',
  '/reports/dual-run/pack',
  '/reports/expense-items',
  '/reports/income-statement',
  '/reports/journal-lines',
  '/reports/pos-data',
  '/reports/pos-reconciliation',
  '/reports/sales-rollup',
  '/reports/store-comparison',
  '/reports/trial-balance',
  '/sales-days',
  '/sales-days/[id]',
  '/sales-days/[id]/edit',
  '/sales-days/new',
  '/service-charge',
  '/settings',
  '/settings/attendance',
  '/settings/business-rules',
  '/settings/expense-categories',
  '/settings/organization',
  '/settings/pos-link',
  '/settings/pos-tablet',
  '/settings/sales-channels',
  '/settings/usage-tolerance',
  '/settings/wastage-monitor',
  '/staff',
  '/staff/[employmentId]',
  '/staff/[employmentId]/credentials',
  '/staff/hire',
  '/statutory-discounts',
  '/till',
  '/trade/orders',
  '/trade/orders/[id]',
  '/trade/orders/[id]/print',
  '/trade/returns',
  '/wastage',
  '/wastage/[id]',
];

/** Paths that never show a breadcrumb even if a page is added under them (rule 5 and 7). */
export const NO_CRUMB_PREFIXES: readonly string[] = ['/pos', '/clock', '/sign-in', '/setup'];

/**
 * What nav does not name. Keyed by route PATTERN (with `[id]`), so one entry covers every record.
 * Every dynamic segment needs an entry: it is what a middle step says before the record's own page has
 * been opened in this tab, and what the last step says for the moment before the page's title is read.
 */
export const SEGMENT_LABELS: Readonly<Record<string, string>> = {
  '/admin': 'Admin',
  '/admin/stores/[id]': 'Store',
  '/admin/stores/[id]/pos-preflight': 'POS pre-flight',
  '/admin/users/[personId]': 'User',
  '/ap/invoices': 'Invoices',
  '/ap/invoices/[id]': 'Invoice',
  '/ap/suppliers/[id]': 'Supplier',
  '/ap/vat': 'VAT',
  '/attendance/[dayId]': 'Day',
  '/cash-requests/[id]': 'Cash request',
  '/commissary/orders/[id]': 'Branch order',
  '/customers/[customerId]': 'Customer',
  '/customers/price-lists/[id]': 'Price list',
  '/documents/[id]': 'Document',
  '/documents/[id]/print': 'Print',
  '/documents/new': 'New document',
  '/expenses/[id]': 'Expense',
  '/expenses/new': 'New expense',
  '/fixed-assets/[id]': 'Asset',
  '/fixed-assets/new': 'New asset',
  '/inventory/counts/[id]': 'Count',
  '/inventory/deliveries/[id]': 'Delivery',
  '/inventory/deliveries/inbound/[shipmentId]': 'Shipment',
  '/inventory/production/[id]': 'Production run',
  '/inventory/production/recipes/[id]': 'Recipe',
  '/inventory/production/recipes/new': 'New recipe',
  '/inventory/usage/[id]': 'Usage record',
  '/items/[id]': 'Item',
  '/liabilities/[id]': 'Liability',
  '/loans/[id]': 'Loan',
  '/menu/items': 'Items',
  '/menu/items/[id]': 'Menu item',
  '/menu/stores': 'Stores',
  '/menu/stores/[storeId]': 'What the store sells',
  '/owners/[id]': 'Owner',
  '/payroll/statutory-payments/[id]': 'Payment',
  '/payroll/statutory-payments/new': 'New payment',
  '/prepaid/[id]': 'Prepaid item',
  '/reports/dual-run/[store]': 'Store',
  '/reports/dual-run/[store]/[week]': 'Week',
  '/sales-days/[id]': 'Sales day',
  '/sales-days/[id]/edit': 'Edit',
  '/sales-days/new': 'New sales day',
  '/staff/[employmentId]': 'Staff member',
  '/staff/[employmentId]/credentials': 'Sign-in',
  '/staff/hire': 'Hire',
  '/trade/orders/[id]': 'Trade order',
  '/trade/orders/[id]/print': 'Print',
  '/wastage/[id]': 'Wastage record',
};

/** Sidebar labels by exact href, read from nav.tsx so a renamed nav entry renames its step too. */
const NAV_LABELS: ReadonlyMap<string, string> = new Map(GROUPS.flatMap((g) => g.links.map((l) => [l.href, l.label] as const)));

/** Words a dash-to-space label keeps in capitals. */
const ACRONYMS: ReadonlySet<string> = new Set(['pos', 'ap', 'ar', 'vat', 'sc', 'pwd']);

function fromSegment(segment: string): string {
  const words = segment.split('-').map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w));
  const first = words[0] ?? '';
  words[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return words.join(' ');
}

const isDynamic = (segment: string) => segment.startsWith('[') && segment.endsWith(']');

/** The page pattern a concrete path belongs to, or null when no page answers it. Static segments win over `[id]`. */
export function matchPage(segments: readonly string[], pages: readonly string[] = CRUMB_PAGES): string | null {
  let best: { pattern: string; dynamics: number } | null = null;
  for (const pattern of pages) {
    const parts = pattern.split('/').filter(Boolean);
    if (parts.length !== segments.length) continue;
    let dynamics = 0;
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i] ?? '';
      if (isDynamic(p)) dynamics++;
      else if (p !== segments[i]) ok = false;
      if (!ok) break;
    }
    if (ok && (!best || dynamics < best.dynamics)) best = { pattern, dynamics };
  }
  return best?.pattern ?? null;
}

/**
 * The trail for one URL path. An empty array means "show no breadcrumb": the Dashboard, a top-level
 * page (a single step adds nothing), an excluded area, or a path no page answers.
 *
 * - `titleOf(path)`: a title the page at that path has shown (the last step's own `<h1>`, or one
 *   remembered from earlier in this tab), or undefined.
 * - `canOpen(path)`: false when the viewer's role cannot open that page, so the step is plain text rather
 *   than a link to a refusal. Presentation only, like the sidebar's filter; each page still gates itself.
 */
export interface CrumbOptions {
  readonly titleOf?: (path: string) => string | undefined;
  readonly canOpen?: (path: string) => boolean;
  readonly pages?: readonly string[];
}

export function crumbSteps(
  pathname: string,
  { titleOf = () => undefined, canOpen = () => true, pages = CRUMB_PAGES }: CrumbOptions = {},
): CrumbStep[] {
  const path = (pathname.split(/[?#]/)[0] ?? '').replace(/\/+$/, '') || '/';
  if (NO_CRUMB_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return [];
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) return [];
  const pattern = matchPage(segments, pages);
  if (!pattern) return [];
  const patternParts = pattern.split('/').filter(Boolean);
  const pageSet = new Set(pages);
  return segments.map((segment, i) => {
    const href = `/${segments.slice(0, i + 1).join('/')}`;
    const patternHref = `/${patternParts.slice(0, i + 1).join('/')}`;
    const current = i === segments.length - 1;
    const label =
      titleOf(href)?.trim() ||
      NAV_LABELS.get(href) ||
      SEGMENT_LABELS[patternHref] ||
      (isDynamic(patternParts[i] ?? '') ? '…' : fromSegment(segment));
    return { label, href: current || !pageSet.has(patternHref) || !canOpen(href) ? null : href, current };
  });
}
