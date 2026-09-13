'use client';

/**
 * The terminal's two-layer sign-in. T-304, docs/tasks/304-two-layer-terminal-sign-in.md.
 *
 * Layer 1: the store's shared email and password (Firebase) — the tablet, not a person.
 * Layer 2: a PIN, typed inside that authenticated terminal context — a person, not the tablet.
 *
 * ⭐ **No store is ever chosen here, by anyone.** DEF-333 was the pre-authentication store list;
 * this form replaces it with a store the SERVER derives from the terminal's own credential, never
 * from anything the browser sends (invariant 5, invariant 9 — no tenancy id reaches the client in
 * any form).
 *
 * ⛔ **The Firebase ID token is NOT cached across the two steps in this component's state.** Layer
 * 2 re-fetches it fresh from `auth.currentUser` at submission time and the server re-resolves the
 * terminal from it on every PIN attempt (orchestrator's carrier ruling, 2026-09-13) — a stale
 * cached token here would silently defeat that: the whole point is that revoking the terminal's
 * credential between layer 1 and a later PIN attempt must take effect on that very next attempt,
 * not merely on the next full sign-in.
 */
import { useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { signInFirebase, prepareSignInPersistence } from './firebase-client';
import { verifyTerminalAction, signInWithTerminalPinAction } from './actions';

function firebaseSignInMessage(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
  if (code === 'auth/too-many-requests') {
    return 'Too many attempts. Firebase has paused sign-in for this device for a few minutes — wait, then try again.';
  }
  if (code === 'auth/network-request-failed') {
    return 'Could not reach the sign-in service. Check the connection and try again.';
  }
  if (code === 'auth/invalid-email') return 'That does not look like an email address.';
  return 'Wrong email or password.';
}

/** Same idiom `EmailSignInForm` uses — see that file for why the digest prefix is matched rather
 *  than a helper import. */
function isRedirectError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('digest' in err)) return false;
  const { digest } = err as { digest?: unknown };
  return typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT');
}

type Step = 'terminal' | 'pin';

export function TerminalSignInForm({ next }: { next: string }) {
  const [step, setStep] = useState<Step>('terminal');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onTerminalSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    let idToken: string;
    try {
      const { auth } = signInFirebase();
      await prepareSignInPersistence(auth);
      const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
      idToken = await credential.user.getIdToken();
    } catch (err) {
      setError(firebaseSignInMessage(err));
      setBusy(false);
      return;
    }

    const outcome = await verifyTerminalAction(idToken);
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    setStep('pin');
  }

  async function onPinSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    let idToken: string;
    try {
      const { auth } = signInFirebase();
      const user = auth.currentUser;
      if (!user) {
        // The Firebase session ended underneath this component (a token expired, a tab was
        // restored) — back to layer 1 rather than submitting a PIN with nothing behind it.
        setStep('terminal');
        setError('Your terminal sign-in expired. Sign in again.');
        setBusy(false);
        return;
      }
      // ⭐ Fresh, not the one layer 1 obtained — see the header. `getIdToken()` with no argument
      // returns the cached token when it still has life left, so this is not a network round trip
      // on the ordinary path.
      idToken = await user.getIdToken();
    } catch (err) {
      setError(firebaseSignInMessage(err));
      setBusy(false);
      return;
    }

    const fd = new FormData();
    fd.set('idToken', idToken);
    fd.set('pin', pin);
    fd.set('next', next);

    try {
      await signInWithTerminalPinAction(fd);
    } catch (err) {
      if (isRedirectError(err)) throw err;
      setError('Could not reach the server to finish signing in. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (step === 'terminal') {
    return (
      <form onSubmit={onTerminalSubmit} className="space-y-4 text-sm">
        {error && (
          <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
            {error}
          </div>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Terminal email
          </span>
          <input
            name="email"
            type="email"
            inputMode="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="store@example.com"
            className="rounded border border-neutral-300 bg-white px-3 py-3 dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Terminal password
          </span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded border border-neutral-300 bg-white px-3 py-3 dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-neutral-900 px-4 py-3 font-medium text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          {busy ? 'Connecting…' : 'Connect this terminal'}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={onPinSubmit} className="space-y-4 text-sm">
      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">PIN</span>
        <input
          name="pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          placeholder="••••••"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          // Touch-first: a cashier enters this on a tablet, so the target is large and the keypad
          // is numeric.
          className="rounded border border-neutral-300 bg-white px-3 py-3 text-center text-2xl tracking-[0.5em] tabular-nums dark:border-neutral-700 dark:bg-neutral-950"
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded bg-neutral-900 px-4 py-3 font-medium text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        <strong>Forgot your PIN?</strong> Ask an admin to issue you a new one. PINs cannot be
        looked up — a new one is the only way back in.
      </p>
    </form>
  );
}
