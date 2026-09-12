import Link from 'next/link';
import { INTEREST_METHODS, PAYMENT_FREQUENCIES, RATE_PERIODS } from '@shareat/db';
import { requirePageAccess } from '../../lib/page-access';
import { createLoanAction } from './actions';
import { METHOD_LABEL, STATUS_LABEL, listRegister, listStores, peso, today } from './lib';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Loans — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
}

export default async function LoansPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const { actor, refusal } = await requirePageAccess('/loans');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const [stores, loans] = await Promise.all([listStores(actor.orgId), listRegister(actor.orgId)]);
  const storeById = new Map(stores.map((s) => [s.id, s]));

  const owed = loans
    .filter((l) => l.status === 'active')
    .reduce((sum, l) => sum + Number(l.position.outstanding), 0);

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Loans</h1>
        <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
          What the business has borrowed, what it has repaid, and what is left. Every figure here is
          summed from the ledger — <strong>there is no stored balance to go stale</strong>.
        </p>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}

      {loans.length > 0 && (
        <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <span className="text-neutral-600 dark:text-neutral-400">Still owed, across active loans</span>{' '}
          <span className="font-mono font-medium tabular-nums">{peso(owed)}</span>
        </div>
      )}

      {/* ── The register ─────────────────────────────────────────────────────────────── */}
      {loans.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[860px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Loan</th>
                <th className="px-3 py-2 font-medium">Store</th>
                <th className="px-3 py-2 font-medium">Terms</th>
                <th className="px-3 py-2 text-right font-medium">Drawn</th>
                <th className="px-3 py-2 text-right font-medium">Repaid</th>
                <th className="px-3 py-2 text-right font-medium">Outstanding</th>
                <th className="px-3 py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {loans.map((l) => (
                <tr
                  key={l.id}
                  className={`border-b border-neutral-100 last:border-0 dark:border-neutral-900 ${
                    l.status === 'active' ? '' : 'opacity-60'
                  }`}
                >
                  <td className="px-3 py-2">
                    <Link href={`/loans/${l.id}`} className="underline underline-offset-2">
                      {l.name}
                    </Link>
                    <div className="text-xs text-neutral-400 dark:text-neutral-600">
                      {l.lenderName}
                    </div>
                  </td>
                  <td className="px-3 py-2">{storeById.get(l.storeId)?.code ?? '—'}</td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {/* ⚠️ The rate is meaningless without its period — "2%" is twelve times more
                        per year when it is monthly, and v1 had rows where nobody had said which. */}
                    {Number(l.interestRate)}% per {l.ratePeriod} · {l.termPeriods}{' '}
                    {l.paymentFrequency}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {peso(l.position.disbursed)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {peso(l.position.principalPaid)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {peso(l.position.outstanding)}
                  </td>
                  <td className="px-3 py-2 text-xs">{STATUS_LABEL[l.status] ?? l.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">No loans recorded.</p>
      )}

      {/* ── Record one ───────────────────────────────────────────────────────────────── */}
      <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div>
          <h2 className="font-medium">Record a loan</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            This records the <strong>agreement</strong>. ⚠️ No money moves until it is drawn — a
            signed loan that has not been drawn is a commitment, not a debt.
          </p>
        </div>

        <form action={createLoanAction} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="What it is called">
              <input name="name" required maxLength={120} placeholder="Grab cash advance" className={INPUT} />
            </Field>
            <Field label="Lender">
              <input name="lenderName" required maxLength={120} placeholder="Grab" className={INPUT} />
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
            <Field label="Amount agreed">
              <input
                name="principalAmount"
                type="number"
                step="0.01"
                min="0.01"
                required
                inputMode="decimal"
                placeholder="0.00"
                className={INPUT}
              />
            </Field>

            <Field label="Interest rate (%)">
              <input
                name="interestRate"
                type="number"
                step="0.0001"
                min="0"
                required
                inputMode="decimal"
                className={INPUT}
              />
            </Field>
            {/* ⛔ No default, deliberately. In v1 an absent rate period meant ANNUAL on old rows and
                MONTHLY on new ones, with nothing on the row to tell them apart — so the same "2"
                described two very different debts. */}
            <Field label="…per" hint="A month is 30 days and a year is 365. Say which.">
              <select name="ratePeriod" required defaultValue="" className={INPUT}>
                <option value="">Choose…</option>
                {RATE_PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="How interest is charged">
              <select name="interestMethod" defaultValue="straight" className={INPUT}>
                {INTEREST_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {METHOD_LABEL[m] ?? m}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Repaid">
              <select name="paymentFrequency" defaultValue="monthly" className={INPUT}>
                {PAYMENT_FREQUENCIES.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Number of payments">
              <input name="termPeriods" type="number" min="1" required defaultValue={12} className={INPUT} />
            </Field>
            <Field label="Starts">
              <input name="startDate" type="date" required defaultValue={today()} className={INPUT} />
            </Field>
          </div>
          <Field label="Notes">
            <input name="notes" className={INPUT} />
          </Field>

          <button
            type="submit"
            className="rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            Record loan
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
