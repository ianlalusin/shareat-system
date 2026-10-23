import { redirect } from 'next/navigation';
import { safeNext } from './lib';
import { TerminalSignInForm } from './TerminalSignInForm';
import { EmailSignInForm } from './EmailSignInForm';
import { TabletSignInForm } from './TabletSignInForm';
import { ForgetDeadPairing } from './ForgetDeadPairing';
import { currentSession, readPosTabletToken } from '../../lib/session';
import { resolvePosTablet } from '@shareat/auth';
import { FlashBanner } from '@/components/ui';

export const metadata = { title: 'Sign in — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  next?: string;
  error?: string;
}

/**
 * The terminal sign-in. T-304 — two layers, no pre-authentication database read at all.
 *
 * ⭐ **DEF-333 closes here, not by patching the old read.** The previous version listed every
 * store through the ordinary connection before anyone had signed in
 * (`docs/tasks/301-def-333-pre-auth-reads-under-rls.md`) — a fifth pre-authentication cross-org
 * caller bible §13 row 194's census missed, and it silently returned zero rows once production's
 * `DATABASE_URL` stopped bypassing RLS. **The fix is not to make that read work again**; it is
 * that the read no longer exists. The store is never chosen by anyone — it comes from whichever
 * terminal credential layer 1 resolves, server-side, from a token the browser cannot forge.
 *
 * Layer 1 (`TerminalSignInForm`, step 'terminal'): the store's own shared email and password —
 * the tablet, not a person. Layer 2 (same component, step 'pin'): a PIN, typed inside that
 * already-authenticated terminal context, identifying the real person. Neither layer creates a
 * `sessions` row until the PIN succeeds (invariant 2) — a terminal has not identified anybody yet.
 *
 * ⛔⛔ **Invariant 7 — the one thing that may never break.** `EmailSignInForm` below is the ADMIN
 * path and stays wired here unconditionally, whether or not a terminal credential exists in the
 * database, whether or not layer 2 errors. It is the only way back in while PIN sign-in is being
 * rebuilt, and it is the only way back in if anything here regresses later.
 */
export default async function SignInPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;

  // Already signed in? Nothing to do here.
  // ⚠️ `safeNext` and not an inline check: this line accepted `next=//evil.com` until T-232's review
  // found it, because `startsWith('/')` is true of a protocol-relative URL. One rule, one place.
  const existing = await currentSession();
  if (existing) redirect(safeNext(sp.next ?? ''));

  // T-464 - a PAIRED POS tablet shows Employee ID + PIN only. The pairing is resolved from the httpOnly cookie on the server, on every
  // load (so a revoke bites at once); a cookie that names nothing live is forgotten and the page is today's, unchanged.
  const tabletToken = await readPosTabletToken();
  const pairing = tabletToken ? await resolvePosTablet(null, tabletToken) : null;

  if (pairing) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-8">
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold">Sign in</h1>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">Your Employee ID and PIN.</p>
          </div>
          <FlashBanner flash={sp} />
          <TabletSignInForm next={sp.next ?? ''} label={pairing.label} />
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-8">
      <div className="space-y-6">
        {tabletToken && <ForgetDeadPairing />}
        <div>
          <h1 className="text-2xl font-semibold">Sign in</h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            A terminal, then a PIN — or your own email and password.
          </p>
        </div>

        <FlashBanner flash={sp} />

        <TerminalSignInForm next={sp.next ?? ''} />

        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
              or
            </span>
            <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
          </div>
          <EmailSignInForm next={sp.next ?? ''} />
        </div>
      </div>
    </main>
  );
}
