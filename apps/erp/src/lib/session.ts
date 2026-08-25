import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { transaction } from '@shareat/db';
import { resolveActor, AuthenticationError, type ResolvedSession } from '@shareat/auth';

/**
 * The request boundary. **The only place `apps/erp` turns a browser request into an `Actor`.**
 * docs/tasks/138-identity-and-sessions.md, bible §7.1.
 *
 * ⭐ Everything above this line asks *"who is signed in?"* and gets an answer or a redirect.
 * Nothing anywhere asks the browser who it is — that is invariant 1, and
 * `tests/unit/no-client-supplied-actor.test.ts` holds it closed repo-wide.
 *
 * ## Cookie flags, and why each one
 *
 * - **`httpOnly`** — script cannot read it, so an XSS bug cannot become a stolen session.
 * - **`sameSite: 'lax'`** — a cross-site POST cannot carry it, which is CSRF defence that costs
 *   nothing. `strict` would break returning from an external sign-in link; `lax` is the right
 *   trade for a back-office app.
 * - **`secure` in production only** — required over HTTPS, and omitted on `localhost` because
 *   otherwise the cookie silently never sets in development and the failure looks like a bug in
 *   the sign-in code.
 * - **`path: '/'`** — one session for the whole app.
 */

const COOKIE = 'shareat_session';

function cookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  };
}

/** Called by the sign-in action after `signInWithPin` / `signInWithFirebase` mints a token. */
export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(COOKIE, token, cookieOptions(expiresAt));
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

export async function readSessionToken(): Promise<string | null> {
  return (await cookies()).get(COOKIE)?.value ?? null;
}

/**
 * The signed-in session, or `null`.
 *
 * ⚠️ **An expired session and an absent one return the same thing**, because they need the same
 * action from the user. v1 reached the same conclusion the hard way: *"a missing cookie now means
 * re-authenticate, not 'trust me'."*
 */
export async function currentSession(): Promise<ResolvedSession | null> {
  const token = await readSessionToken();
  if (!token) return null;
  try {
    return await transaction((tx) => resolveActor(tx, token));
  } catch (err) {
    if (err instanceof AuthenticationError) return null;
    throw err;
  }
}

/**
 * The session, or a redirect to sign in. **Use this in every page and action that acts.**
 *
 * ⚠️ It redirects rather than returning null on purpose: a caller that has to remember to check
 * is a caller that will one day forget, and forgetting here means acting as nobody.
 */
export async function requireSession(returnTo?: string): Promise<ResolvedSession> {
  const session = await currentSession();
  if (!session) {
    const qs = returnTo ? `?next=${encodeURIComponent(returnTo)}` : '';
    redirect(`/sign-in${qs}`);
  }
  return session;
}

/** Shorthand for the common case — the actor alone. */
export async function requireActor(returnTo?: string) {
  return (await requireSession(returnTo)).actor;
}
