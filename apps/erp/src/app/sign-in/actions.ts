'use server';

/**
 * Sign in and out. docs/tasks/138-identity-and-sessions.md.
 *
 * ⭐ **Note what this file does NOT read from the form: a person.** The browser supplies a store
 * and a PIN — a *credential* — and the server decides who that is. That is the entire difference
 * from the "acting as" picker it replaces, and `tests/unit/no-client-supplied-actor.test.ts`
 * enforces it repo-wide.
 */
import { redirect } from 'next/navigation';
import { signInWithPin, signOut, AuthenticationError } from '@shareat/auth';
import { transaction } from '@shareat/db';
import { setSessionCookie, clearSessionCookie, readSessionToken } from '../../lib/session';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** Where to land after signing in. ⚠️ Only ever a path on this app — an open redirect turns a
 *  sign-in page into a phishing tool, and `next` comes from the URL. */
function safeNext(raw: string): string {
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/sales-days';
  return raw;
}

export async function signInAction(formData: FormData): Promise<void> {
  const storeId = str(formData, 'storeId');
  const pin = str(formData, 'pin');
  const next = safeNext(str(formData, 'next'));

  let redirectTo: string;
  try {
    if (!storeId) throw new AuthenticationError('Choose a store first.');
    const result = await transaction((tx) => signInWithPin(tx, { storeId, pin }));
    await setSessionCookie(result.token, result.expiresAt);
    redirectTo = next;
  } catch (err) {
    // ⚠️ The message is whatever the domain said, and the domain says the SAME thing for a wrong
    // PIN and an unknown one. Nothing is added here that would distinguish them.
    const message = err instanceof Error ? err.message : 'Sign-in failed.';
    redirect(`/sign-in?next=${encodeURIComponent(next)}&error=${encodeURIComponent(message)}`);
  }
  redirect(redirectTo);
}

export async function signOutAction(): Promise<void> {
  const token = await readSessionToken();
  if (token) {
    // End the SERVER session first. Clearing only the cookie would leave a live token that a
    // copy of it could still use — the browser forgetting is not the session ending.
    await transaction((tx) => signOut(tx, token));
  }
  await clearSessionCookie();
  redirect('/sign-in');
}
