/**
 * T-234 slice 1 — the sidebar's persisted collapse state, and the pure active-link matcher.
 *
 * ⛔ **Deliberately dependency-free.** No React, no `next/navigation`, no `next/headers`. This is
 * the one module both a server file (`AppShell.tsx`, via `next/headers`'s `cookies()`) and a client
 * file (`Sidebar.tsx`/`SidebarNav.tsx`, via `document.cookie` and `usePathname()`) can import
 * without pulling the other's runtime in — and the one `apps/erp/tests/shell-active-href.test.ts`
 * statically imports, so it must stay far from the ~5s cold-import trap
 * (`reference_vitest_resetmodules_import_timeout`): no `@shareat/db`, no `@shareat/domain`, nothing
 * transitively reaching either.
 */

/** `expanded` = the full 16rem list; `collapsed` = the 4rem icon rail. Phone ignores this — it
 *  always renders the off-canvas drawer instead. */
export type SidebarState = 'expanded' | 'collapsed';

export const SIDEBAR_COOKIE_NAME = 'shareat_sidebar';

/** 7 days, in seconds — matches POS's own `sidebar_state` cookie TTL (the behaviour being copied). */
export const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

/** `undefined` means "no cookie yet" — the caller falls back to each breakpoint's own CSS default
 *  (rail on tablet, expanded on laptop) rather than a JS-guessed value, which is what keeps first
 *  paint honest. Any value that isn't exactly `'expanded'`/`'collapsed'` is treated the same way,
 *  so a corrupted or hand-edited cookie degrades to "no preference" instead of throwing. */
export function parseSidebarState(raw: string | undefined | null): SidebarState | undefined {
  return raw === 'expanded' || raw === 'collapsed' ? raw : undefined;
}

/**
 * ⚠️ Client-only, and deliberately a plain `document.cookie` write, not a Server Action round trip.
 * The cookie is **not httpOnly on purpose** (`§2.3`) — a preference with no security weight, so the
 * client toggling it directly is the correct shape, not a workaround. (Next 16's `cookies().set()`
 * is unavailable here anyway: it cannot be called during Server Component rendering, and a Client
 * Component cannot import `next/headers` at all.)
 *
 * ⭐ `Secure` (review round 2 nit): every browser that matters treats `http://localhost` as a
 * secure context for cookies specifically, so this does not break local dev — it only refuses to
 * set the cookie on a genuinely plain-HTTP origin (a raw LAN IP, say), which is exactly the
 * behaviour wanted for a cookie that will otherwise ride over production HTTPS.
 */
export function writeSidebarStateCookie(state: SidebarState): void {
  document.cookie = `${SIDEBAR_COOKIE_NAME}=${state}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}; SameSite=Lax; Secure`;
}

/**
 * A focus ring visible regardless of what is behind it — including the active link's own
 * near-black pill, where the UA default outline nearly disappears (review round 2 nit). Shared by
 * `Sidebar.tsx` and `SidebarNav.tsx` so every interactive element in the shell uses the same one.
 */
export const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500';

/**
 * The `href` from `hrefs` that is the longest match for `pathname` — `/` matches only when the
 * pathname is exactly `/`; every other href matches when the pathname equals it or continues with
 * a `/`, and the LONGEST such href wins (`/attendance` does not claim `/attendance/terminals` when
 * the longer entry exists). A query string on `pathname` is ignored. Returns `undefined` when
 * nothing matches.
 */
export function activeHref(pathname: string, hrefs: readonly string[]): string | undefined {
  const path = pathname.split('?')[0]!.replace(/\/+$/, '') || '/';

  let best: string | undefined;
  for (const href of hrefs) {
    const matches = href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`);
    if (!matches) continue;
    if (best === undefined || href.length > best.length) best = href;
  }
  return best;
}
