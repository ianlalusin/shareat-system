import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { transaction } from '@shareat/db';
import {
  resolveActor,
  AuthenticationError,
  signSetupIdentity,
  setupIdentitySignatureMatches,
  type ResolvedSession,
} from '@shareat/auth';

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

// =======================================================================================
// The first-run setup identity — T-232 §2.4. Lane E issues it; lane B's /setup consumes it.
// =======================================================================================

/**
 * ## ⭐ What this is, and what it is NOT
 *
 * `/sign-in` verifies a Firebase ID token, finds **no credential row** for that uid, finds **zero
 * organizations**, and sends the browser to `/setup`. This cookie is how the verified identity
 * survives that redirect — `{ uid, email, displayName }` plus an expiry, signed.
 *
 * ⛔ **It is not a session and it authorises nothing.** It carries a *name* that `verifyIdToken`
 * already vouched for. The only thing it unlocks is a screen whose write — `bootstrapOrganization`
 * — refuses outright once an organization exists, under an advisory lock. So a copied cookie can
 * do exactly one thing: create the first organisation, of which there is only ever one.
 * §2.4: *"the guarantee is the database, not the cookie."*
 *
 * ## Why a signed cookie rather than a table or a Map
 *
 * A table means a migration and both slices are "migration: none". An in-process `Map` dies on
 * redeploy and is wrong the moment there is a second worker. A signed cookie is stateless,
 * survives a deploy mid-setup, and carries no secret.
 *
 * ## The key
 *
 * ⛔ The HMAC is **not** computed here. `@shareat/auth`'s `signSetupIdentity` derives a key from
 * `SESSION_SECRET` under the label `'setup-identity'`, so this value can never be confused with a
 * session token hash or a PIN lookup key. Credential crypto lives in `packages/auth`; this file
 * owns the cookie and its flags, and nothing else.
 */

const SETUP_COOKIE = 'shareat_setup';

/** The 10-minute window in which a verified-but-unknown Firebase identity may create the org. */
export const SETUP_IDENTITY_TTL_MS = 10 * 60 * 1000;

export interface SetupIdentity {
  /** The Firebase uid, ALREADY verified by `verifyIdToken`. Never an unverified assertion. */
  readonly uid: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly expiresAt: Date;
}

/** The wire form. ⚠️ Readable by anyone holding the cookie — nothing secret goes in here. */
interface SetupIdentityPayload {
  uid: string;
  email: string | null;
  displayName: string | null;
  /** Epoch milliseconds. The signature covers it, so the browser cannot extend its own window. */
  exp: number;
}

/**
 * Called after verifying the ID token, finding no credential row, and finding zero organizations.
 *
 * ⚠️ `maxAge` and the payload's own `exp` both say 10 minutes, and they are not redundant: the
 * cookie attribute is a request the browser may ignore, and `exp` is the one the server enforces.
 */
export async function setSetupIdentityCookie(identity: {
  uid: string;
  email: string | null;
  displayName: string | null;
}): Promise<void> {
  const payload: SetupIdentityPayload = {
    uid: identity.uid,
    email: identity.email,
    displayName: identity.displayName,
    exp: Date.now() + SETUP_IDENTITY_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const value = `${encoded}.${signSetupIdentity(encoded)}`;

  (await cookies()).set(SETUP_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SETUP_IDENTITY_TTL_MS / 1000,
  });
}

/**
 * The verified setup identity, or `null`.
 *
 * ⚠️ **Absent, expired, malformed and TAMPERED all return `null`** — the flat-refusal idiom
 * `signInWithPin` already uses. They need the same action from the user (sign in again), so
 * distinguishing them would only tell an attacker which half of the value to keep working on.
 */
export async function readSetupIdentity(): Promise<SetupIdentity | null> {
  const raw = (await cookies()).get(SETUP_COOKIE)?.value;
  if (!raw) return null;

  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  const encoded = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);

  // ⭐ Signature FIRST, before the payload is parsed. Parsing attacker-controlled bytes that have
  // not been authenticated is how a decoder bug becomes a vulnerability.
  if (!setupIdentitySignatureMatches(encoded, signature)) return null;

  let payload: SetupIdentityPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof payload?.uid !== 'string' || !payload.uid) return null;
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
  if (payload.exp <= Date.now()) return null;

  return {
    uid: payload.uid,
    email: typeof payload.email === 'string' ? payload.email : null,
    displayName: typeof payload.displayName === 'string' ? payload.displayName : null,
    expiresAt: new Date(payload.exp),
  };
}

/**
 * ⚠️ Hygiene, not the control. `/setup`'s action clears this before opening its transaction, but
 * what actually stops a replay is `bootstrapOrganization` refusing once an organization exists.
 */
export async function clearSetupIdentityCookie(): Promise<void> {
  (await cookies()).delete(SETUP_COOKIE);
}
