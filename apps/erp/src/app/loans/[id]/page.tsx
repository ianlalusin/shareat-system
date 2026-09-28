import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageAccess } from '../../../lib/page-access';
import { disburseLoanAction, recordPaymentAction, reverseEntryAction } from '../actions';
import { METHOD_LABEL, STATUS_LABEL, getDetail, moneyAccounts, peso, today } from '../lib';
import { DetailLayout } from '@/components/shell/DetailLayout';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Loan — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
}

export default async function LoanPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { actor, refusal } = await requirePageAccess(`/loans/${id}`);
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const loan = await getDetail(actor.orgId, id);
  if (!loan) notFound();

  const accounts = await moneyAccounts(actor.orgId, loan.storeId);
  const undrawn = Number(loan.principalAmount) - Number(loan.position.disbursed);
  const owes = Number(loan.position.outstanding) > 0;

  return (
    <Page density="table">
      <div>
        <Link href="/loans" className="text-sm underline underline-offset-2">
          ← Loans
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{loan.name}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {loan.lenderName} · {STATUS_LABEL[loan.status]} · {Number(loan.interestRate)}% per{' '}
          {loan.ratePeriod} · {METHOD_LABEL[loan.interestMethod]}
        </p>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}
      {sp.ok && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          {sp.ok}
        </div>
      )}

      <DetailLayout
        summary={
          /* ── The figures ────────────────────────────────────────────────────────────── */
          <section className="space-y-3">
            {/* ⚠️ `min-[1440px]:grid-cols-1`: `sm` is a VIEWPORT query, so without it these four
                tiles stay four-across inside a 320px rail — 74px each, nothing overflowing, every
                DOM assertion green. T-240 §3.5. */}
            <div className="grid gap-3 sm:grid-cols-4 min-[1440px]:grid-cols-1">
              <Figure label="Agreed" value={peso(loan.principalAmount)} />
              <Figure label="Drawn" value={peso(loan.position.disbursed)} />
              <Figure label="Principal repaid" value={peso(loan.position.principalPaid)} />
              <Figure label="Outstanding" value={peso(loan.position.outstanding)} emphasis />
            </div>
            {/* ⛔ v1 stored all four of these on the loan row and they drifted so far that both live
                Grab loans were unusable. Here they are one query over the ledger. */}
            <p className="text-xs text-neutral-400 dark:text-neutral-600">
              Interest paid to date: <strong>{peso(loan.position.interestPaid)}</strong>. Every
              figure is summed from the ledger on load, never stored — so none of them can disagree
              with the books.
            </p>
          </section>
        }
      >
      {/* ── Draw it ──────────────────────────────────────────────────────────────────── */}
      {undrawn > 0.005 && accounts.length > 0 && (
        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h2 className="font-medium">Draw the money</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {peso(undrawn)} of this agreement is still undrawn. Anything beyond it is a separate
              loan with its own terms, not a bigger version of this one.
            </p>
          </div>
          <form action={disburseLoanAction} className="grid gap-4 sm:grid-cols-3">
            <input type="hidden" name="loanId" value={loan.id} />
            <Field label="Amount">
              <input
                name="amount"
                required
                defaultValue={undrawn.toFixed(2)}
                inputMode="decimal"
                className={INPUT}
              />
            </Field>
            <Field label="Into">
              <select name="intoMoneyAccountId" required defaultValue={accounts[0]?.id} className={INPUT}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="On">
              <input name="on" type="date" required defaultValue={today()} className={INPUT} />
            </Field>
            <div className="sm:col-span-3">
              <button
                type="submit"
                className="rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
              >
                Record the draw
              </button>
            </div>
          </form>
        </section>
      )}

      {/* ── Pay it ───────────────────────────────────────────────────────────────────── */}
      {owes && accounts.length > 0 && (
        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h2 className="font-medium">Record a payment</h2>
            {/*
              ⭐ THE SPLIT IS NOT AN INPUT, AND THAT IS THE POINT.

              v1 asks the person to type how much of the payment is interest and how much is
              principal — the number deciding how fast the debt retires, hand-entered. Here you say
              what was paid, and the split follows from the loan's own terms.
            */}
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Enter what was paid. Interest is taken first, principal second — you do not split it
              yourself, because the loan&apos;s own terms already decide it.
            </p>
          </div>

          <div className="rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800">
            <span className="text-neutral-600 dark:text-neutral-400">
              Interest built up since {loan.lastPaymentOn ?? loan.startDate}
            </span>{' '}
            <span className="font-mono font-medium tabular-nums">{peso(loan.accruedNow)}</span>
            <div className="mt-1 text-xs text-neutral-400 dark:text-neutral-600">
              A payment of {peso(loan.instalment)} is one scheduled instalment. ⚠️ Paying less is
              normal and is handled — it simply retires less principal, or none.
            </div>
          </div>

          <form action={recordPaymentAction} className="grid gap-4 sm:grid-cols-3">
            <input type="hidden" name="loanId" value={loan.id} />
            <Field label="Amount paid">
              <input
                name="amount"
                required
                inputMode="decimal"
                placeholder={loan.instalment}
                className={INPUT}
              />
            </Field>
            <Field label="From">
              <select name="fromMoneyAccountId" required defaultValue={accounts[0]?.id} className={INPUT}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {peso(a.balance)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="On">
              <input name="on" type="date" required defaultValue={today()} className={INPUT} />
            </Field>
            <div className="sm:col-span-3">
              <button
                type="submit"
                className="rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
              >
                Record payment
              </button>
            </div>
          </form>
        </section>
      )}

      {/* ── History ──────────────────────────────────────────────────────────────────── */}
      {loan.payments.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Payments</h2>
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 text-right font-medium">Interest</th>
                  <th className="px-3 py-2 text-right font-medium">Principal</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {loan.payments.map((p) => (
                  <tr
                    key={p.entryId}
                    className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                  >
                    <td className="px-3 py-2 font-mono whitespace-nowrap">{p.paidOn}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {peso(p.interest)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {peso(p.principal)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(p.total)}</td>
                    <td className="px-3 py-2 text-right">
                      <form action={reverseEntryAction} className="flex justify-end gap-1">
                        <input type="hidden" name="loanId" value={loan.id} />
                        <input type="hidden" name="entryId" value={p.entryId} />
                        <input
                          name="reason"
                          required
                          placeholder="Reason…"
                          className="w-28 rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
                        />
                        <button
                          type="submit"
                          className="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
                        >
                          Reverse
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* ⚠️ A reversed payment disappears from this list rather than sitting beside its own
              undo — netting is right for a figure and wrong for a history. */}
          <p className="text-xs text-neutral-400 dark:text-neutral-600">
            Reversing writes the opposite entry; the two net to nothing and the debt returns to what
            it was. A reversed payment leaves this list — it never happened as far as the loan is
            concerned, and both entries stay in the ledger.
          </p>
        </section>
      )}
      </DetailLayout>
    </Page>
  );
}

const INPUT =
  'w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

function Figure({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="text-xs text-neutral-500 dark:text-neutral-400">{label}</div>
      <div className={`font-mono tabular-nums ${emphasis ? 'text-lg font-medium' : 'text-lg'}`}>
        {value}
      </div>
    </div>
  );
}

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
