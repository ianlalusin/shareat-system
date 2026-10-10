'use client';

/**
 * T-234 slice 1 — the sidebar's interactive shell: the persistent rail/expanded view (≥768) and
 * the phone off-canvas drawer, both rendered by this one component so the server-rendered markup
 * is identical at every viewport and CSS alone decides which is visible — the "no flash, no
 * layout shift" invariant depends on never branching this tree on a client-guessed width.
 *
 * Also exports the `SidebarProvider`/`useSidebarContext` pair `TopBar.tsx` uses to open the
 * drawer from its own ☰ button — copying POS's `SidebarProvider`/`useSidebar()` shape
 * (`components/ui/sidebar.tsx`) behaviourally, not as code.
 *
 * ⛔ Review round 2: the toggle button moves to the TOP of the persistent sidebar (§2.3 says "the
 * rail's TOP button expands it" — it was at the bottom), the focus trap now re-queries focusable
 * elements on every Tab press rather than once at open (SidebarNav's group toggle changes which
 * links exist while the drawer is open, so a snapshot taken at mount goes stale), and the
 * persistent sidebar gains its own "Signed in" line — `TopBar` is `md:hidden`, so ≥768 had lost
 * the affordance the old `Nav` always showed.
 *
 * ⛔ Review round 2, part 2: fixing the rail (hiding the whole sublist) removed the active link's
 * `aria-current="page"` from the tree along with it — a rail had zero "you are here". `state` is
 * now exposed on the context (not just the derived helper functions) so `SidebarNav` can react to
 * it changing, for its own current-group marker on the rail.
 *
 * ⭐ T-257/DEF-259 — both "Signed in" slots (expanded span, collapsed dot) are now the sign-out
 * control, not a label beside one. `signOutAction` is a Server Action reference; passing it as a
 * plain `<form>`'s `action` needs no extra client wiring even though this whole file is already
 * `'use client'`. docs/tasks/257-def-259-sign-out.md, "Placement decision".
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { signOutAction } from '../../app/sign-in/actions';
import { CloseIcon, CollapseIcon, MenuIcon, SignOutIcon } from './icons';
import { FOCUS_RING, writeSidebarStateCookie, type SidebarState } from './sidebar-state';
import { SidebarNav } from './SidebarNav';

interface SidebarContextValue {
  drawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleCollapse: () => void;
  /** True when the sidebar is CURRENTLY showing as the icon rail — the explicit `collapsed`
   *  state, or `auto` at a tablet width. Only ever called from a click handler (never during
   *  render), so reading `window.matchMedia` here is always safe. Shared by the toggle button and
   *  `SidebarNav`'s "tap a rail icon to expand" handler, rather than each re-deriving it. */
  isRailNow: () => boolean;
  /** Forces `expanded`, unconditionally — the rail-icon-tap shape, as opposed to `toggleCollapse`,
   *  which flips whichever state is current. */
  expandFromRail: () => void;
  /** The raw cookie-derived state, exposed (not just derived functions) because `SidebarNav`'s
   *  rail current-group marker (review round 2, part 2) needs to react to it changing over time —
   *  `isRailNow()` is a snapshot, correct only at the instant it's called. */
  state: SidebarState | undefined;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebarContext(): SidebarContextValue {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error('useSidebarContext must be used within SidebarProvider');
  return ctx;
}

export function SidebarProvider({
  initialState,
  children,
}: {
  initialState: SidebarState | undefined;
  children: ReactNode;
}) {
  const [state, setState] = useState<SidebarState | undefined>(initialState);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const openerRef = useRef<Element | null>(null);

  function isRailNow(): boolean {
    return state === 'collapsed' || (state === undefined && !window.matchMedia('(min-width: 1280px)').matches);
  }

  function toggleCollapse() {
    const next: SidebarState = isRailNow() ? 'expanded' : 'collapsed';
    writeSidebarStateCookie(next);
    setState(next);
  }

  function expandFromRail() {
    writeSidebarStateCookie('expanded');
    setState('expanded');
  }

  function openDrawer() {
    openerRef.current = document.activeElement;
    setDrawerOpen(true);
  }

  function closeDrawer() {
    setDrawerOpen(false);
    (openerRef.current as HTMLElement | null)?.focus?.();
  }

  return (
    <SidebarContext.Provider
      value={{ drawerOpen, openDrawer, closeDrawer, toggleCollapse, isRailNow, expandFromRail, state }}
    >
      <div data-sidebar-state={state ?? 'auto'} className="contents">
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

function Wordmark() {
  return (
    <Link href="/" className={`flex h-14 shrink-0 items-center px-4 text-sm font-semibold tracking-tight ${FOCUS_RING}`}>
      {/* T-387 S1 — the logo always shows; the 4rem rail shows ONLY the logo, since the wordmark
          text would clip there. Decorative (alt=""); the link's text is its accessible name. */}
      <img src="/brand/logo-icon.png" alt="" width={32} height={32} className="brand-logo h-8 w-8 shrink-0" />
      <span className="shell-sidebar-expanded-only ml-2 font-display text-lg font-bold">
        Shar<span className="text-brand-ink">E</span>at
      </span>
      <span className="sr-only shell-sidebar-collapsed-only">SharEat</span>
    </Link>
  );
}

/** The persistent ≥768 sidebar — rail or expanded, decided entirely by CSS off `data-sidebar-state`
 *  on the `SidebarProvider` wrapper (see globals.css). */
function PersistentSidebar({ allowedHrefs }: { allowedHrefs: readonly string[] }) {
  const { toggleCollapse, isRailNow, expandFromRail, state } = useSidebarContext();
  return (
    <div className="shell-sidebar hidden shrink-0 flex-col border-r border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950 md:sticky md:top-0 md:flex md:h-dvh">
      <Wordmark />
      <button
        type="button"
        onClick={toggleCollapse}
        aria-label="Collapse sidebar"
        className={`shell-nav-row mx-2 mb-1 flex items-center justify-center gap-2 rounded-md border border-neutral-200 text-neutral-500 hover:bg-neutral-100 dark:border-neutral-800 dark:hover:bg-neutral-900 ${FOCUS_RING}`}
      >
        <CollapseIcon className="h-4 w-4 shrink-0 shell-sidebar-collapse-icon" />
        <span className="shell-sidebar-expanded-only text-xs">Collapse</span>
      </button>
      {/* T-257/DEF-259 browser pass, 1280x800 — the scroll boundary moved IN to here from
          `.shell-sidebar` itself: at 969px of nav content in an 800px box, a sidebar-level scroll
          took the sign-out footer below the fold, reachable only by discovering the sidebar
          scrolls. `min-h-0` is required, not decorative — a flex item's default `min-height: auto`
          lets it grow to fit content and ignore `flex-1`'s shrink, which is exactly what let the
          nav push the footer out of the fixed-height column in the first place. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <SidebarNav
          allowedHrefs={allowedHrefs}
          isRailNow={isRailNow}
          expandFromRail={expandFromRail}
          explicitState={state}
        />
      </div>
      <div className="mx-2 mb-2 flex items-center justify-center border-t border-neutral-100 pt-2 dark:border-neutral-900">
        <form action={signOutAction}>
          <button
            type="submit"
            className={`shell-sidebar-expanded-only shell-nav-row rounded-md px-2 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-900 dark:hover:text-neutral-100 ${FOCUS_RING}`}
          >
            Sign out
          </button>
        </form>
        <form action={signOutAction}>
          <button
            type="submit"
            aria-label="Sign out"
            // ⚠️ `w-9` (36px) is explicit and deliberate, not left to shrink-to-fit: this button is
            // `inline-flex` (via `.shell-sidebar-collapsed-only`'s own CSS, not Tailwind's `flex`,
            // so it does not stretch to the rail's width the way the Collapse button's block-level
            // `flex` does), and an icon-only inline-flex box with no explicit width hugs its 16px
            // icon — a ~16px-wide target, not a touch target. 36px matches `.shell-nav-row`'s own
            // fine-pointer floor (`globals.css:86-88`) rather than an arbitrary number.
            className={`shell-sidebar-collapsed-only shell-nav-row w-9 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900 ${FOCUS_RING}`}
          >
            <SignOutIcon className="h-4 w-4 shrink-0" />
          </button>
        </form>
      </div>
    </div>
  );
}

/** The phone (< 768) off-canvas drawer, plus its scrim. Always in the DOM (so SSR/hydration never
 *  disagree); `hidden` below the open state and always `md:hidden` regardless of it. */
function Drawer({ allowedHrefs }: { allowedHrefs: readonly string[] }) {
  const { drawerOpen, closeDrawer } = useSidebarContext();
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus into the drawer on open; body scroll lock while open; Escape closes; Tab is trapped.
  useEffect(() => {
    if (!drawerOpen) return undefined;

    const panel = panelRef.current;
    panel?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')[0]?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // ⛔ Review round 2: re-queries the panel EVERY Tab press rather than once at open. A snapshot
    // taken here at mount goes stale the moment SidebarNav's own group toggle adds or removes
    // links from the DOM while the drawer is still open — first/last would point at nodes that no
    // longer exist (or aren't first/last any more), and Tab could walk straight out of the drawer.
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        closeDrawer();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [drawerOpen, closeDrawer]);

  return (
    <div className="md:hidden">
      {/* Scrim — always mounted, `pointer-events-none`/transparent when closed rather than
          conditionally rendered, so the closing transition (if one is ever added) has something to
          animate. Tapping it closes, per §2.3. */}
      <div
        aria-hidden="true"
        onClick={closeDrawer}
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity ${drawerOpen ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Main navigation"
        aria-hidden={!drawerOpen}
        // ⭐ Not just `aria-hidden`: while closed the panel is only translated off-screen (so the
        // transition has something to animate), and without `inert` it would still be reachable by
        // Tab and by a screen reader's virtual cursor despite being invisible. The `boolean` typing
        // for `inert` here comes from `@types/react`'s EXPERIMENTAL typings (not `index.d.ts`),
        // pulled in transitively by something in this toolchain (Next's bundled types, most
        // likely) — not a guarantee `@types/react` makes on its own. If a future dependency bump
        // ever drops that transitive pull, the symptom is a RED TYPECHECK on this exact line, not
        // a silent regression — so a failure here means "go find where the experimental typings
        // used to come from," not "delete this prop." Verified working, twice, independently (the
        // orchestrator and lane C): tsc clean, `inert=""` present in the rendered DOM, 0/40 Tab
        // stops reaching the closed drawer. Do not "fix" this a third time.
        inert={!drawerOpen}
        className={`fixed inset-y-0 left-0 z-50 flex w-[min(18rem,85vw)] flex-col bg-white shadow-xl transition-transform dark:bg-neutral-950 ${drawerOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 pl-4 pr-2 dark:border-neutral-800">
          <span className="flex items-center gap-2">
            <img src="/brand/logo-icon.png" alt="" width={32} height={32} className="brand-logo h-8 w-8 shrink-0" />
            <span className="font-display text-lg font-bold">
              Shar<span className="text-brand-ink">E</span>at
            </span>
          </span>
          <button
            type="button"
            onClick={closeDrawer}
            aria-label="Close menu"
            className={`shell-nav-row flex w-11 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900 ${FOCUS_RING}`}
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {/* The drawer is never a rail — a heading tap is always a plain accordion toggle. */}
          <SidebarNav
            allowedHrefs={allowedHrefs}
            onLinkClick={closeDrawer}
            isRailNow={() => false}
            expandFromRail={() => {}}
            explicitState="expanded"
          />
        </div>
      </div>
    </div>
  );
}

/**
 * ⭐ T-288 — `allowedHrefs` is the filtered nav, computed server-side in `AppShell` from
 * `ROUTE_CAPABILITY`. ⛔ Presentation only: a link this actor cannot see is ALSO refused by
 * `requirePageAccess` on the route itself, so hiding is never the thing doing the work.
 */
export function Sidebar({ allowedHrefs }: { allowedHrefs: readonly string[] }) {
  return (
    <>
      <PersistentSidebar allowedHrefs={allowedHrefs} />
      <Drawer allowedHrefs={allowedHrefs} />
    </>
  );
}

/** The phone top bar's ☰ — a tiny client leaf so `TopBar.tsx` itself doesn't need to import this
 *  file's context wiring beyond this one button. */
export function MenuButton() {
  const { openDrawer } = useSidebarContext();
  return (
    <button
      type="button"
      onClick={openDrawer}
      aria-label="Open menu"
      className={`shell-nav-row flex w-11 items-center justify-center rounded-md text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900 ${FOCUS_RING}`}
    >
      <MenuIcon className="h-6 w-6" />
    </button>
  );
}
