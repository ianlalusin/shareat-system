'use client';

/**
 * T-526 R3 - the POS frame: top bar (store, status pill, who is signed in, Switch cashier, ERP), the tab strip, and the page body.
 * The server layout decides what this person may see and passes it in; everything here is presentation plus the schedulers in
 * `use-pos-state.ts` and `use-device-sync.ts`. The tab bodies are placeholders until T-527; the slice that first needs this state (the
 * state body, `drainNow`, the offline actor) adds the context that hands it down, so nothing here is exported before it has a caller.
 * Touch size is `min-h-12` (3rem) on every control. No state library: React state only.
 */
import Link from 'next/link';
import { startTransition, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Badge, Banner, Button } from '@/components/ui';
import { signOutAction } from '@/app/sign-in/actions';
import { POS_CONFLICT_MESSAGE, POS_NEEDS_INTERNET_ONCE, POS_STORE_ACCESS_LOST, POS_TABLET_UNPAIRED_MESSAGE, posHttpErrorMessage } from './messages';
import { SwitchCashierDialog } from './SwitchCashierDialog';
import { posOfflineBandText } from './offline-band';
import { statusPillLabel, statusPillShort } from './status-pill';
import { tabCount, visibleTabs } from './tabs';
import { useDeviceSync } from './use-device-sync';
import { usePosState } from './use-pos-state';

export interface PosShellProps {
  person: { personId: string; displayName: string };
  /** The POS capabilities the signed-in person holds (from the server). Offline, the offline actor's own list replaces them. */
  heldPos: string[];
  /** The stores this person may work at. */
  stores: { id: string; name: string }[];
  /** The store of this tablet's live pairing; null on a phone or a kitchen browser. */
  pairedStoreId: string | null;
  /** Where the ERP button goes (the person's normal landing); null when they hold no ERP screen. */
  erpHref: string | null;
  children: ReactNode;
}

// Phone (below sm): the tabs are a fixed bottom bar, every tab the same width, label always visible, 3rem tall. From sm up it is the strip under the top bar.
const NAV = 'fixed inset-x-0 bottom-0 z-30 flex gap-0.5 border-t border-surface-border bg-canvas px-2 pt-1 pb-[env(safe-area-inset-bottom)] sm:static sm:z-auto sm:gap-1 sm:overflow-x-auto sm:border-b sm:border-t-0 sm:bg-transparent sm:px-3 sm:py-1';
const TAB = 'min-h-12 min-w-0 flex-1 inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-full px-0.5 text-xs font-semibold sm:flex-none sm:gap-2 sm:px-4 sm:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const MENU_ITEM = 'min-h-12 flex w-full items-center rounded-xl px-3 text-left text-sm font-semibold hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink';
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => (w[0] ?? '').toUpperCase()).join('');

export function PosShell({ person, heldPos, stores, pairedStoreId, erpHref, children }: PosShellProps) {
  const pathname = usePathname();
  const requested = useSearchParams().get('storeId');
  const storeId = pairedStoreId ?? stores.find((s) => s.id === requested)?.id ?? (stores.length === 1 ? (stores[0]?.id ?? null) : null);
  const store = stores.find((s) => s.id === storeId);
  const state = usePosState(storeId);
  const sync = useDeviceSync({ paired: pairedStoreId !== null, personId: person.personId, online: state.online });
  const [switching, setSwitching] = useState(false);
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const avatarRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const signingOut = useRef(false);

  const offline = !state.online;
  const actor = sync.offlineActor;
  const caps = new Set(actor ? actor.posCapabilities : heldPos);
  const tabs = visibleTabs(caps);
  const query = !pairedStoreId && stores.length > 1 && storeId ? `?storeId=${storeId}` : '';

  // How long the pill says we have been offline; re-read every 30 s so the minutes move.
  useEffect(() => {
    if (!offline) return setOfflineSince(null);
    setOfflineSince((t) => t ?? Date.now());
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [offline]);

  // The phone's avatar panel (a plain disclosure, not an ARIA menu): opening it puts focus on its first item; Escape or a tap outside closes it and
  // hands focus back to the avatar button.
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>('[data-menu-item]')?.focus();
    const close = () => {
      setMenuOpen(false);
      avatarRef.current?.focus();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const onDown = (e: PointerEvent) => menuRef.current && !menuRef.current.contains(e.target as Node) && close();
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [menuOpen]);

  // Back online with someone else still signed in on the server: send what they queued, then ask the real holder to sign in online (R5).
  useEffect(() => {
    if (actor && actor.personId === person.personId) sync.setOfflineActor(null);
    else if (actor && state.online && sync.pending === 0 && !sync.sending && !signingOut.current) {
      signingOut.current = true;
      sync.setOfflineActor(null);
      startTransition(() => void signOutAction());
    }
  }, [actor, person.personId, state.online, sync]);

  const sinceMs = state.failingSinceMs ?? offlineSince;
  const pillInput = { online: state.online, sending: sync.sending, pending: sync.pending, offlineForMs: sinceMs === null ? 0 : Math.max(0, now - sinceMs), signedOut: state.signedOut === true };
  const pill = statusPillLabel(pillInput);
  const pillShort = statusPillShort(pillInput);
  const pillTone = state.signedOut ? 'danger' : offline ? 'warning' : sync.sending ? 'info' : 'success';
  const name = actor?.displayName ?? person.displayName;
  const switchCashier = () => (offline ? setSwitching(true) : startTransition(() => void signOutAction()));
  const signInAgain = () => startTransition(() => void signOutAction());
  const showErp = erpHref && !offline;

  return (
    <>
      <div className="flex min-h-dvh flex-col bg-canvas text-ink">
        <header className="flex items-center gap-2 border-b border-surface-border px-3 py-2 sm:gap-4 sm:px-4">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <span className="shrink-0 font-display text-xl font-bold">
              Shar<span className="text-brand-ink">E</span>at <span className="text-sm font-semibold text-muted">POS</span>
            </span>
            {store ? <span className="min-w-0 truncate rounded-full bg-closed-soft px-3 py-1 text-sm font-semibold text-closed">{store.name}</span> : null}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
            <Badge tone={pillTone} label={pillShort} className="sm:hidden" />
            <Badge tone={pillTone} label={pill} className="hidden sm:inline-flex" />
            {/* 401: the session ended. The outbox keeps sending (events ride the device cookie); only a person can sign in again. */}
            {state.signedOut ? (
              <Button icon={null} className="hidden min-h-12 sm:inline-flex" onClick={signInAgain}>
                Sign in again
              </Button>
            ) : null}
            {/* Tablet and up: the person, Switch cashier and ERP sit in the bar. */}
            <div className="hidden items-center gap-3 sm:flex">
              <div className="flex items-center gap-2">
                <span aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">
                  {initials(name)}
                </span>
                <div className="leading-tight">
                  <p className="text-sm font-semibold">{name}</p>
                  {actor ? <p className="text-xs text-warning-ink">offline sign-in</p> : null}
                </div>
              </div>
              <Button icon={null} className="min-h-12" onClick={switchCashier}>
                Switch cashier
              </Button>
              {showErp ? (
                <a href={erpHref} className="min-h-12 inline-flex items-center rounded-full border border-surface-border bg-surface px-4 text-sm font-semibold hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink">
                  ERP
                </a>
              ) : null}
            </div>
            {/* Phone: one round avatar button; the person, Switch cashier and ERP live in its small menu so the bar stays one row. */}
            <div ref={menuRef} className="relative sm:hidden">
              <button
                ref={avatarRef}
                type="button"
                aria-label={`${name}: account`}
                aria-controls={menuId}
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((o) => !o)}
                className="flex min-h-12 min-w-12 items-center justify-center rounded-full bg-brand text-sm font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
              >
                {initials(name)}
              </button>
              {menuOpen ? (
                <div id={menuId} role="region" aria-label="Account" className="absolute right-0 top-full z-40 mt-2 w-64 rounded-2xl border border-surface-border bg-surface p-2 shadow-lg">
                  <p className="px-3 py-2 text-sm font-semibold">
                    {name}
                    {actor ? <span className="block text-xs font-normal text-warning-ink">offline sign-in</span> : null}
                  </p>
                  {state.signedOut ? (
                    <button type="button" data-menu-item className={MENU_ITEM} onClick={signInAgain}>
                      Sign in again
                    </button>
                  ) : null}
                  <button type="button" data-menu-item className={MENU_ITEM} onClick={() => (setMenuOpen(false), switchCashier())}>
                    Switch cashier
                  </button>
                  {showErp ? (
                    <a data-menu-item href={erpHref} className={MENU_ITEM}>
                      ERP
                    </a>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </header>

        {/* T-526b: while offline, one full-width amber band says what still works (orders-offline.png). The time is the first failed poll. */}
        {offline ? (
          <div role="status" className="w-full bg-warning-soft px-4 py-3 text-sm font-semibold text-warning-ink">
            {posOfflineBandText(sinceMs ?? now)}
          </div>
        ) : null}

        {tabs.length > 0 ? (
          <nav aria-label="POS sections" className={NAV}>
            {tabs.map((t) => {
              const active = t.href === '/pos' ? pathname === '/pos' : pathname.startsWith(t.href);
              const count = tabCount(t.key, state.body);
              return (
                <Link key={t.key} href={`${t.href}${query}`} aria-current={active ? 'page' : undefined} className={`${TAB} ${active ? 'bg-ink text-canvas' : 'text-muted hover:text-ink'}`}>
                  {t.label}
                  {count ? <span className="rounded-full bg-brand px-2 text-xs font-bold text-white">{count}</span> : null}
                </Link>
              );
            })}
          </nav>
        ) : null}

        <main className="min-w-0 flex-1 space-y-3 p-4 pb-24 sm:pb-4">
          {state.forbidden ? <Banner tone="error">{POS_STORE_ACCESS_LOST}</Banner> : null}
          {state.httpError ? <Banner tone="error">{posHttpErrorMessage(state.httpError)}</Banner> : null}
          {sync.unpaired ? <Banner tone="error">{POS_TABLET_UNPAIRED_MESSAGE}</Banner> : null}
          {sync.needsInternet ? <Banner tone="warning">{POS_NEEDS_INTERNET_ONCE}</Banner> : null}
          {sync.conflicts > 0 ? (
            <Banner tone="warning">
              {POS_CONFLICT_MESSAGE}{' '}
              <Button icon={null} className="min-h-12" onClick={sync.clearConflicts}>
                OK
              </Button>
            </Banner>
          ) : null}
          {storeId || stores.length === 0 ? (
            // No store at all: the page below shows its own refusal card for this person, not a sentence from the shell.
            children
          ) : (
            <section aria-labelledby="pos-pick-store" className="mx-auto max-w-md rounded-2xl border border-surface-border bg-surface p-5">
              <h1 id="pos-pick-store" className="text-lg font-semibold">
                Choose a store
              </h1>
              <ul className="mt-3 space-y-2">
                {stores.map((s) => (
                  <li key={s.id}>
                    <Link href={`${pathname}?storeId=${s.id}`} className="flex min-h-12 items-center rounded-xl border border-field-border px-4 text-base font-semibold hover:bg-canvas">
                      {s.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </main>
      </div>
      <SwitchCashierDialog open={switching} onClose={() => setSwitching(false)} onSwitched={sync.setOfflineActor} />
    </>
  );
}
