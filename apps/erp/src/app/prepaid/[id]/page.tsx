import { toBusinessDate } from '@shareat/core/datetime';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { compare, ZERO } from '@shareat/core/money';
import { requirePageAccess } from '../../../lib/page-access';
import {
  amortiseAction,
  confirmTermAction,
  reverseMonthAction,
  writeOffAction,
} from '../actions';
import { CATEGORY_LABEL, STATUS_LABEL, getDetail, peso, thisPeriod } from '../lib';
import { DetailLayout } from '@/components/shell/DetailLayout';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';

export const metadata = { title: 'Prepaid item — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
  /** T-343 S5.5u item 3 — set by `writeOffAction` on a refusal, so the write-off form keeps what
   *  was typed instead of going blank (fixed-assets/[id]/page.tsx's `sp.reason` precedent). */
  reason?: string;
  refundAmount?: string;
  refundAccountCode?: string;
  /** S5.5u Amendment A1 item 1 — else a back-dated write-off resubmitted after a refusal silently
   *  reverts to today's date. */
  writtenOffOn?: string;
}

export default async function PrepaidItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { actor, refusal } = await requirePageAccess(`/prepaid/${id}`);
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const item = await getDetail(actor.orgId, id);
  if (!item) notFound();

  const active = item.status === 'active';

  return (
    <Page density="table">
      <div>
        <Link href="/prepaid" className="text-sm underline underline-offset-2">
          ← Prepaid expenses
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{item.name}</h1>
        <PageDescription>
          {CATEGORY_LABEL[item.category] ?? item.category} · {STATUS_LABEL[item.status]} · covers{' '}
          {item.coverageMonths} months from {item.coverageStartDate}
        </PageDescription>
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
          /* ── The three figures ──────────────────────────────────────────────────────── */
          <section className="space-y-3">
            {/* ⚠️ `min-[1440px]:grid-cols-1`: `sm` is a VIEWPORT query, so without it these tiles
                stay three-across inside a 320px rail. T-240 §3.5. */}
            <div className="grid gap-3 sm:grid-cols-3 min-[1440px]:grid-cols-1">
              <Figure label="Cost" value={peso(item.totalCost)} />
              <Figure label="Released so far" value={peso(item.amortised)} />
              <Figure label="Still unused" value={peso(item.remaining)} emphasis />
            </div>
            {/* ⛔ None of these is a column. "Released" is summed from the ledger and "still unused"
                is cost minus that — so they cannot drift from the books, which is exactly what v1's
                stored amortizedToDate / remainingBookValue pair did. */}
            <p className="text-xs text-neutral-400 dark:text-neutral-600">
              Released and still-unused are summed from the ledger on load, never stored — so they
              cannot disagree with the books they describe.
            </p>
          </section>
        }
      >
      {/* ── The review, when the term was guessed ────────────────────────────────────── */}
      {item.needsReview && active && (
        <section className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
          <div className="text-sm text-amber-900 dark:text-amber-300">
            <strong className="font-medium">This term was a guess.</strong> The amount and date came
            off the invoice — only a person can say how long the cover actually runs. Confirm it or
            correct it.
            {item.sourceExpenseId && (
              <>
                {' '}
                <Link
                  href={`/expenses/${item.sourceExpenseId}`}
                  className="underline underline-offset-2"
                >
                  Open the expense it came from
                </Link>{' '}
                to see what was actually bought.
              </>
            )}
          </div>
          <form action={confirmTermAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="prepaidItemId" value={item.id} />
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-amber-900 dark:text-amber-300">Starts</span>
              <input
                name="coverageStartDate"
                type="date"
                required
                defaultValue={item.coverageStartDate}
                className={INPUT}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-amber-900 dark:text-amber-300">Months</span>
              <input
                name="coverageMonths"
                inputMode="numeric"
                required
                defaultValue={item.coverageMonths}
                className={`${INPUT} w-24`}
              />
            </label>
            <button
              type="submit"
              className="rounded bg-amber-700 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600"
            >
              Confirm term
            </button>
          </form>
        </section>
      )}

      {/* ── The schedule ─────────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">Schedule</h2>
          {active && (
            <form action={amortiseAction} className="flex flex-wrap items-end gap-2 gap-y-2">
              <input type="hidden" name="prepaidItemId" value={item.id} />
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
                  Release through
                </span>
                <input
                  name="asOfPeriod"
                  type="month"
                  required
                  defaultValue={thisPeriod()}
                  className={INPUT}
                />
              </label>
              <button
                type="submit"
                className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
              >
                Release
              </button>
            </form>
          )}
        </div>

        {/* ⭐ Running it again is SAFE and is how you catch up — months already out no-op. v1's
            scheduler silently stopped for two months and its register still looked fine, because
            the register was a maintained column (DEF-044). */}
        <p className="text-xs text-neutral-400 dark:text-neutral-600">
          Releasing is safe to repeat: months already posted are skipped, so catching up after a
          missed run is just running it again.
        </p>

        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Month</th>
                <th className="px-3 py-2 font-medium">Posts on</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">State</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {item.schedule.map((p) => (
                <tr
                  key={p.period}
                  className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                >
                  <td className="px-3 py-2 font-mono">{p.period}</td>
                  <td className="px-3 py-2 text-neutral-500 dark:text-neutral-400">{p.entryDate}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(p.amount)}</td>
                  <td className="px-3 py-2 text-xs">
                    {p.posted ? (
                      <span className="text-emerald-700 dark:text-emerald-400">Released</span>
                    ) : (
                      <span className="text-neutral-400 dark:text-neutral-600">Not yet</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {/*
                      ⭐ REVERSING ONE MONTH — v1 cannot do this at all.

                      Its only undo cascade-voids every leg including the original purchase, so
                      fixing one bad month means re-creating the item and re-running every prior
                      period. It is nearly free here because the balance is derived: reversing the
                      entry IS the fix, with no column to repair.
                    */}
                    {p.posted && (
                      <form action={reverseMonthAction} className="flex justify-end gap-1">
                        <input type="hidden" name="prepaidItemId" value={item.id} />
                        <input type="hidden" name="period" value={p.period} />
                        <input
                          name="reason"
                          required
                          placeholder="Reason…"
                          className="w-28 rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
                        />
                        <button
                          type="submit"
                          className="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
                        >
                          Reverse
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Early termination ────────────────────────────────────────────────────────── */}
      {active && compare(item.remaining, ZERO) > 0 && (
        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h2 className="font-medium">End it early</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Whatever is left is recognised now. If some money came back, say how much — a refund
              is cash returning, not income.
            </p>
          </div>
          <form action={writeOffAction} className="space-y-4">
            <input type="hidden" name="prepaidItemId" value={item.id} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Date">
                <input
                  name="writtenOffOn"
                  type="date"
                  required
                  defaultValue={sp.writtenOffOn ?? toBusinessDate()}
                  className={INPUT}
                />
              </Field>
              <Field label="Reason">
                <input name="reason" required maxLength={200} defaultValue={sp.reason ?? ''} className={INPUT} />
              </Field>
              <Field
                label="Refunded"
                hint={`Leave blank if nothing came back. At most ${peso(item.remaining)}`}
              >
                <input
                  name="refundAmount"
                  inputMode="decimal"
                  defaultValue={sp.refundAmount ?? ''}
                  className={INPUT}
                />
              </Field>
              <Field label="Refund landed in" hint="Account code, e.g. 1110 cash or 1140 e-wallet">
                <input
                  name="refundAccountCode"
                  maxLength={8}
                  placeholder="1110"
                  defaultValue={sp.refundAccountCode ?? ''}
                  className={INPUT}
                />
              </Field>
            </div>
            {/* ⚠️ The trap worth naming on the page: booking the whole remainder as expense AND
                the refund as income double-counts the cancellation — and the entry still balances,
                so nothing would catch it. */}
            <p className="text-xs text-neutral-400 dark:text-neutral-600">
              Only the part that did <strong>not</strong> come back reaches the P&amp;L. The refund
              moves from one balance-sheet account to another.
            </p>
            <button
              type="submit"
              className="rounded border border-neutral-300 px-4 py-2.5 text-sm font-medium text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
            >
              Write it off
            </button>
          </form>
        </section>
      )}

      {item.status === 'written_off' && (
        <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <strong className="font-medium">Written off {item.writtenOffOn}.</strong>{' '}
          {item.writeOffReason}
        </div>
      )}
      </DetailLayout>
    </Page>
  );
}

const INPUT =
  'w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

function Figure({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="text-xs text-neutral-500 dark:text-neutral-400">{label}</div>
      <div
        className={`font-mono tabular-nums ${emphasis ? 'text-lg font-medium' : 'text-lg'}`}
      >
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
