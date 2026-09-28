import Link from 'next/link';
import { PREPAID_CATEGORIES } from '@shareat/db';
import { SchedulerStatus } from '../../components/scheduler-status';
import { requirePageAccess } from '../../lib/page-access';
import { createPrepaidItemAction } from './actions';
import {
  CATEGORY_LABEL,
  STATUS_LABEL,
  listRegister,
  listStores,
  peso,
  reviewCount,
} from './lib';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Prepaid expenses — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  review?: string;
}

export default async function PrepaidPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const { actor, refusal } = await requirePageAccess('/prepaid');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const [stores, all, needingReview] = await Promise.all([
    listStores(actor.orgId),
    listRegister(actor.orgId),
    reviewCount(actor.orgId),
  ]);
  const storeById = new Map(stores.map((s) => [s.id, s]));

  // The banner doubles as a filter — §11.2's "a place, not a notification".
  const onlyReview = sp.review === '1';
  const items = onlyReview ? all.filter((i) => i.needsReview && i.status === 'active') : all;

  const totalRemaining = all
    .filter((i) => i.status === 'active')
    .reduce((sum, i) => sum + Number(i.remaining), 0);

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Prepaid expenses</h1>
        <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
          Things already paid for but not yet used up — a year of insurance, a mayor&apos;s permit,
          rent paid in advance. Each sits on the balance sheet and is released into the month it
          actually covers.
        </p>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}

      {/* ⭐ Is anybody keeping these books? Reads scheduler_runs, not the ledger — a run that
          posts nothing looks exactly like a run that never happened (T-140, DEF-044). */}
      <SchedulerStatus orgId={actor.orgId} job="amortisation" label="Amortisation" />

      {/*
        ⭐ THE REVIEW COUNTER IS THE WHOLE DESIGN (§11.2).

        Ian: "design that the review is obvious, not just a toast notif." A toast is gone in four
        seconds and is seen by whoever happened to be looking. An auto-created item with a GUESSED
        term posts a wrong amount every month, quietly, for years — and the only thing between that
        and the books is somebody noticing.

        ⚠️ It is NOT dismissible and nothing expires the queue. It reads zero when there is nothing
        to do, because a counter that is only ever present is a counter people stop seeing.
      */}
      {needingReview > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <div>
            <strong className="font-medium">
              {needingReview} item{needingReview === 1 ? '' : 's'} need
              {needingReview === 1 ? 's' : ''} a term confirmed.
            </strong>{' '}
            The amount and date came off the invoice; the coverage length was a guess. A wrong term
            is wrong in every month it posts.
          </div>
          <Link
            href={onlyReview ? '/prepaid' : '/prepaid?review=1'}
            className="rounded border border-amber-400 px-3 py-1.5 text-xs font-medium hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900"
          >
            {onlyReview ? 'Show all items' : 'Show only these'}
          </Link>
        </div>
      ) : (
        <p className="text-xs text-neutral-400 dark:text-neutral-600">
          Nothing is waiting for review.
        </p>
      )}

      {all.length > 0 && (
        <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <span className="text-neutral-600 dark:text-neutral-400">Still unused, across every active item</span>{' '}
          <span className="font-mono font-medium tabular-nums">{peso(totalRemaining)}</span>
          {/* ⛔ Summed from the register's derived figures, not read from a column. v1 had two
              independent code paths computing this number that never read from each other. */}
        </div>
      )}

      {/* ── The register ─────────────────────────────────────────────────────────────── */}
      {items.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[820px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 font-medium">Store</th>
                <th className="px-3 py-2 font-medium">Covers</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
                <th className="px-3 py-2 text-right font-medium">Released</th>
                <th className="px-3 py-2 text-right font-medium">Still unused</th>
                <th className="px-3 py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr
                  key={i.id}
                  className={`border-b border-neutral-100 last:border-0 dark:border-neutral-900 ${
                    i.status === 'active' ? '' : 'opacity-60'
                  }`}
                >
                  <td className="px-3 py-2">
                    <Link href={`/prepaid/${i.id}`} className="underline underline-offset-2">
                      {i.name}
                    </Link>
                    {i.needsReview && i.status === 'active' && (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                        Term unconfirmed
                      </span>
                    )}
                    <div className="text-xs text-neutral-400 dark:text-neutral-600">
                      {CATEGORY_LABEL[i.category] ?? i.category}
                    </div>
                  </td>
                  <td className="px-3 py-2">{storeById.get(i.storeId)?.code ?? '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {i.coverageStartDate} · {i.coverageMonths} mo
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(i.totalCost)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(i.amortised)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(i.remaining)}</td>
                  <td className="px-3 py-2 text-xs">{STATUS_LABEL[i.status] ?? i.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {onlyReview ? 'Nothing needs review.' : 'No prepaid items yet.'}
        </p>
      )}

      {/* ── Add one ──────────────────────────────────────────────────────────────────── */}
      <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div>
          <h2 className="font-medium">Record a prepaid item</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Below ₱5,000 this is an ordinary expense, not a prepaid — the same threshold fixed
            assets use.
          </p>
        </div>

        <form action={createPrepaidItemAction} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" hint="What it is, as somebody would say it out loud">
              <input name="name" required maxLength={120} placeholder="Fire insurance 2026" className={INPUT} />
            </Field>
            <Field label="Store">
              <select name="storeId" required defaultValue="" className={INPUT}>
                <option value="">Choose a store…</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Kind">
              <select name="category" defaultValue="insurance" className={INPUT}>
                {PREPAID_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c] ?? c}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Total cost">
              <input
                name="totalCost"
                required
                inputMode="decimal"
                placeholder="0.00"
                className={INPUT}
              />
            </Field>
            <Field label="Coverage starts" hint="The first month the cover actually applies to">
              <input name="coverageStartDate" type="date" required className={INPUT} />
            </Field>
            <Field
              label="Coverage months"
              hint="The CONTRACT's term — read it off the document, don't estimate"
            >
              <input
                name="coverageMonths"
                inputMode="numeric"
                required
                defaultValue={12}
                className={INPUT}
              />
            </Field>
          </div>
          <Field label="Notes">
            <input name="notes" className={INPUT} />
          </Field>

          {/* ⭐ No interval selector, deliberately (§10). A 12-month policy covers 12 months;
              charging it quarterly would recognise cost for months not yet covered, which is the
              error prepaid accounting exists to prevent. */}
          <p className="text-xs text-neutral-400 dark:text-neutral-600">
            Released monthly, evenly, from the coverage start — with any odd centavos landing on
            the final month so the total is exact.
          </p>

          <button
            type="submit"
            className="rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            Record prepaid item
          </button>
        </form>
      </section>
    </Page>
  );
}

const INPUT =
  'w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-400 dark:text-neutral-600">{hint}</span>}
    </label>
  );
}
