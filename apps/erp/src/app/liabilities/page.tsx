import Link from 'next/link';
import { LIABILITY_CATEGORIES } from '@shareat/db/schema';
import { requireSession } from '../../lib/session';
import { createLiabilityAction } from './actions';
import { CATEGORY_LABEL, listRegister, listStores, peso, today } from './lib';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Liabilities — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
}

export default async function LiabilitiesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const { actor } = await requireSession('/liabilities');

  const [stores, rows] = await Promise.all([listStores(actor.orgId), listRegister(actor.orgId)]);
  const storeById = new Map(stores.map((s) => [s.id, s]));

  // ⭐ Overdue first. v1 has no due date at all, so it can show what is owed and never what is late
  // — the question people open this screen to ask.
  const overdue = rows.filter((r) => r.overdue);
  const owed = rows.reduce((sum, r) => sum + Number(r.position.outstanding), 0);

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Liabilities</h1>
        <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
          What the business owes that nothing else already tracks. Supplier invoices, loans, wages
          and statutory contributions each have their own home —{' '}
          <strong>this is the residual</strong>, and naming it precisely is what stops it becoming a
          dumping ground.
        </p>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}

      {overdue.length > 0 && (
        <section className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950">
          <h2 className="font-medium text-amber-900 dark:text-amber-200">
            {overdue.length === 1 ? 'One obligation is' : `${overdue.length} obligations are`} past
            due
          </h2>
          <ul className="space-y-1">
            {overdue.map((r) => (
              <li key={r.id}>
                <Link href={`/liabilities/${r.id}`} className="underline underline-offset-2">
                  {r.name}
                </Link>{' '}
                — <span className="font-mono tabular-nums">{peso(r.position.outstanding)}</span>, due{' '}
                {r.dueOn}
              </li>
            ))}
          </ul>
        </section>
      )}

      {rows.length > 0 && (
        <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <span className="text-neutral-600 dark:text-neutral-400">Still owed, across all</span>{' '}
          <span className="font-mono font-medium tabular-nums">{peso(owed)}</span>
        </div>
      )}

      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[820px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Obligation</th>
                <th className="px-3 py-2 font-medium">Store</th>
                <th className="px-3 py-2 font-medium">Due</th>
                <th className="px-3 py-2 text-right font-medium">Charged</th>
                <th className="px-3 py-2 text-right font-medium">Paid</th>
                <th className="px-3 py-2 text-right font-medium">Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={`border-b border-neutral-100 last:border-0 dark:border-neutral-900 ${
                    Number(r.position.outstanding) > 0 ? '' : 'opacity-60'
                  }`}
                >
                  <td className="px-3 py-2">
                    <Link href={`/liabilities/${r.id}`} className="underline underline-offset-2">
                      {r.name}
                    </Link>
                    <div className="text-xs text-neutral-400 dark:text-neutral-600">
                      {CATEGORY_LABEL[r.category] ?? r.category}
                    </div>
                  </td>
                  <td className="px-3 py-2">{storeById.get(r.storeId)?.code ?? '—'}</td>
                  <td
                    className={`px-3 py-2 text-xs whitespace-nowrap ${
                      r.overdue ? 'text-amber-700 dark:text-amber-400' : ''
                    }`}
                  >
                    {r.dueOn ?? '—'}
                    {r.overdue && ' · overdue'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {peso(r.position.charged)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {peso(r.position.paid)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {peso(r.position.outstanding)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">No obligations recorded.</p>
      )}

      <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div>
          <h2 className="font-medium">Record an obligation</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            ⚠️ This records <strong>what it is</strong>. Nothing is owed until it is charged — the
            same separation as a loan that has not been drawn.
          </p>
        </div>

        <form action={createLiabilityAction} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Store">
              <select name="storeId" required defaultValue="" className={INPUT}>
                <option value="" disabled>
                  Choose…
                </option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="What it is">
              <input name="name" required placeholder="Accrued rent — January" className={INPUT} />
            </Field>
            <Field label="Category">
              <select name="category" defaultValue="other" className={INPUT}>
                {LIABILITY_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c] ?? c}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Due"
              hint="Optional — but an obligation with no due date can never be reported late."
            >
              <input name="dueOn" type="date" defaultValue={today()} className={INPUT} />
            </Field>
            <Field label="Description" hint="Optional.">
              <input name="description" className={INPUT} />
            </Field>
            <Field label="Notes" hint="Optional.">
              <input name="notes" className={INPUT} />
            </Field>
          </div>
          <button
            type="submit"
            className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            Record obligation
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
      {hint && <span className="text-xs text-neutral-500 dark:text-neutral-500">{hint}</span>}
    </label>
  );
}
