import { transaction, schema } from '@shareat/db';
import { asc, eq } from 'drizzle-orm';
import { signInAction } from './actions';
import { safeNext } from './lib';
import { EmailSignInForm } from './EmailSignInForm';
import { currentSession } from '../../lib/session';
import { redirect } from 'next/navigation';

export const metadata = { title: 'Sign in — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  next?: string;
  error?: string;
}

/**
 * The terminal sign-in. **A store and a 6-digit PIN** — Ian: *"retain the current 6-digit
 * passcode."* An email and password at a busy counter is a worse control, not a better one,
 * because it gets shared.
 *
 * ⚠️ The store list is public here by necessity — you must pick one before you can prove anything.
 * That is fine: a store's existence is not a secret, and the PIN is scoped to it.
 *
 * ## T-232 — the email form beside it, and why both belong on one page
 *
 * The two forms are for two different situations, not two tastes. A PIN is scoped to **one store**
 * and is what a shared tablet at a counter should ever hold. An email and password belong to **one
 * person on one machine** — the owner and the office — and carry a session seven days long rather
 * than twelve hours. Decision 6: the PIN path is untouched, and it keeps working even when the
 * email form cannot be configured (it says so in place rather than throwing this page away).
 *
 * ⭐ On a genuinely empty database this page has no stores to offer, so the email form is the only
 * door — which is exactly the first-run case T-232 exists for: sign in, then create the
 * organisation from inside.
 */
export default async function SignInPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;

  // Already signed in? Nothing to do here.
  // ⚠️ `safeNext` and not an inline check: this line accepted `next=//evil.com` until T-232's review
  // found it, because `startsWith('/')` is true of a protocol-relative URL. One rule, one place.
  const existing = await currentSession();
  if (existing) redirect(safeNext(sp.next ?? ''));

  const stores = await transaction((tx) =>
    tx
      .select({ id: schema.stores.id, name: schema.stores.name, code: schema.stores.code })
      .from(schema.stores)
      .orderBy(asc(schema.stores.name)),
  );

  const isDev = process.env.NODE_ENV !== 'production';

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-8">
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Sign in</h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            A store and a 6-digit PIN at a terminal — or your own email and password.
          </p>
        </div>

        {sp.error && (
          <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
            {sp.error}
          </div>
        )}

        {stores.length === 0 ? (
          <div className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            No stores exist in this database yet.
          </div>
        ) : (
          <form action={signInAction} className="space-y-4 text-sm">
            <input type="hidden" name="next" value={sp.next ?? ''} />

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Store</span>
              <select
                name="storeId"
                defaultValue={stores[0]?.id ?? ''}
                className="rounded border border-neutral-300 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-950"
              >
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">PIN</span>
              <input
                name="pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                placeholder="••••••"
                // Touch-first: a cashier enters this on a tablet, so the target is large and the
                // keypad is numeric (memory: phone/tablet is the default canvas).
                className="rounded border border-neutral-300 bg-white px-3 py-3 text-center text-2xl tracking-[0.5em] tabular-nums dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>

            <button
              type="submit"
              className="w-full rounded bg-neutral-900 px-4 py-3 font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              Sign in
            </button>
          </form>
        )}

        {/* T-232 — the same page, a different credential. See the header for why both live here. */}
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

        {isDev && (
          // ⚠️ DEVELOPMENT ONLY, and gated on NODE_ENV so it cannot reach production. Printing a
          // working PIN is exactly the kind of convenience that ships by accident.
          <p className="rounded border border-dashed border-neutral-300 p-3 text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            <strong>Dev only:</strong> <code>npm run dev:seed</code> creates{' '}
            <code>000000</code> (super-admin), <code>111111</code> (admin), <code>222222</code>{' '}
            (manager) and <code>333333</code> (cashier) for every store.
          </p>
        )}
      </div>
    </main>
  );
}
