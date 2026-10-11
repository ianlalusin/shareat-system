'use client';

/**
 * T-234 slice 1 — the grouped link list, shared by the persistent sidebar (rail/expanded) and the
 * phone drawer; the caller decides which container it sits in and how that container is shown.
 *
 * ⭐ Not split into a separate "active-link-only" client leaf. The spec's original shape put
 * `usePathname` in a tiny client leaf under an otherwise server-rendered list, but the group
 * open/closed toggle already needs component state at this level ("a heading toggles its
 * section") — so the RSC-purity gain of splitting further is close to zero here, and one file is
 * easier to keep correct than two. `activeHref` itself stays in `sidebar-state.ts`, framework-free,
 * so the unit test never needs this file's `usePathname`/React Client Component weight at all.
 *
 * ⛔ **Review round 2 fix — the rail (768–1279, and the ≥1280 collapsed state) was not a rail.**
 * Every label and the whole open sublist rendered at full length inside the 4rem column, wrapped
 * and clipped (screenshot `rail-768.png` — 64px `.shell-sidebar` was correctly narrow, but nothing
 * inside it was actually hidden; `.shell-sidebar-expanded-only` had only ever been applied to the
 * PersistentSidebar's own "Collapse" caption). Now applied to the group label, the chevron, and
 * the ENTIRE open sublist — a rail shows six icon buttons and nothing else, full stop, regardless
 * of which group's `open` state happens to be true.
 *
 * `isRailNow`/`expandFromRail` come in as props, not via `useSidebarContext` — `Sidebar.tsx`
 * already imports THIS file, so importing back from it would be a circular module dependency;
 * passing the two functions down is one prop wider and avoids that entirely.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { GROUPS } from '../nav';
import { ChevronIcon, GROUP_ICONS } from './icons';
import { FOCUS_RING, activeHref, type SidebarState } from './sidebar-state';

function groupContaining(
  groups: { label: string; links: { href: string }[] }[],
  href: string | undefined,
): string | undefined {
  if (!href) return undefined;
  return groups.find((g) => g.links.some((l) => l.href === href))?.label;
}

/**
 * Review round 2, part 2 — hiding the whole sublist at rail width means the active LINK's
 * `aria-current="page"` is removed from the accessibility tree along with it, so a rail had zero
 * "you are here" at all: six identical icons, nothing marking which one. This tracks whether the
 * sidebar is ACTUALLY showing as a rail right now, reactively — `Sidebar.tsx`'s `isRailNow()` is
 * only a click-time snapshot, correct for a toggle handler but not something a render can read
 * continuously. Starts `false` so the server render and the first client render agree (no
 * hydration mismatch); the effect corrects it immediately after mount and on every resize/toggle.
 */
function useIsRailReactive(explicitState: SidebarState | undefined): boolean {
  const [narrowViewport, setNarrowViewport] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1279px)');
    const update = () => setNarrowViewport(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return explicitState === 'collapsed' || (explicitState === undefined && narrowViewport);
}

export function SidebarNav({
  allowedHrefs,
  onLinkClick,
  isRailNow,
  expandFromRail,
  explicitState,
}: {
  /**
   * ⭐ T-288 — the hrefs this actor may be SHOWN, computed server-side in `AppShell` from
   * `ROUTE_CAPABILITY`. ⛔ Presentation only. The same map drives `requirePageAccess`, which is
   * what actually refuses the route, so a hidden link is never the control (DEF-051).
   */
  allowedHrefs: readonly string[];
  onLinkClick?: () => void;
  isRailNow: () => boolean;
  expandFromRail: () => void;
  /** The raw cookie-derived state from `SidebarProvider` — `undefined` (`auto`) resolves against
   *  viewport width same as everywhere else in the shell; the `Drawer` instance passes the fixed
   *  literal `'expanded'`, since the drawer is never a rail regardless of any cookie. */
  explicitState: SidebarState | undefined;
}) {
  const pathname = usePathname();
  /**
   * ⭐ T-288 — the nav this actor actually sees. A group whose every link is filtered away is
   * dropped entirely rather than rendered as an empty heading that opens to nothing.
   *
   * ⚠️ `allHrefs` below is derived from the FILTERED groups on purpose. `activeHref` resolves
   * "you are here" by longest matching prefix, so leaving hidden routes in that list would let a
   * link the actor cannot see win the match and highlight a group that is not on screen.
   */
  const visibleGroups = GROUPS.map((g) => ({
    ...g,
    links: g.links.filter((l) => allowedHrefs.includes(l.href)),
  })).filter((g) => g.links.length > 0);
  const allHrefs = visibleGroups.flatMap((g) => g.links.map((l) => l.href));
  const current = activeHref(pathname, allHrefs);
  const currentGroup = groupContaining(visibleGroups, current);
  const isRailReactive = useIsRailReactive(explicitState);

  // ⭐ Seeded from the current route on first render, then kept true across client-side
  // navigations by the effect below — without it, "the current group is open" would only ever be
  // true on the page the sidebar first mounted on. Manually opened OTHER groups are never closed
  // by this — only ever added to, per §2.3 ("the open/closed set is component state only").
  //
  // ⚠️ Review round 2 nit, left as-is on purpose: `PersistentSidebar` and `Drawer` each mount their
  // own `SidebarNav`, so each has its OWN `openGroups` — resizing across the 768 breakpoint can
  // show a different open group than the one just touched. Lifting this into `SidebarProvider`
  // would fix it, but only for someone actively dragging a browser window across that exact width,
  // which is nobody on a touch device — not worth the extra state-sharing surface for this slice.
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () => new Set(currentGroup ? [currentGroup] : []),
  );
  useEffect(() => {
    if (!currentGroup) return;
    setOpenGroups((prev) => (prev.has(currentGroup) ? prev : new Set(prev).add(currentGroup)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentGroup]);

  /** §2.3: "tapping a group icon on the rail expands it with that group open." On a rail, a
   *  heading click has to do two things at once — leave the rail (the shared sidebar state, up in
   *  `Sidebar.tsx`) AND open this specific group (local state, right here) — so this is the one
   *  place both need to be reachable from a single click. Already expanded, it is an ordinary
   *  accordion toggle. */
  function onHeadingClick(label: string) {
    if (isRailNow()) {
      expandFromRail();
      setOpenGroups((prev) => (prev.has(label) ? prev : new Set(prev).add(label)));
      return;
    }
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  return (
    <nav aria-label="Main" className="flex flex-col gap-1 overflow-y-auto px-2 py-2">
      {visibleGroups.map((group) => {
        const Icon = GROUP_ICONS[group.icon];
        const open = openGroups.has(group.label);
        // The rail's own "you are here" — live only while the rail is actually what's showing, so
        // it never doubles up with the link's own `aria-current="page"` at expanded/drawer widths.
        const isCurrentOnRail = group.label === currentGroup && isRailReactive;
        return (
          <div key={group.label} className="flex flex-col">
            <button
              type="button"
              onClick={() => onHeadingClick(group.label)}
              // ⛔ Review round 2, part 3: the same disagreement as the marker fix, one attribute
              // over — `open` can be true (the current group auto-opens) while the rail is what's
              // actually showing, and the sublist it names is `display:none`, not in the tree at
              // all. `aria-expanded` must describe what's REALLY expanded, not the stored intent
              // for when the sidebar isn't a rail — same `isRailReactive` source of truth as the
              // marker above, so the two attributes can never independently drift again.
              aria-expanded={isRailReactive ? false : open}
              aria-label={group.label}
              aria-current={isCurrentOnRail ? 'true' : undefined}
              className={`shell-nav-row flex items-center gap-2 rounded-md px-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400 hover:bg-neutral-100 aria-[current=true]:bg-brand aria-[current=true]:text-white dark:hover:bg-neutral-900 ${FOCUS_RING}`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="shell-sidebar-expanded-only flex-1 text-left">{group.label}</span>
              <ChevronIcon
                className={`shell-sidebar-expanded-only h-3.5 w-3.5 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}
              />
            </button>
            {open && (
              <ul className="shell-sidebar-expanded-only ml-2 flex flex-col gap-0.5 border-l border-neutral-200 pl-4 dark:border-neutral-800">
                {group.links.map((link) => {
                  const isActive = link.href === current;
                  return (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        aria-current={isActive ? 'page' : undefined}
                        onClick={onLinkClick}
                        className={`shell-nav-row flex items-center rounded-md px-2 text-sm text-neutral-600 aria-[current=page]:bg-brand aria-[current=page]:font-medium aria-[current=page]:text-white hover:bg-neutral-100 aria-[current=page]:hover:bg-brand-hover dark:text-neutral-400 dark:hover:bg-neutral-900 dark:aria-[current=page]:text-white ${FOCUS_RING}`}
                      >
                        {link.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}
