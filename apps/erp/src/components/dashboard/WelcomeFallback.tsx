import Link from 'next/link';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';

/**
 * T-589 B3a - what `/` shows a person who may not read the financial dashboard (no `view_financial_reports`). Everyone lands on `/`,
 * so it never refuses: no tiles, no figures, just a welcome and the screens that are open to every signed-in person.
 */
const OPEN_LINKS: readonly { href: string; label: string }[] = [
  { href: '/expenses', label: 'Expenses' },
  { href: '/attendance/leave', label: 'Leave' },
  { href: '/inventory', label: 'Stock on hand' },
];

export function WelcomeFallback() {
  return (
    <Page density="table">
      <h1 className="text-2xl font-semibold">Welcome</h1>
      <PageDescription>You are signed in. The money dashboard is for managers and owners. Use the menu to open the screens your role can use, or start here.</PageDescription>
      <ul className="mt-4 flex flex-wrap gap-2">
        {OPEN_LINKS.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="inline-flex min-h-[44px] items-center rounded border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </Page>
  );
}
