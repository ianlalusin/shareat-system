import Link from 'next/link';
import { requirePageAccess } from '../../lib/page-access';
import { createOwnerAction } from './actions';
import {
  AGED_DAYS,
  TREATMENT_LABEL,
  listActivePersons,
  listRegister,
  listStores,
  peso,
} from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Owners — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
}

export default async function OwnersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/owners');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const [stores, persons, owners] = await Promise.all([
    listStores(actor.orgId),
    listActivePersons(actor.orgId),
    listRegister(actor.orgId),
  ]);
  const storeById = new Map(stores.map((s) => [s.id, s]));
  const personById = new Map(persons.map((p) => [p.id, p]));

  // ⭐ Aged receivables render FIRST, above the register. An owner balance left uncollected long
  // enough stops looking like a loan to anyone examining it, and nobody should have to remember to
  // go looking for it — the same reason remittance surfaces open variances at the top.
  const stale = owners.filter((o) => o.aged && o.aged.daysOutstanding >= AGED_DAYS);

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Owners</h1>
        <PageDescription>
          What each owner has put in, taken out, and still owes. Every figure is summed from the
          ledger — <strong>no total is stored anywhere</strong>, so none of them can drift from the
          books.
        </PageDescription>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}

      {/* ── Aged receivables ─────────────────────────────────────────────────────────── */}
      {stale.length > 0 && (
        <section className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950">
          <h2 className="font-medium text-amber-900 dark:text-amber-200">
            {stale.length === 1 ? 'An owner balance has' : `${stale.length} owner balances have`}{' '}
            been outstanding a long time
          </h2>
          <p className="text-amber-900 dark:text-amber-300">
            A personal expense the business is owed stops looking like a loan once it sits
            uncollected. Take it back in cash, recover it from pay, or write it off deliberately —
            leaving it is the one option that decides itself.
          </p>
          <ul className="space-y-1">
            {stale.map((o) => (
              <li key={o.id}>
                <Link href={`/owners/${o.id}`} className="underline underline-offset-2">
                  {personById.get(o.personId)?.displayName ?? 'Unknown'}
                </Link>{' '}
                — <span className="font-mono tabular-nums">{peso(o.aged!.outstanding)}</span>, oldest
                charge {o.aged!.oldestOn} ({o.aged!.daysOutstanding} days)
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── The register ─────────────────────────────────────────────────────────────── */}
      {owners.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[880px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Store</th>
                <th className="px-3 py-2 text-right font-medium">Contributed</th>
                <th className="px-3 py-2 text-right font-medium">Drawn</th>
                <th className="px-3 py-2 text-right font-medium">Net</th>
                <th className="px-3 py-2 text-right font-medium">Owes</th>
                <th className="px-3 py-2 font-medium">Limit</th>
              </tr>
            </thead>
            <tbody>
              {owners.map((o) => (
                <tr
                  key={o.id}
                  className={`border-b border-neutral-100 last:border-0 dark:border-neutral-900 ${
                    o.status === 'active' ? '' : 'opacity-60'
                  }`}
                >
                  <td className="px-3 py-2">
                    <Link href={`/owners/${o.id}`} className="underline underline-offset-2">
                      {personById.get(o.personId)?.displayName ?? 'Unknown'}
                    </Link>
                    <div className="text-xs text-neutral-400 dark:text-neutral-600">
                      {o.role ?? '—'}
                      {o.ownershipPercentage && (
                        // ⚠️ Labelled advisory on purpose: nothing validates that these sum to 100,
                        // because a store mid-restructure legitimately does not.
                        <> · {Number(o.ownershipPercentage)}% (indicative)</>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">{storeById.get(o.storeId)?.code ?? '—'}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {peso(o.position.contributed)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {peso(o.position.drawn)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {peso(o.position.net)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {peso(o.position.receivable)}
                  </td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {o.drawingLimit
                      ? `${peso(o.drawingLimit)} ${o.drawingLimitPeriod}`
                      : 'none'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">No owners recorded.</p>
      )}

      {/* ── Add one ──────────────────────────────────────────────────────────────────── */}
      <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div>
          <h2 className="font-medium">Record an owner</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Who they are and what they are allowed to withdraw. ⚠️ No money moves — this is the
            record, not a contribution.
          </p>
        </div>

        <form action={createOwnerAction} className="space-y-4">
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
            <Field label="Who">
              <select name="personId" required defaultValue="" className={INPUT}>
                <option value="" disabled>
                  Choose…
                </option>
                {persons.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Role" hint="Managing Partner, Silent Partner…">
              <input name="role" className={INPUT} />
            </Field>
            <Field
              label="Ownership %"
              hint="Indicative only — nothing checks that these add to 100, because a store mid-restructure legitimately does not."
            >
              <input name="ownershipPercentage" inputMode="decimal" className={INPUT} />
            </Field>
            <Field label="Drawing limit" hint="Leave both blank for no limit.">
              <input name="drawingLimit" inputMode="decimal" className={INPUT} />
            </Field>
            <Field label="Limit period">
              <select name="drawingLimitPeriod" defaultValue="" className={INPUT}>
                <option value="">—</option>
                <option value="monthly">Monthly — resets each calendar month</option>
                <option value="total">Total — across all time</option>
              </select>
            </Field>
            <Field
              label="Personal expenses"
              hint="Decides where a personal expense lands. It is the line the tax treatment turns on, so it is a stated policy rather than a per-expense guess."
            >
              <select name="personalExpenseTreatment" defaultValue="repayable" className={INPUT}>
                <option value="repayable">{TREATMENT_LABEL.repayable}</option>
                <option value="drawing">{TREATMENT_LABEL.drawing}</option>
              </select>
            </Field>
            <Field label="Notes" hint="Optional.">
              <input name="notes" className={INPUT} />
            </Field>
          </div>
          <button
            type="submit"
            className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            Record owner
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
