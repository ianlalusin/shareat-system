'use client';

/**
 * The clock terminal. T-184. `docs/tasks/184-offline-clock-terminal.md`.
 *
 * ⛔⛔ **NOTHING ON THIS PATH MAY TOUCH THE SERVER.** Bible §5.2, binding: *"the clock terminal
 * reads and writes Firestore via the client SDK, never via Server Actions. A Server Action cannot
 * function offline."*
 *
 * ⭐ That rule has been true in prose since Phase 0 and had never once been checked.
 * `apps/erp/tests/clock-route-is-client-only.test.ts` now **fails the build** if anything reachable
 * from here imports a Server Action, `next/headers`, `@shareat/db` or `@shareat/domain` — because a
 * rule nothing enforces is a comment.
 *
 * ⚠️ There is no dead-letter here, and there is nowhere for a punch to go and die: it is in
 * Firestore or it was never written. Landmine #14 is closed at the source, not at the screen.
 */
import { useEffect, useRef, useState } from 'react';
import { signInWithCustomToken, onAuthStateChanged, type User } from 'firebase/auth';
import { disableNetwork, enableNetwork } from 'firebase/firestore';
import { requestPersistentStorage, terminalFirebase } from '../../lib/terminal/firebase';
import {
  resolveScan,
  watchMirrors,
  watchPending,
  writePunch,
  type MirroredConfig,
  type MirroredCredential,
  type MirroredRoster,
  type PunchIntent,
} from '../../lib/terminal/lane';

interface Claims {
  deviceId: string;
  storeId: string;
}

export default function ClockTerminalPage() {
  const [user, setUser] = useState<User | null>(null);
  const [claims, setClaims] = useState<Claims | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [durable, setDurable] = useState<boolean | null>(null);

  const [roster, setRoster] = useState<MirroredRoster[]>([]);
  const [config, setConfig] = useState<MirroredConfig | null>(null);
  const [credentials, setCredentials] = useState<MirroredCredential[]>([]);
  const [mirrorError, setMirrorError] = useState<string | null>(null);

  const [scan, setScan] = useState('');
  const [intent, setIntent] = useState<PunchIntent>('in');
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [pending, setPending] = useState<{ pending: number; fromCache: boolean } | null>(null);
  const [online, setOnline] = useState(true);
  const scanBox = useRef<HTMLInputElement>(null);

  // ── Identity ────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const { auth } = terminalFirebase();
    return onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (!u) return setClaims(null);
      const token = await u.getIdTokenResult();
      // ⭐ The device principal, proved by a claim this server minted (T-159). The same `deviceId`
      // travels from the token to the rules to the document to the Postgres row.
      setClaims({
        deviceId: String(token.claims.deviceId ?? ''),
        storeId: String(token.claims.storeId ?? ''),
      });
    });
  }, []);

  useEffect(() => {
    void requestPersistentStorage().then(setDurable);
  }, []);

  useEffect(() => {
    const sync = () => setOnline(typeof navigator === 'undefined' ? true : navigator.onLine);
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  // ── The mirrors ─────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!claims?.storeId) return;
    const { db } = terminalFirebase();
    return watchMirrors(db, claims.storeId, {
      roster: setRoster,
      config: setConfig,
      credentials: setCredentials,
      error: setMirrorError,
    });
  }, [claims?.storeId]);

  /**
   * ⭐ A LIVE subscription, not a poll. A punch being acknowledged changes no document data — only
   * its metadata — so this is the only way the number ever reaches zero on its own.
   */
  useEffect(() => {
    if (!claims?.deviceId) return;
    const { db } = terminalFirebase();
    return watchPending(db, claims.deviceId, setPending);
  }, [claims?.deviceId]);

  // ── Pairing ─────────────────────────────────────────────────────────────────────────
  async function pair(formData: FormData) {
    const token = String(formData.get('token') ?? '').trim();
    if (!token) return setPairError('Paste the pairing token from the provisioning screen.');
    setPairError(null);
    try {
      const { auth } = terminalFirebase();
      await signInWithCustomToken(auth, token);
    } catch (err) {
      // ⚠️ T-180 finding 3: a device CANNOT begin authenticating offline. Saying so plainly is the
      // difference between "this terminal is broken" and "plug it in for ten seconds".
      setPairError(
        `Pairing failed. A terminal must sign in ONCE while online before it can work offline — ` +
          `check the connection and try again. (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  // ── The punch ───────────────────────────────────────────────────────────────────────
  async function submitScan(e: React.FormEvent) {
    e.preventDefault();
    if (!claims) return;
    const value = scan.trim();
    if (!value) return;

    const credential = resolveScan(credentials, value);
    if (!credential) {
      /**
       * ⭐ Refused HERE, on the device, rather than written and left to quarantine.
       *
       * ⚠️ This is a deliberate exception to "the server decides". The server still decides *whose*
       * badge it is — the punch carries the credential, never a person. What the device decides is
       * that this scan matches nothing it has ever heard of, and the honest response to that is to
       * tell the person standing there, not to accept a punch that will quietly fail hours later.
       */
      setMessage({
        tone: 'bad',
        text: 'That badge is not recognised at this store. It may not be enrolled yet — see a manager.',
      });
      setScan('');
      return;
    }

    const method = credential.kind === 'card' ? 'qr' : 'fingerprint';
    if (credential.kind === 'card' && config && !config.credentialNfc) {
      setMessage({ tone: 'bad', text: 'Card clock-in is switched off for this store.' });
      setScan('');
      return;
    }

    try {
      const { db } = terminalFirebase();
      const { acknowledged } = writePunch({
        db,
        deviceId: claims.deviceId,
        storeId: claims.storeId,
        credentialKind: credential.kind,
        credentialRef: value,
        method,
        assertedIntent: intent,
      });

      /**
       * ⛔ NOT awaited, and that is the whole point — see `writePunch`. Offline, the promise does
       * not settle until the server acknowledges, so awaiting it here would leave the staffer
       * staring at a screen that never responds while their punch sat safely in IndexedDB.
       *
       * ⚠️ A later failure is still surfaced, just not blocked on: this is the only place a rules
       * refusal can appear, and it may arrive minutes after the tap.
       */
      void acknowledged.catch((err: unknown) => {
        setMessage({ tone: 'bad', text: `That punch was refused by the server: ${String(err)}` });
      });

      const who = roster.find((r) => r.employmentId === credential.employmentId);
      setMessage({
        tone: 'ok',
        text: `${who?.displayName ?? 'Recorded'} — clocked ${intent === 'in' ? 'in' : 'out'}${
          online ? '' : ' (saved on this device; it will sync when the network is back)'
        }.`,
      });
      setScan('');
    } catch (err) {
      setMessage({ tone: 'bad', text: `Could not record that: ${String(err)}` });
    } finally {
      scanBox.current?.focus();
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────────────
  if (!user || !claims?.deviceId) {
    return (
      <main className="mx-auto max-w-md space-y-5 p-6">
        <div>
          <h1 className="text-2xl font-semibold">Pair this terminal</h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Paste the pairing token from the provisioning screen. ⚠️ This has to happen{' '}
            <strong>while the tablet is online</strong> — a device cannot start authenticating
            offline, and it will not be able to record anything until this succeeds once.
          </p>
        </div>
        {pairError && (
          <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
            {pairError}
          </p>
        )}
        <form action={pair} className="space-y-3">
          <textarea
            name="token"
            rows={4}
            placeholder="Pairing token"
            className="w-full rounded border border-neutral-300 p-3 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            type="submit"
            className="w-full rounded bg-neutral-900 px-4 py-3 text-base font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
          >
            Pair
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Clock in / out</h1>
        {/* ⭐ Offline is a NORMAL state here, not an error — the whole design assumes it. */}
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium ${
            online
              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
              : 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300'
          }`}
        >
          {online ? 'Online' : 'Offline — punches are saved here'}
        </span>
      </div>

      {/* ⭐ The number that tells a cashier whether their clock-in is SAFE. v1's equivalent is a
          banner reading "N failed — tell a manager", with nothing behind it to open. */}
      <p className="text-xs text-neutral-600 dark:text-neutral-400">
        {pending === null
          ? 'Checking what is waiting…'
          : pending.pending === 0
            ? 'Everything on this device has synced.'
            : `${pending.pending} punch${pending.pending === 1 ? '' : 'es'} waiting to sync${
                pending.fromCache ? ' (counted on this device)' : ''
              }.`}
        {durable === false && ' · ⚠️ This browser would not promise to keep offline data.'}
      </p>

      {mirrorError && (
        <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          {mirrorError}
        </p>
      )}

      <div className="flex gap-2">
        {(['in', 'out'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setIntent(k)}
            className={`flex-1 rounded px-4 py-3 text-base font-medium ${
              intent === k
                ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                : 'border border-neutral-300 dark:border-neutral-700'
            }`}
          >
            Clock {k}
          </button>
        ))}
      </div>

      {/* ⚠️ A plain text box on purpose: a USB badge reader and a QR scanner both TYPE. That is how
          the hardware actually behaves, so this is the real interface, not a placeholder for one. */}
      <form onSubmit={submitScan} className="space-y-3">
        <input
          ref={scanBox}
          value={scan}
          onChange={(e) => setScan(e.target.value)}
          autoFocus
          placeholder="Scan or tap your badge"
          className="w-full rounded border border-neutral-300 p-4 text-center text-lg dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          className="w-full rounded bg-neutral-900 px-4 py-3 text-base font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
        >
          Record
        </button>
      </form>

      {message && (
        <p
          className={`rounded-lg border p-3 text-sm ${
            message.tone === 'ok'
              ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
              : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
          }`}
        >
          {message.text}
        </p>
      )}

      <p className="text-xs text-neutral-500 dark:text-neutral-500">
        {roster.length} on the roster · {credentials.length} badge
        {credentials.length === 1 ? '' : 's'} known here
        {config ? '' : ' · ⚠️ no store config has reached this device yet'}
      </p>

      {/*
        ⚠️ DEVELOPMENT ONLY, and it earns its place: `disableNetwork()` is what the SDK's own
        documentation prescribes for testing offline behaviour, and it is closer to a pulled cable
        than DevTools' throttling — which does not stop Firestore's already-open streams.
        This is how T-184's four browser assertions are actually run.
      */}
      {process.env.NODE_ENV !== 'production' && (
        <div className="flex gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <button
            type="button"
            onClick={async () => {
              await disableNetwork(terminalFirebase().db);
              setOnline(false);
            }}
            className="rounded border border-neutral-300 px-3 py-2 text-xs dark:border-neutral-700"
          >
            Simulate offline
          </button>
          <button
            type="button"
            onClick={async () => {
              await enableNetwork(terminalFirebase().db);
              setOnline(true);
            }}
            className="rounded border border-neutral-300 px-3 py-2 text-xs dark:border-neutral-700"
          >
            Reconnect
          </button>
        </div>
      )}
    </main>
  );
}
