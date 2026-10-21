'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { ClipboardList, Receipt, ShoppingCart, Star, User, Utensils } from 'lucide-react';
import { useCart, useNotice, useSession } from '@/data/provider';
import { cartCount } from '@/lib/cart';
import { Card } from './ui';

export function DemoBanner() {
  return (
    <div className="bg-accent px-4 py-1.5 text-center text-xs font-medium text-accent-foreground">
      Demo - sample data, nothing is sent to the store
    </div>
  );
}

export function NoticeStrip() {
  const { notice, dismissNotice } = useNotice();
  if (!notice) return null;
  return (
    <div role="status" className="flex items-center justify-between gap-3 bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
      <span>{notice.text}</span>
      <button type="button" onClick={dismissNotice} className="min-h-[44px] px-2 text-xs underline">
        Dismiss
      </button>
    </div>
  );
}

const TABS = [
  { href: '/menu', label: 'Menu', icon: Utensils },
  { href: '/cart', label: 'Cart', icon: ShoppingCart },
  { href: '/orders', label: 'Orders', icon: ClipboardList },
  { href: '/bill', label: 'Bill', icon: Receipt },
  { href: '/feedback', label: 'Feedback', icon: Star },
] as const;

export function TabBar() {
  const pathname = usePathname() ?? '';
  const { cart } = useCart();
  const count = cartCount(cart);
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-card">
      <ul className="mx-auto flex max-w-md">
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname === `${href}/`;
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`relative flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-xs ${active ? 'font-bold text-foreground' : 'text-muted-foreground'}`}
              >
                <Icon className={`h-5 w-5 ${active ? 'text-primary' : ''}`} />
                {label}
                {href === '/cart' && count > 0 ? (
                  <span className="absolute right-3 top-1.5 min-w-[18px] rounded-full bg-primary px-1 text-center text-[10px] font-bold text-primary-foreground">
                    {count}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Page frame: brand header, notice strip, one centred phone-width column, bottom tabs once a table is joined. */
export function AppShell({ children }: { children: ReactNode }) {
  const { session } = useSession();
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col">
      <header className="flex items-center justify-between gap-3 px-4 py-3">
        <Link href="/" className="min-h-[44px] content-center text-lg font-extrabold">
          Shareat
        </Link>
        <div className="flex items-center gap-3">
          {session ? (
            <span className="text-right text-xs text-muted-foreground">
              {session.store.name}
              <br />
              {session.tableLabel}
            </span>
          ) : null}
          <Link href="/account" aria-label="Account" className="flex h-11 w-11 items-center justify-center rounded-full border border-border">
            <User className="h-5 w-5" />
          </Link>
        </div>
      </header>
      <NoticeStrip />
      <main className={`flex-1 px-4 pt-2 ${session ? 'pb-24' : 'pb-8'}`}>{children}</main>
      {session ? <TabBar /> : null}
    </div>
  );
}

/** Shows the screen only for a joined table; otherwise a friendly pointer back to the join screen. */
export function RequireSession({ children }: { children: ReactNode }) {
  const { session, ready } = useSession();
  if (!ready) return <p className="py-8 text-center text-sm text-muted-foreground">Loading...</p>;
  if (!session) {
    return (
      <Card className="mt-4 text-center">
        <p className="font-semibold">Join a table first</p>
        <p className="mt-1 text-sm text-muted-foreground">Enter the 6-digit PIN on your table, or scan the table QR code.</p>
        <Link href="/" className="mt-4 inline-block">
          <span className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground">
            Go to join screen
          </span>
        </Link>
      </Card>
    );
  }
  return <>{children}</>;
}
