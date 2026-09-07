import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '../../../../lib/session';
import { storeDetail } from '../lib';
import {
  deactivateStoreAction,
  reactivateStoreAction,
  updateStoreAction,
} from '../actions';

export const metadata = { title: 'Store — Shareat System' };
export const dynamic = 'force-dynamic';

/**
 * T-222 — one store, its cash-custody policy, and the readiness checklist.
 *
 * ⭐ **The checklist is computed on read from the live tables. Nothing about readiness is stored**,
 * and that is bible row 123's lesson rather than a style preference: v1's OIL layer stored `state`
 * per finding, so resolving one suppressed tomorrow's recompute *while the condition still held*. A
 * stored "store is ready" flag is the same defect — someone ticks it, the sales channel is later
 * deleted, and the store reports ready forever.
 */
export default async function StoreDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { actor } = await requireSession(`/admin/stores/${id}`);
  const detail = await storeDetail(actor, id);
  if (!detail) notFound();

  const { store, readiness } = detail;

  // ⭐ A manager can reach this URL — the nav link is not gated per-role and the list page is a
  // plain read. Before this, `storeReadiness`'s `authorize()` threw and they got an HTTP 500; the
  // T-222 smoketest is what caught it. A refusal is a sentence, never a stack trace.
  if (!readiness) {
    return (
      <main className="mx-auto max-w-2xl space-y-4 p-4 sm:p-8">
        <Link href="/admin/stores" className="text-sm underline underline-offset-2">
          ← Stores
        </Link>
        <h1 className="text-2xl font-semibold">
          {store.code} — {store.name}
        </h1>
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          Only an admin or super-admin can open or close a branch. You can see this store in the
          list, but its readiness checklist and settings are not yours to read or change.
        </p>
      </main>
    );
  }

  const blocking = readiness.filter((c) => !c.ok && c.blocking);

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8">
      <div>
        <Link href="/admin/stores" className="text-sm underline underline-offset-2">
          ← Stores
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">
          {store.code} — {store.name}
        </h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {store.isActive ? 'Active' : 'Inactive'} · {store.stockModel} · {store.remittanceCadence}
          {store.unremittedCeiling ? ` · ceiling ${store.unremittedCeiling}` : ''}
        </p>
      </div>

      {sp.ok && (
        <p className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          {sp.ok}
        </p>
      )}
      {sp.error && (
        <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </p>
      )}

      {blocking.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <strong>
            {blocking.length} thing{blocking.length === 1 ? '' : 's'} still stop this store working.
          </strong>{' '}
          They are listed below. Each is a real business fact — a default here would be a guess
          wearing the costume of a decision.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-medium">Readiness</h2>
          <ul className="space-y-3">
            {readiness.map((c) => (
              <li key={c.key} className="text-sm">
                <div className="flex items-start gap-2">
                  <span className={c.ok ? 'text-emerald-600' : 'text-amber-600'}>
                    {c.ok ? '✓' : '•'}
                  </span>
                  <div>
                    <div className="font-medium">
                      {c.label}
                      <span className="ml-2 text-xs font-normal text-neutral-500">
                        {c.kind === 'auto' ? 'automatic' : 'business fact'}
                      </span>
                    </div>
                    <div className="text-neutral-600 dark:text-neutral-400">{c.detail}</div>
                    {c.key === 'salesChannel' && !c.ok && (
                      // ⭐ T-230 / DEF-207. This row was blocking with no remedy anywhere in the
                      // product — `sales_channels` had no production writer at all. The link goes
                      // to `/settings` and not to a panel here because channels are
                      // `manage_store_settings` (manager ✅) while this page is admin-only.
                      <Link
                        href={`/settings/sales-channels?store=${store.id}`}
                        className="text-xs underline underline-offset-2"
                      >
                        Add a sales channel →
                      </Link>
                    )}
                    {c.key === 'signIn' && !c.ok && (
                      // ⚠️ Links to T-217's gated issuance path, never to a new ungated caller —
                      // `setPin` has no `authorize()` of its own.
                      <Link href="/staff" className="text-xs underline underline-offset-2">
                        Issue a PIN from Staff →
                      </Link>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-xs text-neutral-500">
            Recomputed every time this page loads. Nothing here is stored, so it cannot report ready
            after the thing it checked was deleted.
          </p>
        </section>

        <section className="space-y-4">
          <form action={updateStoreAction} className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <h2 className="text-sm font-medium">Details</h2>
            <input type="hidden" name="storeId" value={store.id} />
            <label className="block text-sm">
              <span className="block text-neutral-600 dark:text-neutral-400">Name</span>
              <input name="name" defaultValue={store.name} required
                className="mt-1 w-full rounded border border-neutral-300 p-2 dark:border-neutral-700 dark:bg-neutral-900" />
            </label>
            <label className="block text-sm">
              <span className="block text-neutral-600 dark:text-neutral-400">Timezone</span>
              <input name="timezone" defaultValue={store.timezone}
                className="mt-1 w-full rounded border border-neutral-300 p-2 dark:border-neutral-700 dark:bg-neutral-900" />
            </label>
            <p className="text-xs text-neutral-500">
              ⛔ The code (<code>{store.code}</code>) is not editable. Rename freely — the code is the
              stable handle other records refer to.
            </p>
            <button type="submit"
              className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900">
              Save
            </button>
          </form>

          <form
            action={store.isActive ? deactivateStoreAction : reactivateStoreAction}
            className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
          >
            <h2 className="text-sm font-medium">{store.isActive ? 'Close this branch' : 'Reopen this branch'}</h2>
            <input type="hidden" name="storeId" value={store.id} />
            <p className="text-xs text-neutral-500">
              {store.isActive
                ? 'Deactivating never deletes. Its journal entries, attendance and stock stay queryable.'
                : 'Reopening also re-grants store access to every admin — including any appointed while it was closed, who would otherwise not see it.'}
            </p>
            <button type="submit"
              className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700">
              {store.isActive ? 'Deactivate' : 'Reactivate'}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
