/**
 * T-334 slice 1 — the theme preference, resolved server-side so the FIRST PAINT is already right.
 *
 * ⭐ **The defect this exists to fix (ADR-013, Ian 2026-09-19):** v2 follows the operating system
 * into dark mode and v1 never did. `tailwind.config.ts` declared no `darkMode` key at all, so
 * Tailwind sat on its default `media` strategy — nobody chose OS-following, it was inherited by
 * omission. A viewer with no cookie now gets **light**, whatever their OS says.
 *
 * ⛔ **Deliberately dependency-free**, exactly like `sidebar-state.ts` (T-234): no React, no
 * `next/navigation`, no `next/headers`. This is the one module both a server file (`layout.tsx`,
 * via `cookies()`) and a client file (the toggle, later) can import without dragging the other's
 * runtime in — and it is statically imported by a unit test, so it must stay far from anything
 * transitively reaching `@shareat/db` or `@shareat/domain`.
 *
 * ⚠️ **Why a cookie and not `prefers-color-scheme`:** the value has to be correct in the first
 * server-rendered paint, before any JS runs, or the "no flash, no layout shift" invariant breaks —
 * the same reason `AppShell` reads the sidebar cookie server-side rather than measuring in an
 * effect. A media query cannot be read on the server.
 */

/**
 * ⛔ Exactly two values. There is deliberately **no `auto`/`system`** — that would reintroduce
 * OS-following through the back door, which is the whole defect.
 */
export type Theme = 'light' | 'dark';

export const THEME_COOKIE_NAME = 'shareat_theme';

/**
 * ⭐ **Anything that is not exactly `'dark'` resolves to `'light'`** — absent cookie, empty string,
 * wrong case, a stale value from some future experiment, or a hand-edited one.
 *
 * ⛔ **The fallback DIRECTION is the ruling, not a detail.** A corrupted cookie degrades toward the
 * mode the user is guaranteed to be able to read, never toward the one this task exists to stop
 * happening by accident. Unlike `parseSidebarState`, this never returns `undefined`: there is no
 * "no preference" state to fall back to, because the whole point of the ruling is that the absence
 * of a preference has exactly one answer.
 */
export function parseTheme(raw: string | undefined | null): Theme {
  return raw === 'dark' ? 'dark' : 'light';
}

/*
 * ⛔ **THE COOKIE WRITER IS DELIBERATELY NOT HERE.** Slice 1 ships the MECHANISM and the DEFAULT:
 * the cookie is READ, never written.
 *
 * ⭐ A `writeThemeCookie` was drafted here and removed when the production-caller ratchet (T-295)
 * correctly flagged it as an export nothing reaches — **DEF-129's shape, and the guard doing its
 * job on its own author.** It ships with the toggle that calls it, in a later slice, together with
 * the `THEME_COOKIE_MAX_AGE` whose only consumer it is. Copy `writeSidebarStateCookie`'s shape
 * then: a plain `document.cookie` write, not a Server Action, and not httpOnly — a display
 * preference carries no security weight, so the client owning it is correct rather than a
 * shortcut.
 *
 * ⚠️ Until that slice, the theme is settable only by a cookie set out of band. That is enough to
 * drive the §9.4 screen check in both modes, and it is why slice 1 can ship without a control.
 */
