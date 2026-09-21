import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import './globals.css';
import { AppShell } from '../components/shell/AppShell';
import { THEME_COOKIE_NAME, parseTheme } from '../components/shell/theme-state';

export const metadata: Metadata = {
  title: 'Shareat System',
  description: 'Shareat ERP — correct books, simply modelled',
};

/**
 * ⭐ **T-334 slice 1 — the theme is resolved HERE and not in `AppShell`, and that is deliberate.**
 *
 * ADR-013 says to reuse the `data-sidebar-state` pattern, and this reuses its *shape* — a cookie
 * read on the server, written onto a DOM attribute, with CSS doing the rest. ⛔ **It cannot reuse
 * its *placement*.** The sidebar attribute is written on a `div` inside `AppShell`, and `AppShell`
 * returns `<>{children}</>` early for a kiosk request or anyone without a session — so `/sign-in`,
 * the first screen anybody sees, never reaches it. The theme attribute has to be on `<html>`, which
 * lives here.
 *
 * Two consequences, both wanted:
 *   1. ⭐ Sign-in and kiosk screens get themed too; they are currently outside the shell entirely.
 *   2. ⚠️ This component becomes `async` and therefore dynamic. **Nothing is lost** — as the note
 *      below has always recorded, every page under it is already dynamic because each one reads
 *      the session. (Confirmed at review: every route still builds as `ƒ (Dynamic)`.)
 *
 * ⛔ **ONE SCREEN IS STILL OUTSIDE THIS, AND SAYING "every screen" WOULD BE FALSE.**
 * `global-error.tsx` renders its own `<html>` and therefore never receives `data-theme`. Harmless
 * while light is the default and the only theme anyone can be in — ⚠️ **but once the toggle slice
 * ships, a dark-mode user hitting a root-layout crash gets a LIGHT error page**, with that file's
 * own `dark:` classes never firing. It is a client error boundary and cannot read cookies, so it
 * needs its own answer in the toggle slice. (Found by review.)
 *
 * ⛔ **Why a cookie rather than `prefers-color-scheme`:** the value must be correct in the FIRST
 * server-rendered paint, before any JS runs, or the "no flash, no layout shift" invariant breaks.
 * A media query cannot be read on the server, and an effect runs too late — the user would see the
 * wrong theme first. `parseTheme` defaults to `light`, so a viewer with no cookie gets light
 * whatever their operating system prefers, which is the entire point of the ruling.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const theme = parseTheme(cookieStore.get(THEME_COOKIE_NAME)?.value);

  return (
    <html lang="en" data-theme={theme}>
      <body>
        {/* ⚠️ Reads the session, so every page under it is dynamic. That is already true of every
            screen in this app — each one calls `requireSession` — so nothing was static to lose. */}
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
