/**
 * T-234 slice 1 — the phone (< 768) top bar: wordmark, ☰, a page-title slot, the signed-in
 * affordance. Server-rendered — the only client piece it needs is the ☰ button itself
 * (`MenuButton`, from `Sidebar.tsx`, which reads `SidebarProvider`'s context), so this file stays
 * a plain Server Component rather than becoming a client one for one button's sake.
 *
 * ⚠️ Rendered unconditionally at every width, hidden at ≥768 by CSS (`md:hidden`) rather than
 * branched on a client-guessed viewport — same reasoning as `Sidebar.tsx`'s persistent/drawer
 * split: the server-rendered markup must be identical regardless of the requesting viewport for
 * hydration to ever match it.
 *
 * ⚠️ No page-title content yet — there is no per-page title data plumbed into the shell in this
 * slice (that is slice 2's `PageHeader`, a different lane's file). The slot exists structurally
 * (a `<span>` reserved for it) so wiring a real title later is a one-line change here, not a new
 * layout.
 *
 * ⛔ Review round 2 SHOULD-FIX: a `<div>` carries no landmark role, so a phone's accessibility
 * tree had `main` alone — no banner, and correctly no navigation (the nav is behind ☰, exactly as
 * intended). `<header>` at the page's top level is the implicit ARIA `banner` landmark; no
 * `role="banner"` needed alongside it.
 *
 * ⭐ T-257/DEF-259 — the "Signed in" slot is now the sign-out control, not a label beside one.
 * `signOutAction` is a Server Action (`'use server'`), so a plain `<form action={signOutAction}>`
 * needs no client boundary — this file stays a Server Component, matching prior art already in
 * this codebase (`app/budgets/page.tsx`). docs/tasks/257-def-259-sign-out.md, "Placement decision".
 */
import { signOutAction } from '../../app/sign-in/actions';
import { MenuButton } from './Sidebar';

export function TopBar() {
  return (
    <header className="shell-nav-row sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-neutral-200 bg-white px-2 dark:border-neutral-800 dark:bg-neutral-950 md:hidden">
      <MenuButton />
      <img src="/brand/logo-icon.png" alt="" width={32} height={32} className="brand-logo h-8 w-8 shrink-0" />
      <span className="font-display text-lg font-bold">
        Shar<span className="text-brand-ink">E</span>at
      </span>
      {/* The page-title slot — empty until slice 2 wires a real value through. */}
      <span className="flex-1 truncate text-sm text-neutral-500" />
      <form action={signOutAction}>
        <button
          type="submit"
          className="shell-nav-row rounded-md px-2 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
        >
          Sign out
        </button>
      </form>
    </header>
  );
}
