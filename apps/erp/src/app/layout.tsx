import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import localFont from 'next/font/local';
import './globals.css';
import { AppShell } from '../components/shell/AppShell';
import { Toaster } from '../components/feedback/Toaster';
import { TooltipLayer } from '@/components/ui/TooltipLayer';
import { readToastFlash } from '../lib/flash-toast';
import { THEME_COOKIE_NAME, parseTheme } from '../components/shell/theme-state';

// T-496 — fonts are committed woff2 files (./fonts); the build never calls Google. Latin subset, variable weight.
const fontDisplay = localFont({
  src: './fonts/baloo-2-latin-wght-normal.woff2',
  weight: '400 800',
  variable: '--font-display',
  display: 'swap',
});
const fontBody = localFont({
  src: './fonts/plus-jakarta-sans-latin-wght-normal.woff2',
  weight: '200 800',
  variable: '--font-body',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'SharEat ERP',
  description: 'Shareat ERP — correct books, simply modelled',
  icons: {
    icon: [{ url: '/brand/favicon.ico' }, { url: '/brand/favicon-32.png', sizes: '32x32', type: 'image/png' }],
    apple: [{ url: '/brand/apple-touch-icon.png' }],
  },
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
 * `global-error.tsx` renders its own `<html>` and therefore never receives `data-theme` or the font
 * variables. T-387 S1 gives it inline light canvas/ink colours so it is readable on its own, but it
 * is a client error boundary and cannot read the cookie: a dark-mode user hitting a root-layout
 * crash still gets a LIGHT error page. That gap is documented there and is accepted.
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
  const toast = await readToastFlash();

  return (
    <html lang="en" data-theme={theme} className={`${fontDisplay.variable} ${fontBody.variable}`}>
      <body>
        {/* ⚠️ Reads the session, so every page under it is dynamic. That is already true of every
            screen in this app — each one calls `requireSession` — so nothing was static to lose. */}
        <AppShell>{children}</AppShell>
        {/* T-387 S4: outside AppShell on purpose (L13) - sign-in and the kiosk get bare children and still need toasts. */}
        <Toaster token={toast?.token} ok={toast?.ok} stamp={toast?.stamp} />
        <TooltipLayer />
      </body>
    </html>
  );
}
