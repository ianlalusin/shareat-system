import Link from 'next/link';
import { requireSession } from '../../../lib/session';
import {
  addOpeningFigureAction,
  postOpeningBalancesAction,
  removeOpeningFigureAction,
} from '../actions';
import {
  CONVERSION_DATE,
  listStores,
  loadGaps,
  loadOpeningDrafts,
  loadPostableAccounts,
  peso,
} from '../lib';
import { Page } from '@/components/shell/Page';
import { ACTION_LINK } from '@/components/action-link';

export const metadata = { title: 'Opening balances — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  posted?: string;
}

export default async function OpeningPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const { actor } = await requireSession('/cutover/opening');

  const [stores, drafts, accounts, gaps] = await Promise.all([
    listStores(actor.orgId),
    loadOpeningDrafts(actor.orgId),
    loadPostableAccounts(actor.orgId),
    loadGaps(actor.orgId),
  ]);

  const residual = Number(gaps.residual);
  const balanced = Math.abs(residual) < 0.005;
  const storeName = (id: string | null) => stores.find((s) => s.id === id)?.name ?? '—';

  return (
    <Page density="form">
      <div>
        <Link
          href="/cutover"
          className={`${ACTION_LINK} text-neutral-500 dark:text-neutral-400`}
        >
          ← Back to the conversion
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Opening balances</h1>
        <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
          What the business owns and owes on the morning the new books open. Enter them over as
          many days as it takes — nothing is final until you post at the end.
        </p>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}

      {sp.posted === '1' && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          <strong className="font-medium">The books are open.</strong> The opening entry is posted
          and can no longer be edited — a correction from here is a reversal.
        </div>
      )}

      {/* ⭐ The same running difference as the wizard, because it is the same question. Watching it
          while you type is what stops the last supplier being the moment you find out. */}
      <section
        className={`rounded-lg border p-4 sm:p-5 ${
          balanced
            ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950'
            : 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950'
        }`}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span
            className={`text-sm font-medium ${
              balanced ? 'text-emerald-900 dark:text-emerald-300' : 'text-amber-900 dark:text-amber-300'
            }`}
          >
            {balanced ? 'Everything balances' : 'Difference still to explain'}
          </span>
          <span
            className={`font-mono text-2xl font-semibold tabular-nums ${
              balanced ? 'text-emerald-900 dark:text-emerald-300' : 'text-amber-900 dark:text-amber-300'
            }`}
          >
            {peso(Math.abs(residual))}
          </span>
        </div>
        <p
          className={`mt-1 text-xs ${
            balanced ? 'text-emerald-800 dark:text-emerald-400' : 'text-amber-800 dark:text-amber-400'
          }`}
        >
          {balanced
            ? drafts.length > 0
              ? 'Ready to post. Everything entered so far accounts for itself.'
              : 'Nothing entered yet.'
            : 'Something on one side has no matching figure on the other. It has to be found — there is nowhere to park it.'}
        </p>
      </section>

      {/* ── What is still needed ─────────────────────────────────────────────────────── */}
      {gaps.doubleCounted.length > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          <strong className="font-medium">
            {gaps.doubleCounted.length} part
            {gaps.doubleCounted.length === 1 ? 'y has' : 'ies have'} the same money twice.
          </strong>
          <p className="mt-1 text-xs">
            An opening balance was entered for them, and a document dated before the conversion also
            exists. One of the two has to go.
          </p>
        </div>
      )}

      {/* ── Add a figure ─────────────────────────────────────────────────────────────── */}
      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-medium">Add a figure</h2>
        <form action={addOpeningFigureAction} className="mt-3 space-y-3">
          <input type="hidden" name="entryDate" value={CONVERSION_DATE} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">Account</span>
              <select
                name="accountCode"
                required
                className="w-full rounded border border-neutral-300 px-3 py-2.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              >
                {accounts.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} — {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">Store</span>
              <select
                name="storeId"
                required
                className="w-full rounded border border-neutral-300 px-3 py-2.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              >
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">
                Owns or owes
              </span>
              <select
                name="direction"
                required
                className="w-full rounded border border-neutral-300 px-3 py-2.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              >
                {/* Plain words, because "debit" and "credit" are the thing people get backwards. */}
                <option value="debit">We have this (asset)</option>
                <option value="credit">We owe this (liability)</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">Amount</span>
              <input
                type="number"
                name="amount"
                step="0.01"
                min="0.01"
                required
                inputMode="decimal"
                placeholder="0.00"
                className="w-full rounded border border-neutral-300 px-3 py-2.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
          </div>
          <input
            type="text"
            name="memo"
            placeholder="What this is (optional)"
            className="w-full rounded border border-neutral-300 px-3 py-2.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            type="submit"
            className="w-full rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white sm:w-auto dark:bg-neutral-100 dark:text-neutral-900"
          >
            Add figure
          </button>
        </form>
      </section>

      {/* ── What has been entered ────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium">
          Entered so far{' '}
          <span className="font-normal text-neutral-500 dark:text-neutral-500">
            ({drafts.length})
          </span>
        </h2>
        {drafts.length === 0 ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Nothing yet. Everything you add stays editable until you post.
          </p>
        ) : (
          drafts.map((d) => (
            <div
              key={d.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
            >
              <div className="min-w-0">
                <span className="font-mono text-xs text-neutral-500 dark:text-neutral-500">
                  {d.accountCode}
                </span>{' '}
                <span className="text-sm">{d.memo}</span>
                <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-500">
                  {storeName(d.storeId)}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm tabular-nums">
                  {Number(d.debit) > 0 ? peso(Number(d.debit)) : `(${peso(Number(d.credit))})`}
                </span>
                {/* A draft was never final, so removing one is a delete rather than a reversal. */}
                <form action={removeOpeningFigureAction}>
                  <input type="hidden" name="entryId" value={d.id} />
                  <button
                    type="submit"
                    className="rounded border border-neutral-300 px-3 py-2 text-xs dark:border-neutral-700"
                  >
                    Remove
                  </button>
                </form>
              </div>
            </div>
          ))
        )}
      </section>

      {/* ── Post ─────────────────────────────────────────────────────────────────────── */}
      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-medium">Open the books</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Posting makes every figure above final. After this a correction is a reversal, not an
          edit.
        </p>
        {/*
          ⛔ The button is ABSENT, not disabled, when it cannot run — and the reason is written
          where the button would be. A greyed-out control invites clicking it to find out why.
        */}
        {balanced && drafts.length > 0 ? (
          <form action={postOpeningBalancesAction} className="mt-3">
            <button
              type="submit"
              className="w-full rounded bg-emerald-700 px-4 py-2.5 text-sm font-medium text-white sm:w-auto dark:bg-emerald-600"
            >
              Post the opening balances
            </button>
          </form>
        ) : (
          <p className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
            {drafts.length === 0
              ? 'Nothing to post yet.'
              : `₱${Math.abs(residual).toFixed(2)} is still unexplained, so this cannot be posted. There is no holding account to put it in — the difference has to be found.`}
          </p>
        )}
      </section>
    </Page>
  );
}
