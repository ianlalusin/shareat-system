import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageAccess } from '../../../../lib/page-access';
import { storeDetail } from '../lib';
import {
  deactivateStoreAction,
  reactivateStoreAction,
  setStoreOpeningDateAction,
  setStoreStockModelAction,
  updateStoreAction,
} from '../actions';
import { Page } from '@/components/shell/Page';
import { ACTION_LINK } from '@/components/action-link';

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
  const { actor, refusal } = await requirePageAccess(`/admin/stores/${id}`);
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;
  const detail = await storeDetail(actor, id);
  if (!detail) notFound();

  const { store, readiness } = detail;

  // ⭐ A manager can reach this URL — the nav link is not gated per-role and the list page is a
  // plain read. Before this, `storeReadiness`'s `authorize()` threw and they got an HTTP 500; the
  // T-222 smoketest is what caught it. A refusal is a sentence, never a stack trace.
  if (!readiness) {
    return (
      <Page density="form" className="space-y-4">
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
      </Page>
    );
  }

  const blocking = readiness.filter((c) => !c.ok && c.blocking);

  return (
    <Page density="form">
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
                    {/* ⭐ T-243 / DEF-216 — one generic renderer replaces what T-230 and T-229
                        slice 3 each hand-wired for their own check. `remedy` is absent for a check
                        (`adminScope`) that no single screen clears. */}
                    {!c.ok && c.remedy && (
                      <Link href={c.remedy.href} className={ACTION_LINK}>
                        {c.remedy.label}
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
            {/* ⭐ T-229 slice 4 / DEF-208 — what a document printed for THIS BRANCH carries. The
                registered name, the TIN and the tax type belong to the organisation and are set
                once, on /settings/organization: in PH a corporation holds one TIN and each branch
                carries a code against it, so duplicating the number per store (as v1 did) is one
                number in N places to go wrong. */}
            <label className="block text-sm">
              <span className="block text-neutral-600 dark:text-neutral-400">Trading address</span>
              <textarea name="address" defaultValue={store.address ?? ''} rows={2}
                className="mt-1 w-full rounded border border-neutral-300 p-2 dark:border-neutral-700 dark:bg-neutral-900" />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="block text-neutral-600 dark:text-neutral-400">Contact number</span>
                <input name="contactNumber" defaultValue={store.contactNumber ?? ''}
                  className="mt-1 w-full rounded border border-neutral-300 p-2 dark:border-neutral-700 dark:bg-neutral-900" />
              </label>
              <label className="block text-sm">
                <span className="block text-neutral-600 dark:text-neutral-400">
                  TIN branch code <span className="text-neutral-400">— digits, e.g. 00001</span>
                </span>
                <input name="tinBranchCode" defaultValue={store.tinBranchCode ?? ''} inputMode="numeric"
                  className="mt-1 w-full rounded border border-neutral-300 p-2 tabular-nums dark:border-neutral-700 dark:bg-neutral-900" />
              </label>
            </div>
            <p className="text-xs text-neutral-500">
              ⛔ The code (<code>{store.code}</code>) is not editable. Rename freely — the code is the
              stable handle other records refer to. The registered name and TIN are the
              organisation&apos;s —{' '}
              <Link href="/settings/organization" className="underline underline-offset-2">
                set them once
              </Link>
              .
            </p>
            <button type="submit"
              className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900">
              Save
            </button>
          </form>

          {/**
            * ⭐ T-346 S1 (DEF-428). Its own form, not a field on Details above — same reasoning as
            * `stock_model` below: `setStoreOpeningDate` carries a refusal (has this store already
            * traded?) a general "save details" call should not have to know about.
            *
            * ⛔ No confirm-reversal control here — §3.4's cascade is S2's; `fixed_assets.in_service_on`
            * does not exist yet, so there is nothing today's call could ever need to reverse.
            */}
          <form
            action={setStoreOpeningDateAction}
            className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
          >
            <h2 className="text-sm font-medium">Opening date</h2>
            <input type="hidden" name="storeId" value={store.id} />
            <label className="block text-sm">
              <span className="block text-neutral-600 dark:text-neutral-400">Opening date</span>
              <input type="date" name="openingDate" defaultValue={store.openingDate ?? ''}
                className="mt-1 w-full rounded border border-neutral-300 p-2 dark:border-neutral-700 dark:bg-neutral-900" />
            </label>
            <p className="text-xs text-neutral-500">
              Leave blank if it has not opened. The first day this store trades.
            </p>
            <button type="submit"
              className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700">
              Save opening date
            </button>
          </form>

          {/**
            * ⭐ T-284 / DEF-316 — Ian: *"shareat lipa needs more than 1 storage room, i can not
            * edit the store."* `stores.stock_model` was created by migration `0062` and has had
            * NO writer of any kind since; every store sat on the default `single_room` with no
            * path off it. This is that path.
            *
            * ⛔ Its own form, not a field on Details above, because narrowing to single-room runs
            * a room-count pre-flight the database does not have on this side (DEF-316) — folding
            * it in would route the column past that check.
            */}
          <form
            action={setStoreStockModelAction}
            className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
          >
            <h2 className="text-sm font-medium">How this branch keeps stock</h2>
            <input type="hidden" name="storeId" value={store.id} />
            <p className="text-xs text-neutral-500">
              A Receiving room never counts toward this — every branch needs somewhere to park a
              delivery, including one that keeps its stock in a single place.
            </p>

            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-neutral-200 p-3 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900">
              <input
                type="radio"
                name="stockModel"
                value="single_room"
                defaultChecked={store.stockModel === 'single_room'}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium">One room</span>
                <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                  A branch or kiosk. Stock lives in one place, which is also where usage posts
                  from.
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-neutral-200 p-3 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900">
              <input
                type="radio"
                name="stockModel"
                value="multi_room"
                defaultChecked={store.stockModel === 'multi_room'}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium">Several rooms</span>
                <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                  A commissary, or a branch with a separate stockroom and kitchen. Once this is
                  saved, add the rooms under Inventory / Locations.
                  {/* ⚠️ Named, not linked. An inline <Link> inside `text-xs` help text models at
                      16px against T-262's 24px touch-target floor, and `action-link-sweep`
                      counted it as a NEW FAIL — a real undersized control, not a bookkeeping
                      gap. Baselining it would have accepted an accessibility defect to save a
                      sentence; the success banner after saving names the destination anyway. */}
                </span>
              </span>
            </label>

            <p className="text-xs text-neutral-500">
              ⚠️ Going back to one room is refused while the branch still has more than one active
              non-Receiving room — deactivate or merge the extras first.
            </p>

            <button
              type="submit"
              className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700"
            >
              Save stock model
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
    </Page>
  );
}
