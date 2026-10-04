import { toBusinessDate } from '@shareat/core/datetime';
import { requirePageAccess } from '../../../lib/page-access';
import { compare, money, ZERO } from '@shareat/core/money';
import { post13thMonthRunAction, void13thMonthRunAction } from './actions';
import { cashAccountsFor, listStores, payoutsFor, peso, preview, runsFor } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';

export const metadata = { title: '13th-month pay — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  year?: string;
  ok?: string;
  error?: string;
}

/**
 * `/payroll/thirteenth-month`. T-191.
 *
 * ⭐ The input is a YEAR, not a period — that is the whole reason this is a separate page from
 * `/payroll` rather than a section on it. See `docs/tasks/191-thirteenth-month-pay.md` §2.4.
 */
export default async function ThirteenthMonthPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const { actor, refusal } = await requirePageAccess('/payroll/thirteenth-month');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const stores = await listStores(actor.orgId);
  const storeId = sp.store || stores[0]?.id;
  const year = Number(sp.year) || Number(toBusinessDate().slice(0, 4));

  if (!storeId) {
    return (
      <Page density="table" className="space-y-4">
        <h1 className="text-2xl font-semibold">13th-month pay</h1>
        <PageDescription>No store is set up yet.</PageDescription>
      </Page>
    );
  }

  const [{ preview: pv, error: previewError }, runs, accounts] = await Promise.all([
    preview(actor.orgId, actor, { storeId, year }),
    runsFor(actor.orgId, storeId),
    cashAccountsFor(actor.orgId, storeId),
  ]);

  const latest = runs[0];
  const latestPayouts = latest ? await payoutsFor(actor.orgId, latest.id) : [];

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">13th-month pay</h1>
        <PageDescription>
          Total basic pay each person earned in <b>{year}</b>, divided by 12 — DOLE&rsquo;s
          formula, applied to what payroll already posted. Nobody who has no posted basic pay for
          the year is included. ⚠️{' '}
          <b>2026 is not real here</b> — v2 pilots Oct&ndash;Dec 2026 and every operational table
          purges 1 Jan 2027 (ADR-007); the real 2026 payout has to happen outside v2.
        </PageDescription>
      </div>

      <form className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Store</span>
          <select name="store" defaultValue={storeId} className={`${FIELD} w-52`}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Year</span>
          <input name="year" type="number" step={1} defaultValue={year} className={`${FIELD} w-28`} />
        </label>
        <button type="submit" className={BTN}>
          Preview
        </button>
      </form>

      {sp.error && <Banner tone="error">{sp.error}</Banner>}
      {sp.ok && <Banner tone="ok">{sp.ok}</Banner>}
      {previewError && <Banner tone="error">{previewError}</Banner>}

      {pv && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium">{year}</h2>
            <span className="text-xs text-neutral-500">
              {pv.payouts.length} payout(s) · gross {peso(Number(pv.totalGross))} · net{' '}
              {peso(Number(pv.totalNet))}
            </span>
          </div>

          {pv.payouts.length === 0 ? (
            <p className="rounded border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
              Nobody has posted basic pay for {year} at this store yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[42rem] text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-neutral-500">
                    <th className="py-1 pr-3 font-medium">Person</th>
                    <th className="py-1 pr-3 text-right font-medium">Basic pay earned</th>
                    <th className="py-1 pr-3 text-right font-medium">Gross (÷12)</th>
                    <th className="py-1 pr-3 text-right font-medium">Advance</th>
                    <th className="py-1 text-right font-medium">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {pv.payouts.map((p) => (
                    <tr key={p.employmentId} className="border-t border-neutral-200 dark:border-neutral-800">
                      <td className="py-1.5 pr-3">{p.personName}</td>
                      <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-neutral-500">
                        {peso(Number(p.basicPayEarned))}
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{peso(Number(p.grossPay))}</td>
                      <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-amber-700 dark:text-amber-400">
                        {compare(money(p.advanceRecovered), ZERO) > 0 ? `−${peso(Number(p.advanceRecovered))}` : '—'}
                      </td>
                      <td className="py-1.5 text-right font-mono font-medium tabular-nums">
                        {peso(Number(p.netPay))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {pv.payouts.length > 0 && (
            <form
              action={post13thMonthRunAction}
              className="flex flex-wrap items-end gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-800"
            >
              <input type="hidden" name="storeId" value={storeId} />
              <input type="hidden" name="year" value={year} />
              <label className="flex flex-col gap-1">
                <span className={LABEL}>Pay from</span>
                <select name="moneyAccountId" className={`${FIELD} w-56`}>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <input name="notes" placeholder="Notes (optional)" className={`${FIELD} w-64`} />
              <button type="submit" className={BTN_PRIMARY}>
                Post {pv.payouts.length} payout(s)
              </button>
            </form>
          )}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Runs</h2>
        {runs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
            No 13th-month run yet at this store.
          </p>
        ) : (
          runs.map((run) => (
            <div key={run.id} className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-medium">{run.year}</span>
                <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-xs dark:bg-neutral-800">{run.status}</span>
                {run.voidReason && <span className="text-xs text-neutral-500">voided — {run.voidReason}</span>}
              </div>

              {run.id === latest?.id && latestPayouts.length > 0 && (
                <ul className="text-xs text-neutral-600 dark:text-neutral-400">
                  {latestPayouts.map((p) => (
                    <li key={p.id}>
                      {p.personName} — net <span className="font-mono">{peso(Number(p.netPay))}</span>
                      {compare(money(p.advanceRecovered), ZERO) > 0 && ` (advance −${peso(Number(p.advanceRecovered))})`}
                    </li>
                  ))}
                </ul>
              )}

              {run.status === 'posted' && (
                <form action={void13thMonthRunAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="storeId" value={storeId} />
                  <input type="hidden" name="year" value={run.year} />
                  <input type="hidden" name="runId" value={run.id} />
                  <input name="reason" placeholder="Why void it?" className={`${FIELD} w-64`} />
                  <button type="submit" className={BTN}>
                    Void
                  </button>
                  <span className="text-xs text-neutral-500">
                    ⭐ Reverses the entries, so the year is payable again.
                  </span>
                </form>
              )}
            </div>
          ))
        )}
      </section>
    </Page>
  );
}

function Banner({ tone, children }: { tone: 'error' | 'ok'; children: React.ReactNode }) {
  const cls =
    tone === 'error'
      ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
      : 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300';
  return <div className={`rounded-lg border p-4 text-sm ${cls}`}>{children}</div>;
}

const FIELD =
  'rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const LABEL = 'text-xs font-medium text-neutral-600 dark:text-neutral-400';
const BTN =
  'rounded border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900';
const BTN_PRIMARY =
  'rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300';
